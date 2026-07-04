"""Step 4: Filler Detection - フィラー検出。

ElevenLabs STT は日本語を一文字1word（「あ」「の」等）で返すため、word単位の
完全一致/正規表現マッチでは「あの」「まー」等の複数文字フィラーが検出できない。
そこで連続するwordのテキストを連結した文字列に対してパターンマッチし、マッチ
範囲を構成word群へ逆引きする方式（文字連結マッチ方式）を採用する。

各エントリは action フィールドを持つ:
- remove: step07 で除去対象（えー/あー/えーと 等の明確な言い淀み）
- warn_only: 検出のみ・除去しない（終助詞 ね/よ/さ/な 等）

Usage:
    python step04_filler_detect.py \
        --stt ../runs/{run}/step02_stt/stt_result.json \
        --vad ../runs/{run}/step03_vad/vad_result.json \
        --output ../runs/{run}/step04_filler_detect
"""

import argparse
import json
import os
import re
import sys

ACTION_REMOVE = "remove"
ACTION_WARN_ONLY = "warn_only"

# 除去対象外（終助詞・間投助詞）— 警告のみ
WARN_ONLY_LITERALS = frozenset({"ね", "ねー", "よ", "さ", "な", "なあ", "かな"})

# 単独1文字で現れたときのみ除去してよい言い淀み。孤立判定(_is_isolated_word)必須。
# 「ま」は「作成しました」の語中「ま」を破壊した実績があるため必ず孤立判定を通す
SINGLE_CHAR_HESITATIONS = frozenset({"あ", "え", "ま", "ア", "エ", "マ"})

# 孤立判定: 隣接語との時間ギャップがこれ以上あればポーズとみなす
ISOLATION_GAP_MS = 160

# フィラーパターン定義 (日本語トーク動画向け)
FILLER_PATTERNS = {
    # 典型的なフィラー (hesitation) — 除去対象
    "えー": {"type": "hesitation", "confidence": 0.9, "action": ACTION_REMOVE},
    "えーと": {"type": "hesitation", "confidence": 0.95, "action": ACTION_REMOVE},
    "えーっと": {"type": "hesitation", "confidence": 0.95, "action": ACTION_REMOVE},
    "えっと": {"type": "hesitation", "confidence": 0.95, "action": ACTION_REMOVE},
    "え": {"type": "hesitation", "confidence": 0.85, "action": ACTION_REMOVE},
    "あー": {"type": "hesitation", "confidence": 0.85, "action": ACTION_REMOVE},
    "あ": {"type": "hesitation", "confidence": 0.75, "action": ACTION_REMOVE},
    "あのー": {"type": "hedging", "confidence": 0.9, "action": ACTION_REMOVE},
    "うーん": {"type": "thinking", "confidence": 0.9, "action": ACTION_REMOVE},
    # ぼかし表現 — 除去は高信頼・長音付きのみ
    "まあ": {"type": "hedging", "confidence": 0.7, "action": ACTION_REMOVE},
    "まー": {"type": "hedging", "confidence": 0.8, "action": ACTION_REMOVE},
    "ま": {"type": "hedging", "confidence": 0.65, "action": ACTION_REMOVE},
    "そのー": {"type": "hedging", "confidence": 0.85, "action": ACTION_REMOVE},
    "あの": {"type": "hedging", "confidence": 0.7},
    "その": {"type": "hedging", "confidence": 0.5},
    "なんか": {"type": "hedging", "confidence": 0.65},
    "やっぱ": {"type": "hedging", "confidence": 0.5},
    "ちょっと": {"type": "hedging", "confidence": 0.4},
    "こう": {"type": "hedging", "confidence": 0.5},
    # 対話的アーティファクト
    "どうぞ": {"type": "turn_taking", "confidence": 0.5},
    "はいはい": {"type": "backchannel", "confidence": 0.7},
    "そうそう": {"type": "backchannel", "confidence": 0.6},
    "そうそうそう": {"type": "backchannel", "confidence": 0.75},
    "ね": {"type": "backchannel", "confidence": 0.4, "action": ACTION_WARN_ONLY},
    "ねー": {"type": "backchannel", "confidence": 0.5, "action": ACTION_WARN_ONLY},
    "はい": {"type": "backchannel", "confidence": 0.3},
    "うん": {"type": "backchannel", "confidence": 0.6},
    # 英語系フィラー
    "um": {"type": "hesitation", "confidence": 0.9, "action": ACTION_REMOVE},
    "uh": {"type": "hesitation", "confidence": 0.9, "action": ACTION_REMOVE},
    "ah": {"type": "hesitation", "confidence": 0.85, "action": ACTION_REMOVE},
    "well": {"type": "hedging", "confidence": 0.5},
}

