"""Step 5: AI Retake Detection - 言い直しカット + 復元困難箇所の検出 (改善13 パス1 / 改善14 チャンク分割・フィラーAI判定)。

STT全文(文単位)をLLMに渡し、言い直し(不完全な方をカット)と復元困難区間(要確認)を検出する。
出力は step07 互換の retakes.json と ai_review.json。

Usage:
    python step05_ai_retake.py <run_dir> \\
        --stt ../runs/{run}/step02b_transcript_correct/stt_corrected.json \\
        --fillers ../runs/{run}/step04_filler_detect/fillers.json \\
        --retakes-output ../runs/{run}/step05_retake_detect/retakes.json \\
        --review-output ../runs/{run}/step05_ai_retake/ai_review.json \\
        [--provider auto]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Callable, Optional

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from shared.llm_client import (  # noqa: E402
    ProviderArg,
    ProviderName,
    call_llm,
    call_llm_json,
    resolve_provider_and_key,
)

REPO_ROOT = ROOT.parent

SENTENCES_PER_CHUNK = 100
CONTEXT_SENTENCES = 5


def load_stt(stt_path: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, dict[str, Any]]]:
    data = json.loads(stt_path.read_text(encoding="utf-8"))
    words = data.get("words") or []
    sentences = data.get("sentences") or []
    sentence_map = {str(s.get("id", "")): s for s in sentences if s.get("id")}
    return words, sentences, sentence_map


def build_word_to_sentence(sentence_map: dict[str, dict[str, Any]]) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for sid, sentence in sentence_map.items():
        for wid in sentence.get("word_ids") or []:
            mapping[str(wid)] = sid
    return mapping


def load_fillers(fillers_path: Path) -> list[dict[str, Any]]:
    if not fillers_path.exists():
        return []
    try:
        data = json.loads(fillers_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    fillers = data.get("fillers") or []
    return [f for f in fillers if isinstance(f, dict)]


def build_filler_candidates(
    fillers: list[dict[str, Any]],
    sentence_map: dict[str, dict[str, Any]],
    word_to_sentence: dict[str, str],
) -> list[dict[str, Any]]:
    """fillers.json の全候補(warn_only含む)をLLM向けpayloadに変換する。"""
    candidates: list[dict[str, Any]] = []
    for filler in fillers:
        word_ids = filler.get("word_ids")
        if isinstance(word_ids, list) and word_ids:
            primary_id = str(word_ids[0])
        else:
            primary_id = str(filler.get("word_id") or "")
        if not primary_id:
            continue
        sentence_id = word_to_sentence.get(primary_id, "")
        sentence = sentence_map.get(sentence_id)
        sentence_text = str(sentence.get("text", "")) if sentence else ""
        candidates.append({
            "word_id": primary_id,
            "match_text": str(filler.get("match_text") or filler.get("text") or ""),
            "sentence_id": sentence_id,
            "sentence_text": sentence_text,
            "action": str(filler.get("action") or ""),
        })
    return candidates


def build_sentences_payload(sentences: list[dict[str, Any]]) -> list[dict[str, Any]]:
    payload = []
    for sentence in sentences:
        sid = str(sentence.get("id", ""))
        if not sid:
            continue
        word_ids = [str(wid) for wid in (sentence.get("word_ids") or [])]
        payload.append({
            "id": sid,
            "text": str(sentence.get("text", "")),
            "word_ids": word_ids,
        })
    return payload


def chunk_sentences(
    sentences: list[dict[str, Any]],
    chunk_size: int = SENTENCES_PER_CHUNK,
    context_size: int = CONTEXT_SENTENCES,
) -> list[tuple[list[dict[str, Any]], list[dict[str, Any]]]]:
    """文リストを (文脈参考, 判定対象) のチャンク列に分割する。"""
    chunks: list[tuple[list[dict[str, Any]], list[dict[str, Any]]]] = []
    for start in range(0, len(sentences), chunk_size):
        target = sentences[start : start + chunk_size]
        context_start = max(0, start - context_size)
        context = sentences[context_start:start] if start > 0 else []
        chunks.append((context, target))
    return chunks


def merge_llm_responses(responses: list[dict[str, Any]]) -> dict[str, Any]:
    """複数チャンクのLLM応答をマージする。"""
    merged: dict[str, Any] = {
        "retakes": [],
        "needs_review": [],
        "remove_filler_word_ids": [],
    }
    for response in responses:
        merged["retakes"].extend(response.get("retakes") or [])
        merged["needs_review"].extend(response.get("needs_review") or [])
        filler_ids = response.get("remove_filler_word_ids") or []
        if isinstance(filler_ids, list):
            merged["remove_filler_word_ids"].extend(str(fid) for fid in filler_ids if fid)
    return merged


def build_prompt(
    sentences_payload: list[dict[str, Any]],
    context_payload: Optional[list[dict[str, Any]]] = None,
    filler_candidates: Optional[list[dict[str, Any]]] = None,
) -> str:
    sentences_json = json.dumps(sentences_payload, ensure_ascii=False, indent=2)
    context_section = ""
    if context_payload:
        context_json = json.dumps(context_payload, ensure_ascii=False, indent=2)
        context_section = f"""
