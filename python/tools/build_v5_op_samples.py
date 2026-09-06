"""フェーズV5: OP(highlight_teaser)装飾4パターンの視覚検収用スチル生成。

flash_pop / cinema_bars / color_wipe / neon_frame をそれぞれ本編カット付きで
レンダリングし、各装飾の代表フレーム(転換演出・装飾+テロップ・終端タイトル・本編開始)を
横に並べた4段1枚(templates/samples/out/v5_op_decorations.png)を作る。

使い方(build_u7_u8_samples.py と同じ2段階):
    1. composition生成:
       .venv/bin/python python/tools/build_v5_op_samples.py
    2. レンダリング(4本):
       cd remotion && npx tsx scripts/render-cli.ts \
         --composition ../templates/samples/v5_op_flash_pop_composition.json \
         --output ../templates/samples/out/v5_op_flash_pop.mp4
       (cinema_bars / color_wipe / neon_frame も同様)
    3. スチルPNG生成:
       .venv/bin/python python/tools/build_v5_op_samples.py --sheet

動画素材は build_u7_u8_samples.py と同じ既存runのセグメントを使う(runは変更しない)。
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from _telop_presets import embed_presets_into_composition
from capture_telop_frames import _load_label_font

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

EDITOR_ROOT = Path(__file__).resolve().parents[2]
SEGMENTS_DIR = EDITOR_ROOT / "runs" / "20260704_204052_videoplayback_7" / "step08_composition" / "segments"
SAMPLES_DIR = EDITOR_ROOT / "templates" / "samples"
OUT_DIR = SAMPLES_DIR / "out"

FPS = 30

# 抜粋クリップ3本(各1.6秒)。テロップ文言で text_animation の見え方も同時に検収する
CLIP_SPECS = [
    ("cut_003", 0, 1600, "ここが神回！"),
    ("cut_005", 200, 1800, "衝撃の展開"),
    ("cut_007", 0, 1600, "まさかのオチ"),
]
BODY_SEGMENTS = ["cut_009", "cut_011"]
BODY_CUT_MS = 2000
OP_MS = sum(end - start for _, start, end, _ in CLIP_SPECS)  # 4800ms

# 装飾ごとの設定(text_animationはジャンル既定design_scenes.yamlに合わせる)
DECORATIONS: list[tuple[str, str, str]] = [
    ("flash_pop", "slide_left", "white flash + end title (default)"),
    ("cinema_bars", "slide_left", "letterbox + OPENING + clip no."),
    ("color_wipe", "stamp", "accent wipe + brand bar title"),
    ("neon_frame", "slide_up", "neon frame + zoom-in transition"),
]

# 代表フレーム(OP開始からのms):
#   転換演出(クリップ2先頭フレーム=白フラッシュのピーク) / 装飾+テロップ(クリップ2中盤)
#   / 終端タイトル(尺-0.7s) / 本編開始(+1s)
FRAME_SPECS: list[tuple[int, str]] = [
    (1600, "transition"),
    (2400, "decoration+telop"),
    (OP_MS - 700, "end title"),
    (OP_MS + 1000, "main start"),
]


def _segment(name: str) -> Path:
    path = SEGMENTS_DIR / f"{name}.mp4"
    if not path.exists():
        raise FileNotFoundError(f"segment not found: {path}")
    return path


def build_composition(decoration: str, text_animation: str) -> dict:
    """OP(装飾つきhighlight_teaser)+本編2カット。step08と同形(cutsはOP尺分オフセット済み)。"""
    clips = []
    for seg_name, start_ms, end_ms, text in CLIP_SPECS:
        clips.append({
            "file_path": str(_segment(seg_name)),
            "start_ms": start_ms,
            "end_ms": end_ms,
            "text": text,
            "style": "special_purple",
        })
    op = {
        "pattern": "highlight_teaser",
        "duration_ms": OP_MS,
        "title": "猫のいる暮らし",
        "catch_copy": "",
        "accent_color": "#D9482B",
        "sfx_hit": "don",
        "decoration": decoration,
        "text_animation": text_animation,
        "highlight_cuts": clips,
    }

    cuts = []
    offset = OP_MS
    for i, seg_name in enumerate(BODY_SEGMENTS):
        cuts.append({
            "cut_id": f"cut_{i + 1:03d}",
            "type": "body",
            "video": {"file_path": str(_segment(seg_name)), "start_ms": 0, "end_ms": BODY_CUT_MS},
            "timeline": {"start_ms": offset, "end_ms": offset + BODY_CUT_MS},
            "telop": {"pages": []},
            "layout": "talk",
            "scene_id": None,
        })
        offset += BODY_CUT_MS

    composition = {
        "timeline": {
            "version": "1.0.0",
            "total_duration_ms": offset,
            "video_fit": "cover",
            "fps": FPS,
            "framing": {"scale": 1.0, "offset_y": 0},
            "telop_y": 0.72,
            "telop_font_size": 72,
            "telop_max_chars_per_line": 16,
            "animation_in": "none",
            "animation_out": "none",
            "sfx_volume": 0.25,
            "overlays": [],
            "cuts": cuts,
            "op": op,
        },
        "voice_data": {"version": "1.0", "cuts": []},
        "meta": {
            "source_video": str(SEGMENTS_DIR),
            "original_duration_ms": offset,
            "edited_duration_ms": offset,
            "reduction_ratio": 0,
            "total_cuts": len(cuts),
            "display_width": 1280,
            "display_height": 720,
            "orientation": "horizontal",
            "rotation": 0,
            "project": {"name": f"v5_op_{decoration}"},
        },
    }
    embed_presets_into_composition(composition)
    return composition


def _extract_frame(video_path: Path, at_ms: int, out_path: Path) -> bool:
    result = subprocess.run(
        ["ffmpeg", "-y", "-ss", f"{at_ms / 1000.0:.3f}", "-i", str(video_path),
         "-frames:v", "1", "-q:v", "2", str(out_path)],
        capture_output=True, text=True,
    )
    return result.returncode == 0 and out_path.exists()


def _labeled_cell(frame_path: Path, label: str, label_font):
    from PIL import Image, ImageDraw

    img = Image.open(frame_path).convert("RGB")
    img.thumbnail((640, 360))
    label_h = 30
    cell = Image.new("RGB", (img.width, img.height + label_h), (24, 24, 24))
    cell.paste(img, (0, 0))
    ImageDraw.Draw(cell).text((10, img.height + 5), label, fill=(230, 230, 230), font=label_font)
    return cell


def build_sheet(videos: dict[str, Path]) -> Path:
    """装飾4段×代表4フレームのグリッド1枚。"""
    from PIL import Image, ImageDraw

    label_font = _load_label_font(18)
    header_font = _load_label_font(26)
    tmp_dir = Path(tempfile.mkdtemp(prefix="v5_op_"))
    try:
        rows = []
        for decoration, _anim, description in DECORATIONS:
            video_path = videos[decoration]
            cells = []
            for j, (at_ms, phase) in enumerate(FRAME_SPECS):
                frame_path = tmp_dir / f"{decoration}_{j}.png"
                if not _extract_frame(video_path, at_ms, frame_path):
                    raise RuntimeError(f"frame extraction failed: {decoration} @{at_ms}ms")
                cells.append(_labeled_cell(frame_path, f"{decoration}  [{phase} {at_ms / 1000:.1f}s]", label_font))
            row_w = sum(c.width for c in cells)
            row_h = max(c.height for c in cells) + 30
            row = Image.new("RGB", (row_w, row_h), (24, 24, 24))
            ImageDraw.Draw(row).text((10, 4), f"{decoration}: {description}", fill=(255, 214, 90), font=label_font)
            x = 0
            for cell in cells:
                row.paste(cell, (x, 30))
                x += cell.width
            rows.append(row)

        header_h = 46
        width = max(row.width for row in rows)
        sheet = Image.new("RGB", (width, header_h + sum(r.height for r in rows)), (24, 24, 24))
        ImageDraw.Draw(sheet).text(
            (12, 10), "V5: OP digest decorations (flash_pop / cinema_bars / color_wipe / neon_frame)",
            fill=(255, 255, 255), font=header_font,
        )
        y = header_h
        for row in rows:
            sheet.paste(row, (0, y))
            y += row.height
        out_path = OUT_DIR / "v5_op_decorations.png"
        sheet.save(out_path)
        return out_path
    finally:
        import shutil

        shutil.rmtree(tmp_dir, ignore_errors=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="V5 OP decoration visual sample builder")
    parser.add_argument("--sheet", action="store_true", help="レンダリング済みMP4からスチルPNGを生成する")
    args = parser.parse_args()

    if args.sheet:
        videos = {}
        for decoration, _anim, _desc in DECORATIONS:
            video_path = OUT_DIR / f"v5_op_{decoration}.mp4"
            if not video_path.exists():
                sys.exit(f"video not found: {video_path}(先にrender-cliでレンダリングする)")
            videos[decoration] = video_path
        print(f"[v5op] {build_sheet(videos)}")
        return

    SAMPLES_DIR.mkdir(parents=True, exist_ok=True)
    for decoration, text_animation, _desc in DECORATIONS:
        composition = build_composition(decoration, text_animation)
        out_path = SAMPLES_DIR / f"v5_op_{decoration}_composition.json"
        out_path.write_text(json.dumps(composition, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        total_s = composition["timeline"]["total_duration_ms"] / 1000
        print(f"[v5op] v5_op_{decoration}: total {total_s:.1f}s -> {out_path}")


if __name__ == "__main__":
    main()
