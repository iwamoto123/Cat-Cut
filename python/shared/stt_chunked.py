"""Long-form audio STT via chunked ElevenLabs requests.

Splits audio into fixed-length chunks, transcribes each, and merges word-level
timestamps. Used automatically when source audio exceeds the chunk threshold.
"""

from __future__ import annotations

import json
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from shared.speakers import dominant_speaker, remap_chunk_speaker_ids
from shared.stt_elevenlabs import transcribe_audio


def get_audio_duration_seconds(audio_path: str) -> float:
    cmd = [
        "ffprobe",
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        str(audio_path),
    ]
    result = subprocess.run(cmd, check=True, capture_output=True, text=True)
    data = json.loads(result.stdout)
    return float(data["format"]["duration"])


def split_audio(audio_path: Path, tmp_dir: Path, chunk_seconds: int) -> list[Path]:
    pattern = tmp_dir / "chunk_%03d.mp3"
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(audio_path),
        "-f",
        "segment",
        "-segment_time",
        str(chunk_seconds),
        "-c:a",
        "libmp3lame",
        "-b:a",
        "128k",
        str(pattern),
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    return sorted(tmp_dir.glob("chunk_*.mp3"))


def chunk_duration_seconds(chunk_path: Path) -> float:
    cmd = [
        "ffprobe",
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        str(chunk_path),
    ]
    result = subprocess.run(cmd, check=True, capture_output=True, text=True)
    data = json.loads(result.stdout)
    return float(data["format"]["duration"])


def merge_chunk_results(chunk_results: list[dict[str, Any]], chunk_offsets: list[float]) -> dict[str, Any]:
    all_words: list[dict[str, Any]] = []
    all_utterances: list[dict[str, Any]] = []
    text_parts: list[str] = []

    for chunk_result, offset in zip(chunk_results, chunk_offsets):
        text_parts.append(chunk_result.get("text", ""))
        for word in chunk_result.get("words", []):
            shifted = dict(word)
            if "start" in shifted:
                shifted["start"] = shifted["start"] + offset
            if "end" in shifted:
                shifted["end"] = shifted["end"] + offset
            all_words.append(shifted)
        for utterance in chunk_result.get("utterances", []) or []:
            shifted = dict(utterance)
            if "start" in shifted:
                shifted["start"] = shifted["start"] + offset
            if "end" in shifted:
                shifted["end"] = shifted["end"] + offset
            all_utterances.append(shifted)

    return {
        "text": " ".join(text_parts),
        "words": all_words,
        "utterances": all_utterances,
    }


def raw_result_to_words(stt_result: dict[str, Any]) -> list[dict[str, Any]]:
    words: list[dict[str, Any]] = []
    idx = 0
    for word in stt_result.get("words", []):
        if word.get("type") != "word":
            continue
        entry = {
            "id": f"w-{idx:04d}",
            "text": word["text"],
            "start_ms": int(word["start"] * 1000),
            "end_ms": int(word["end"] * 1000),
            "confidence": round(word.get("confidence", 0.0), 3),
        }
        # フェーズW1: diarize時の話者ID(無ければフィールド自体を書かない=後方互換)
        speaker_id = word.get("speaker_id")
        if isinstance(speaker_id, str) and speaker_id:
            entry["speaker"] = speaker_id
        words.append(entry)
        idx += 1
    return words


def _sentence_entry(sentence_id: str, text: str, sentence_words: list[dict[str, Any]]) -> dict[str, Any]:
    """sentence 1件を組み立てる。フェーズW1: dominant speaker があれば付与する(任意フィールド)。"""
    entry = {
        "id": sentence_id,
        "text": text,
        "start_ms": sentence_words[0]["start_ms"] if sentence_words else 0,
        "end_ms": sentence_words[-1]["end_ms"] if sentence_words else 0,
        "word_ids": [w["id"] for w in sentence_words],
    }
    speaker = dominant_speaker(sentence_words)
    if speaker:
        entry["speaker"] = speaker
    return entry


def build_sentences_from_raw(stt_result: dict[str, Any], words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    sentences: list[dict[str, Any]] = []
    utterances = stt_result.get("utterances", [])

    if utterances:
        for index, utterance in enumerate(utterances):
            text = utterance.get("text", "").strip()
            if not text:
                continue
            start_ms = int(utterance.get("start", 0) * 1000)
            end_ms = int(utterance.get("end", 0) * 1000)
            utterance_words = [w for w in words if w["end_ms"] > start_ms and w["start_ms"] < end_ms]
            entry = _sentence_entry(f"sent_{index:04d}", text, utterance_words)
            if not utterance_words:
                entry["start_ms"] = start_ms
                entry["end_ms"] = end_ms
            sentences.append(entry)
        return sentences

    punct_pattern = re.compile(r"[。！？.!?]$")
    current: list[dict[str, Any]] = []
    for word in words:
        current.append(word)
        if punct_pattern.search(word["text"]) or len(current) >= 30:
            text = "".join(item["text"] for item in current)
            sentences.append(_sentence_entry(f"sent_{len(sentences):04d}", text, current))
            current = []

    if current:
        text = "".join(item["text"] for item in current)
        sentences.append(_sentence_entry(f"sent_{len(sentences):04d}", text, current))

    return sentences


def transcribe_audio_chunked(
    audio_path: str,
    *,
    chunk_seconds: int = 600,
    language_code: str = "ja",
) -> dict[str, Any]:
    audio = Path(audio_path).resolve()
    print(f"[stt_chunked] audio: {audio}")
    print(f"[stt_chunked] chunk_seconds: {chunk_seconds}")

    with tempfile.TemporaryDirectory(prefix="stt_chunks_") as tmp:
        tmp_dir = Path(tmp)
        chunks = split_audio(audio, tmp_dir, chunk_seconds)
        print(f"[stt_chunked] split into {len(chunks)} chunks")

        chunk_results: list[dict[str, Any]] = []
        chunk_offsets: list[float] = []
        running_offset = 0.0

        for index, chunk in enumerate(chunks):
            duration = chunk_duration_seconds(chunk)
            print(
                f"[stt_chunked] [{index + 1}/{len(chunks)}] "
                f"{chunk.name} ({duration:.1f}s, offset={running_offset:.1f}s)"
            )
            chunk_results.append(transcribe_audio(str(chunk), language_code=language_code))
            chunk_offsets.append(running_offset)
            running_offset += duration

        # フェーズW1: チャンクごとにリセットされる speaker_id をグローバルIDへリマップする
        # (speaker_id の無いレスポンスはそのまま素通し=後方互換)
        chunk_results = remap_chunk_speaker_ids(chunk_results, chunk_offsets)
        merged = merge_chunk_results(chunk_results, chunk_offsets)
        words = raw_result_to_words(merged)
        sentences = build_sentences_from_raw(merged, words)

        return {
            "provider": "elevenlabs",
            "language_code": language_code,
            "model": "scribe_v1",
            "chunked": True,
            "chunk_seconds": chunk_seconds,
            "chunk_count": len(chunks),
            "words": words,
            "sentences": sentences,
            "raw_text": merged.get("text", ""),
        }