# 文脈参考（この部分は判定対象外。直前の会話の流れを把握するための参考情報）
{context_json}

"""
    filler_section = ""
    if filler_candidates:
        filler_json = json.dumps(filler_candidates, ensure_ascii=False, indent=2)
        filler_section = f"""
## フィラー除去
以下は step04 で検出したフィラー候補です（warn_only 含む全件）。
**基本方針: フィラー候補は基本的にすべて除去してください。**
残すのは、消すと会話が成立しない意味のある応答（質問への返事の「そうですね」「うん」等）だけです。
迷ったら除去してください。

除去するフィラーは remove_filler_word_ids に word_id を列挙してください。

# フィラー候補 (word_id / match_text / sentence_text)
{filler_json}

"""
    return f"""あなたは日本語トーク動画の文字起こし校正者です。以下の文単位の文字起こし全文を読み、
言い直し検出と復元困難箇所の検出を行ってください。
{filler_section}
## 確信を持ってカットするもの（needs_review にしない）
以下は迷わず remove_sentence_ids に入れてカットしてください。

### 収録の進行に関する発話（動画の内容ではなく撮影自体についての会話）
- 「もう1回お願いします」「もう1回いきます」「編集で切ってください」「編集するんで」
- 「カメラ」「マイク」「録画」「完璧です」「いい感じですよ」
- 「大丈夫です」（撮り直し・収録調整の文脈）
- その他、収録スタッフとの進行会話

### やり直しテイク
同じ内容を言い直して撮り直している場合、**古い方のテイクと間の進行会話を丸ごと**カットする。
後のテイクで同じ自己紹介・同じフレーズを言い直しているなら、古いテイク＋「もう1回…」等の間の会話はすべてカット。

### 動画の締めの挨拶より後
収録終了後の雑談・スタッフ会話（「完璧です」「いいことですよ」等）はカット。

## 言い直し検出（上記以外）
- 文が完結せずに言い直している場合、**不完全な方の発話を丸ごとカット対象**にしてください。
- **意図的な繰り返し**(強調・あえて2回言っている等)は残してください。

## 復元困難検出（needs_review）
- needs_review は**発話内容として意味があるか本当に判断できない場合のみ**使ってください。
- 収録メタ会話・明白なやり直しは迷わずカットし、needs_review に回さないでください。
- 文字起こしが崩れていて、文脈から正しい文を**確信を持って復元できない**区間だけ報告してください。
- 無理に推測して違う内容に直さないでください。

## 判定例（few-shot）
入力: 「はい、お願いします／私けいわというふうに／ちょっともう1回お願いしていいですか？／編集するんで／大丈夫です／はい、慣れないですよね／何を言っていいんだっけみたいな／もう1回いきます／はい、じゃあいきます」
→ これらすべて remove_sentence_ids（後のテイクで同じ自己紹介をやり直しているため）

入力: 末尾の「はい、じゃあ完璧です／ありがとうございます（収録終了後）／いいことですよ」
→ すべて remove_sentence_ids（収録終了後の雑談）

対比例: 「とても大切です。大切なんです」→ 強調のための意図的な繰り返しなので**残す**

