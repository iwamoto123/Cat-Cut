"""フェーズU7/U8/V2: シーンタイトル設定(overlay_title)とOP生成(shared/opening.py)のテスト。"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shared.direction import build_directed_overlays
from shared.opening import (
    apply_op_offset,
    build_op,
    load_op_patterns,
    normalize_op_config,
    resolve_user_clips,
    select_highlight_clips,
)
from shared.telop_types import load_overlay_title, sanitize_overlay_title


# ---------------------------------------------------------------------------
# U7: overlay_title の正規化・読み込み
# ---------------------------------------------------------------------------

def test_sanitize_overlay_title_defaults():
    # 欠落・不正は「有効・box_accent」= U7以前と同じ挙動(後方互換)
    assert sanitize_overlay_title(None) == {"enabled": True, "style": "box_accent"}
    assert sanitize_overlay_title("garbage") == {"enabled": True, "style": "box_accent"}
    assert sanitize_overlay_title({"style": "unknown"}) == {"enabled": True, "style": "box_accent"}


def test_sanitize_overlay_title_keeps_valid_values():
    assert sanitize_overlay_title({"enabled": False, "style": "neon_plate"}) == {
        "enabled": False,
        "style": "neon_plate",
    }
    for style in ("box_accent", "band_gradient", "tag_ribbon", "minimal_line", "neon_plate"):
        assert sanitize_overlay_title({"style": style})["style"] == style


def test_load_overlay_title_from_mapping_file(tmp_path):
    mapping_file = tmp_path / "mapping.json"
    mapping_file.write_text(
        json.dumps({"type_styles": {}, "overlay_title": {"enabled": True, "style": "band_gradient"}}),
        encoding="utf-8",
    )
    assert load_overlay_title(mapping_file) == {"enabled": True, "style": "band_gradient"}
    # ファイルなし・セクションなしは既定
    assert load_overlay_title(tmp_path / "missing.json") == {"enabled": True, "style": "box_accent"}


# ---------------------------------------------------------------------------
# U7: build_directed_overlays への反映
# ---------------------------------------------------------------------------

_DIRECTIVES = {
    "chapters": [
        {"id": "ch1", "title": "序章", "source_start_ms": 0},
        {"id": "ch2", "title": "本題", "source_start_ms": 5000},
    ],
    "overlays": [],
}
_SEGMENTS = [{"source_start_ms": 0, "source_end_ms": 10000, "timeline_start_ms": 0}]


def test_directed_overlays_default_has_no_style_field():
    # overlay_title未指定(=None)はU7以前と同一の出力(styleフィールドなし)
    overlays = build_directed_overlays(_DIRECTIVES, _SEGMENTS, 10000)
    chapters = [o for o in overlays if o["type"] == "chapter_title"]
    assert len(chapters) == 2
    assert all("style" not in o for o in chapters)


def test_directed_overlays_box_accent_omits_style():
    # box_accent(既定)もstyleを書かない=既存compositionと同形を維持
    overlays = build_directed_overlays(
        _DIRECTIVES, _SEGMENTS, 10000, overlay_title={"enabled": True, "style": "box_accent"}
    )
    assert all("style" not in o for o in overlays if o["type"] == "chapter_title")


def test_directed_overlays_pattern_style_attached():
    overlays = build_directed_overlays(
        _DIRECTIVES, _SEGMENTS, 10000, overlay_title={"enabled": True, "style": "neon_plate"}
    )
    chapters = [o for o in overlays if o["type"] == "chapter_title"]
    assert chapters and all(o["style"] == "neon_plate" for o in chapters)


def test_directed_overlays_disabled_suppresses_chapters():
    overlays = build_directed_overlays(
        _DIRECTIVES, _SEGMENTS, 10000, overlay_title={"enabled": False, "style": "box_accent"}
    )
    assert [o for o in overlays if o["type"] == "chapter_title"] == []


# ---------------------------------------------------------------------------
# U8: --op-config の正規化
# ---------------------------------------------------------------------------

def test_normalize_op_config_rejects_none_and_unknown():
    assert normalize_op_config(None) is None
    assert normalize_op_config({}) is None
    assert normalize_op_config({"pattern": "none"}) is None
    assert normalize_op_config({"pattern": "unknown"}) is None


def test_normalize_op_config_valid():
    config = normalize_op_config({"pattern": "highlight_teaser", "title": " 猫会議 ", "catch_copy": " 今夜 "})
    # clips未指定はNone=AI自動選定(V2以前のop設定との後方互換)。
    # decoration/text_animation未指定は既定(flash_pop/slide_left)
    # W11-5: title_enabled未指定はTrue(後方互換)
    assert config == {
        "pattern": "highlight_teaser",
        "decoration": "flash_pop",
        "text_animation": "slide_left",
        "title": "猫会議",
        "title_enabled": True,
        "catch_copy": "今夜",
        "clips": None,
    }


def test_normalize_op_config_w13_placeholder_texts_become_empty():
    # W13-3: プレースホルダ的文言(「タイトルテキスト」等)は空文字=非表示へ正規化する
    for placeholder in ("タイトルテキスト", "タイトルテスト", " タイトルテキスト "):
        assert normalize_op_config({"pattern": "highlight_teaser", "title": placeholder})["title"] == ""
    assert normalize_op_config({"pattern": "highlight_teaser", "catch_copy": "キャッチコピー"})["catch_copy"] == ""
    # 部分一致では消えない(実タイトルは保持)
    assert (
        normalize_op_config({"pattern": "highlight_teaser", "title": "タイトルテキストの話"})["title"]
        == "タイトルテキストの話"
    )


def test_normalize_op_config_w11_title_enabled():
    # W11-5: 明示False のみ「表示しない」。省略・不正値はTrue(後方互換)
    assert normalize_op_config({"pattern": "highlight_teaser", "title_enabled": False})["title_enabled"] is False
    assert normalize_op_config({"pattern": "highlight_teaser"})["title_enabled"] is True
    assert normalize_op_config({"pattern": "highlight_teaser", "title_enabled": "x"})["title_enabled"] is True


def test_normalize_op_config_v5_migrates_legacy_patterns():
    # フェーズV5: 旧パターン(title_card / question_hook)は highlight_teaser へ無警告移行
    assert normalize_op_config({"pattern": "title_card"})["pattern"] == "highlight_teaser"
    assert normalize_op_config({"pattern": "question_hook"})["pattern"] == "highlight_teaser"


def test_normalize_op_config_v5_decoration_and_text_animation():
    config = normalize_op_config({
        "pattern": "highlight_teaser",
        "decoration": "neon_frame",
        "text_animation": "stamp",
    })
    assert config["decoration"] == "neon_frame"
    assert config["text_animation"] == "stamp"
    # 未知値は既定へ落とす
    fallback = normalize_op_config({
        "pattern": "highlight_teaser",
        "decoration": "sparkle",
        "text_animation": "spin",
    })
    assert fallback["decoration"] == "flash_pop"
    assert fallback["text_animation"] == "slide_left"


def test_normalize_op_config_clips_v2():
    # 有効クリップは正規化して保持、不正エントリ(end<=start・型不正)は捨てる
    config = normalize_op_config({
        "pattern": "highlight_teaser",
        "title": "T",
        "catch_copy": "",
        "clips": [
            {"cut_id": "cut_001", "start_ms": 1000, "end_ms": 3000, "text": " 神回 ", "style": "special_purple"},
            {"cut_id": "cut_002", "start_ms": 5000, "end_ms": 5000},  # 尺ゼロ
            {"start_ms": "abc", "end_ms": 9000},  # 型不正
            "garbage",
        ],
    })
    assert config["clips"] == [
        {"cut_id": "cut_001", "start_ms": 1000, "end_ms": 3000, "text": "神回", "style": "special_purple"},
    ]
    # 全滅・非リストは None(=AI自動選定へフォールバック)
    assert normalize_op_config({"pattern": "highlight_teaser", "clips": []})["clips"] is None
    assert normalize_op_config({"pattern": "highlight_teaser", "clips": "x"})["clips"] is None


def test_load_op_patterns_has_all_ids():
    patterns = load_op_patterns()
    assert {"none", "title_card", "highlight_teaser", "question_hook"} <= set(patterns.keys())
    # ネット調査の設計指針: 尺は3〜7秒
    for pid in ("title_card", "question_hook"):
        assert 3000 <= int(patterns[pid]["duration_ms"]) <= 7000


# ---------------------------------------------------------------------------
# U8: ハイライト選定(決定的)
# ---------------------------------------------------------------------------

_KEEP_SEGMENTS = [
    {"start_ms": 0, "end_ms": 10000},
    {"start_ms": 20000, "end_ms": 30000},
]


def _slot(slot_type, start, end, text=""):
    return {"type": slot_type, "source_start_ms": start, "source_end_ms": end, "text": text}


def _clip_ranges(clips):
    """時間範囲の検証用にV2で追加されたメタ(text/style/source_*_ms)を除いた形へ。"""
    return [{"cut_index": c["cut_index"], "start_ms": c["start_ms"], "end_ms": c["end_ms"]} for c in clips]


def test_select_highlight_clips_priority_and_chronological_order():
    slots = [
        _slot("surprise", 1000, 3000),
        _slot("hype", 25000, 27000),
        _slot("punchline", 5000, 7000),
        _slot("hype", 2000, 4000),
    ]
    clips = select_highlight_clips(slots, _KEEP_SEGMENTS, max_clips=3)
    # hype2つ+punchline1つが選ばれ、採用後は時系列順(source_start順)
    assert _clip_ranges(clips) == [
        {"cut_index": 0, "start_ms": 2000, "end_ms": 4000},
        {"cut_index": 0, "start_ms": 5000, "end_ms": 7000},
        {"cut_index": 1, "start_ms": 5000, "end_ms": 7000},
    ]
    # 同入力なら同出力(決定的)
    assert select_highlight_clips(slots, _KEEP_SEGMENTS, max_clips=3) == clips


def test_select_highlight_clips_clamps_and_skips():
    slots = [
        _slot("hype", 1000, 6000),  # 5秒 → clip_max(2秒)へ切り詰め
        _slot("hype", 8000, 8500),  # 0.5秒 → clip_min未満でスキップ
        _slot("quote", 2000, 4000),  # 対象外type
    ]
    clips = select_highlight_clips(slots, _KEEP_SEGMENTS, max_clips=3, clip_min_ms=1200, clip_max_ms=2000)
    assert _clip_ranges(clips) == [{"cut_index": 0, "start_ms": 1000, "end_ms": 3000}]


def test_select_highlight_clips_attaches_text_style_and_source_ms():
    # フェーズV2: 各クリップに該当スロットのテロップ文言と解決済みスタイル・絶対msを持たせる
    slots = [_slot("hype", 2000, 4000, text=" ここが神回！ ")]
    clips = select_highlight_clips(slots, _KEEP_SEGMENTS, max_clips=3)
    assert clips == [{
        "cut_index": 0,
        "start_ms": 2000,
        "end_ms": 4000,
        "text": "ここが神回！",
        "style": "special_purple",  # hype の既定マッピング
        "source_start_ms": 2000,
        "source_end_ms": 4000,
    }]
    # type→presetマッピングのユーザー設定を反映する
    mapped = select_highlight_clips(slots, _KEEP_SEGMENTS, max_clips=3, type_mapping={"hype": "emotion_red"})
    assert mapped[0]["style"] == "emotion_red"


# ---------------------------------------------------------------------------
# V2: ユーザー指定クリップ(op_config.clips)のカット再解決
# ---------------------------------------------------------------------------

def test_resolve_user_clips_maps_to_segments_and_keeps_order():
    user_clips = [
        # 2番目のセグメント(20000〜30000)内 → cut_index=1
        {"cut_id": "cut_002", "start_ms": 22000, "end_ms": 24000, "text": "後半の山場", "style": "box_yellow"},
        # 1番目のセグメント内。ユーザー指定順を維持(時系列に並べ直さない)
        {"cut_id": "cut_001", "start_ms": 1000, "end_ms": 3000, "text": "冒頭", "style": ""},
    ]
    clips = resolve_user_clips(user_clips, _KEEP_SEGMENTS)
    assert clips == [
        {"cut_index": 1, "start_ms": 2000, "end_ms": 4000, "text": "後半の山場", "style": "box_yellow",
         "source_start_ms": 22000, "source_end_ms": 24000},
        {"cut_index": 0, "start_ms": 1000, "end_ms": 3000, "text": "冒頭", "style": "",
         "source_start_ms": 1000, "source_end_ms": 3000},
    ]


def test_resolve_user_clips_clamps_and_drops_invalid():
    user_clips = [
        # セグメント末尾をはみ出す指定(中点9500はセグメント内) → セグメント内へクランプ
        {"cut_id": "c", "start_ms": 8000, "end_ms": 11000, "text": "", "style": ""},
        # どのセグメントにも属さない(中点15000がギャップ) → 捨てる
        {"cut_id": "c", "start_ms": 14000, "end_ms": 16000, "text": "", "style": ""},
        # 短すぎる(400ms未満) → 捨てる
        {"cut_id": "c", "start_ms": 1000, "end_ms": 1200, "text": "", "style": ""},
        # 長すぎる指定(6秒) → 上限4秒へ切り詰め
        {"cut_id": "c", "start_ms": 20000, "end_ms": 26000, "text": "", "style": ""},
    ]
    clips = resolve_user_clips(user_clips, _KEEP_SEGMENTS)
    assert _clip_ranges(clips) == [
        {"cut_index": 0, "start_ms": 8000, "end_ms": 10000},
        {"cut_index": 1, "start_ms": 0, "end_ms": 4000},
    ]


# ---------------------------------------------------------------------------
# U8: build_op と apply_op_offset
# ---------------------------------------------------------------------------

_CUTS = [
    {"video": {"file_path": "/run/segments/seg_000.mp4", "start_ms": 0},
     "timeline": {"start_ms": 0, "end_ms": 10000}},
    {"video": {"file_path": "/run/segments/seg_001.mp4", "start_ms": 0},
     "timeline": {"start_ms": 10000, "end_ms": 20000}},
]


def test_build_op_title_empty_without_filename_fallback():
    # W11-5: ファイル名フォールバックは廃止。ユーザー入力もAI生成も無ければタイトルは空
    # (Remotion側が空文字ガードで描画しない)
    op = build_op(
        {"pattern": "title_card", "title": "", "catch_copy": ""},
        load_op_patterns(), [], _KEEP_SEGMENTS, _CUTS, "/videos/猫の集会.mp4",
    )
    assert op["pattern"] == "title_card"
    assert op["title"] == ""
    assert op["duration_ms"] == 4000
    assert op["sfx_hit"] == "don"


def test_build_op_title_priority_user_then_ai():
    # W11-5: 優先順位はユーザー入力 > AI生成(ai_title)。ファイル名は使わない
    op_ai = build_op(
        {"pattern": "title_card", "title": "", "catch_copy": ""},
        load_op_patterns(), [], _KEEP_SEGMENTS, _CUTS, "/videos/猫の集会.mp4",
        ai_title="AI生成タイトル",
    )
    assert op_ai["title"] == "AI生成タイトル"
    op_user = build_op(
        {"pattern": "title_card", "title": "ユーザー入力", "catch_copy": ""},
        load_op_patterns(), [], _KEEP_SEGMENTS, _CUTS, "/videos/猫の集会.mp4",
        ai_title="AI生成タイトル",
    )
    assert op_user["title"] == "ユーザー入力"


def test_build_op_title_enabled_false_forces_empty():
    # W11-5: 「表示しない」チェック(title_enabled=False)はユーザー入力・AI生成があっても空にする
    op = build_op(
        {"pattern": "title_card", "title": "ユーザー入力", "title_enabled": False, "catch_copy": ""},
        load_op_patterns(), [], _KEEP_SEGMENTS, _CUTS, "/videos/猫の集会.mp4",
        ai_title="AI生成タイトル",
    )
    assert op["title"] == ""
    # title_enabled 省略(旧op_config)は従来どおりタイトルを出す(後方互換)
    op_legacy = build_op(
        {"pattern": "title_card", "title": "ユーザー入力", "catch_copy": ""},
        load_op_patterns(), [], _KEEP_SEGMENTS, _CUTS, "/videos/猫の集会.mp4",
    )
    assert op_legacy["title"] == "ユーザー入力"


def test_build_op_question_hook_skips_catch_copy_when_title_empty():
    # W11-5: タイトルが空(非表示)なら「〜、知っていますか？」の自動補完もしない
    op = build_op(
        {"pattern": "question_hook", "title": "", "catch_copy": ""},
        load_op_patterns(), [], _KEEP_SEGMENTS, _CUTS, "/videos/x.mp4",
    )
    assert op["catch_copy"] == ""


def test_build_op_question_hook_default_catch_copy():
    op = build_op(
        {"pattern": "question_hook", "title": "夜の猫", "catch_copy": ""},
        load_op_patterns(), [], _KEEP_SEGMENTS, _CUTS, "/videos/x.mp4",
    )
    assert op["catch_copy"] == "夜の猫、知っていますか？"
    # ユーザー入力があればそれを尊重する
    op2 = build_op(
        {"pattern": "question_hook", "title": "夜の猫", "catch_copy": "なぜ集まる？"},
        load_op_patterns(), [], _KEEP_SEGMENTS, _CUTS, "/videos/x.mp4",
    )
    assert op2["catch_copy"] == "なぜ集まる？"


def test_build_op_teaser_builds_clips_and_duration():
    slots = [_slot("hype", 1000, 3000, text="盛り上がり"), _slot("punchline", 25000, 26500, text="オチ")]
    op = build_op(
        {"pattern": "highlight_teaser", "title": "T", "catch_copy": "", "clips": None},
        load_op_patterns(), slots, _KEEP_SEGMENTS, _CUTS, "/videos/x.mp4",
    )
    assert op["pattern"] == "highlight_teaser"
    # V2: file_path/時間に加えて、テロップ文言・スタイル・UI用メタ(cut_id/絶対ms)を出力する
    assert op["highlight_cuts"] == [
        {"file_path": "/run/segments/seg_000.mp4", "start_ms": 1000, "end_ms": 3000,
         "cut_id": "", "source_start_ms": 1000, "source_end_ms": 3000,
         "text": "盛り上がり", "style": "special_purple"},
        {"file_path": "/run/segments/seg_001.mp4", "start_ms": 5000, "end_ms": 6500,
         "cut_id": "", "source_start_ms": 25000, "source_end_ms": 26500,
         "text": "オチ", "style": "box_yellow"},
    ]
    assert op["duration_ms"] == 3500  # クリップ合計


def test_build_op_teaser_omits_text_when_empty():
    # 文言なしスロット由来のクリップは text/style を出力しない(Remotionはテロップを描かない)
    slots = [_slot("hype", 1000, 3000)]
    op = build_op(
        {"pattern": "highlight_teaser", "title": "T", "catch_copy": "", "clips": None},
        load_op_patterns(), slots, _KEEP_SEGMENTS, _CUTS, "/videos/x.mp4",
    )
    assert "text" not in op["highlight_cuts"][0]
    assert "style" not in op["highlight_cuts"][0]


def test_build_op_teaser_prefers_user_clips():
    # フェーズV2: op_config.clips(ユーザー指定)があればスロット由来の自動選定より優先する
    slots = [_slot("hype", 1000, 3000, text="自動選定側")]
    op = build_op(
        {
            "pattern": "highlight_teaser", "title": "T", "catch_copy": "",
            "clips": [
                {"cut_id": "cut_002", "start_ms": 22000, "end_ms": 24000,
                 "text": "ユーザー編集済み", "style": "emotion_red"},
            ],
        },
        load_op_patterns(), slots, _KEEP_SEGMENTS, _CUTS, "/videos/x.mp4",
    )
    assert op["highlight_cuts"] == [
        {"file_path": "/run/segments/seg_001.mp4", "start_ms": 2000, "end_ms": 4000,
         "cut_id": "", "source_start_ms": 22000, "source_end_ms": 24000,
         "text": "ユーザー編集済み", "style": "emotion_red"},
    ]
    assert op["duration_ms"] == 2000


def test_build_op_teaser_invalid_user_clips_fall_back_to_auto():
    # ユーザー指定クリップが全滅(カット編集で該当範囲が消えた等)→AI自動選定へ戻す
    slots = [_slot("hype", 1000, 3000, text="自動")]
    op = build_op(
        {
            "pattern": "highlight_teaser", "title": "T", "catch_copy": "",
            "clips": [{"cut_id": "gone", "start_ms": 14000, "end_ms": 16000, "text": "", "style": ""}],
        },
        load_op_patterns(), slots, _KEEP_SEGMENTS, _CUTS, "/videos/x.mp4",
    )
    assert op["pattern"] == "highlight_teaser"
    assert op["highlight_cuts"][0]["text"] == "自動"


def test_build_op_teaser_uses_retained_video_without_slots():
    # fullモード等でスロットが無くても、無地カードではなく実映像を使う。
    op = build_op(
        {"pattern": "highlight_teaser", "title": "T", "catch_copy": "", "clips": None},
        load_op_patterns(), [], _KEEP_SEGMENTS, _CUTS, "/videos/x.mp4",
    )
    assert op["pattern"] == "highlight_teaser"
    assert op["highlight_cuts"][0]["file_path"] == _CUTS[0]["video"]["file_path"]
    assert op["duration_ms"] == 3500


def test_build_op_teaser_outputs_decoration_and_text_animation():
    # フェーズV5: timeline.op へ decoration / text_animation を出力(Remotionが描画分岐する)
    slots = [_slot("hype", 1000, 3000, text="盛り上がり")]
    op = build_op(
        {
            "pattern": "highlight_teaser", "title": "T", "catch_copy": "", "clips": None,
            "decoration": "cinema_bars", "text_animation": "slide_up",
        },
        load_op_patterns(), slots, _KEEP_SEGMENTS, _CUTS, "/videos/x.mp4",
    )
    assert op["decoration"] == "cinema_bars"
    assert op["text_animation"] == "slide_up"
    # 未指定(旧op_config)は既定値で出力する
    op_default = build_op(
        {"pattern": "highlight_teaser", "title": "T", "catch_copy": "", "clips": None},
        load_op_patterns(), slots, _KEEP_SEGMENTS, _CUTS, "/videos/x.mp4",
    )
    assert op_default["decoration"] == "flash_pop"
    assert op_default["text_animation"] == "slide_left"


def test_apply_op_offset_shifts_cuts_and_overlays():
    cuts = [
        {"timeline": {"start_ms": 0, "end_ms": 5000}},
        {"timeline": {"start_ms": 5000, "end_ms": 9000}},
    ]
    overlays = [{"start_ms": 0, "end_ms": 9000}]
    apply_op_offset(cuts, overlays, 4000)
    assert cuts[0]["timeline"] == {"start_ms": 4000, "end_ms": 9000}
    assert cuts[1]["timeline"] == {"start_ms": 9000, "end_ms": 13000}
    assert overlays[0] == {"start_ms": 4000, "end_ms": 13000}
    # offset 0以下は無変更(OPなし=後方互換)
    apply_op_offset(cuts, overlays, 0)
    assert cuts[0]["timeline"]["start_ms"] == 4000