FILLER_REGEX_PATTERNS = [
    (r"[えエ][ーェ]+[とト]?", "hesitation", 0.9, ACTION_REMOVE),
    (r"[あア][ーァ]+", "hesitation", 0.85, ACTION_REMOVE),
    (r"[うウ][ーゥ]+[んン]?", "thinking", 0.85, ACTION_REMOVE),
    (r"[そソ][のノ][ーォ]+", "hedging", 0.85, ACTION_REMOVE),
    (r"[まマ][ーァ]+", "hedging", 0.8, ACTION_REMOVE),
    # 長音「ー」単独 (え/あ の直後に来る場合は _merge で結合)
    (r"[ー—]+", "hesitation", 0.8, ACTION_REMOVE),
]

_LITERAL_KEYS_SORTED = sorted(FILLER_PATTERNS.keys(), key=len, reverse=True)
FILLER_LITERAL_REGEX = re.compile("|".join(re.escape(k) for k in _LITERAL_KEYS_SORTED)) if _LITERAL_KEYS_SORTED else None

SENTENCE_INITIAL_BOOST = 0.1
PRE_GAP_BOOST_MS = 300
PRE_GAP_BOOST = 0.05
POST_BOUNDARY_BOOST = 0.1
POST_PAUSE_MS = 300
POST_CONTINUE_MS = 150
POST_CONTINUE_PENALTY = 0.25
HESITATION_MERGE_MAX_GAP_MS = 500

PAUSE_PUNCTUATION = {"、", "。", "！", "!", "？", "?", "…"}


