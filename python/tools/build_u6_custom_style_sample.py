"""フェーズU6: 第3縁(outer_stroke2)+光彩(glow)の視覚検収用サンプル生成。

詳細エディタで作れるカスタムスタイル(custom_* ID)を composition の telop_styles に
直接注入した3カットのcompositionを作り、レンダリング後にフレームを縦に並べた
検収PNG(templates/samples/out/u6_custom_style_sample.png)を作る。

使い方(build_genre_swatches.py と同じ2段階):
    1. composition生成:
       .venv/bin/python python/tools/build_u6_custom_style_sample.py
    2. レンダリング(remotionはサンドボックス外で実行が必要):
       cd remotion && npx tsx scripts/render-cli.ts \
         --composition ../templates/samples/u6_custom_style_composition.json \
         --output ../templates/samples/out/u6_custom_style_sample.mp4
    3. 検収PNG生成:
       .venv/bin/python python/tools/build_u6_custom_style_sample.py \
         --sheet --video templates/samples/out/u6_custom_style_sample.mp4
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from capture_telop_frames import _load_label_font

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

EDITOR_ROOT = Path(__file__).resolve().parents[2]
SEGMENTS_DIR = EDITOR_ROOT / "runs" / "20260704_204052_videoplayback_7" / "step08_composition" / "segments"
COMPOSITION_PATH = EDITOR_ROOT / "templates" / "samples" / "u6_custom_style_composition.json"
OUT_DIR = EDITOR_ROOT / "templates" / "samples" / "out"

CUT_DURATION_MS = 2000
FRAME_AT_MS = 1000

# 詳細エディタが生成するカスタムスタイル定義のサンプル3種
# (1) 第3縁のみ: 白→紺→白の三重縁「太枠」
# (2) 光彩のみ: ネオングロウ
# (3) 第3縁+光彩+ハードシャドウの全部載せ
CUSTOM_STYLES: dict[str, dict] = {
    "custom_scene_stroke3": {
        "font_family": '"GenEi Gothic N U-KL", "Zen Kaku Gothic Antique", sans-serif',
        "font_size": 84,
        "font_weight": 900,
        "letter_spacing": "0.02em",
        "line_height": 1.3,
        "fill": {"type": "gradient", "gradient_from": "#FFD93D", "gradient_to": "#FF6B35", "gradient_direction": "vertical"},
        "inner_stroke": {"color": "#FFFFFF", "width": 10},
        "outer_stroke": {"color": "#16305E", "width": 22},
        "outer_stroke2": {"color": "#FFFFFF", "width": 34},
        "drop_shadow": "drop-shadow(0px 5px 8px rgba(0,0,0,0.45))",
    },
    "custom_theme_x_glow": {
        "font_family": '"Dela Gothic One", "Zen Kaku Gothic Antique", sans-serif',
        "font_size": 80,
        "font_weight": 900,
        "letter_spacing": "0.04em",
        "line_height": 1.3,
        "fill": {"type": "solid", "color": "#FFFFFF"},
        "inner_stroke": {"color": "#00E5FF", "width": 8},
        "outer_stroke": {"color": "#003A47", "width": 18},
        "glow": {"color": "#00E5FF", "radius": 16},
    },
    "custom_scene_full": {
        "font_family": '"GenEi Kiwami Go", "Zen Kaku Gothic Antique", sans-serif',
        "font_size": 88,
        "font_weight": 900,
        "letter_spacing": "0.02em",
        "line_height": 1.3,
        "fill": {"type": "gradient", "gradient_from": "#FF9DE0", "gradient_to": "#D6188F", "gradient_direction": "vertical"},
        "inner_stroke": {"color": "#FFFFFF", "width": 10},
        "outer_stroke": {"color": "#5C0A3C", "width": 20},
        "outer_stroke2": {"color": "#FFF3B8", "width": 32},
        "glow": {"color": "#FF2ED2", "radius": 14},
        "shadow_offset": {"x": 6, "y": 6, "color": "#2A0018"},
    },
}

SAMPLES: list[tuple[str, list[str]]] = [
    ("custom_scene_stroke3", ["三重縁の太枠テロップ"]),
    ("custom_theme_x_glow", ["ネオングロウ光彩"]),
    ("custom_scene_full", ["第3縁+光彩+影 全部載せ"]),
]

SEGMENT_POOL = ["cut_002", "cut_004", "cut_006"]


def build_composition() -> dict:
    cuts = []
    voice_cuts = []
    offset_ms = 0
    for index, (style_id, lines) in enumerate(SAMPLES):
        segment_path = SEGMENTS_DIR / f"{SEGMENT_POOL[index % len(SEGMENT_POOL)]}.mp4"
        if not segment_path.exists():
            raise FileNotFoundError(f"segment not found: {segment_path}")
        cut_id = f"cut_{index + 1:03d}"
        cuts.append({
            "cut_id": cut_id,
            "type": "body",
            "video": {"file_path": str(segment_path), "start_ms": 0, "end_ms": CUT_DURATION_MS},
            "timeline": {"start_ms": offset_ms, "end_ms": offset_ms + CUT_DURATION_MS},
            "telop": {"pages": [{"id": f"{cut_id}_p00", "lines": lines}]},
            "layout": "talk",
            "scene_id": None,
            "swatch": {"style": style_id},
        })
        voice_cuts.append({
            "id": cut_id,
            "narration": "".join(lines),
            "voice": {"duration_ms": CUT_DURATION_MS, "words": []},
            "telops": [{
                "id": f"{cut_id}_p00",
                "text": "".join(lines),
                "word_indices": [],
                "segments": [{"text": line, "word_indices": []} for line in lines],
                "start": 0.15,
                "end": 1.9,
                "style": style_id,
            }],
        })
        offset_ms += CUT_DURATION_MS

    composition = {
        "timeline": {
            "version": "1.0.0",
            "total_duration_ms": offset_ms,
            "video_fit": "cover",
            "fps": 30,
            "framing": {"scale": 1.0, "offset_y": 0},
            "telop_y": 0.72,
            "telop_font_size": 72,
            "telop_max_chars_per_line": 16,
            "animation_in": "none",
            "animation_out": "none",
            "overlays": [],
            # step08のU6注入と同じく、カスタム定義をtelop_stylesへ直接載せる
            "telop_styles": dict(CUSTOM_STYLES),
            "default_telop_style": "custom_scene_stroke3",
            "cuts": cuts,
        },
        "voice_data": {"version": "1.0", "cuts": voice_cuts},
        "meta": {
            "source_video": str(SEGMENTS_DIR),
            "original_duration_ms": offset_ms,
            "edited_duration_ms": offset_ms,
            "reduction_ratio": 0,
            "total_cuts": len(cuts),
            "display_width": 1280,
            "display_height": 720,
            "orientation": "horizontal",
            "rotation": 0,
            "project": {"name": "u6_custom_style_sample"},
        },
    }
    return composition


def build_sheet(video_path: Path) -> Path:
    from PIL import Image, ImageDraw

    composition = json.loads(COMPOSITION_PATH.read_text(encoding="utf-8"))
    cuts = composition["timeline"]["cuts"]
    label_font = _load_label_font(22)

    tmp_dir = Path(tempfile.mkdtemp(prefix="u6_sample_"))
    try:
        cells = []
        for cut in cuts:
            frame_path = tmp_dir / f"{cut['cut_id']}.png"
            at_ms = int(cut["timeline"]["start_ms"]) + FRAME_AT_MS
            result = subprocess.run(
                ["ffmpeg", "-y", "-ss", f"{at_ms / 1000.0:.3f}", "-i", str(video_path),
                 "-frames:v", "1", "-q:v", "2", str(frame_path)],
                capture_output=True, text=True,
            )
            if result.returncode != 0 or not frame_path.exists():
                raise RuntimeError(f"frame extraction failed: {cut['cut_id']} @{at_ms}ms")
            img = Image.open(frame_path).convert("RGB")
            label_h = 36
            cell = Image.new("RGB", (img.width, img.height + label_h), (24, 24, 24))
            cell.paste(img, (0, 0))
            draw = ImageDraw.Draw(cell)
            draw.text((12, img.height + 7), cut["swatch"]["style"], fill=(230, 230, 230), font=label_font)
            cells.append(cell)

        width = max(cell.width for cell in cells)
        sheet = Image.new("RGB", (width, sum(cell.height for cell in cells)), (24, 24, 24))
        y = 0
        for cell in cells:
            sheet.paste(cell, (0, y))
            y += cell.height
        out_path = OUT_DIR / "u6_custom_style_sample.png"
        out_path.parent.mkdir(parents=True, exist_ok=True)
        sheet.save(out_path)
        return out_path
    finally:
        import shutil

        shutil.rmtree(tmp_dir, ignore_errors=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="U6 custom style sample builder")
    parser.add_argument("--sheet", action="store_true")
    parser.add_argument("--video", default=None)
    args = parser.parse_args()

    if args.sheet:
        if not args.video:
            sys.exit("--sheet には --video が必要")
        video_path = Path(args.video).resolve()
        if not video_path.exists():
            sys.exit(f"video not found: {video_path}")
        print(f"[u6_sample] {build_sheet(video_path)}")
        return

    composition = build_composition()
    COMPOSITION_PATH.parent.mkdir(parents=True, exist_ok=True)
    COMPOSITION_PATH.write_text(json.dumps(composition, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[u6_sample] output: {COMPOSITION_PATH}")


if __name__ == "__main__":
    main()
