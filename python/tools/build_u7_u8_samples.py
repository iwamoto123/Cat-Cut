"""フェーズU7/U8: シーンタイトル5パターン+OP3パターンの視覚検収用スチル生成。

U7: chapter_titleの5パターン(box_accent/band_gradient/tag_ribbon/minimal_line/neon_plate)を
実映像上に1パターン=1カットで載せ、代表フレームを縦に並べた1枚
(templates/samples/out/u7_title_patterns.png)を作る。

U8: OP3パターン(title_card/highlight_teaser/question_hook)をそれぞれ本編カット付きで
レンダリングし、OP内の代表2フレーム+本編開始1フレームを横に並べた3段1枚
(templates/samples/out/u8_op_patterns.png)を作る。

使い方(build_genre_swatches.py と同じ2段階。レンダリングはremotion側=サンドボックス外):
    1. composition生成:
       .venv/bin/python python/tools/build_u7_u8_samples.py
    2. レンダリング(4本):
       cd remotion && npx tsx scripts/render-cli.ts \
         --composition ../templates/samples/u7_title_patterns_composition.json \
         --output ../templates/samples/out/u7_title_patterns.mp4
       (u8_op_title_card / u8_op_highlight_teaser / u8_op_question_hook も同様)
    3. スチルPNG生成:
       .venv/bin/python python/tools/build_u7_u8_samples.py --sheet

動画素材は build_genre_swatches.py と同じ既存runのセグメントを使う(runは変更しない)。
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

# --- U7: タイトルパターン(パターンID, 見本文言) ---
TITLE_PATTERNS = [
    ("box_accent", "第1章 今日のテーマ"),
    ("band_gradient", "第2章 衝撃の展開"),
    ("tag_ribbon", "第3章 注目ポイント"),
    ("minimal_line", "第4章 旅のはじまり"),
    ("neon_plate", "第5章 ラスボス戦"),
]
U7_CUT_MS = 2500

# --- U8: OPパターンと代表フレーム(OP開始からのms) ---
# title_card: タイトルstamp後(1.2s)とキャッチ表示後(2.6s)
# highlight_teaser: 1クリップ目(0.8s)とタイトル被せ(尺-0.7s)
# question_hook: 問いテキスト(1.2s)とタイトル(3.4s)
OP_SAMPLES: dict[str, dict] = {
    "title_card": {
        "op": {
            "pattern": "title_card",
            "duration_ms": 4000,
            "title": "猫のいる暮らし",
            "catch_copy": "知られざる夜の習性に迫る",
            "sfx_hit": "don",
            "sfx_transition": "hyu",
        },
        "frames_ms": [1200, 2600],
    },
    "highlight_teaser": {
        "op": {
            "pattern": "highlight_teaser",
            # duration_ms はクリップ合計(build_composition内で計算して上書きする)
            "title": "猫のいる暮らし",
            "catch_copy": "",
            "sfx_hit": "don",
            "highlight_clips_spec": [
                ("cut_003", 0, 1600),
                ("cut_005", 200, 1800),
                ("cut_007", 0, 1600),
            ],
        },
        "frames_ms": [800, None],  # None = 尺-700ms(タイトル被せ)を後で解決
    },
    "question_hook": {
        "op": {
            "pattern": "question_hook",
            "duration_ms": 5000,
            "title": "猫のいる暮らし",
            "catch_copy": "猫が集会を開く理由、知っていますか？",
            "sfx_hit": "don",
            "sfx_transition": "hyu",
        },
        "frames_ms": [1200, 3400],
    },
}
# OP後の本編カット(オフセットの検証も兼ねて2カット)
U8_BODY_SEGMENTS = ["cut_009", "cut_011"]
U8_BODY_CUT_MS = 2000


def _segment(name: str) -> Path:
    path = SEGMENTS_DIR / f"{name}.mp4"
    if not path.exists():
        raise FileNotFoundError(f"segment not found: {path}")
    return path


def _base_composition(cuts: list, overlays: list, total_ms: int, name: str, op: dict | None = None) -> dict:
    composition = {
        "timeline": {
            "version": "1.0.0",
            "total_duration_ms": total_ms,
            "video_fit": "cover",
            "fps": FPS,
            "framing": {"scale": 1.0, "offset_y": 0},
            "telop_y": 0.72,
            "telop_font_size": 72,
            "telop_max_chars_per_line": 16,
            "animation_in": "none",
            "animation_out": "none",
            "sfx_volume": 0.25,
            "overlays": overlays,
            "cuts": cuts,
        },
        "voice_data": {"version": "1.0", "cuts": []},
        "meta": {
            "source_video": str(SEGMENTS_DIR),
            "original_duration_ms": total_ms,
            "edited_duration_ms": total_ms,
            "reduction_ratio": 0,
            "total_cuts": len(cuts),
            "display_width": 1280,
            "display_height": 720,
            "orientation": "horizontal",
            "rotation": 0,
            "project": {"name": name},
        },
    }
    if op:
        composition["timeline"]["op"] = op
    embed_presets_into_composition(composition)
    return composition


def build_u7_composition() -> dict:
    """5カット、各カットに1パターンのchapter_titleを載せる。"""
    cuts = []
    overlays = []
    offset = 0
    pool = ["cut_002", "cut_004", "cut_006", "cut_008", "cut_010"]
    for i, (pattern, text) in enumerate(TITLE_PATTERNS):
        cut_id = f"cut_{i + 1:03d}"
        cuts.append({
            "cut_id": cut_id,
            "type": "body",
            "video": {"file_path": str(_segment(pool[i])), "start_ms": 0, "end_ms": U7_CUT_MS},
            "timeline": {"start_ms": offset, "end_ms": offset + U7_CUT_MS},
            "telop": {"pages": []},
            "layout": "talk",
            "scene_id": None,
        })
        item = {
            "id": f"title_{pattern}",
            "type": "chapter_title",
            "start_ms": offset,
            "end_ms": offset + U7_CUT_MS,
            "text": text,
            "position": "top_left",
        }
        # box_accent は style を書かない=後方互換のフォールバック経路も同時に検収する
        if pattern != "box_accent":
            item["style"] = pattern
        overlays.append(item)
        offset += U7_CUT_MS
    return _base_composition(cuts, overlays, offset, "u7_title_patterns")


def build_u8_composition(pattern: str) -> tuple[dict, list[int]]:
    """OP1パターン+本編2カット。step08と同形(cutsはOP尺分オフセット済み)にする。"""
    spec = OP_SAMPLES[pattern]
    op = {k: v for k, v in spec["op"].items() if k != "highlight_clips_spec"}

    if pattern == "highlight_teaser":
        clips = []
        for seg_name, start_ms, end_ms in spec["op"]["highlight_clips_spec"]:
            clips.append({
                "file_path": str(_segment(seg_name)),
                "start_ms": start_ms,
                "end_ms": end_ms,
            })
        op["highlight_cuts"] = clips
        op["duration_ms"] = sum(c["end_ms"] - c["start_ms"] for c in clips)

    op_ms = int(op["duration_ms"])
    cuts = []
    offset = op_ms
    for i, seg_name in enumerate(U8_BODY_SEGMENTS):
        cuts.append({
            "cut_id": f"cut_{i + 1:03d}",
            "type": "body",
            "video": {"file_path": str(_segment(seg_name)), "start_ms": 0, "end_ms": U8_BODY_CUT_MS},
            "timeline": {"start_ms": offset, "end_ms": offset + U8_BODY_CUT_MS},
            "telop": {"pages": []},
            "layout": "talk",
            "scene_id": None,
        })
        offset += U8_BODY_CUT_MS

    frames_ms = [ms if ms is not None else op_ms - 700 for ms in spec["frames_ms"]]
    # 本編開始1秒後のフレームも追加(オフセットの目視検証)
    frames_ms.append(op_ms + 1000)
    return _base_composition(cuts, [], offset, f"u8_op_{pattern}", op=op), frames_ms


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
    label_h = 34
    cell = Image.new("RGB", (img.width, img.height + label_h), (24, 24, 24))
    cell.paste(img, (0, 0))
    ImageDraw.Draw(cell).text((12, img.height + 6), label, fill=(230, 230, 230), font=label_font)
    return cell


def build_u7_sheet(video_path: Path) -> Path:
    """u7_title_patterns.mp4 から各パターン1フレームを抜き、縦5枚の1枚に。"""
    from PIL import Image, ImageDraw

    label_font = _load_label_font(20)
    header_font = _load_label_font(26)
    tmp_dir = Path(tempfile.mkdtemp(prefix="u7_titles_"))
    try:
        cells = []
        for i, (pattern, text) in enumerate(TITLE_PATTERNS):
            at_ms = i * U7_CUT_MS + U7_CUT_MS // 2
            frame_path = tmp_dir / f"{pattern}.png"
            if not _extract_frame(video_path, at_ms, frame_path):
                raise RuntimeError(f"frame extraction failed: {pattern} @{at_ms}ms")
            cells.append(_labeled_cell(frame_path, f"{pattern}  「{text}」", label_font))

        header_h = 48
        width = max(cell.width for cell in cells)
        sheet = Image.new("RGB", (width, header_h + sum(c.height for c in cells)), (24, 24, 24))
        ImageDraw.Draw(sheet).text(
            (12, 10), "U7: scene title patterns (chapter_title)", fill=(255, 255, 255), font=header_font
        )
        y = header_h
        for cell in cells:
            sheet.paste(cell, (0, y))
            y += cell.height
        out_path = OUT_DIR / "u7_title_patterns.png"
        sheet.save(out_path)
        return out_path
    finally:
        import shutil

        shutil.rmtree(tmp_dir, ignore_errors=True)


def build_u8_sheet(videos: dict[str, Path], frames_by_pattern: dict[str, list[int]]) -> Path:
    """OP3パターン×3フレーム(OP内2+本編開始1)の3段グリッド1枚。"""
    from PIL import Image, ImageDraw

    label_font = _load_label_font(20)
    header_font = _load_label_font(26)
    tmp_dir = Path(tempfile.mkdtemp(prefix="u8_op_"))
    try:
        rows = []
        for pattern in ("title_card", "highlight_teaser", "question_hook"):
            video_path = videos[pattern]
            cells = []
            for j, at_ms in enumerate(frames_by_pattern[pattern]):
                frame_path = tmp_dir / f"{pattern}_{j}.png"
                if not _extract_frame(video_path, at_ms, frame_path):
                    raise RuntimeError(f"frame extraction failed: {pattern} @{at_ms}ms")
                phase = "本編開始" if j == len(frames_by_pattern[pattern]) - 1 else f"OP {at_ms / 1000:.1f}s"
                cells.append(_labeled_cell(frame_path, f"{pattern}  [{phase}]", label_font))
            row_w = sum(c.width for c in cells)
            row_h = max(c.height for c in cells)
            row = Image.new("RGB", (row_w, row_h), (24, 24, 24))
            x = 0
            for cell in cells:
                row.paste(cell, (x, 0))
                x += cell.width
            rows.append(row)

        header_h = 48
        width = max(row.width for row in rows)
        sheet = Image.new("RGB", (width, header_h + sum(r.height for r in rows)), (24, 24, 24))
        ImageDraw.Draw(sheet).text(
            (12, 10), "U8: OP patterns (title_card / highlight_teaser / question_hook)",
            fill=(255, 255, 255), font=header_font,
        )
        y = header_h
        for row in rows:
            sheet.paste(row, (0, y))
            y += row.height
        out_path = OUT_DIR / "u8_op_patterns.png"
        sheet.save(out_path)
        return out_path
    finally:
        import shutil

        shutil.rmtree(tmp_dir, ignore_errors=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="U7/U8 visual sample builder")
    parser.add_argument("--sheet", action="store_true", help="レンダリング済みMP4からスチルPNGを生成する")
    args = parser.parse_args()

    # フレーム位置はcomposition定義から決まるため、sheetフェーズでも再計算する
    frames_by_pattern: dict[str, list[int]] = {}
    compositions: dict[str, dict] = {"u7_title_patterns": build_u7_composition()}
    for pattern in ("title_card", "highlight_teaser", "question_hook"):
        composition, frames_ms = build_u8_composition(pattern)
        compositions[f"u8_op_{pattern}"] = composition
        frames_by_pattern[pattern] = frames_ms

    if args.sheet:
        u7_video = OUT_DIR / "u7_title_patterns.mp4"
        if not u7_video.exists():
            sys.exit(f"video not found: {u7_video}(先にrender-cliでレンダリングする)")
        print(f"[u7u8] {build_u7_sheet(u7_video)}")
        videos = {}
        for pattern in ("title_card", "highlight_teaser", "question_hook"):
            video_path = OUT_DIR / f"u8_op_{pattern}.mp4"
            if not video_path.exists():
                sys.exit(f"video not found: {video_path}(先にrender-cliでレンダリングする)")
            videos[pattern] = video_path
        print(f"[u7u8] {build_u8_sheet(videos, frames_by_pattern)}")
        return

    SAMPLES_DIR.mkdir(parents=True, exist_ok=True)
    for name, composition in compositions.items():
        out_path = SAMPLES_DIR / f"{name}_composition.json"
        out_path.write_text(json.dumps(composition, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        total_s = composition["timeline"]["total_duration_ms"] / 1000
        print(f"[u7u8] {name}: total {total_s:.1f}s -> {out_path}")


if __name__ == "__main__":
    main()
