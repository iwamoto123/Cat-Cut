"""Validate existing composition media even when step08 was skipped.

Repair only manifest-owned segment files, retaining composition/telop edits.
"""
import argparse
import json
import math
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from step08_composition import _encode_segment, _segment_cache_available


def has_decodable_video(path):
    if not _segment_cache_available(str(path)):
        return False
    try:
        result = subprocess.run([
            "ffmpeg", "-v", "error", "-i", str(path), "-map", "0:v:0",
            "-frames:v", "1", "-f", "framemd5", "-",
        ], capture_output=True, text=True, timeout=60)
        return result.returncode == 0 and any(
            line.strip() and not line.startswith("#")
            for line in result.stdout.splitlines()
        )
    except (OSError, subprocess.TimeoutExpired):
        return False


def validate_export_media(run_dir):
    app_root = Path(__file__).resolve().parents[2]
    for version_file in (app_root / "VERSION.txt", app_root / "distribution" / "VERSION"):
        if version_file.is_file():
            print(f"映像検査ビルド: {version_file.read_text().strip()[:120]}", flush=True)
            break
    run_dir = Path(run_dir).resolve()
    output = run_dir / "step08_composition"
    composition = json.loads((output / "composition.json").read_text())
    timeline = composition.get("timeline", {})
    refs = [cut.get("video", {}).get("file_path") for cut in timeline.get("cuts", [])]
    refs += [clip.get("file_path") for clip in (timeline.get("op") or {}).get("clips", [])]
    paths = list(dict.fromkeys(Path(ref).resolve() for ref in refs if ref))
    segments = (output / "segments").resolve()
    manifest_path = segments / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    repaired = 0
    for index, path in enumerate(paths, 1):
        if not has_decodable_video(path):
            entry = manifest.get(path.stem.removeprefix("seg_")) if path.parent == segments and path.name.startswith("seg_") else None
            if not isinstance(entry, dict):
                raise RuntimeError(f"映像を読み取れません。修復情報のない素材です: {path}")
            source = Path(entry["source"]).resolve()
            start = float(entry["start_ms"]) / 1000
            duration = (float(entry["end_ms"]) - float(entry["start_ms"])) / 1000
            if source == path or not source.is_file() or not math.isfinite(start) or not math.isfinite(duration) or start < 0 or duration <= 0:
                raise RuntimeError(f"中間動画の修復に必要な元素材・区間を確認してください: {source}")
            print(f"中間動画を修復: {path.name} ({start:.3f}s / {duration:.3f}s)", flush=True)
            error = _encode_segment(str(source), start, duration,
                                    ["-c:v", "libx264", "-crf", "16", "-preset", "fast"], str(path))
            if error is not None or not has_decodable_video(path):
                raise RuntimeError(f"中間動画を修復できませんでした: {path.name}\n{(error or '')[-1500:]}")
            repaired += 1
        print(f"映像検査: {index}/{len(paths)}", flush=True)
    print(f"映像検査完了: {len(paths)}ファイル、{repaired}ファイルを修復", flush=True)
    return repaired


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_dir")
    args = parser.parse_args()
    try:
        validate_export_media(args.run_dir)
    except Exception as error:
        print(f"書き出し前の映像検査に失敗: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
