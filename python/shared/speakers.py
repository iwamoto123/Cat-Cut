"""フェーズW1: 話者分離(diarization)の決定的ロジック。

ElevenLabs STT の diarize=true が返す word 単位の speaker_id を扱う純関数群。
LLM・APIを一切呼ばない(step02/step06c/step08 とテストの両方から使う)。

役割:
1. チャンク境界の話者リマップ: 長尺STT(stt_chunked)はチャンクごとに独立した
   リクエストを投げるため speaker_id が毎チャンク speaker_0 からリセットされる。
   境界連続性ヒューリスティックでグローバルな話者IDへ貪欲リマップする
2. dominant speaker 算出: sentence / スロットの単語列から発話時間が最大の話者を出す
3. 話者カラーの発動ガード: 動画全体で発話シェア10%以上の話者が2人未満なら
   話者カラーを発動しない(1人喋りで色が変わる事故防止)

後方互換: speaker を持たない word 列に対しては全関数が None / 空を返すため、
diarize 前の既存 run(stt_result.json)でも安全に通る。
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

# 話者カラーの発動に必要な最小発話シェア(動画全体に対する割合)
SPEAKER_SHARE_THRESHOLD = 0.10
# チャンク境界リマップ: 境界の話者判定に使う前後の単語数
BOUNDARY_WORDS = 3
# チャンク境界リマップ: この発話間ギャップ(秒)以下なら「発話の途中で
# チャンクが切れた」とみなし、境界の前後を同一話者と同定する。
# ffmpegのセグメント分割は発話の途中で切れることが大半のため、
# ギャップが小さい境界は同一話者の継続とみなせる。
BOUNDARY_MAX_GAP_SECONDS = 1.0


def _word_duration(word: Dict[str, Any], start_key: str, end_key: str) -> float:
    try:
        return max(0.0, float(word.get(end_key, 0)) - float(word.get(start_key, 0)))
    except (TypeError, ValueError):
        return 0.0


def _speaker_durations(
    words: List[Dict[str, Any]],
    *,
    speaker_key: str = "speaker",
    start_key: str = "start_ms",
    end_key: str = "end_ms",
) -> Dict[str, float]:
    """話者ごとの発話時間合計。speaker の無い word は無視する。"""
    durations: Dict[str, float] = {}
    for word in words:
        if not isinstance(word, dict):
            continue
        speaker = word.get(speaker_key)
        if not isinstance(speaker, str) or not speaker:
            continue
        durations[speaker] = durations.get(speaker, 0.0) + _word_duration(word, start_key, end_key)
    return durations


def _ranked_speakers(durations: Dict[str, float], first_seen: Dict[str, int]) -> List[str]:
    """発話時間の降順(同点は初出順)で話者を並べる(決定的な順序付け)。"""
    return sorted(durations, key=lambda s: (-durations[s], first_seen.get(s, 0)))


def dominant_speaker(
    words: List[Dict[str, Any]],
    *,
    speaker_key: str = "speaker",
    start_key: str = "start_ms",
    end_key: str = "end_ms",
) -> Optional[str]:
    """単語列の dominant speaker(発話時間が最大の話者)。

    speaker 付きの word が1つも無ければ None(=フィールドを書かない後方互換の合図)。
    同点は先に登場した話者を採用する(決定的)。
    """
    durations = _speaker_durations(words, speaker_key=speaker_key, start_key=start_key, end_key=end_key)
    if not durations:
        return None
    first_seen: Dict[str, int] = {}
    for index, word in enumerate(words):
        speaker = word.get(speaker_key) if isinstance(word, dict) else None
        if isinstance(speaker, str) and speaker and speaker not in first_seen:
            first_seen[speaker] = index
    return _ranked_speakers(durations, first_seen)[0]


def significant_speakers(
    words: List[Dict[str, Any]],
    *,
    threshold: float = SPEAKER_SHARE_THRESHOLD,
    speaker_key: str = "speaker",
    start_key: str = "start_ms",
    end_key: str = "end_ms",
) -> List[str]:
    """発話シェアが threshold 以上の話者(発話時間の降順)。

    シェアの分母は「speaker 付き word の発話時間合計」(speaker 無し word は含めない)。
    """
    durations = _speaker_durations(words, speaker_key=speaker_key, start_key=start_key, end_key=end_key)
    total = sum(durations.values())
    if total <= 0:
        return []
    first_seen: Dict[str, int] = {}
    for index, word in enumerate(words):
        speaker = word.get(speaker_key) if isinstance(word, dict) else None
        if isinstance(speaker, str) and speaker and speaker not in first_seen:
            first_seen[speaker] = index
    ranked = _ranked_speakers(durations, first_seen)
    return [s for s in ranked if durations[s] / total >= threshold]


def speaker_colors_applicable(
    words: List[Dict[str, Any]],
    *,
    threshold: float = SPEAKER_SHARE_THRESHOLD,
    speaker_key: str = "speaker",
    start_key: str = "start_ms",
    end_key: str = "end_ms",
) -> bool:
    """話者カラーの発動ガード: 発話シェア threshold 以上の話者が2人以上いるか。"""
    return (
        len(
            significant_speakers(
                words,
                threshold=threshold,
                speaker_key=speaker_key,
                start_key=start_key,
                end_key=end_key,
            )
        )
        >= 2
    )


# ---------------------------------------------------------------------------
# チャンク境界の話者リマップ (stt_chunked 用)
# ---------------------------------------------------------------------------

def _chunk_speaker_words(chunk_result: Dict[str, Any]) -> List[Dict[str, Any]]:
    """ElevenLabs生レスポンスから speaker_id 付きの発話 word だけ取り出す。"""
    return [
        w
        for w in chunk_result.get("words", [])
        if isinstance(w, dict)
        and w.get("type") == "word"
        and isinstance(w.get("speaker_id"), str)
        and w.get("speaker_id")
    ]


def remap_chunk_speaker_ids(
    chunk_results: List[Dict[str, Any]],
    chunk_offsets: List[float],
    *,
    boundary_words: int = BOUNDARY_WORDS,
    max_gap_seconds: float = BOUNDARY_MAX_GAP_SECONDS,
) -> List[Dict[str, Any]]:
    """チャンクごとにリセットされる speaker_id をグローバル話者IDへ貪欲リマップする。

    ヒューリスティック(チャンクを時系列に処理する):
    1. 境界連続性: 前チャンク末尾N語と現チャンク先頭N語の発話間ギャップが
       max_gap_seconds 以下なら、両者の dominant speaker を同一人物と同定する
       (固定長分割は発話の途中で切れることが大半のため)
    2. 残りの話者は発話時間ランクで対応付ける(現チャンク内の発話時間降順 ↔
       これまでの累積発話時間降順)。対応相手が尽きたら新しいグローバルIDを発行する

    入出力は ElevenLabs 生レスポンス形式(words[].speaker_id / start / end 秒)の
    チャンク配列。入力は変更せず、リマップ済みのディープでない新配列を返す(word は
    speaker_id を差し替えた新しい dict)。speaker_id が無いチャンクはそのまま通す。
    グローバルIDは speaker_0, speaker_1, ... を初出順に振り直す。
    """
    remapped: List[Dict[str, Any]] = []
    global_durations: Dict[str, float] = {}
    global_first_seen: Dict[str, int] = {}
    next_global_index = 0
    # 直前までの speaker 付き末尾単語(グローバルID・絶対秒)。境界同定に使う
    prev_tail: List[Dict[str, Any]] = []

    for chunk_index, (chunk, offset) in enumerate(zip(chunk_results, chunk_offsets)):
        speaker_words = _chunk_speaker_words(chunk)
        if not speaker_words:
            remapped.append(chunk)
            continue

        local_durations: Dict[str, float] = {}
        local_first_seen: Dict[str, int] = {}
        for index, word in enumerate(speaker_words):
            local_id = word["speaker_id"]
            local_durations[local_id] = local_durations.get(local_id, 0.0) + _word_duration(word, "start", "end")
            local_first_seen.setdefault(local_id, index)

        mapping: Dict[str, str] = {}
        used_globals: set = set()

        # 1. 境界連続性: 前チャンク末尾と現チャンク先頭のギャップが小さければ同一話者
        if prev_tail:
            try:
                gap = (float(speaker_words[0].get("start", 0)) + offset) - float(prev_tail[-1]["end_abs"])
            except (TypeError, ValueError):
                gap = float("inf")
            if gap <= max_gap_seconds:
                head = speaker_words[:boundary_words]
                head_speaker = dominant_speaker(
                    head, speaker_key="speaker_id", start_key="start", end_key="end",
                )
                tail_speaker = dominant_speaker(
                    prev_tail, speaker_key="speaker", start_key="start_abs", end_key="end_abs",
                )
                if head_speaker and tail_speaker:
                    mapping[head_speaker] = tail_speaker
                    used_globals.add(tail_speaker)

        # 2. 残りは発話時間ランクで対応付け(尽きたら新規グローバルIDを発行)
        remaining_locals = [
            lid for lid in _ranked_speakers(local_durations, local_first_seen) if lid not in mapping
        ]
        remaining_globals = [
            gid for gid in _ranked_speakers(global_durations, global_first_seen) if gid not in used_globals
        ]
        for local_id in remaining_locals:
            if remaining_globals:
                mapping[local_id] = remaining_globals.pop(0)
            else:
                mapping[local_id] = f"speaker_{next_global_index}"
                next_global_index += 1

        # 適用: speaker_id を持つ全エントリ(spacing等を含む)を差し替える
        new_words = []
        for word in chunk.get("words", []):
            local_id = word.get("speaker_id") if isinstance(word, dict) else None
            if isinstance(local_id, str) and local_id in mapping:
                new_words.append({**word, "speaker_id": mapping[local_id]})
            else:
                new_words.append(word)
        remapped.append({**chunk, "words": new_words})

        # 累積情報の更新
        for local_id, duration in local_durations.items():
            global_id = mapping[local_id]
            global_durations[global_id] = global_durations.get(global_id, 0.0) + duration
            global_first_seen.setdefault(global_id, chunk_index * 1_000_000 + local_first_seen[local_id])
        tail = speaker_words[-boundary_words:]
        prev_tail = [
            {
                "speaker": mapping[w["speaker_id"]],
                "start_abs": float(w.get("start", 0)) + offset,
                "end_abs": float(w.get("end", 0)) + offset,
            }
            for w in tail
        ]

    return remapped
