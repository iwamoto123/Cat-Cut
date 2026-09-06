"""ElevenLabs Speech-to-Text tool.

scribe_v1 モデルで word-level タイムスタンプ付き文字起こしを行う。
"""

import os
from typing import Any, Dict, List

import httpx

from shared.network import prefer_ipv4


ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text"


def transcribe_audio(
    audio_path: str,
    api_key: str = None,
    language_code: str = "ja",
    model_id: str = "scribe_v1",
) -> Dict[str, Any]:
    """ElevenLabs STT で word-level 文字起こしを実行。"""
    if not api_key:
        api_key = os.environ.get("ELEVEN_API_KEY", "")
    if not api_key:
        raise ValueError("ELEVEN_API_KEY is required")

    file_size = os.path.getsize(audio_path)
    print(f"[elevenlabs-stt] Transcribing: {audio_path} ({file_size / 1024 / 1024:.1f}MB)")
    print(f"[elevenlabs-stt] Model: {model_id}, Language: {language_code}")

    headers = {
        "xi-api-key": api_key,
        "Accept": "application/json",
    }

    with open(audio_path, "rb") as f:
        files = {"file": (os.path.basename(audio_path), f, "audio/mpeg")}
        data = {
            "model_id": model_id,
            "timestamps_granularity": "word",
            "language_code": language_code,
            # フェーズW1: 話者分離。word ごとに speaker_id("speaker_0"等)が付く
            "diarize": "true",
        }

        with prefer_ipv4():
            response = httpx.post(
                ELEVENLABS_STT_URL,
                headers=headers,
                files=files,
                data=data,
                timeout=600.0,
            )

    response.raise_for_status()
    result = response.json()

    word_count = len(result.get("words", []))
    print(f"[elevenlabs-stt] Transcription complete: {word_count} words")
    print(f"[elevenlabs-stt] Text preview: {result.get('text', '')[:100]}...")

    return result


def stt_result_to_words(stt_result: Dict[str, Any]) -> List[Dict[str, Any]]:
    """ElevenLabs STT 結果を words[] フォーマットに変換。"""
    words = []
    idx = 0

    for w in stt_result.get("words", []):
        if w.get("type") != "word":
            continue

        word = {
            "id": f"w-{idx:04d}",
            "text": w["text"],
            "start_ms": int(w["start"] * 1000),
            "end_ms": int(w["end"] * 1000),
            "confidence": round(w.get("confidence", 0.0), 3),
        }
        # フェーズW1: diarize時の話者ID。APIが返さない場合はフィールド自体を
        # 書かない(speaker無しの既存runと同形=完全後方互換)
        speaker_id = w.get("speaker_id")
        if isinstance(speaker_id, str) and speaker_id:
            word["speaker"] = speaker_id
        words.append(word)
        idx += 1

    return words
