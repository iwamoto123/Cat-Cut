"""Step 2: STT - word-level 文字起こし。

Usage:
    python step02_stt.py --audio ../runs/{run}/step01_preprocess/audio.wav --output ../runs/{run}/step02_stt
"""

import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))

DEFAULT_CHUNK_THRESHOLD_SECONDS = 900
DEFAULT_CHUNK_SECONDS = 600

# 括弧のみで構成されるイベントトークン（「(6秒停止)」「(laughs)」等）の
# 開き括弧 -> 閉じ括弧対応。ElevenLabs STT がノイズ/無音区間の説明を
# word として混入させることがあるため、正規化段階で除去する。
_EVENT_TOKEN_BRACKET_PAIRS = {
    "(": ")",
    "（": "）",
    "[": "]",
    "【": "】",
}


def _is_event_token(text: str) -> bool:
    """括弧だけで囲まれたイベントトークンかどうかを判定する。

    例: "(6秒停止)" "(laughs)" "【BGM】" -> True
        "た" "。" "(笑いながら)話す" -> False (括弧で始まり閉じ括弧で終わらない、
        または前後に本文が付随している)
    """
    stripped = text.strip()
    if len(stripped) < 2:
        return False
    opening = stripped[0]
    closing = _EVENT_TOKEN_BRACKET_PAIRS.get(opening)
    if closing is None or stripped[-1] != closing:
        return False
    inner = stripped[1:-1]
    if not inner:
        return False
    # 内側にさらに開き括弧がある場合は複数トークンの連結の可能性があるため
    # 誤除去を避けて対象外とする。
    if any(ch in _EVENT_TOKEN_BRACKET_PAIRS for ch in inner):
        return False
    return True


def _strip_event_tokens(result: dict) -> dict:
    """words/sentences からイベントトークン（括弧のみのword）を除去する。

    除去した時間帯は word が存在しなくなるため、以降の無音クラスタリングで
    自然に無音扱いになる。sentences 側は該当 word_id を除いて text/start_ms/
    end_ms を再計算する。
    """
    words = result.get("words", [])
    event_word_ids = {w["id"] for w in words if _is_event_token(w.get("text", ""))}
    if not event_word_ids:
        result["event_tokens_removed"] = 0
        return result

    filtered_words = [w for w in words if w["id"] not in event_word_ids]
    word_map = {w["id"]: w for w in filtered_words}
    result["words"] = filtered_words

    new_sentences = []
    for sent in result.get("sentences", []):
        word_ids = [wid for wid in sent.get("word_ids", []) if wid not in event_word_ids]
        sent_words = [word_map[wid] for wid in word_ids if wid in word_map]
        if not sent_words:
            # イベントトークンのみで構成されていた sentence は除去
            continue
        new_sent = dict(sent)
        new_sent["word_ids"] = word_ids
        new_sent["text"] = "".join(w["text"] for w in sent_words)
        new_sent["start_ms"] = sent_words[0]["start_ms"]
        new_sent["end_ms"] = sent_words[-1]["end_ms"]
        new_sentences.append(new_sent)
    result["sentences"] = new_sentences
    result["event_tokens_removed"] = len(event_word_ids)
    return result


