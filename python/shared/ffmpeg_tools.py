"""FFmpeg tools for video/audio processing."""

import json
import os
import re
import subprocess
from typing import List


def extract_audio(
    video_path: str,
    output_path: str,
    sample_rate: int = 16000,
    channels: int = 1,
) -> str:
    """動画から音声を抽出 (WAV 16kHz mono)。"""
    print(f"[ffmpeg] Extracting audio: {video_path} -> {output_path}")

    cmd = [
        "ffmpeg",
        "-i", video_path,
        "-vn",
        "-acodec", "pcm_s16le",
        "-ar", str(sample_rate),
        "-ac", str(channels),
        "-y",
        output_path,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)

    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg audio extraction failed: {result.stderr[-500:]}")

    size = os.path.getsize(output_path)
    print(f"[ffmpeg] Audio extracted: {size / 1024 / 1024:.1f}MB")

    return output_path


def detect_silence(
    audio_path: str,
    noise_threshold: str = "-30dB",
    min_duration: float = 0.5,
) -> List[dict]:
    """FFmpeg silencedetect で無音区間を検出。"""
    print(f"[ffmpeg] Detecting silence: threshold={noise_threshold}, min_duration={min_duration}s")

    cmd = [
        "ffmpeg",
        "-i", audio_path,
        "-af", f"silencedetect=noise={noise_threshold}:d={min_duration}",
        "-f", "null",
        "-",
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)

    output = result.stderr

    starts = re.findall(r"silence_start:\s*([\d.]+)", output)
    ends_durations = re.findall(
        r"silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)", output
    )

    pauses = []
    for i, (end, dur) in enumerate(ends_durations):
        start_s = float(starts[i]) if i < len(starts) else float(end) - float(dur)
        end_s = float(end)
        dur_s = float(dur)

        pauses.append({
            "start_ms": int(start_s * 1000),
            "end_ms": int(end_s * 1000),
            "duration_ms": int(dur_s * 1000),
            "type": "speech_pause" if dur_s < 3.0 else "silence",
        })

    print(f"[ffmpeg] Detected {len(pauses)} pauses")

    return pauses


def get_audio_duration_ms(audio_path: str) -> int:
    """音声ファイルの長さをミリ秒で取得。"""
    cmd = [
        "ffprobe",
        "-v", "quiet",
        "-show_entries", "format=duration",
        "-of", "json",
        audio_path,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {result.stderr}")

    data = json.loads(result.stdout)
    duration_s = float(data["format"]["duration"])

    return int(duration_s * 1000)


def get_video_metadata(video_path: str) -> dict:
    """動画のメタデータを取得。"""
    cmd = [
        "ffprobe",
        "-v", "quiet",
        "-show_format",
        "-show_streams",
        "-of", "json",
        video_path,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {result.stderr}")

    data = json.loads(result.stdout)

    # 基本情報を抽出
    fmt = data.get("format", {})
    video_stream = None
    audio_stream = None
    for s in data.get("streams", []):
        if s.get("codec_type") == "video" and not video_stream:
            video_stream = s
        elif s.get("codec_type") == "audio" and not audio_stream:
            audio_stream = s

    metadata = {
        "duration_s": float(fmt.get("duration", 0)),
        "duration_ms": int(float(fmt.get("duration", 0)) * 1000),
        "size_bytes": int(fmt.get("size", 0)),
        "format_name": fmt.get("format_name", ""),
    }

    if video_stream:
        # rotation 取得 (iPhone縦撮り等)
        rotation = 0
        for sd in video_stream.get("side_data_list", []):
            if "rotation" in sd:
                rotation = int(sd["rotation"])
                break

        raw_w = video_stream.get("width", 0)
        raw_h = video_stream.get("height", 0)

        # rotation ±90 なら表示上 width/height が入れ替わる
        if abs(rotation) == 90 or abs(rotation) == 270:
            display_w, display_h = raw_h, raw_w
        else:
            display_w, display_h = raw_w, raw_h

        metadata["video"] = {
            "codec": video_stream.get("codec_name", ""),
            "width": display_w,
            "height": display_h,
            "raw_width": raw_w,
            "raw_height": raw_h,
            "rotation": rotation,
            "fps": _parse_fps(video_stream.get("r_frame_rate", "30/1")),
        }

    if audio_stream:
        metadata["audio"] = {
            "codec": audio_stream.get("codec_name", ""),
            "sample_rate": int(audio_stream.get("sample_rate", 0)),
            "channels": audio_stream.get("channels", 0),
        }

    return metadata


def _parse_fps(fps_str: str) -> float:
    """FPS文字列をfloatに変換 (例: '30/1' -> 30.0)。"""
    if "/" in fps_str:
        parts = fps_str.split("/")
        return round(float(parts[0]) / float(parts[1]), 2)
    return float(fps_str)
