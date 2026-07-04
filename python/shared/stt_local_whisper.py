"""Local Whisper Speech-to-Text tool.

Uses faster-whisper so transcription can run locally without paid API usage.
"""

from typing import Any, Dict, List


def transcribe_audio(
    audio_path: str,
    language_code: str = "ja",
    model_size: str = "small",
    compute_type: str = "int8",
) -> Dict[str, Any]:
    """Run local Whisper with word-level timestamps."""
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise ImportError(
            "faster-whisper is required for --provider local-whisper. "
            "Install it with: .venv/bin/pip install faster-whisper"
        ) from exc

    print(f"[local-whisper] Transcribing: {audio_path}")
    print(
        f"[local-whisper] Model: {model_size}, Language: {language_code}, "
        f"compute_type: {compute_type}"
    )

    model = WhisperModel(model_size, device="cpu", compute_type=compute_type)
    segments_iter, info = model.transcribe(
        audio_path,
        language=language_code,
        beam_size=5,
        word_timestamps=True,
        vad_filter=False,
    )

    segments = []
    words = []
    full_text_parts = []

    for idx, segment in enumerate(segments_iter):
        segment_text = segment.text.strip()
        if segment_text:
            full_text_parts.append(segment_text)

        segment_words = []
        for word in segment.words or []:
            text = word.word.strip()
            if not text:
                continue
            item = {
                "type": "word",
                "text": text,
                "start": float(word.start),
                "end": float(word.end),
                "confidence": 0.0,
            }
            words.append(item)
            segment_words.append(item)

        segments.append({
            "id": f"seg_{idx:04d}",
            "text": segment_text,
            "start": float(segment.start),
            "end": float(segment.end),
            "words": segment_words,
        })

    text = "".join(full_text_parts) if language_code == "ja" else " ".join(full_text_parts)
    print(f"[local-whisper] Detected language: {info.language} ({info.language_probability:.2f})")
    print(f"[local-whisper] Transcription complete: {len(words)} words")
    print(f"[local-whisper] Text preview: {text[:100]}...")

    return {
        "provider": "local-whisper",
        "model": model_size,
        "language": info.language,
        "language_probability": info.language_probability,
        "text": text,
        "segments": segments,
        "words": words,
    }


def stt_result_to_words(stt_result: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Convert local Whisper output to the pipeline words[] format."""
    words = []

    for idx, w in enumerate(stt_result.get("words", [])):
        if w.get("type") != "word":
            continue

        words.append({
            "id": f"w-{idx:04d}",
            "text": w["text"],
            "start_ms": int(w["start"] * 1000),
            "end_ms": int(w["end"] * 1000),
            "confidence": round(w.get("confidence", 0.0), 3),
        })

    return words