def run_step(
    audio_path: str,
    output_dir: str,
    provider: str = "elevenlabs",
    language_code: str = "ja",
    whisper_model: str = "small",
    whisper_compute_type: str = "int8",
    chunk_threshold_seconds: int = DEFAULT_CHUNK_THRESHOLD_SECONDS,
    chunk_seconds: int = DEFAULT_CHUNK_SECONDS,
    force_chunked: bool = False,
) -> dict:
    """STT実行 + sentence構築。"""
    os.makedirs(output_dir, exist_ok=True)

    print(f"[Step 2] STT ({provider}): {audio_path}")

    if provider == "elevenlabs":
        from shared.stt_chunked import get_audio_duration_seconds, transcribe_audio_chunked
        from shared.stt_elevenlabs import transcribe_audio, stt_result_to_words

        duration_seconds = get_audio_duration_seconds(audio_path)
        use_chunked = force_chunked or duration_seconds > chunk_threshold_seconds
        print(f"  duration: {duration_seconds:.1f}s")

        if use_chunked:
            print(
                f"  using chunked STT "
                f"(threshold={chunk_threshold_seconds}s, chunk={chunk_seconds}s)"
            )
            result = transcribe_audio_chunked(
                audio_path,
                chunk_seconds=chunk_seconds,
                language_code=language_code,
            )
        else:
            raw_result = transcribe_audio(audio_path, language_code=language_code)
            words = stt_result_to_words(raw_result)
            sentences = _build_sentences(raw_result, words)
            result = {
                "provider": provider,
                "language_code": language_code,
                "model": raw_result.get("model", "scribe_v1"),
                "chunked": False,
                "words": words,
                "sentences": sentences,
                "raw_text": raw_result.get("text", ""),
            }
    elif provider == "local-whisper":
        from shared.stt_local_whisper import transcribe_audio, stt_result_to_words

        raw_result = transcribe_audio(
            audio_path,
            language_code=language_code,
            model_size=whisper_model,
            compute_type=whisper_compute_type,
        )
        words = stt_result_to_words(raw_result)
        sentences = _build_sentences(raw_result, words)
        result = {
            "provider": provider,
            "language_code": language_code,
            "model": whisper_model,
            "chunked": False,
            "words": words,
            "sentences": sentences,
            "raw_text": raw_result.get("text", ""),
        }
    else:
        raise ValueError(f"Unsupported STT provider: {provider}")

    result = _strip_event_tokens(result)

    print(f"  words: {len(result.get('words', []))}")
    print(f"  sentences: {len(result.get('sentences', []))}")
    if result.get("event_tokens_removed"):
        print(f"  event tokens removed: {result['event_tokens_removed']}")

    output_path = os.path.join(output_dir, "stt_result.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"[Step 2] Done: {output_path}")
    return result


def _build_sentences(raw_result: dict, words: list) -> list:
    """utterances、segments、または句読点からsentencesを構築。"""
    sentences = []

    # utterancesがある場合はそれを使用
    utterances = raw_result.get("utterances", [])
    if utterances:
        for i, utt in enumerate(utterances):
            utt_text = utt.get("text", "").strip()
            if not utt_text:
                continue

            # utterance内のwordsを特定
            utt_words = _find_words_in_range(
                words,
                int(utt.get("start", 0) * 1000),
                int(utt.get("end", 0) * 1000),
            )

            sentences.append({
                "id": f"sent_{i:04d}",
                "text": utt_text,
                "start_ms": utt_words[0]["start_ms"] if utt_words else 0,
                "end_ms": utt_words[-1]["end_ms"] if utt_words else 0,
                "word_ids": [w["id"] for w in utt_words],
            })
    elif raw_result.get("segments"):
        for i, seg in enumerate(raw_result.get("segments", [])):
            seg_text = seg.get("text", "").strip()
            if not seg_text:
                continue

            seg_words = _find_words_in_range(
                words,
                int(seg.get("start", 0) * 1000),
                int(seg.get("end", 0) * 1000),
            )

            sentences.append({
                "id": f"sent_{i:04d}",
                "text": seg_text,
                "start_ms": seg_words[0]["start_ms"] if seg_words else int(seg.get("start", 0) * 1000),
                "end_ms": seg_words[-1]["end_ms"] if seg_words else int(seg.get("end", 0) * 1000),
                "word_ids": [w["id"] for w in seg_words],
            })
    else:
        # フォールバック: 句読点で分割
        sentences = _split_by_punctuation(words)

    return sentences


def _find_words_in_range(words: list, start_ms: int, end_ms: int) -> list:
    """指定範囲内のwordsを抽出。"""
    return [w for w in words if w["end_ms"] > start_ms and w["start_ms"] < end_ms]


def _split_by_punctuation(words: list) -> list:
    """句読点でsentencesに分割 (フォールバック)。"""
    if not words:
        return []

    punct_pattern = re.compile(r"[。！？\.!\?]$")
    sentences = []
    current_words = []

    for w in words:
        current_words.append(w)

        if punct_pattern.search(w["text"]) or len(current_words) >= 30:
            text = "".join(cw["text"] for cw in current_words)
            sentences.append({
                "id": f"sent_{len(sentences):04d}",
                "text": text,
                "start_ms": current_words[0]["start_ms"],
                "end_ms": current_words[-1]["end_ms"],
                "word_ids": [cw["id"] for cw in current_words],
            })
            current_words = []

    # 残り
    if current_words:
        text = "".join(cw["text"] for cw in current_words)
        sentences.append({
            "id": f"sent_{len(sentences):04d}",
            "text": text,
            "start_ms": current_words[0]["start_ms"],
            "end_ms": current_words[-1]["end_ms"],
            "word_ids": [cw["id"] for cw in current_words],
        })

    return sentences


def main():
    parser = argparse.ArgumentParser(description="Step 2: STT")
    parser.add_argument("--audio", required=True, help="Input audio path (WAV)")
    parser.add_argument("--output", required=True, help="Output directory")
    parser.add_argument(
        "--provider",
        choices=["elevenlabs", "local-whisper"],
        default="elevenlabs",
        help="STT provider",
    )
    parser.add_argument("--language", default="ja", help="Language code")
    parser.add_argument(
        "--whisper-model",
        default="small",
        help="Local Whisper model size: tiny, base, small, medium, large-v3, etc.",
    )
    parser.add_argument(
        "--whisper-compute-type",
        default="int8",
        help="faster-whisper compute type, e.g. int8 or float32",
    )
    parser.add_argument(
        "--chunk-threshold-seconds",
        type=int,
        default=DEFAULT_CHUNK_THRESHOLD_SECONDS,
        help="ElevenLabs STT switches to chunked mode above this duration",
    )
    parser.add_argument(
        "--chunk-seconds",
        type=int,
        default=DEFAULT_CHUNK_SECONDS,
        help="Chunk length in seconds for long-form ElevenLabs STT",
    )
    parser.add_argument(
        "--force-chunked",
        action="store_true",
        help="Always use chunked ElevenLabs STT",
    )
    args = parser.parse_args()

    run_step(
        args.audio,
        args.output,
        provider=args.provider,
        language_code=args.language,
        whisper_model=args.whisper_model,
        whisper_compute_type=args.whisper_compute_type,
        chunk_threshold_seconds=args.chunk_threshold_seconds,
        chunk_seconds=args.chunk_seconds,
        force_chunked=args.force_chunked,
    )


if __name__ == "__main__":
    main()
