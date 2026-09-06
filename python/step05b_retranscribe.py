"""Step 5b: 弱い区間の再文字起こし (W19-B1)。

step05_ai_retake の ai_review.json が報告した「弱い区間」(needs_review / suggestion無しの
suspect_words) を audio.wav から切り出して再STTし、元テキストと差分がある区間だけを
1回のLLM呼び出しで裁定して、表示テキストへの置換候補(suggestion)として出力する。

本文の自動置換は行わない。suggestion は UI の要確認パネル(種別: retranscribe)に出す。

Usage:
    python step05b_retranscribe.py <run_dir> \\
        --review ../runs/{run}/step05_ai_retake/ai_review.json \\
        --stt ../runs/{run}/step02b_transcript_correct/stt_corrected.json \\
        --audio ../runs/{run}/step01_preprocess/audio.wav \\
        --output ../runs/{run}/step05b_retranscribe/retranscribe.json \\
        [--stt-provider elevenlabs] [--whisper-model small] [--provider auto]

出力 retranscribe.json:
    {enabled, usage, items: [{start_ms, end_ms, word_ids, old_text, new_text, suggestion, reason}]}

STTキー無し・LLMキー無し・各種失敗はすべて non-fatal (enabled: false を書いて正常終了)。
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable, Optional

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from shared.llm_client import (  # noqa: E402
    ProviderArg,
    ProviderName,
    call_llm,
    call_llm_json,
    classify_llm_error,
    find_env_key,
    get_usage_summary,
    print_usage_summary,
    reset_usage_tracking,
    resolve_provider_and_key,
    truncate_error_detail,
)

REPO_ROOT = ROOT.parent

# 弱区間の前後に付けるパディング(ms)。境界の単語切れを吸収する。
INTERVAL_PADDING_MS = 500
# 1区間の最長(ms)。これを超える区間は先頭から15秒にクランプする。
MAX_INTERVAL_DURATION_MS = 15_000
# 再STTする区間数の上限(開始時刻順に採用)。
MAX_INTERVALS = 20
# revised裁定の suggestion 長の上限(創作された長文を破棄する)。
MAX_SUGGESTION_CHARS = 300

VALID_VERDICTS = ("original", "retranscribed", "revised")

# 正規化比較で除去する文字: 空白全種 + Unicodeの句読点/記号類(和文・欧文)。
_NORMALIZE_STRIP_RE = re.compile(r"[\s\u3000。、．，,\.!！?？・…‥「」『』()（）\[\]【】\-‐–—ー~〜:：;；\"'’”]")


def normalize_for_compare(text: str) -> str:
    """空白・句読点を除去した比較用文字列を返す(新旧テキストの同一判定用)。"""
    return _NORMALIZE_STRIP_RE.sub("", str(text or ""))


def collect_weak_ranges(ai_review: dict[str, Any]) -> list[tuple[int, int]]:
    """ai_review.json から弱区間候補の時間範囲を集める。

    - needs_review[] は全件
    - suspect_words[] は suggestion 無しのもののみ(suggestion有りは既にワンクリック適用できる)
    """
    ranges: list[tuple[int, int]] = []

    def push(entry: Any) -> None:
        if not isinstance(entry, dict):
            return
        start_ms = entry.get("start_ms")
        end_ms = entry.get("end_ms")
        if not isinstance(start_ms, (int, float)) or not isinstance(end_ms, (int, float)):
            return
        start = int(start_ms)
        end = int(end_ms)
        if start < 0 or end < start:
            return
        ranges.append((start, end))

    for entry in ai_review.get("needs_review") or []:
        push(entry)
    for entry in ai_review.get("suspect_words") or []:
        if isinstance(entry, dict) and str(entry.get("suggestion") or ""):
            continue
        push(entry)
    return ranges


def merge_weak_intervals(
    ranges: list[tuple[int, int]],
    padding_ms: int = INTERVAL_PADDING_MS,
    max_duration_ms: int = MAX_INTERVAL_DURATION_MS,
    max_count: int = MAX_INTERVALS,
) -> list[dict[str, int]]:
    """弱区間候補を パディング → 重複マージ → 15秒クランプ → 件数上限 の順で整形する。"""
    if not ranges:
        return []
    padded = sorted(
        (max(0, start - padding_ms), end + padding_ms) for start, end in ranges
    )
    merged: list[list[int]] = []
    for start, end in padded:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    clamped = [
        {"start_ms": start, "end_ms": min(end, start + max_duration_ms)}
        for start, end in merged
    ]
    return clamped[:max_count]


def attach_interval_words(
    intervals: list[dict[str, int]],
    words: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """各区間に、区間と重なる words の id 群と連結テキスト(old_text)を付与する。

    words が1つも無い区間は比較対象が無いため捨てる。interval_id を採番する。
    """
    sorted_words = sorted(
        (w for w in words if w.get("id")),
        key=lambda w: int(w.get("start_ms") or 0),
    )
    results: list[dict[str, Any]] = []
    for interval in intervals:
        start = int(interval["start_ms"])
        end = int(interval["end_ms"])
        members = [
            w
            for w in sorted_words
            if int(w.get("start_ms") or 0) < end and int(w.get("end_ms") or w.get("start_ms") or 0) > start
        ]
        if not members:
            continue
        old_text = "".join(str(w.get("text") or "") for w in members)
        if not old_text.strip():
            continue
        results.append({
            "interval_id": f"iv-{len(results) + 1:03d}",
            "start_ms": start,
            "end_ms": end,
            "word_ids": [str(w["id"]) for w in members],
            "old_text": old_text,
        })
    return results


def build_interval_contexts(
    intervals: list[dict[str, Any]],
    sentences: list[dict[str, Any]],
) -> None:
    """各区間に前後の文(文脈)を付与する(LLM裁定の判断材料。無ければ空文字)。"""
    sorted_sentences = sorted(
        (s for s in sentences if str(s.get("text") or "").strip()),
        key=lambda s: int(s.get("start_ms") or 0),
    )
    for interval in intervals:
        start = int(interval["start_ms"])
        end = int(interval["end_ms"])
        before = ""
        after = ""
        for sentence in sorted_sentences:
            s_end = int(sentence.get("end_ms") or 0)
            s_start = int(sentence.get("start_ms") or 0)
            if s_end <= start:
                before = str(sentence.get("text") or "")
            elif s_start >= end and not after:
                after = str(sentence.get("text") or "")
                break
        interval["context_before"] = before
        interval["context_after"] = after


def extract_audio_interval(
    audio_path: Path,
    start_ms: int,
    end_ms: int,
    output_path: Path,
) -> None:
    """audio.wav から区間を wav で切り出す(ffmpeg -ss/-t)。"""
    duration_ms = max(1, end_ms - start_ms)
    cmd = [
        "ffmpeg",
        "-y",
        "-ss",
        f"{start_ms / 1000:.3f}",
        "-i",
        str(audio_path),
        "-t",
        f"{duration_ms / 1000:.3f}",
        "-c:a",
        "pcm_s16le",
        str(output_path),
    ]
    subprocess.run(cmd, check=True, capture_output=True)


def resolve_stt_transcriber(
    stt_provider: str,
    whisper_model: str,
    language_code: str = "ja",
) -> tuple[Optional[Callable[[str], str]], str]:
    """現在のSTTプロバイダ設定から「音声ファイル→テキスト」関数を解決する。

    キー無し・未知プロバイダは (None, 理由) を返す(呼び出し側で non-fatal スキップ)。
    """
    if stt_provider == "elevenlabs":
        api_key = find_env_key("ELEVEN_API_KEY", REPO_ROOT)
        if not api_key:
            return None, "no ELEVEN_API_KEY set"

        def transcribe_elevenlabs(chunk_path: str) -> str:
            from shared.stt_elevenlabs import transcribe_audio

            result = transcribe_audio(chunk_path, api_key=api_key, language_code=language_code)
            return str(result.get("text") or "")

        return transcribe_elevenlabs, ""

    if stt_provider == "local-whisper":

        def transcribe_whisper(chunk_path: str) -> str:
            from shared.stt_local_whisper import transcribe_audio

            result = transcribe_audio(
                chunk_path, language_code=language_code, model_size=whisper_model,
            )
            return str(result.get("text") or "")

        return transcribe_whisper, ""

    return None, f"unsupported stt provider: {stt_provider}"


def build_prompt(candidates: list[dict[str, Any]]) -> str:
    """差分のあった全区間をまとめて1回で裁定させるプロンプトを作る。"""
    payload = [
        {
            "interval_id": c["interval_id"],
            "original": c["old_text"],
            "retranscribed": c["new_text"],
            "context_before": c.get("context_before") or "",
            "context_after": c.get("context_after") or "",
        }
        for c in candidates
    ]
    payload_json = json.dumps(payload, ensure_ascii=False, indent=2)
    return f"""あなたは日本語トーク動画の文字起こし校正者です。音声認識の信頼度が低い区間を