## 出力ルール
- remove_sentence_ids / needs_review.sentence_ids には、入力JSONの文 id のみを指定してください。
- remove_filler_word_ids には、フィラー候補の word_id のみを指定してください。
- 存在しない id は無視されます。
- 出力は次のJSON形式のみ。説明文やコードフェンスは不要です:
{{
  "retakes": [
    {{"reason": "言い直し: 前半が未完で後半に言い直し", "remove_sentence_ids": ["s-003"]}}
  ],
  "needs_review": [
    {{"sentence_ids": ["s-010"], "reason": "音声認識が崩れて文脈から復元できない"}}
  ],
  "remove_filler_word_ids": ["w-0039"]
}}
{context_section}
# 文単位の文字起こし (id / text / word_ids) — 判定対象
{sentences_json}
"""


def sentence_word_ids(sentence_map: dict[str, dict[str, Any]], sentence_id: str) -> list[str]:
    sentence = sentence_map.get(sentence_id)
    if not sentence:
        return []
    return [str(wid) for wid in (sentence.get("word_ids") or [])]


def resolve_word_span(
    word_ids: list[str],
    word_map: dict[str, dict[str, Any]],
) -> tuple[int, int, str]:
    if not word_ids:
        return 0, 0, ""
    starts = []
    ends = []
    texts = []
    for wid in word_ids:
        word = word_map.get(wid)
        if not word:
            continue
        starts.append(int(word.get("start_ms") or 0))
        ends.append(int(word.get("end_ms") or word.get("start_ms") or 0))
        texts.append(str(word.get("text") or ""))
    if not starts:
        return 0, 0, "".join(texts)
    return min(starts), max(ends), "".join(texts)


def apply_llm_response(
    response: dict[str, Any],
    sentences: list[dict[str, Any]],
    sentence_map: dict[str, dict[str, Any]],
    word_map: dict[str, dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], int, int]:
    """LLM応答を retakes.json 形式と ai_review.needs_review 形式に変換する。"""
    retake_entries: list[dict[str, Any]] = []
    needs_review_items: list[dict[str, Any]] = []

    raw_retakes = response.get("retakes") or []
    if isinstance(raw_retakes, list):
        for item in raw_retakes:
            if not isinstance(item, dict):
                continue
            reason = str(item.get("reason") or "言い直し")
            ids = item.get("remove_sentence_ids") or []
            if not isinstance(ids, list):
                continue
            valid_ids = [str(sid) for sid in ids if str(sid) in sentence_map]
            if not valid_ids:
                continue
            word_ids: list[str] = []
            for sid in valid_ids:
                word_ids.extend(sentence_word_ids(sentence_map, sid))
            if word_ids:
                retake_entries.append({
                    "keep": "retry",
                    "original_sentence_ids": word_ids,
                    "retry_sentence_ids": [],
                    "reason": reason,
                })

    raw_filler_ids = response.get("remove_filler_word_ids") or []
    fillers_removed = 0
    if isinstance(raw_filler_ids, list):
        valid_filler_ids = [str(fid) for fid in raw_filler_ids if str(fid) in word_map]
        if valid_filler_ids:
            retake_entries.append({
                "keep": "retry",
                "original_sentence_ids": valid_filler_ids,
                "retry_sentence_ids": [],
                "reason": "フィラー除去(AI判定)",
            })
            fillers_removed = len(valid_filler_ids)

    raw_needs = response.get("needs_review") or []
    if isinstance(raw_needs, list):
        for item in raw_needs:
            if not isinstance(item, dict):
                continue
            reason = str(item.get("reason") or "要確認")
            ids = item.get("sentence_ids") or []
            if not isinstance(ids, list):
                continue
            for sid in ids:
                sid_str = str(sid)
                if sid_str not in sentence_map:
                    continue
                word_ids = sentence_word_ids(sentence_map, sid_str)
                start_ms, end_ms, text = resolve_word_span(word_ids, word_map)
                needs_review_items.append({
                    "word_ids": word_ids,
                    "start_ms": start_ms,
                    "end_ms": end_ms,
                    "text": text,
                    "reason": reason,
                })

    retakes_applied = len([e for e in retake_entries if e.get("reason") != "フィラー除去(AI判定)"])
    return retake_entries, needs_review_items, retakes_applied, fillers_removed


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def run_step(
    run_dir: str,
    stt_path: str,
    fillers_path: str,
    retakes_output: str,
    review_output: str,
    provider: ProviderArg = "auto",
    api_key: Optional[str] = None,
    call_llm_fn: Optional[Callable[[ProviderName, str, str, str], dict[str, Any]]] = None,
) -> dict[str, Any]:
    """AI retake ステップ本体。キーなし/エラー時は安全にスキップする。"""
    print("[Step 5 AI] Retake detection (LLM)")
    caller = call_llm_fn or call_llm
    stt_file = Path(stt_path)
    fillers_file = Path(fillers_path)
    retakes_file = Path(retakes_output)
    review_file = Path(review_output)

    if not stt_file.exists():
        print(f"  skip: STT not found ({stt_file})")
        _write_json(retakes_file, {"retakes": []})
        _write_json(review_file, {"enabled": False, "reason": "stt not found"})
        return {"enabled": False, "reason": "stt not found"}

    words, sentences, sentence_map = load_stt(stt_file)
    word_map = {str(w.get("id", "")): w for w in words if w.get("id")}
    word_to_sentence = build_word_to_sentence(sentence_map)
    filler_candidates = build_filler_candidates(
        load_fillers(fillers_file), sentence_map, word_to_sentence,
    )

    resolved_provider: Optional[ProviderName]
    resolved_key: str
    resolved_model: str

    if api_key is not None:
        if api_key.strip():
            resolved_provider = provider if provider != "auto" else "anthropic"
            if resolved_provider == "auto":
                resolved_provider = "anthropic"
            resolved_key = api_key.strip()
            resolved_model = "claude-sonnet-5"
        else:
            resolved_provider, resolved_key, resolved_model = None, "", ""
    else:
        resolved_provider, resolved_key, resolved_model = resolve_provider_and_key(provider, REPO_ROOT)

    if not resolved_provider or not resolved_key:
        print("  no AI provider key set - skipping AI retake detection")
        _write_json(retakes_file, {"retakes": []})
        _write_json(review_file, {"enabled": False, "reason": "no AI provider key set"})
        return {"enabled": False, "reason": "no AI provider key set"}

    print(f"  provider: {resolved_provider}, model: {resolved_model}")

    if not sentences:
        print("  skip: no sentences in STT")
        _write_json(retakes_file, {"retakes": []})
        _write_json(review_file, {"enabled": False, "reason": "no sentences", "provider": resolved_provider})
        return {"enabled": False, "reason": "no sentences"}

    chunks = chunk_sentences(sentences)
    print(f"  sentences: {len(sentences)}, chunks: {len(chunks)}")

    successful_responses: list[dict[str, Any]] = []
    failed_chunks = 0

    for chunk_index, (context, target) in enumerate(chunks):
        prompt = build_prompt(
            build_sentences_payload(target),
            context_payload=build_sentences_payload(context) if context else None,
            filler_candidates=filler_candidates if chunk_index == 0 else None,
        )
        try:
            response = call_llm_json(
                resolved_provider, resolved_key, resolved_model, prompt,
                caller=caller,
            )
            successful_responses.append(response)
            print(f"  chunk {chunk_index + 1}/{len(chunks)}: ok")
        except Exception as exc:  # noqa: BLE001
            failed_chunks += 1
            print(
                f"  chunk {chunk_index + 1}/{len(chunks)} failed "
                f"({type(exc).__name__}: {exc})"
            )

    if not successful_responses:
        print(f"  all {len(chunks)} chunks failed - skipping")
        _write_json(retakes_file, {"retakes": []})
        _write_json(review_file, {
            "enabled": False,
            "reason": f"api_error: all {len(chunks)} chunks failed",
            "provider": resolved_provider,
            "failed_chunks": failed_chunks,
        })
        return {"enabled": False, "reason": f"api_error: all {len(chunks)} chunks failed"}

    merged_response = merge_llm_responses(successful_responses)

    try:
        retake_entries, needs_review_items, retakes_applied, fillers_removed = apply_llm_response(
            merged_response, sentences, sentence_map, word_map,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"  failed to apply response ({type(exc).__name__}: {exc}) - skipping")
        _write_json(retakes_file, {"retakes": []})
        _write_json(review_file, {
            "enabled": False,
            "reason": f"apply_error: {exc}",
            "provider": resolved_provider,
            "failed_chunks": failed_chunks,
        })
        return {"enabled": False, "reason": f"apply_error: {exc}"}

    _write_json(retakes_file, {"retakes": retake_entries})
    review_payload: dict[str, Any] = {
        "enabled": True,
        "provider": resolved_provider,
        "model": resolved_model,
        "needs_review": needs_review_items,
        "retakes_applied": retakes_applied,
        "fillers_removed_by_ai": fillers_removed,
    }
    if failed_chunks > 0:
        review_payload["failed_chunks"] = failed_chunks
    _write_json(review_file, review_payload)

    print(
        f"  retakes: {retakes_applied}, fillers_removed: {fillers_removed}, "
        f"needs_review: {len(needs_review_items)}, failed_chunks: {failed_chunks}"
    )
    print(f"[Step 5 AI] Done: {review_file}")
    return review_payload


def main() -> None:
    parser = argparse.ArgumentParser(description="Step 5: AI Retake Detection")
    parser.add_argument("run_dir", help="runs/<run_name> へのパス")
    parser.add_argument("--stt", required=True, help="stt_corrected.json パス")
    parser.add_argument("--fillers", required=True, help="fillers.json パス")
    parser.add_argument("--retakes-output", required=True, help="retakes.json 出力先")
    parser.add_argument("--review-output", required=True, help="ai_review.json 出力先")
    parser.add_argument(
        "--provider",
        default="auto",
        choices=["auto", "anthropic", "openai", "gemini"],
        help="LLMプロバイダ",
    )
    args = parser.parse_args()

    run_step(
        args.run_dir,
        args.stt,
        args.fillers,
        args.retakes_output,
        args.review_output,
        provider=args.provider,
    )


if __name__ == "__main__":
    main()
