"""フェーズT2.5検証用デモ composition の生成。

新体系(semantic type → preset マッピング解決)・明朝系プリセット(serif_quote /
serif_harsh)・オフセット影付き刷新プリセット・はみ出し境界ケース(長文2行・極長文言)を
網羅した templates/samples/direction_demo_composition.json を組み立てる。
動画素材は既存run (runs/20260704_204052_videoplayback_7) のセグメントを絶対パスで
参照する(runは変更しない)。プリセット変更後の再生成もこのスクリプトで行う。

Usage:
    .venv/bin/python python/tools/build_direction_demo.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from _telop_presets import embed_presets_into_composition

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shared.telop_types import load_type_mapping, resolve_style_for_type  # noqa: E402

EDITOR_ROOT = Path(__file__).resolve().parents[2]
SEGMENTS_DIR = EDITOR_ROOT / "runs" / "20260704_204052_videoplayback_7" / "step08_composition" / "segments"
OUTPUT_PATH = EDITOR_ROOT / "templates" / "samples" / "direction_demo_composition.json"

TYPE_MAPPING = load_type_mapping()

# (セグメント名, カット尺ms, semantic type or ("style", プリセット名), テロップ行, ハイライト語, テロップ相対区間秒)
# - 第3要素が semantic type 文字列なら telop_type_mapping.yaml でプリセットへ解決する(新体系)
# - ("style", name) ならプリセット直指定(マッピング外のプリセットの網羅用)
# 尺は必ずセグメント実尺以内にする(cut_001=2.53s, 他は3s以上ある)
DEMO_CUTS = [
    # --- semantic type 10種(type→presetマッピング解決の検証) ---
    ("cut_001", 2500, "default", ["再生数が10倍に伸びた"], ["10倍"], (0.15, 2.35)),
    ("cut_002", 3000, "surprise", ["実は無料でできる"], None, (0.15, 2.85)),
    ("cut_003", 3000, "harsh", ["それ、ただの言い訳です"], None, (0.15, 2.85)),
    ("cut_004", 3000, "quote", ["継続だけが才能を超える"], None, (0.2, 2.85)),
    ("cut_005", 3000, "emphasis", ["底辺YouTuber卒業！"], None, (0.15, 2.85)),
    # cut_006 は caption オーバーレイと下部が重ならないようテロップを前半のみにする
    ("cut_006", 3000, "question", ["何でですかね?"], None, (0.2, 1.6)),
    ("cut_007", 3000, "reply", ["ちょこちょこ頑張りました"], None, (0.15, 2.85)),
    ("cut_008", 3000, "punchline", ["何がビジネスYouTuberとして", "ハマりかけているのか？"], None, (0.15, 2.85)),
    ("cut_009", 3000, "hype", ["リスクのほうがデカい"], None, (0.15, 2.85)),
    ("cut_010", 3000, "cta", ["概要欄の公式LINEに", "『ショート希望』"], ["『ショート希望』"], (0.15, 2.85)),
    # --- マッピング外プリセットの網羅(直指定) ---
    ("cut_011", 3000, ("style", "neutral_white"), ["底辺でいいと思っていた"], ["底辺"], (0.15, 2.85)),
    ("cut_012", 3000, ("style", "neutral_white_pink"), ["ここだけの話ですけど"], None, (0.15, 2.85)),
    ("cut_013", 3000, ("style", "box_red"), ["外販OKプラン"], None, (0.2, 1.8)),
    ("cut_014", 3000, ("style", "op_brush"), ["その秘策とは!?"], None, (0.15, 2.85)),
    # --- はみ出し境界ケース(T2.5-1: 最大2行折返し+幅フィット縮小の検証) ---
    # 長文2行: 1行バジェット(16)を大きく超え、2行折返し+縮小が必要になる文言
    (
        "cut_015",
        3000,
        "default",
        ["チャンネル登録者数がたった3ヶ月で10万人を突破した本当の理由"],
        ["10万人"],
        (0.15, 2.85),
    ),
    # 極長文言: 2行でも収まらず縮小下限(55%)近くまで縮む保険パスの検証
    (
        "cut_016",
        3000,
        ("style", "neutral_white"),
        ["動画編集も企画もサムネイルも全部ひとりでやっていた頃には想像もできなかった景色がそこにはありました"],
        None,
        (0.15, 2.85),
    ),
    # 縦クランプ: y_position_offset持ちのプリセット(op_brush等)の2行時のはみ出し検証
    (
        "cut_017",
        3000,
        ("style", "serif_quote"),
        ["努力は裏切らないという言葉を", "信じられるかどうかが分かれ道"],
        None,
        (0.15, 2.85),
    ),
]


def build_composition() -> dict:
    cuts = []
    voice_cuts = []
    offset_ms = 0

    for i, (segment_name, duration_ms, type_or_style, lines, highlight_words, (rel_start, rel_end)) in enumerate(DEMO_CUTS):
        cut_id = f"cut_{i + 1:03d}"
        # 新体系: semantic type はマッピングでプリセットへ解決し、telop には type も残す
        if isinstance(type_or_style, tuple):
            semantic_type = None
            style = type_or_style[1]
        else:
            semantic_type = type_or_style
            style = resolve_style_for_type(type_or_style, TYPE_MAPPING)
        segment_path = SEGMENTS_DIR / f"{segment_name}.mp4"
        if not segment_path.exists():
            raise FileNotFoundError(f"segment not found: {segment_path}")

        cuts.append({
            "cut_id": cut_id,
            "type": "body",
            "video": {
                "file_path": str(segment_path),
                "start_ms": 0,
                "end_ms": duration_ms,
            },
            "timeline": {
                "start_ms": offset_ms,
                "end_ms": offset_ms + duration_ms,
            },
            "telop": {"pages": [{"id": f"{cut_id}_p00", "lines": lines}]},
            "layout": "talk",
            "scene_id": None,
        })

        telop = {
            "id": f"{cut_id}_p00",
            "text": "".join(lines),
            "word_indices": [],
            # 演出テロップは word 同期ではなくカット内相対秒の明示タイミングで表示する
            "start": rel_start,
            "end": rel_end,
            "style": style,
            "segments": [{"text": line, "word_indices": []} for line in lines],
        }
        if semantic_type:
            telop["type"] = semantic_type
        if highlight_words:
            telop["highlight_words"] = highlight_words
        voice_cuts.append({
            "id": cut_id,
            "narration": "".join(lines),
            "voice": {"duration_ms": duration_ms, "words": []},
            "telops": [telop],
        })
        offset_ms += duration_ms

    # オーバーレイ5種(タイムライン基準ms)。chapter_title はカットを跨いで連続表示する
    # カット割: cut_001=0-2500 / cut_002..cut_010=type網羅(2500+3000刻み、29500まで)
    #           cut_011..cut_014=直指定プリセット(29500-41500) / cut_015..cut_017=境界ケース(41500-50500)
    overlays = [
        {
            "id": "ov_chapter_1",
            "type": "chapter_title",
            "start_ms": 0,
            "end_ms": 29500,
            "text": "シーン種類10種デモ",
            "position": "top_left",
        },
        {
            "id": "ov_chapter_2",
            "type": "chapter_title",
            "start_ms": 29500,
            "end_ms": 41500,
            "text": "個別プリセット",
            "position": "top_left",
        },
        {
            "id": "ov_chapter_3",
            "type": "chapter_title",
            "start_ms": 41500,
            "end_ms": offset_ms,
            "text": "はみ出し境界ケース",
            "position": "top_left",
        },
        {
            "id": "ov_profile",
            "type": "profile_card",
            "start_ms": 3000,
            "end_ms": 8000,
            "text": "小林 理玖",
            "subtitle": "株式会社エフ・コード M&A担当\n株式会社Real us 創業者",
            "position": "bottom_left",
        },
        # cut_006(question)のテロップは前半のみ(rel 0.2-1.6)のため、後半にcaptionを出す
        {
            "id": "ov_caption",
            "type": "caption",
            "start_ms": 16400,
            "end_ms": 17400,
            "text": "3年で5億円",
            "position": "bottom",
        },
        {
            "id": "ov_list",
            "type": "list_stack",
            "start_ms": 12000,
            "end_ms": 14300,
            "lines": ["動画編集会社の方", "YouTube事業者の方", "SEO会社"],
            "position": "center",
        },
        # cut_013(box_red)のテロップは前半のみ(rel 0.2-1.8)のため、後半にcta_bannerを出す
        {
            "id": "ov_cta",
            "type": "cta_banner",
            "start_ms": 37500,
            "end_ms": 41500,
            "lines": ["概要欄の公式LINEに", "『切り抜き希望』"],
            "position": "bottom",
        },
    ]

    composition = {
        "timeline": {
            "version": "1.0.0",
            "total_duration_ms": offset_ms,
            "video_fit": "cover",
            "fps": 30,
            "framing": {"scale": 1.0, "offset_y": 0},
            "telop_y": 0.85,
            "telop_font_size": 72,
            "telop_max_chars_per_line": 16,
            "animation_in": "none",
            "animation_out": "none",
            "overlays": overlays,
            "cuts": cuts,
        },
        "voice_data": {"version": "1.0", "cuts": voice_cuts},
        "meta": {
            "source_video": str(SEGMENTS_DIR),
            "original_duration_ms": offset_ms,
            "edited_duration_ms": offset_ms,
            "reduction_ratio": 0,
            "total_cuts": len(cuts),
            # 素材は640x360だが、テロップの視認性のため2倍で書き出す
            "display_width": 1280,
            "display_height": 720,
            "orientation": "horizontal",
            "rotation": 0,
            "project": {"name": "direction_demo_t25"},
        },
    }
    embed_presets_into_composition(composition)
    return composition


def main() -> None:
    composition = build_composition()
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(
        json.dumps(composition, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    total_s = composition["timeline"]["total_duration_ms"] / 1000
    print(f"[build_direction_demo] cuts: {len(composition['timeline']['cuts'])}, "
          f"overlays: {len(composition['timeline']['overlays'])}, total: {total_s:.1f}s")
    print(f"[build_direction_demo] output: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
