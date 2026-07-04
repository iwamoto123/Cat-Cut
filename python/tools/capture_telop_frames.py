"""改善8-A-6: テロップページのキャプチャハーネス。

composition.json の各テロップページ (voice_data.cuts[].telops[]) の中央時刻を、
書き出し済みMP4 (カット後のタイムライン) 上の対応時刻に変換して ffmpeg でフレーム
抽出し、ページ番号・テロップ本文をラベルにしたコンタクトシートPNGを書き出す。
AIによる目視QAの一次確認に使う。

タイムラインの対応関係 (重要):
    composition.json の voice_data.cuts[].telops[] は時刻を直接持たず、同cut内の
    voice.words への添字 (word_indices) だけを持つ。そのため対象wordのstart/end
    (カット内相対秒)から区間を逆算し、
    書き出し後MP4上の絶対時刻 = timeline.cuts[cut].timeline.start_ms + word区間*1000
    として求める (= 元動画の時刻ではなく、カット済み後の圧縮タイムライン上の時刻)。

Usage:
    .venv/bin/python python/tools/capture_telop_frames.py runs/<run_name> \\
        --video runs/<run_name>/output/final.mp4
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Optional

COLUMNS_DEFAULT = 4
THUMB_WIDTH_DEFAULT = 320
LABEL_HEIGHT = 56

# 日本語グリフを含むラベルが豆腐(tofu)にならないよう、macOS標準の日本語対応
# フォントを優先的に探す (PIL の ImageFont.load_default() は日本語非対応)。
_JP_FONT_CANDIDATES = [
    "/System/Library/Fonts/ヒラギノ角ゴシック W4.ttc",
    "/System/Library/Fonts/ヒラギノ丸ゴ ProN W4.ttc",
    "/System/Library/Fonts/ヒラギノ明朝 ProN.ttc",
    "/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/PingFang.ttc",
]


def _load_label_font(size: int = 14):
    from PIL import ImageFont

    for path in _JP_FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def _load_composition(run_dir: Path, composition_path: Optional[Path] = None) -> dict[str, Any]:
    comp_path = composition_path or (run_dir / "step08_composition" / "composition.json")
    if not comp_path.exists():
        raise FileNotFoundError(f"composition.json not found: {comp_path}")
    return json.loads(comp_path.read_text(encoding="utf-8"))


def _telop_word_span_ms(voice_words: list[dict[str, Any]], word_indices: list[int]) -> Optional[tuple[float, float]]:
    """word_indices (voice.words への添字) からページのカット内相対区間(秒->ms)を求める。"""
    starts = []
    ends = []
    for idx in word_indices:
        if not isinstance(idx, int) or idx < 0 or idx >= len(voice_words):
            continue
        w = voice_words[idx]
        if isinstance(w.get("start"), (int, float)):
            starts.append(float(w["start"]))
        if isinstance(w.get("end"), (int, float)):
            ends.append(float(w["end"]))
    if not starts or not ends:
        return None
    return min(starts) * 1000.0, max(ends) * 1000.0


def collect_pages(composition: dict[str, Any]) -> list[dict[str, Any]]:
    """各テロップページの (page_id, text, center_ms) を書き出し後タイムライン上で計算する。

    composition.json の voice_data.cuts[].telops[] は text と word_indices
    (同cutの voice.words への添字) を持つが、start/end (時刻) は直接持たない。
    そのため対象wordのstart/endから区間を逆算し、カットのtimeline.start_msを
    加算して書き出し後タイムライン上の絶対時刻に変換する。
    """
    cuts_by_id = {c.get("cut_id"): c for c in composition.get("timeline", {}).get("cuts", [])}
    pages: list[dict[str, Any]] = []

    for vcut in composition.get("voice_data", {}).get("cuts", []):
        cut_id = vcut.get("id")
        tl_cut = cuts_by_id.get(cut_id)
        if not tl_cut:
            continue
        cut_start_ms = int(tl_cut.get("timeline", {}).get("start_ms", 0))
        cut_end_ms = int(tl_cut.get("timeline", {}).get("end_ms", cut_start_ms))
        voice_words = vcut.get("voice", {}).get("words", [])

        for telop in vcut.get("telops", []):
            word_indices = telop.get("word_indices") or []
            span = _telop_word_span_ms(voice_words, word_indices)
            if span is None:
                continue
            rel_start_ms, rel_end_ms = span

            start_ms = cut_start_ms + int(round(rel_start_ms))
            end_ms = cut_start_ms + int(round(rel_end_ms))
            end_ms = max(end_ms, start_ms + 1)
            # カットの範囲内にクランプ (稀にテロップタイミングがカット境界をわずかに超える場合の保険)
            start_ms = max(cut_start_ms, min(start_ms, cut_end_ms))
            end_ms = max(cut_start_ms, min(end_ms, cut_end_ms))
            center_ms = (start_ms + end_ms) // 2

            text = telop.get("text") or "".join(
                seg.get("text", "") for seg in telop.get("segments", []) if isinstance(seg, dict)
            )
            pages.append({
                "page_id": telop.get("id") or f"{cut_id}_p??",
                "cut_id": cut_id,
                "text": text,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "center_ms": max(0, center_ms),
            })

    pages.sort(key=lambda p: p["center_ms"])
    return pages


def _extract_frame(video_path: Path, center_ms: int, out_path: Path) -> bool:
    seconds = max(0.0, center_ms / 1000.0)
    cmd = [
        "ffmpeg", "-y",
        "-ss", f"{seconds:.3f}",
        "-i", str(video_path),
        "-frames:v", "1",
        "-q:v", "2",
        str(out_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    return result.returncode == 0 and out_path.exists()


def _build_contact_sheet(
    thumbs: list[tuple[dict[str, Any], Optional[Path]]],
    columns: int = COLUMNS_DEFAULT,
    thumb_width: int = THUMB_WIDTH_DEFAULT,
):
    from PIL import Image, ImageDraw

    font = _load_label_font()

    cell_images = []
    for page, frame_path in thumbs:
        if frame_path is not None and frame_path.exists():
            img = Image.open(frame_path).convert("RGB")
            ratio = thumb_width / img.width
            img = img.resize((thumb_width, max(1, int(img.height * ratio))))
        else:
            img = Image.new("RGB", (thumb_width, int(thumb_width * 9 / 16)), (60, 60, 60))
            draw = ImageDraw.Draw(img)
            draw.text((8, 8), "capture failed", fill=(255, 80, 80), font=font)

        thumb_height = img.height
        cell = Image.new("RGB", (thumb_width, thumb_height + LABEL_HEIGHT), (255, 255, 255))
        cell.paste(img, (0, 0))
        draw = ImageDraw.Draw(cell)
        draw.text((4, thumb_height + 4), str(page.get("page_id", "")), fill=(0, 0, 0), font=font)
        label_text = (page.get("text") or "")[:24]
        draw.text((4, thumb_height + 26), label_text, fill=(30, 30, 30), font=font)
        cell_images.append(cell)

    if not cell_images:
        return Image.new("RGB", (thumb_width, thumb_width), (255, 255, 255))

    cell_w, cell_h = cell_images[0].size
    rows = (len(cell_images) + columns - 1) // columns
    sheet = Image.new("RGB", (cell_w * columns, cell_h * rows), (230, 230, 230))
    for idx, cell in enumerate(cell_images):
        r, c = divmod(idx, columns)
        sheet.paste(cell, (c * cell_w, r * cell_h))
    return sheet


def run_step(
    run_dir: Path,
    video_path: Path,
    output_path: Path,
    composition_path: Optional[Path] = None,
    columns: int = COLUMNS_DEFAULT,
    thumb_width: int = THUMB_WIDTH_DEFAULT,
) -> dict[str, Any]:
    composition = _load_composition(run_dir, composition_path)
    pages = collect_pages(composition)
    if not pages:
        raise ValueError("no telop pages found in composition.json (voice_data.cuts[].telops)")

    tmp_dir = Path(tempfile.mkdtemp(prefix="telop_capture_"))
    thumbs: list[tuple[dict[str, Any], Optional[Path]]] = []
    captured = 0
    try:
        for i, page in enumerate(pages):
            frame_path = tmp_dir / f"frame_{i:04d}.png"
            ok = _extract_frame(video_path, page["center_ms"], frame_path)
            thumbs.append((page, frame_path if ok else None))
            if ok:
                captured += 1

        sheet = _build_contact_sheet(thumbs, columns=columns, thumb_width=thumb_width)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        sheet.save(output_path)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    return {
        "pages": len(pages),
        "captured": captured,
        "failed": len(pages) - captured,
        "output": str(output_path),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Telop page capture -> contact sheet PNG (QA harness)")
    parser.add_argument("run_dir", help="runs/<run_name> へのパス")
    parser.add_argument("--video", default=None, help="書き出し済みMP4パス (省略時 run_dir/output/final.mp4)")
    parser.add_argument("--composition", default=None, help="composition.json のパス (省略時 自動検出)")
    parser.add_argument("--output", default=None, help="出力PNGパス (省略時 run_dir/qa/telop_contact_sheet.png)")
    parser.add_argument("--columns", type=int, default=COLUMNS_DEFAULT)
    parser.add_argument("--thumb-width", type=int, default=THUMB_WIDTH_DEFAULT)
    args = parser.parse_args()

    run_dir = Path(args.run_dir).resolve()
    video_path = Path(args.video).resolve() if args.video else run_dir / "output" / "final.mp4"
    composition_path = Path(args.composition).resolve() if args.composition else None
    output_path = Path(args.output).resolve() if args.output else run_dir / "qa" / "telop_contact_sheet.png"

    if not video_path.exists():
        sys.exit(f"video not found: {video_path}")

    result = run_step(
        run_dir, video_path, output_path,
        composition_path=composition_path, columns=args.columns, thumb_width=args.thumb_width,
    )
    print(f"[capture_telop_frames] pages: {result['pages']} (captured={result['captured']}, failed={result['failed']})")
    print(f"[capture_telop_frames] contact sheet: {result['output']}")


if __name__ == "__main__":
    main()
