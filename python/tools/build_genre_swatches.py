"""フェーズU5: ジャンル別プリセットの視覚検収用スウォッチ生成。

design_scenes.yaml の8ジャンルそれぞれについて、代表3系統(メイン/強調/見出し・特殊)の
プリセットを実映像上でレンダリングし、ジャンルごとに縦3枚を並べたスチルPNG
(templates/samples/out/genre_swatches_<genre>.png)を作る。

使い方(2段階。レンダリングはremotion側で行う):
    1. composition生成:
       .venv/bin/python python/tools/build_genre_swatches.py
    2. レンダリング(remotionはサンドボックス外で実行が必要):
       cd remotion && npx tsx scripts/render-cli.ts \
         --composition ../templates/samples/genre_swatches_composition.json \
         --output ../templates/samples/out/genre_swatches.mp4
    3. スウォッチPNG生成:
       .venv/bin/python python/tools/build_genre_swatches.py \
         --sheet --video templates/samples/out/genre_swatches.mp4

動画素材は build_direction_demo.py と同じ既存runのセグメントを使う(runは変更しない)。
背景の異なる実映像に載せることで、縁・座布団・グロウの可読性を目視確認できる。
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

from _telop_presets import embed_presets_into_composition
from capture_telop_frames import _load_label_font

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

EDITOR_ROOT = Path(__file__).resolve().parents[2]
SEGMENTS_DIR = EDITOR_ROOT / "runs" / "20260704_204052_videoplayback_7" / "step08_composition" / "segments"
SCENES_PATH = EDITOR_ROOT / "templates" / "design_scenes.yaml"
COMPOSITION_PATH = EDITOR_ROOT / "templates" / "samples" / "genre_swatches_composition.json"
OUT_DIR = EDITOR_ROOT / "templates" / "samples" / "out"

CUT_DURATION_MS = 2000
# フレーム抽出はカット中央(登場アニメ完了後)
FRAME_AT_MS = 1000

# ジャンルごとの代表3系統(semantic type, 見本テキスト)。
# 原則は default=メイン / emphasis=強調 / punchline=見出し・特殊 だが、
# ジャンルの特徴がその3typeに出ない場合は特徴的なtypeへ差し替える
# (dialogue=質問・返し、variety=手書きサプライズ、vlog=明朝引用)。
GENRE_SAMPLES: list[tuple[str, list[tuple[str, list[str]]]]] = [
    ("solo", [
        ("default", ["この方法で再生数が伸びた"]),
        ("emphasis", ["ここが一番大事!"]),
        ("punchline", ["結論:継続が9割"]),
    ]),
    ("business", [
        ("default", ["売上を3倍にした仕組み"]),
        ("emphasis", ["重要なのは利益率です"]),
        ("punchline", ["まとめ:数字で語る"]),
    ]),
    ("dialogue", [
        ("default", ["なるほど、面白いですね"]),
        ("question", ["それってどういうこと?"]),
        ("reply", ["たしかに!"]),
    ]),
    ("podcast", [
        ("default", ["先週の続きを話します"]),
        ("emphasis", ["ここだけの裏話です"]),
        ("punchline", ["要点はこの3つ"]),
    ]),
    ("vlog", [
        ("default", ["朝6時、旅のはじまり"]),
        ("emphasis", ["この景色に出会えた"]),
        ("quote", ["旅は道連れ世は情け"]),
    ]),
    ("variety", [
        ("default", ["まさかの結末に一同驚愕"]),
        ("emphasis", ["衝撃の事実が発覚!"]),
        ("surprise", ["ドッキリ大成功!!"]),
    ]),
    ("beauty", [
        ("default", ["毎日のスキンケア習慣"]),
        ("emphasis", ["うるおいが違う"]),
        ("punchline", ["ご褒美コスメ3選"]),
    ]),
    ("game", [
        ("default", ["ラスボス戦、開幕"]),
        ("emphasis", ["会心の一撃!!"]),
        ("punchline", ["GAME OVER"]),
    ]),
]

# 背景に使う実映像セグメント(3s以上あるもの。cut_001は2.53sのため除外)
SEGMENT_POOL = [f"cut_{i:03d}" for i in range(2, 18)]


def load_scene_type_styles() -> dict[str, dict[str, dict]]:
    parsed = yaml.safe_load(SCENES_PATH.read_text(encoding="utf-8"))
    return {scene["id"]: scene.get("type_styles", {}) for scene in parsed.get("scenes", [])}


def build_composition() -> dict:
    type_styles_by_genre = load_scene_type_styles()
    cuts = []
    voice_cuts = []
    offset_ms = 0
    cut_index = 0

    for genre_id, samples in GENRE_SAMPLES:
        type_styles = type_styles_by_genre.get(genre_id)
        if type_styles is None:
            raise KeyError(f"design_scenes.yaml に {genre_id} が無い")
        for semantic_type, lines in samples:
            entry = type_styles.get(semantic_type)
            if not isinstance(entry, dict) or not entry.get("style"):
                raise KeyError(f"{genre_id}.{semantic_type} の style が引けない")
            style = str(entry["style"])
            segment_name = SEGMENT_POOL[cut_index % len(SEGMENT_POOL)]
            segment_path = SEGMENTS_DIR / f"{segment_name}.mp4"
            if not segment_path.exists():
                raise FileNotFoundError(f"segment not found: {segment_path}")

            cut_id = f"cut_{cut_index + 1:03d}"
            cuts.append({
                "cut_id": cut_id,
                "type": "body",
                "video": {"file_path": str(segment_path), "start_ms": 0, "end_ms": CUT_DURATION_MS},
                "timeline": {"start_ms": offset_ms, "end_ms": offset_ms + CUT_DURATION_MS},
                "telop": {"pages": [{"id": f"{cut_id}_p00", "lines": lines}]},
                "layout": "talk",
                "scene_id": None,
                # スウォッチのメタ情報(remotionは読まない。sheet生成フェーズが使う)
                "swatch": {"genre": genre_id, "semantic_type": semantic_type, "style": style},
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
                    "style": style,
                    "type": semantic_type,
                }],
            })
            offset_ms += CUT_DURATION_MS
            cut_index += 1

    composition = {
        "timeline": {
            "version": "1.0.0",
            "total_duration_ms": offset_ms,
            "video_fit": "cover",
            "fps": 30,
            "framing": {"scale": 1.0, "offset_y": 0},
            # 素材セグメントには元動画の焼き込みテロップが下部(0.85付近)に残っているため、
            # スウォッチは少し上に置いて重なりを避ける(検収のしやすさ優先)
            "telop_y": 0.72,
            "telop_font_size": 72,
            "telop_max_chars_per_line": 16,
            "animation_in": "none",
            "animation_out": "none",
            "overlays": [],
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
            "project": {"name": "genre_swatches_u5"},
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


def build_sheets(video_path: Path) -> list[Path]:
    """レンダリング済みMP4からジャンルごとの縦3枚スウォッチPNGを作る。"""
    from PIL import Image, ImageDraw

    composition = json.loads(COMPOSITION_PATH.read_text(encoding="utf-8"))
    cuts = composition["timeline"]["cuts"]
    label_font = _load_label_font(20)
    header_font = _load_label_font(26)

    outputs: list[Path] = []
    tmp_dir = Path(tempfile.mkdtemp(prefix="genre_swatch_"))
    try:
        cuts_by_genre: dict[str, list[dict]] = {}
        for cut in cuts:
            genre = cut["swatch"]["genre"]
            cuts_by_genre.setdefault(genre, []).append(cut)

        for genre, genre_cuts in cuts_by_genre.items():
            cells = []
            for cut in genre_cuts:
                frame_path = tmp_dir / f"{genre}_{cut['cut_id']}.png"
                at_ms = int(cut["timeline"]["start_ms"]) + FRAME_AT_MS
                ok = _extract_frame(video_path, at_ms, frame_path)
                if not ok:
                    raise RuntimeError(f"frame extraction failed: {genre} {cut['cut_id']} @{at_ms}ms")
                img = Image.open(frame_path).convert("RGB")
                # ラベル帯: プリセット名とsemantic typeを載せて検収時に対応が分かるようにする
                label_h = 34
                cell = Image.new("RGB", (img.width, img.height + label_h), (24, 24, 24))
                cell.paste(img, (0, 0))
                draw = ImageDraw.Draw(cell)
                swatch = cut["swatch"]
                draw.text(
                    (12, img.height + 6),
                    f"{swatch['style']}  ({swatch['semantic_type']})",
                    fill=(230, 230, 230),
                    font=label_font,
                )
                cells.append(cell)

            header_h = 48
            width = max(cell.width for cell in cells)
            height = header_h + sum(cell.height for cell in cells)
            sheet = Image.new("RGB", (width, height), (24, 24, 24))
            draw = ImageDraw.Draw(sheet)
            draw.text((12, 10), f"genre: {genre}", fill=(255, 255, 255), font=header_font)
            y = header_h
            for cell in cells:
                sheet.paste(cell, (0, y))
                y += cell.height

            out_path = OUT_DIR / f"genre_swatches_{genre}.png"
            out_path.parent.mkdir(parents=True, exist_ok=True)
            sheet.save(out_path)
            outputs.append(out_path)
    finally:
        import shutil

        shutil.rmtree(tmp_dir, ignore_errors=True)
    return outputs


def main() -> None:
    parser = argparse.ArgumentParser(description="U5 genre swatch composition/sheet builder")
    parser.add_argument("--sheet", action="store_true", help="レンダリング済みMP4からスウォッチPNGを生成する")
    parser.add_argument("--video", default=None, help="--sheet時のレンダリング済みMP4パス")
    args = parser.parse_args()

    if args.sheet:
        if not args.video:
            sys.exit("--sheet には --video が必要")
        video_path = Path(args.video).resolve()
        if not video_path.exists():
            sys.exit(f"video not found: {video_path}")
        outputs = build_sheets(video_path)
        for path in outputs:
            print(f"[genre_swatches] {path}")
        return

    composition = build_composition()
    COMPOSITION_PATH.parent.mkdir(parents=True, exist_ok=True)
    COMPOSITION_PATH.write_text(
        json.dumps(composition, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    total_s = composition["timeline"]["total_duration_ms"] / 1000
    print(f"[genre_swatches] cuts: {len(composition['timeline']['cuts'])}, total: {total_s:.1f}s")
    print(f"[genre_swatches] output: {COMPOSITION_PATH}")


if __name__ == "__main__":
    main()
