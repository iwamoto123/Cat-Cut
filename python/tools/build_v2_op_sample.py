"""フェーズV2: OPダイジェスト(highlight_teaser+横スライドテロップ)の視覚検収用スチル生成。

shared/opening.py の実経路(telop_directivesスロット → select_highlight_clips →
text/style付与)で timeline.op を組み、既存runのセグメント実映像でレンダリングして
「テロップが横スライドで出ている瞬間」を含む代表フレームを1枚
(templates/samples/out/v2_op_digest.png)に並べる。

使い方(build_u7_u8_samples.py と同じ2段階。レンダリングはremotion側=サンドボックス外):
    1. composition生成:
       .venv/bin/python python/tools/build_v2_op_sample.py
    2. レンダリング:
       cd remotion && npx tsx scripts/render-cli.ts \
         --composition ../templates/samples/v2_op_digest_composition.json \
         --output ../templates/samples/out/v2_op_digest.mp4
    3. スチルPNG生成:
       .venv/bin/python python/tools/build_v2_op_sample.py --sheet
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

from shared.opening import build_op, load_op_patterns  # noqa: E402

EDITOR_ROOT = Path(__file__).resolve().parents[2]
SEGMENTS_DIR = EDITOR_ROOT / "runs" / "20260704_204052_videoplayback_7" / "step08_composition" / "segments"
SAMPLES_DIR = EDITOR_ROOT / "templates" / "samples"
OUT_DIR = SAMPLES_DIR / "out"

FPS = 30

# ハイライト元にするセグメント(絶対msは架空の10秒間隔。クリップ相対位置の検証には十分)
HIGHLIGHT_SPECS = [
    # (segment名, slot type, テロップ文言)。type既定マッピング: hype=special_purple /
    # punchline=box_yellow / surprise=box_yellow(スタイル解決の実経路を通す)
    ("cut_003", "hype", "ここが神回ポイント！"),
    ("cut_005", "punchline", "まさかのオチが…！？"),
    ("cut_007", "surprise", "衝撃の事実が発覚"),
]
CLIP_MS = 1600  # 各スロット尺(clip_max=2000ms未満なのでそのまま採用される)
U8_BODY_SEGMENTS = ["cut_009", "cut_011"]
U8_BODY_CUT_MS = 2000


def _segment(name: str) -> Path:
    path = SEGMENTS_DIR / f"{name}.mp4"
    if not path.exists():
        raise FileNotFoundError(f"segment not found: {path}")
    return path


def build_composition() -> tuple[dict, list[tuple[int, str]]]:
    """build_op の実経路でOPを組む(スロット→選定→text/style付与→highlight_cuts)。"""
    slots = []
    keep_segments = []
    cuts = []
    for i, (seg_name, slot_type, text) in enumerate(HIGHLIGHT_SPECS):
        seg_start = i * 10000
        keep_segments.append({"start_ms": seg_start, "end_ms": seg_start + 5000})
        slots.append({
            "type": slot_type,
            "source_start_ms": seg_start,
            "source_end_ms": seg_start + CLIP_MS,
            "text": text,
        })
        # セグメント抽出後のcut形(file_path=セグメントMP4・start_ms=0)
        cuts.append({
            "cut_id": f"cut_{i + 1:03d}",
            "video": {"file_path": str(_segment(seg_name)), "start_ms": 0, "end_ms": 5000},
            "timeline": {"start_ms": seg_start, "end_ms": seg_start + 5000},
        })

    op = build_op(
        {"pattern": "highlight_teaser", "title": "猫のいる暮らし", "catch_copy": "", "clips": None},
        load_op_patterns(),
        slots,
        keep_segments,
        cuts,
        "/videos/猫のいる暮らし.mp4",
    )
    assert op and op["pattern"] == "highlight_teaser", "highlight_teaser が組めていない"
    assert all(c.get("text") for c in op["highlight_cuts"]), "クリップにテロップ文言が無い"
    op_ms = int(op["duration_ms"])

    body_cuts = []
    offset = op_ms
    for i, seg_name in enumerate(U8_BODY_SEGMENTS):
        body_cuts.append({
            "cut_id": f"cut_{i + 1:03d}",
            "type": "body",
            "video": {"file_path": str(_segment(seg_name)), "start_ms": 0, "end_ms": U8_BODY_CUT_MS},
            "timeline": {"start_ms": offset, "end_ms": offset + U8_BODY_CUT_MS},
            "telop": {"pages": []},
            "layout": "talk",
            "scene_id": None,
        })
        offset += U8_BODY_CUT_MS

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
            "cuts": body_cuts,
            "op": op,
        },
        "voice_data": {"version": "1.0", "cuts": []},
        "meta": {
            "source_video": str(SEGMENTS_DIR),
            "original_duration_ms": offset,
            "edited_duration_ms": offset,
            "reduction_ratio": 0,
            "total_cuts": len(body_cuts),
            "display_width": 1280,
            "display_height": 720,
            "orientation": "horizontal",
            "rotation": 0,
            "project": {"name": "v2_op_digest"},
        },
    }
    embed_presets_into_composition(composition)

    # 代表フレーム: クリップ1のスライド入り中(0.25s)・定常(1.0s)・クリップ2のスライド入り中
    # (クリップ境界+0.25s)・タイトル被せ(尺-0.7s)・本編開始(オフセット検証)
    clip1_end_ms = int(op["highlight_cuts"][0]["end_ms"] - op["highlight_cuts"][0]["start_ms"])
    frames = [
        (250, "clip1 slide-in"),
        (1000, "clip1 telop"),
        (clip1_end_ms + 250, "clip2 slide-in"),
        (op_ms - 700, "title overlay"),
        (op_ms + 1000, "body start"),
    ]
    return composition, frames


def _extract_frame(video_path: Path, at_ms: int, out_path: Path) -> bool:
    result = subprocess.run(
        ["ffmpeg", "-y", "-ss", f"{at_ms / 1000.0:.3f}", "-i", str(video_path),
         "-frames:v", "1", "-q:v", "2", str(out_path)],
        capture_output=True, text=True,
    )
    return result.returncode == 0 and out_path.exists()


def build_sheet(video_path: Path, frames: list[tuple[int, str]]) -> Path:
    from PIL import Image, ImageDraw

    label_font = _load_label_font(20)
    header_font = _load_label_font(26)
    tmp_dir = Path(tempfile.mkdtemp(prefix="v2_op_"))
    try:
        cells = []
        for j, (at_ms, phase) in enumerate(frames):
            frame_path = tmp_dir / f"frame_{j}.png"
            if not _extract_frame(video_path, at_ms, frame_path):
                raise RuntimeError(f"frame extraction failed @{at_ms}ms")
            img = Image.open(frame_path).convert("RGB")
            # 5枚横並びで見やすい幅へ縮小
            scale = 640 / img.width
            img = img.resize((640, round(img.height * scale)))
            label_h = 34
            cell = Image.new("RGB", (img.width, img.height + label_h), (24, 24, 24))
            cell.paste(img, (0, 0))
            ImageDraw.Draw(cell).text(
                (12, img.height + 6), f"{phase}  @{at_ms / 1000:.2f}s", fill=(230, 230, 230), font=label_font,
            )
            cells.append(cell)

        header_h = 48
        # 2列グリッド(5枚: 3段目は1枚)
        cols = 2
        cell_w = max(c.width for c in cells)
        cell_h = max(c.height for c in cells)
        rows_n = (len(cells) + cols - 1) // cols
        sheet = Image.new("RGB", (cell_w * cols, header_h + cell_h * rows_n), (24, 24, 24))
        ImageDraw.Draw(sheet).text(
            (12, 10), "V2: OP digest (highlight_teaser + slide-in telop)", fill=(255, 255, 255), font=header_font,
        )
        for j, cell in enumerate(cells):
            sheet.paste(cell, ((j % cols) * cell_w, header_h + (j // cols) * cell_h))
        out_path = OUT_DIR / "v2_op_digest.png"
        sheet.save(out_path)
        return out_path
    finally:
        import shutil

        shutil.rmtree(tmp_dir, ignore_errors=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="V2 OP digest visual sample builder")
    parser.add_argument("--sheet", action="store_true", help="レンダリング済みMP4からスチルPNGを生成する")
    args = parser.parse_args()

    composition, frames = build_composition()

    if args.sheet:
        video_path = OUT_DIR / "v2_op_digest.mp4"
        if not video_path.exists():
            sys.exit(f"video not found: {video_path}(先にrender-cliでレンダリングする)")
        print(f"[v2op] {build_sheet(video_path, frames)}")
        return

    SAMPLES_DIR.mkdir(parents=True, exist_ok=True)
    out_path = SAMPLES_DIR / "v2_op_digest_composition.json"
    out_path.write_text(json.dumps(composition, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    total_s = composition["timeline"]["total_duration_ms"] / 1000
    print(f"[v2op] total {total_s:.1f}s (op {composition['timeline']['op']['duration_ms']}ms) -> {out_path}")


if __name__ == "__main__":
    main()