def run_step(stt_result_path: str, vad_result_path: str, output_dir: str, config: dict = None) -> dict:
    """フィラー検出 (文字連結マッチ方式)。"""
    os.makedirs(output_dir, exist_ok=True)

    print(f"[Step 4] Filler Detection")

    with open(stt_result_path, "r", encoding="utf-8") as f:
        stt_result = json.load(f)
    with open(vad_result_path, "r", encoding="utf-8") as f:
        json.load(f)

    words = stt_result.get("words", [])
    sentences = stt_result.get("sentences", [])

    fillers = _detect_fillers(words, sentences)

    type_counts = {}
    action_counts = {}
    for f in fillers:
        t = f["type"]
        type_counts[t] = type_counts.get(t, 0) + 1
        a = f.get("action", "unknown")
        action_counts[a] = action_counts.get(a, 0) + 1

    result = {
        "fillers": fillers,
        "stats": {
            "total_fillers": len(fillers),
            "type_distribution": type_counts,
            "action_distribution": action_counts,
            "high_confidence": sum(1 for f in fillers if f["confidence"] >= 0.7),
            "remove_count": sum(1 for f in fillers if f.get("action") == ACTION_REMOVE),
            "warn_only_count": sum(1 for f in fillers if f.get("action") == ACTION_WARN_ONLY),
        },
    }

    print(f"  fillers: {len(fillers)}")
    print(f"  remove: {result['stats']['remove_count']}, warn_only: {result['stats']['warn_only_count']}")
    print(f"  types: {type_counts}")

    output_path = os.path.join(output_dir, "fillers.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"[Step 4] Done: {output_path}")
    return result


def _detect_fillers(words: list, sentences: list) -> list:
    if not words:
        return []

    concat_text, owner_idx, word_char_start, word_char_end = _build_concat_index(words)
    if not concat_text:
        return []

    candidates = _collect_candidates(concat_text, owner_idx, word_char_start, word_char_end)
    matches = _resolve_overlaps(candidates)
    for m in matches:
        m["word_indices"] = sorted(set(owner_idx[m["start"]:m["end"]]))

    match_start_indices = {m["word_indices"][0] for m in matches}

    for m in matches:
        m["confidence"] = _adjust_confidence(m, words, sentences, match_start_indices)

    matches = _merge_consecutive_matches(matches, words, max_gap_ms=200)
    matches = _merge_hesitation_pairs(matches, words)

    fillers = []
    for m in matches:
        action = _resolve_action(m, words, concat_text)
        if action is None:
            continue
        m["action"] = action
        matched_text = concat_text[m["start"]:m["end"]]
        word_ids = [words[i]["id"] for i in m["word_indices"]]
        for idx in m["word_indices"]:
            w = words[idx]
            fillers.append({
                "text": w["text"],
                "type": m["type"],
                "action": action,
                "start_ms": w["start_ms"],
                "end_ms": w["end_ms"],
                "confidence": round(m["confidence"], 3),
                "source": m["source"],
                "word_id": w["id"],
                "word_ids": word_ids,
                "match_text": matched_text,
            })

    return fillers


def _resolve_action(match: dict, words: list, concat_text: str) -> str | None:
    """マッチに対する action (remove / warn_only) を決定。None なら出力しない。"""
    matched_text = concat_text[match["start"]:match["end"]]
    indices = match["word_indices"]
    first_idx = indices[0]

    # 終助詞・間投助詞 — 警告のみ
    if matched_text in WARN_ONLY_LITERALS:
        return ACTION_WARN_ONLY
    if all(words[i]["text"] in WARN_ONLY_LITERALS for i in indices):
        return ACTION_WARN_ONLY

    # 例え / えば 等の誤検出防止
    if _is_reeba_context(words, first_idx, matched_text):
        return None

    # 単独1文字の言い淀み(あ/え)は、前後がポーズで孤立している場合のみ除去。
    # 「情報あるけど」の「あ」や「あっなんだ」の「あ」のような語中・語頭の文字を
    # 削るとテキストが破壊されるため(改善10検証で実際に発生)。
    if matched_text in SINGLE_CHAR_HESITATIONS and not _is_isolated_word(words, indices):
        return None

    # パターン定義の明示 action
    for key, info in FILLER_PATTERNS.items():
        if matched_text == key and info.get("action"):
            if info["action"] == ACTION_REMOVE and info.get("type") == "hedging":
                if match["confidence"] < 0.6:
                    return None
            return info["action"]

    # regex / 型ベースの既定
    if match["type"] in ("hesitation", "thinking"):
        return ACTION_REMOVE

    if match["type"] == "hedging":
        remove_hedging = {"あのー", "そのー", "まー", "まあ", "ま"}
        if matched_text in remove_hedging:
            if matched_text == "ま":
                next_idx = indices[-1] + 1
                if next_idx < len(words) and words[next_idx]["text"] in PAUSE_PUNCTUATION:
                    return ACTION_REMOVE
                return None
            return ACTION_REMOVE if match["confidence"] >= 0.6 else None
        # あの/その/やっぱ 等の部分一致は低信頼なら抑制
        if match["confidence"] < 0.6:
            return None
        return ACTION_WARN_ONLY

    if match["type"] == "backchannel":
        if matched_text in WARN_ONLY_LITERALS:
            return ACTION_WARN_ONLY
        return None

    return None


def _is_isolated_word(words: list, indices: list) -> bool:
    """単独1文字フィラーの孤立判定。

    前後の語との時間ギャップが ISOLATION_GAP_MS 以上、または隣接語が句読点/
    トランスクリプト端であれば「ポーズに挟まれた言い淀み」とみなす。
    前後どちらも語が密着している場合は語の一部の可能性が高いので除去しない。
    """
    first_idx = indices[0]
    last_idx = indices[-1]

    def boundary_ok(neighbor_idx: int, is_prev: bool) -> bool:
        if neighbor_idx < 0 or neighbor_idx >= len(words):
            return True
        neighbor = words[neighbor_idx]
        if (neighbor.get("text") or "").strip() in PAUSE_PUNCTUATION:
            return True
        if is_prev:
            gap = words[first_idx]["start_ms"] - neighbor["end_ms"]
        else:
            gap = neighbor["start_ms"] - words[last_idx]["end_ms"]
        return gap >= ISOLATION_GAP_MS

    return boundary_ok(first_idx - 1, True) and boundary_ok(last_idx + 1, False)


def _is_reeba_context(words: list, word_idx: int, matched_text: str) -> bool:
    """「例えば」の「え」をフィラーと誤判定しない。"""
    if matched_text not in ("え", "エ"):
        return False
    prev_text = words[word_idx - 1]["text"] if word_idx > 0 else ""
    next_text = words[word_idx + 1]["text"] if word_idx + 1 < len(words) else ""
    if prev_text.endswith("例") or prev_text == "例":
        if next_text.startswith("ば") or next_text == "ば":
            return True
    return False


def _merge_hesitation_pairs(matches: list, words: list) -> list:
    """え+ー / あ+ー 等、ギャップがあっても同一フィラーとしてマージする。"""
    if len(matches) <= 1:
        return matches

    merged = [dict(matches[0])]
    for m in matches[1:]:
        last = merged[-1]
        last_end_idx = last["word_indices"][-1]
        first_idx = m["word_indices"][0]
        gap = words[first_idx]["start_ms"] - words[last_end_idx]["end_ms"]
        last_text = "".join(words[i]["text"] for i in last["word_indices"])
        curr_text = "".join(words[i]["text"] for i in m["word_indices"])
        is_hesitation_pair = (
            last.get("type") in ("hesitation", "thinking")
            and m.get("type") in ("hesitation", "thinking")
            and gap <= HESITATION_MERGE_MAX_GAP_MS
            and (
                (last_text in ("え", "あ", "う") and curr_text.startswith("ー"))
                or (last_text.endswith("え") and curr_text in ("ー", "—"))
                or (last_text.endswith("あ") and curr_text in ("ー", "—"))
            )
        )
        if is_hesitation_pair:
            last["word_indices"] = last["word_indices"] + m["word_indices"]
            last["end"] = m["end"]
            last["confidence"] = max(last["confidence"], m["confidence"])
            last["type"] = "hesitation"
        else:
            merged.append(dict(m))
    return merged


def _build_concat_index(words: list):
    chars = []
    owner_idx = []
    word_char_start = [0] * len(words)
    word_char_end = [0] * len(words)
    pos = 0
    for i, w in enumerate(words):
        text = w.get("text") or ""
        word_char_start[i] = pos
        for ch in text:
            chars.append(ch)
            owner_idx.append(i)
            pos += 1
        word_char_end[i] = pos
    return "".join(chars), owner_idx, word_char_start, word_char_end


def _is_word_aligned(start: int, end: int, owner_idx: list, word_char_start: list, word_char_end: list) -> bool:
    if start >= end or end > len(owner_idx):
        return False
    first_word = owner_idx[start]
    last_word = owner_idx[end - 1]
    return word_char_start[first_word] == start and word_char_end[last_word] == end


def _collect_candidates(concat_text: str, owner_idx: list, word_char_start: list, word_char_end: list) -> list:
    candidates = []

    if FILLER_LITERAL_REGEX is not None:
        for m in FILLER_LITERAL_REGEX.finditer(concat_text):
            key = m.group(0)
            info = FILLER_PATTERNS.get(key)
            if not info:
                continue
            start, end = m.start(), m.end()
            if not _is_word_aligned(start, end, owner_idx, word_char_start, word_char_end):
                continue
            candidates.append({
                "start": start,
                "end": end,
                "type": info["type"],
                "confidence": info["confidence"],
                "source": "pattern",
            })

    for pattern, ftype, conf, *rest in FILLER_REGEX_PATTERNS:
        default_action = rest[0] if rest else None
        for m in re.finditer(pattern, concat_text):
            start, end = m.start(), m.end()
            if start == end:
                continue
            if not _is_word_aligned(start, end, owner_idx, word_char_start, word_char_end):
                continue
            # 単独「ー」は直前が え/あ/う のときのみ (後段マージでも可)
            matched = concat_text[start:end]
            if matched in ("ー", "—") and start > 0:
                prev_ch = concat_text[start - 1]
                if prev_ch not in "えあうエアウ":
                    continue
            candidates.append({
                "start": start,
                "end": end,
                "type": ftype,
                "confidence": conf,
                "source": "regex",
                "default_action": default_action,
            })

    return candidates


def _resolve_overlaps(candidates: list) -> list:
    if not candidates:
        return []

    ordered = sorted(candidates, key=lambda c: (-(c["end"] - c["start"]), c["start"]))
    chosen = []
    occupied = []
    for c in ordered:
        overlap = any(not (c["end"] <= s or c["start"] >= e) for s, e in occupied)
        if overlap:
            continue
        occupied.append((c["start"], c["end"]))
        chosen.append(c)

    chosen.sort(key=lambda c: c["start"])
    return chosen


def _adjust_confidence(match: dict, words: list, sentences: list, match_start_indices: set) -> float:
    confidence = match["confidence"]
    first_idx = match["word_indices"][0]
    last_idx = match["word_indices"][-1]
    first_word = words[first_idx]
    last_word = words[last_idx]

    if _is_sentence_initial(first_word, sentences):
        confidence = min(1.0, confidence + SENTENCE_INITIAL_BOOST)

    if first_idx > 0:
        gap_ms = first_word["start_ms"] - words[first_idx - 1]["end_ms"]
        if gap_ms > PRE_GAP_BOOST_MS:
            confidence = min(1.0, confidence + PRE_GAP_BOOST)

    next_idx = last_idx + 1 if last_idx + 1 < len(words) else None
    next_word = words[next_idx] if next_idx is not None else None
    gap_after = (next_word["start_ms"] - last_word["end_ms"]) if next_word is not None else None

    is_boundary_or_pause = (
        next_word is None
        or (next_word.get("text") or "").strip() in PAUSE_PUNCTUATION
        or (gap_after is not None and gap_after > POST_PAUSE_MS)
        or (next_idx is not None and next_idx in match_start_indices)
        or _is_sentence_final(last_word, sentences)
    )

    if is_boundary_or_pause:
        confidence = min(1.0, confidence + POST_BOUNDARY_BOOST)
    elif next_word is not None and gap_after is not None and gap_after < POST_CONTINUE_MS:
        confidence = max(0.0, confidence - POST_CONTINUE_PENALTY)

    return confidence


def _is_sentence_initial(word: dict, sentences: list) -> bool:
    for s in sentences:
        word_ids = s.get("word_ids", [])
        if word_ids and word_ids[0] == word["id"]:
            return True
    return False


def _is_sentence_final(word: dict, sentences: list) -> bool:
    for s in sentences:
        word_ids = s.get("word_ids", [])
        if word_ids and word_ids[-1] == word["id"]:
            return True
    return False


def _merge_consecutive_matches(matches: list, words: list, max_gap_ms: int = 200) -> list:
    if len(matches) <= 1:
        return matches

    merged = [dict(matches[0])]

    for m in matches[1:]:
        last = merged[-1]
        gap = words[m["word_indices"][0]]["start_ms"] - words[last["word_indices"][-1]]["end_ms"]

        if gap <= max_gap_ms and m["type"] == last["type"]:
            last["word_indices"] = last["word_indices"] + m["word_indices"]
            last["end"] = m["end"]
            last["confidence"] = max(last["confidence"], m["confidence"])
        else:
            merged.append(dict(m))

    return merged


def main():
    parser = argparse.ArgumentParser(description="Step 4: Filler Detection")
    parser.add_argument("--stt", required=True, help="STT result JSON path")
    parser.add_argument("--vad", required=True, help="VAD result JSON path")
    parser.add_argument("--output", required=True, help="Output directory")
    args = parser.parse_args()

    run_step(args.stt, args.vad, args.output)


if __name__ == "__main__":
    main()
