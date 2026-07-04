"""Step 1: Preprocess - 音声抽出 + メタデータ取得 + 縦横判定。

Usage:
    python step01_preprocess.py --video /path/to/video.mp4 --output ../runs/{run}/step01_preprocess
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from shared.ffmpeg_tools import extract_audio, get_video_metadata


def run_step(video_path: str, output_dir: str) -> dict:
    """動画から音声抽出 + メタデータ取得。"""
    os.makedirs(output_dir, exist_ok=True)

    print(f"[Step 1] Preprocess: {video_path}")

    # メタデータ取得
    metadata = get_video_metadata(video_path)
    metadata_path = os.path.join(output_dir, "metadata.json")
    with open(metadata_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, ensure_ascii=False, indent=2)
    print(f"  duration: {metadata['duration_s']:.1f}s")

    # 縦横判定 (rotation対応済み: display_w/display_h は回転後の値)
    video_info = metadata.get("video", {})
    display_w = video_info.get("width", 1080)
    display_h = video_info.get("height", 1920)
    is_landscape = display_w > display_h
    orientation = "horizontal" if is_landscape else "vertical"
    print(f"  resolution: {display_w}x{display_h} -> {orientation}")

    # 音声抽出
    audio_path = os.path.join(output_dir, "audio.wav")
    extract_audio(video_path, audio_path)

    result = {
        "audio_path": audio_path,
        "metadata": metadata,
        "video_path": os.path.abspath(video_path),
        "orientation": orientation,
        "display_width": display_w,
        "display_height": display_h,
    }

    output_path = os.path.join(output_dir, "preprocess.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"[Step 1] Done: {output_path}")
    return result


def main():
    parser = argparse.ArgumentParser(description="Step 1: Preprocess")
    parser.add_argument("--video", required=True, help="Input video path")
    parser.add_argument("--output", required=True, help="Output directory")
    args = parser.parse_args()

    run_step(args.video, args.output)


if __name__ == "__main__":
    main()