別の音声認識で撮り直した(再文字起こしした)結果が以下にあります。
各区間について、元テキスト(original)と再文字起こし(retranscribed)のどちらが正しいか、
または両方誤りなら文脈上最も自然な訂正を判定してください。

## 判定ルール
- verdict は "original" / "retranscribed" / "revised" のいずれか
  - original: 元テキストのままで良い(再文字起こしの方が誤り)
  - retranscribed: 再文字起こしの方が正しい
  - revised: 両方に誤りがあり、文脈から確信を持って訂正できる(suggestion に訂正後の全文を書く)
- revised の suggestion は該当区間の**発話内容の全文**を書くこと(創作しない。確信が無ければ original)
- context_before / context_after は前後の文脈(判定対象外)
- reason に判定理由を日本語で簡潔に書くこと

## 出力ルール
出力は次のJSON形式のみ。説明文やコードフェンスは不要です:
{{
  "verdicts": [
    {{"interval_id": "iv-001", "verdict": "retranscribed", "suggestion": "", "reason": "元テキストは音の欠落で崩れており、再文字起こしが文脈と一致する"}}
  ]
}}

# 判定対象の区間 (interval_id / original / retranscribed / 前後文脈)
{payload_json}
"""


def sanitize_verdicts(
    response: dict[str, Any],
    candidates: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """LLM応答のverdictsを検証し、出力itemsへ変換する。

    - 実在しない interval_id(幻覚)・未知のverdict は捨てる
    - verdict=original は解決なし(itemにしない)
    - verdict=retranscribed は suggestion に再文字起こしテキストを使う(LLMのsuggestionは無視)
    - verdict=revised は suggestion 必須。空・old_textと同一・過長は捨てる
    - interval_id の重複は先勝ち
    """
    raw_items = response.get("verdicts")
    if not isinstance(raw_items, list):
        return []
    by_id = {c["interval_id"]: c for c in candidates}

    results: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        interval_id = str(item.get("interval_id") or "")
        candidate = by_id.get(interval_id)
        if candidate is None or interval_id in seen_ids:
            continue
        verdict = str(item.get("verdict") or "")
        if verdict not in VALID_VERDICTS:
            continue
        seen_ids.add(interval_id)
        if verdict == "original":
            continue
        if verdict == "retranscribed":
            suggestion = str(candidate["new_text"] or "").strip()
        else:
            suggestion = str(item.get("suggestion") or "").strip()
        if not suggestion or len(suggestion) > MAX_SUGGESTION_CHARS:
            continue
        if normalize_for_compare(suggestion) == normalize_for_compare(candidate["old_text"]):
            continue
        results.append({
            "start_ms": candidate["start_ms"],
            "end_ms": candidate["end_ms"],
            "word_ids": candidate["word_ids"],
            "old_text": candidate["old_text"],
            "new_text": candidate["new_text"],
            "suggestion": suggestion,
            "reason": str(item.get("reason") or "再文字起こしで差分"),
        })
    return results


def _attach_usage(payload: dict[str, Any]) -> dict[str, Any]:
    usage = get_usage_summary()
    if usage:
        payload["usage"] = usage
    return payload


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _skip(output_file: Path, reason: str) -> dict[str, Any]:
    print(f"  skip: {reason}")
    payload = _attach_usage({"enabled": False, "reason": reason, "items": []})
    _write_json(output_file, payload)
    return payload


def run_step(
    run_dir: str,
    review_path: str,
    stt_path: str,
    audio_path: str,
    output_path: str,
    stt_provider: str = "elevenlabs",
    whisper_model: str = "small",
    provider: ProviderArg = "auto",
    call_llm_fn: Optional[Callable[[ProviderName, str, str, str], dict[str, Any]]] = None,
    transcribe_fn: Optional[Callable[[str], str]] = None,
) -> dict[str, Any]:
    """再文字起こしステップ本体。キー無し・失敗はすべて non-fatal でスキップする。"""
    print("[Step 5b] Retranscribe weak intervals")
    reset_usage_tracking()
    caller = call_llm_fn or call_llm
    review_file = Path(review_path)
    stt_file = Path(stt_path)
    audio_file = Path(audio_path)
    output_file = Path(output_path)

    if not review_file.exists():
        return _skip(output_file, "ai_review not found")
    try:
        ai_review = json.loads(review_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return _skip(output_file, f"ai_review unreadable: {exc}")
    if not ai_review.get("enabled"):
        return _skip(output_file, "ai_review disabled")

    ranges = collect_weak_ranges(ai_review)
    intervals = merge_weak_intervals(ranges)
    if not intervals:
        return _skip(output_file, "no weak intervals")

    if not stt_file.exists():
        return _skip(output_file, "stt not found")
    try:
        stt = json.loads(stt_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return _skip(output_file, f"stt unreadable: {exc}")
    words = stt.get("words") or []
    sentences = stt.get("sentences") or []

    candidates = attach_interval_words(intervals, words)
    if not candidates:
        return _skip(output_file, "no words in weak intervals")
    build_interval_contexts(candidates, sentences)
    print(f"  weak intervals: {len(candidates)} (raw ranges: {len(ranges)})")

    if not audio_file.exists():
        return _skip(output_file, "audio not found")

    # LLMキーを先に解決する(裁定できないなら再STTのコストをかけない)。
    resolved_provider, resolved_key, resolved_model = resolve_provider_and_key(provider, REPO_ROOT)
    if not resolved_provider or not resolved_key:
        return _skip(output_file, "no AI provider key set")

    transcriber = transcribe_fn
    if transcriber is None:
        transcriber, stt_skip_reason = resolve_stt_transcriber(stt_provider, whisper_model)
        if transcriber is None:
            return _skip(output_file, stt_skip_reason)

    # 各区間を切り出して再STTする。区間単位の失敗はその区間だけ捨てる(non-fatal)。
    diff_candidates: list[dict[str, Any]] = []
    failed_intervals = 0
    with tempfile.TemporaryDirectory(prefix="retranscribe_") as tmp:
        tmp_dir = Path(tmp)
        for candidate in candidates:
            chunk_path = tmp_dir / f"{candidate['interval_id']}.wav"
            try:
                extract_audio_interval(
                    audio_file, candidate["start_ms"], candidate["end_ms"], chunk_path,
                )
                new_text = str(transcriber(str(chunk_path)) or "").strip()
            except Exception as exc:  # noqa: BLE001 - 区間単位でnon-fatal
                failed_intervals += 1
                print(
                    f"  {candidate['interval_id']} failed ({type(exc).__name__}: "
                    f"{truncate_error_detail(str(exc), 200)})"
                )
                continue
            candidate["new_text"] = new_text
            if not new_text:
                continue
            if normalize_for_compare(new_text) == normalize_for_compare(candidate["old_text"]):
                continue
            diff_candidates.append(candidate)

    if failed_intervals == len(candidates):
        return _skip(output_file, "all intervals failed to retranscribe")

    print(f"  intervals with diff: {len(diff_candidates)} / {len(candidates)}")
    if not diff_candidates:
        payload = _attach_usage({
            "enabled": True,
            "provider": resolved_provider,
            "intervals_checked": len(candidates),
            "items": [],
        })
        _write_json(output_file, payload)
        print(f"[Step 5b] Done (no diffs): {output_file}")
        return payload

    prompt = build_prompt(diff_candidates)
    try:
        response = call_llm_json(
            resolved_provider, resolved_key, resolved_model, prompt, caller=caller,
        )
    except Exception as exc:  # noqa: BLE001
        error_kind = classify_llm_error(exc)
        detail = truncate_error_detail(f"{type(exc).__name__}: {exc}")
        print(f"  LLM call failed [error_kind={error_kind}] ({detail})")
        payload = _attach_usage({
            "enabled": False,
            "reason": f"api_error: {detail}",
            "error_kind": error_kind,
            "provider": resolved_provider,
            "items": [],
        })
        _write_json(output_file, payload)
        print_usage_summary()
        return payload

    items = sanitize_verdicts(response, diff_candidates)
    payload = _attach_usage({
        "enabled": True,
        "provider": resolved_provider,
        "model": resolved_model,
        "intervals_checked": len(candidates),
        "items": items,
    })
    _write_json(output_file, payload)
    print(f"  items: {len(items)}")
    print_usage_summary()
    print(f"[Step 5b] Done: {output_file}")
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(description="Step 5b: Retranscribe weak intervals (W19-B1)")
    parser.add_argument("run_dir", help="runs/<run_name> へのパス")
    parser.add_argument("--review", required=True, help="ai_review.json パス")
    parser.add_argument("--stt", required=True, help="stt_corrected.json パス")
    parser.add_argument("--audio", required=True, help="audio.wav パス")
    parser.add_argument("--output", required=True, help="retranscribe.json 出力先")
    parser.add_argument(
        "--stt-provider",
        default="elevenlabs",
        choices=["elevenlabs", "local-whisper"],
        help="再STTに使うプロバイダ(解析時のSTT設定を流用)",
    )
    parser.add_argument("--whisper-model", default="small", help="local-whisper時のモデルサイズ")
    parser.add_argument(
        "--provider",
        default="auto",
        choices=["auto", "anthropic", "openai", "gemini"],
        help="裁定に使うLLMプロバイダ",
    )
    args = parser.parse_args()

    run_step(
        args.run_dir,
        args.review,
        args.stt,
        args.audio,
        args.output,
        stt_provider=args.stt_provider,
        whisper_model=args.whisper_model,
        provider=args.provider,
    )


if __name__ == "__main__":
    main()
