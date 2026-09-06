"""フェーズW2: シーン映像ギミック(shared/video_effects.py)の選定純関数テスト。

- 決定的選定: pinch(harsh最大3件・30秒間隔) / zoom(emphasis系最大4件・20秒間隔)
- pinchとzoomの時間重複禁止・OP採用シーンのzoom除外・トグルOFFの選定段階除外
- スロット→タイムライン写像(カット済みスロットの脱落・セグメント内クランプ)
- ON/OFF設定のsanitize・ユーザーマッピングJSONからのロード
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shared.video_effects import (
    DIM_OPACITY,
    FACE_ZOOM_FALLBACK_FOCUS,
    FACE_ZOOM_SCALE,
    PINCH_BRIGHTNESS,
    PINCH_SCALE,
    PINCH_SFX_ID,
    SLOW_PUSH_SCALE,
    ZOOM_FOCUS,
    ZOOM_SCALE,
    load_video_effects_config,
    sanitize_video_effects_enabled,
    select_video_effects,
)

# 既定形(pinch/zoom=ON・W24 Phase C 新3種=OFF)
DEFAULT_ENABLED = {
    "pinch": True,
    "zoom": True,
    "dim": False,
    "face_zoom": False,
    "slow_push": False,
}


def make_slot(slot_id, slot_type, start_ms, end_ms, highlight_words=None, video_effect=None):
    slot = {
        "slot_id": slot_id,
        "type": slot_type,
        "source_start_ms": start_ms,
        "source_end_ms": end_ms,
    }
    if highlight_words is not None:
        slot["highlight_words"] = highlight_words
    if video_effect is not None:
        slot["video_effect"] = video_effect
    return slot


def identity_segments(total_ms, offset_ms=0):
    """元動画全体が1セグメント(source→timelineがオフセットだけの単純写像)。"""
    return [{
        "source_start_ms": 0,
        "source_end_ms": total_ms,
        "timeline_start_ms": offset_ms,
    }]


class SanitizeEnabledTests(unittest.TestCase):
    """sanitize_video_effects_enabled: pinch/zoomは欠落=ON・明示falseのみOFF。
    W24 Phase C 新3種(dim/face_zoom/slow_push)は欠落=OFF・明示trueのみON。"""

    def test_defaults(self):
        self.assertEqual(sanitize_video_effects_enabled(None), DEFAULT_ENABLED)
        self.assertEqual(sanitize_video_effects_enabled("bad"), DEFAULT_ENABLED)
        self.assertEqual(sanitize_video_effects_enabled([]), DEFAULT_ENABLED)
        self.assertEqual(sanitize_video_effects_enabled({}), DEFAULT_ENABLED)

    def test_explicit_false_only_for_pinch_zoom(self):
        self.assertEqual(
            sanitize_video_effects_enabled({"pinch": False}),
            {**DEFAULT_ENABLED, "pinch": False},
        )
        self.assertEqual(
            sanitize_video_effects_enabled({"pinch": 0, "zoom": False}),
            {**DEFAULT_ENABLED, "zoom": False},
        )

    def test_explicit_true_only_for_new_effects(self):
        self.assertEqual(
            sanitize_video_effects_enabled({"dim": True, "face_zoom": True, "slow_push": True}),
            {"pinch": True, "zoom": True, "dim": True, "face_zoom": True, "slow_push": True},
        )
        # truthyだがbool以外・falseは既定OFFのまま(既存テーマの従来動作を維持)
        self.assertEqual(
            sanitize_video_effects_enabled({"dim": 1, "face_zoom": "on", "slow_push": False}),
            DEFAULT_ENABLED,
        )

    def test_vertical_dim_default_on(self):
        """フェーズW26: 縦型はdim既定ON(決めゼリフ明朝と暗転を併用するデザイン)。
        明示的な false は尊重してOFF。横型・orientation未指定は従来どおりOFF。"""
        self.assertEqual(
            sanitize_video_effects_enabled(None, orientation="vertical"),
            {**DEFAULT_ENABLED, "dim": True},
        )
        self.assertEqual(
            sanitize_video_effects_enabled({}, orientation="vertical"),
            {**DEFAULT_ENABLED, "dim": True},
        )
        self.assertEqual(
            sanitize_video_effects_enabled({"dim": False}, orientation="vertical"),
            DEFAULT_ENABLED,
        )
        self.assertEqual(
            sanitize_video_effects_enabled(None, orientation="horizontal"),
            DEFAULT_ENABLED,
        )


class LoadConfigTests(unittest.TestCase):
    """load_video_effects_config: --type-mapping経路のJSONから video_effects を読む。"""

    def test_missing_file_is_default(self):
        self.assertEqual(load_video_effects_config(None), DEFAULT_ENABLED)
        self.assertEqual(
            load_video_effects_config("/nonexistent/mapping.json"),
            DEFAULT_ENABLED,
        )

    def test_reads_video_effects_section(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            mapping_file = Path(tmp_dir) / "telop_type_mapping.effective.json"
            mapping_file.write_text(
                json.dumps({
                    "type_styles": {},
                    "video_effects": {"pinch": False, "zoom": True, "slow_push": True},
                }),
                encoding="utf-8",
            )
            self.assertEqual(
                load_video_effects_config(mapping_file),
                {**DEFAULT_ENABLED, "pinch": False, "slow_push": True},
            )

    def test_broken_json_is_default(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            mapping_file = Path(tmp_dir) / "broken.json"
            mapping_file.write_text("{not json", encoding="utf-8")
            self.assertEqual(load_video_effects_config(mapping_file), DEFAULT_ENABLED)


class SelectVideoEffectsTests(unittest.TestCase):
    """select_video_effects の決定的選定。"""

    def test_pinch_schema_and_zoom_schema(self):
        slots = [
            make_slot("s1", "harsh", 10000, 15000),
            make_slot("s2", "emphasis", 60000, 65000),
        ]
        effects = select_video_effects(slots, identity_segments(300000))
        self.assertEqual(len(effects), 2)
        pinch, zoom = effects[0], effects[1]
        self.assertEqual(pinch["id"], "ve_001")
        self.assertEqual(pinch["type"], "pinch")
        self.assertEqual(pinch["start_ms"], 10000)
        self.assertEqual(pinch["end_ms"], 15000)
        self.assertEqual(pinch["slot_id"], "s1")
        self.assertEqual(pinch["params"], {"scale": PINCH_SCALE, "brightness": PINCH_BRIGHTNESS})
        self.assertEqual(pinch["sfx"], PINCH_SFX_ID)
        self.assertEqual(zoom["id"], "ve_002")
        self.assertEqual(zoom["type"], "zoom")
        self.assertEqual(zoom["params"], {"scale": ZOOM_SCALE, "focus": dict(ZOOM_FOCUS)})
        self.assertNotIn("sfx", zoom)

    def test_pinch_capped_at_3_with_30s_gap(self):
        # 40秒間隔で5本のharsh→間隔は満たすが最大3件で打ち切り
        slots = [
            make_slot(f"h{i}", "harsh", i * 40000, i * 40000 + 5000) for i in range(5)
        ]
        effects = select_video_effects(slots, identity_segments(400000))
        self.assertEqual(len(effects), 3)
        self.assertTrue(all(e["type"] == "pinch" for e in effects))

    def test_pinch_min_gap_30s(self):
        # 10秒間隔で並ぶharshは先頭優先で間引かれる(30秒間隔を満たす組だけ残る)
        slots = [
            make_slot("h1", "harsh", 0, 5000),
            make_slot("h2", "harsh", 15000, 20000),  # h1と10秒差→落ちる
            make_slot("h3", "harsh", 40000, 45000),  # h1と35秒差→残る
        ]
        effects = select_video_effects(slots, identity_segments(300000))
        self.assertEqual([e["slot_id"] for e in effects], ["h1", "h3"])

    def test_pinch_priority_highlight_words_then_duration(self):
        # 3件を超える候補: highlight_wordsあり > 尺が長い の順で選ばれる
        slots = [
            make_slot("short", "harsh", 0, 2000),
            make_slot("long", "harsh", 100000, 110000),
            make_slot("hl", "harsh", 200000, 203000, highlight_words=["毒"]),
            make_slot("mid", "harsh", 300000, 305000),
        ]
        effects = select_video_effects(slots, identity_segments(400000))
        self.assertEqual(len(effects), 3)
        picked = {e["slot_id"] for e in effects}
        # highlight持ちのhl、尺10秒のlong、尺5秒のmid が残り、尺2秒のshortが落ちる
        self.assertEqual(picked, {"hl", "long", "mid"})

    def test_zoom_capped_at_4_with_20s_gap(self):
        slots = [
            make_slot(f"z{i}", "emphasis", i * 30000, i * 30000 + 4000) for i in range(6)
        ]
        effects = select_video_effects(slots, identity_segments(400000))
        self.assertEqual(len(effects), 4)
        self.assertTrue(all(e["type"] == "zoom" for e in effects))

    def test_zoom_types_and_unknown_types_ignored(self):
        slots = [
            make_slot("e", "emphasis", 0, 4000),
            make_slot("p", "punchline", 60000, 64000),
            make_slot("h", "hype", 120000, 124000),
            make_slot("q", "question", 180000, 184000),  # 対象外type
            make_slot("d", "default", 240000, 244000),  # 対象外type
        ]
        effects = select_video_effects(slots, identity_segments(400000))
        self.assertEqual({e["slot_id"] for e in effects}, {"e", "p", "h"})

    def test_zoom_does_not_overlap_pinch(self):
        # 同じ時間帯のharshとemphasis→pinchが優先されzoomは選ばれない
        slots = [
            make_slot("h1", "harsh", 10000, 20000),
            make_slot("z1", "emphasis", 12000, 18000),
            make_slot("z2", "emphasis", 100000, 105000),
        ]
        effects = select_video_effects(slots, identity_segments(300000))
        types = {(e["slot_id"], e["type"]) for e in effects}
        self.assertEqual(types, {("h1", "pinch"), ("z2", "zoom")})

    def test_zoom_excludes_op_clip_ranges(self):
        slots = [
            make_slot("z1", "emphasis", 10000, 15000),  # OP採用区間と重なる→除外
            make_slot("z2", "punchline", 100000, 105000),
        ]
        effects = select_video_effects(
            slots,
            identity_segments(300000),
            op_clip_source_ranges=[(8000, 12000)],
        )
        self.assertEqual([e["slot_id"] for e in effects], ["z2"])
        # pinchはOP除外の対象外(OPに使われても本編の引き締めは意味が変わらない)
        pinch_effects = select_video_effects(
            [make_slot("h1", "harsh", 10000, 15000)],
            identity_segments(300000),
            op_clip_source_ranges=[(8000, 12000)],
        )
        self.assertEqual(len(pinch_effects), 1)

    def test_toggle_off_excludes_at_selection(self):
        slots = [
            make_slot("h1", "harsh", 0, 5000),
            make_slot("z1", "emphasis", 60000, 65000),
        ]
        segments = identity_segments(300000)
        only_zoom = select_video_effects(slots, segments, enabled={"pinch": False, "zoom": True})
        self.assertEqual([e["type"] for e in only_zoom], ["zoom"])
        only_pinch = select_video_effects(slots, segments, enabled={"pinch": True, "zoom": False})
        self.assertEqual([e["type"] for e in only_pinch], ["pinch"])
        none = select_video_effects(slots, segments, enabled={"pinch": False, "zoom": False})
        self.assertEqual(none, [])

    def test_manual_none_excludes_slot_from_automatic_selection(self):
        slots = [
            make_slot("h_none", "harsh", 0, 5000, video_effect="none"),
            make_slot("z_none", "emphasis", 60000, 65000, video_effect="none"),
        ]
        self.assertEqual(select_video_effects(slots, identity_segments(300000)), [])

    def test_manual_effects_ignore_auto_toggles_caps_gaps_and_semantic_type(self):
        slots = [
            make_slot("m1", "default", 0, 500, video_effect="zoom"),  # 自動の最小尺未満・対象外type
            make_slot("m2", "default", 1000, 1500, video_effect="zoom"),  # 手動同士の間隔も不問
            make_slot("m3", "default", 2000, 2500, video_effect="pinch"),
            make_slot("m4", "default", 3000, 3500, video_effect="pinch"),
            make_slot("m5", "default", 4000, 4500, video_effect="pinch"),
            make_slot("m6", "default", 5000, 5500, video_effect="pinch"),  # 自動上限3超
        ]
        effects = select_video_effects(
            slots,
            identity_segments(300000),
            op_clip_source_ranges=[(0, 6000)],
            enabled={"pinch": False, "zoom": False},
        )
        self.assertEqual([effect["slot_id"] for effect in effects], [f"m{i}" for i in range(1, 7)])
        self.assertEqual([effect["type"] for effect in effects], ["zoom", "zoom", "pinch", "pinch", "pinch", "pinch"])

    def test_automatic_candidates_do_not_overlap_manual_intervals(self):
        slots = [
            make_slot("manual", "default", 10000, 20000, video_effect="zoom"),
            make_slot("auto_overlap", "harsh", 12000, 18000),
            make_slot("auto_safe", "harsh", 60000, 65000),
            make_slot("auto_zoom_overlap", "emphasis", 15000, 19000),
            make_slot("auto_zoom_safe", "emphasis", 100000, 105000),
        ]
        effects = select_video_effects(slots, identity_segments(300000))
        self.assertEqual(
            {(effect["slot_id"], effect["type"]) for effect in effects},
            {("manual", "zoom"), ("auto_safe", "pinch"), ("auto_zoom_safe", "zoom")},
        )

    def test_cut_slots_are_dropped_and_op_offset_applied(self):
        # セグメント外(カット済み)のスロットは落ち、OPオフセット分タイムラインへずれる
        segments = [
            {"source_start_ms": 10000, "source_end_ms": 30000, "timeline_start_ms": 5000},
            {"source_start_ms": 60000, "source_end_ms": 90000, "timeline_start_ms": 25000},
        ]
        slots = [
            make_slot("cut", "harsh", 40000, 50000),  # どのセグメントにも属さない
            make_slot("h1", "harsh", 12000, 18000),  # 1つ目のセグメント内
            make_slot("h2", "harsh", 85000, 93000),  # 2つ目のセグメント末尾でクランプ
        ]
        effects = select_video_effects(slots, segments)
        by_id = {e["slot_id"]: e for e in effects}
        self.assertNotIn("cut", by_id)
        self.assertEqual((by_id["h1"]["start_ms"], by_id["h1"]["end_ms"]), (7000, 13000))
        # h2: source 85000-93000 → セグメント2(60000-90000, timeline 25000-55000)内へクランプ
        self.assertEqual((by_id["h2"]["start_ms"], by_id["h2"]["end_ms"]), (50000, 55000))
        # 中点がセグメント外(ちょうど終端以降)のスロットは脱落する
        boundary = select_video_effects([make_slot("edge", "harsh", 85000, 95000)], segments)
        self.assertEqual(boundary, [])

    def test_too_short_and_invalid_slots_are_dropped(self):
        slots = [
            make_slot("short", "harsh", 0, 500),  # 最小尺未満
            {"slot_id": "broken", "type": "harsh", "source_start_ms": "x", "source_end_ms": 100},
            "not a dict",
        ]
        self.assertEqual(select_video_effects(slots, identity_segments(300000)), [])
        self.assertEqual(select_video_effects([], identity_segments(300000)), [])
        self.assertEqual(select_video_effects(None, identity_segments(300000)), [])

    def test_results_sorted_and_ids_sequential(self):
        slots = [
            make_slot("z1", "emphasis", 100000, 105000),
            make_slot("h1", "harsh", 10000, 15000),
        ]
        effects = select_video_effects(slots, identity_segments(300000))
        self.assertEqual([e["id"] for e in effects], ["ve_001", "ve_002"])
        self.assertEqual([e["start_ms"] for e in effects], [10000, 100000])


def make_cut(start_ms, end_ms, face_box=None, cut_id=""):
    """select_video_effects の cuts 引数(timeline基準のカット対応表)1件。"""
    return {"id": cut_id, "start_ms": start_ms, "end_ms": end_ms, "face_box": face_box}


# 中心(0.5, 0.3) → face_zoom focus は目線基準で (0.5, 0.25)
FACE_BOX = {"x": 0.4, "y": 0.2, "w": 0.2, "h": 0.2}


class PhaseCSelectionTests(unittest.TestCase):
    """フェーズW24 Phase C: dim / face_zoom / slow_push の選定(いずれも既定OFF)。"""

    def test_new_effects_are_off_by_default(self):
        # 設定なし(既存run・既存テーマ)では強調系はzoomのみ・ctaは何も付かず・
        # slow_pushも入らない=従来動作
        slots = [
            make_slot("e1", "emphasis", 10000, 15000),
            make_slot("c1", "cta", 100000, 105000),
        ]
        cuts = [make_cut(0, 300000, face_box=FACE_BOX, cut_id="cut_001")]
        effects = select_video_effects(slots, identity_segments(300000), cuts=cuts)
        self.assertEqual([(e["slot_id"], e["type"]) for e in effects], [("e1", "zoom")])

    def test_dim_selected_from_emphasis_types_capped_with_45s_gap(self):
        # 強調系(emphasis/quote/punchline)から最大2件・45秒間隔(連発しない)。
        # zoomをOFFにして競合を除いた純粋な dim の規則を見る
        slots = [
            make_slot("d1", "emphasis", 0, 5000),
            make_slot("d2", "quote", 30000, 35000),      # d1と25秒差→落ちる
            make_slot("d3", "punchline", 100000, 105000),  # d1と95秒差→残る
            make_slot("d4", "emphasis", 200000, 205000),   # 上限2件で打ち切り
            make_slot("h1", "harsh", 250000, 255000),      # dim対象外type(pinchのまま)
        ]
        effects = select_video_effects(
            slots,
            identity_segments(300000),
            enabled={"zoom": False, "dim": True},
        )
        by_type = {(e["slot_id"], e["type"]) for e in effects}
        self.assertEqual(by_type, {("d1", "dim"), ("d3", "dim"), ("h1", "pinch")})
        dim = next(e for e in effects if e["type"] == "dim")
        self.assertEqual(dim["params"], {"opacity": DIM_OPACITY})
        self.assertNotIn("sfx", dim)

    def test_dim_does_not_stack_on_same_cut_as_zoom(self):
        # 同一カットに複数エフェクトを重ねない: zoomが選んだカットのdim候補は
        # (区間が重ならなくても)除外される
        slots = [
            make_slot("e1", "emphasis", 0, 5000),       # zoomが取る
            make_slot("q1", "quote", 50000, 55000),     # 同じカット→dimは入らない
            make_slot("q2", "quote", 70000, 75000),     # 別カット→dimが入る
        ]
        cuts = [make_cut(0, 60000, cut_id="cut_001"), make_cut(60000, 120000, cut_id="cut_002")]
        effects = select_video_effects(
            slots,
            identity_segments(300000),
            enabled={"dim": True},
            cuts=cuts,
        )
        self.assertEqual(
            {(e["slot_id"], e["type"]) for e in effects},
            {("e1", "zoom"), ("q2", "dim")},
        )

    def test_face_zoom_requires_face_box_and_uses_eye_based_focus(self):
        # 訴求系(cta/hype)のうち face_box のあるカットのスロットだけが自動選定される
        slots = [
            make_slot("c1", "cta", 10000, 15000),    # 顔ありカット→選定
            make_slot("c2", "cta", 100000, 105000),  # 顔なしカット→選定しない
        ]
        cuts = [
            make_cut(0, 60000, face_box=FACE_BOX, cut_id="cut_001"),
            make_cut(60000, 300000, face_box=None, cut_id="cut_002"),
        ]
        effects = select_video_effects(
            slots,
            identity_segments(300000),
            enabled={"zoom": False, "face_zoom": True},
            cuts=cuts,
        )
        self.assertEqual([(e["slot_id"], e["type"]) for e in effects], [("c1", "face_zoom")])
        self.assertEqual(
            effects[0]["params"],
            {"scale": FACE_ZOOM_SCALE, "focus": {"x": 0.5, "y": 0.25}},
        )
        # カット対応表なし(旧呼び出し・横型)では顔が判定できないため自動選定しない
        no_cuts = select_video_effects(
            slots,
            identity_segments(300000),
            enabled={"zoom": False, "face_zoom": True},
        )
        self.assertEqual(no_cuts, [])

    def test_manual_face_zoom_without_face_falls_back_to_upper_center(self):
        # 手動指定はONトグル不要で尊重し、顔が無ければ中央上寄りfocusへフォールバック
        slots = [make_slot("m1", "default", 10000, 15000, video_effect="face_zoom")]
        effects = select_video_effects(slots, identity_segments(300000))
        self.assertEqual([(e["slot_id"], e["type"]) for e in effects], [("m1", "face_zoom")])
        self.assertEqual(
            effects[0]["params"],
            {"scale": FACE_ZOOM_SCALE, "focus": dict(FACE_ZOOM_FALLBACK_FOCUS)},
        )

    def test_slow_push_fills_free_cuts_full_length(self):
        # 他の効果が入っていない・3秒以上のカット全長に入る(単調回避の常用モーション)
        slots = [make_slot("e1", "emphasis", 1000, 4000)]  # cut_001をzoomが使う
        cuts = [
            make_cut(0, 10000, cut_id="cut_001"),
            make_cut(10000, 12000, cut_id="cut_002"),   # 2秒→短すぎて入らない
            make_cut(12000, 30000, cut_id="cut_003"),
        ]
        effects = select_video_effects(
            slots,
            identity_segments(300000),
            enabled={"slow_push": True},
            cuts=cuts,
        )
        self.assertEqual(
            [(e["type"], e["start_ms"], e["end_ms"]) for e in effects],
            [("zoom", 1000, 4000), ("slow_push", 12000, 30000)],
        )
        slow_push = effects[1]
        self.assertEqual(slow_push["slot_id"], "cut_003")
        self.assertEqual(slow_push["params"], {"scale": SLOW_PUSH_SCALE})

    def test_manual_slow_push_expands_to_full_cut(self):
        # 手動slow_pushはカット全長の効果なので、属するカットの全長へ広がる
        slots = [make_slot("m1", "default", 14000, 16000, video_effect="slow_push")]
        cuts = [make_cut(12000, 30000, cut_id="cut_003")]
        effects = select_video_effects(slots, identity_segments(300000), cuts=cuts)
        self.assertEqual(
            [(e["type"], e["start_ms"], e["end_ms"]) for e in effects],
            [("slow_push", 12000, 30000)],
        )

    def test_manual_dim_respected_when_toggle_off(self):
        # dimトグルOFFでも手動指定は尊重される(既存pinch/zoomの手動規則と同じ)
        slots = [make_slot("m1", "default", 10000, 15000, video_effect="dim")]
        effects = select_video_effects(
            slots,
            identity_segments(300000),
            enabled={"pinch": False, "zoom": False},
        )
        self.assertEqual([(e["slot_id"], e["type"]) for e in effects], [("m1", "dim")])
        self.assertEqual(effects[0]["params"], {"opacity": DIM_OPACITY})


if __name__ == "__main__":
    unittest.main()


class DimPriorityTests(unittest.TestCase):
    """フェーズW26: dim_priority=True(縦型)はdimをzoomより先に選定する。

    emphasisはzoom候補でもあるため、既定順(zoom先行)だと決めゼリフのカットが
    zoomに占有されてdimが入らない。縦型は「暗転+明朝」がデザインの核なのでdim優先。
    """

    def _run(self, dim_priority):
        slots = [make_slot("e1", "emphasis", 10000, 15000)]
        cuts = [{"id": "cut_001", "start_ms": 0, "end_ms": 30000, "face_box": None}]
        return select_video_effects(
            slots,
            identity_segments(30000),
            enabled={"dim": True},
            cuts=cuts,
            dim_priority=dim_priority,
        )

    def test_default_order_picks_zoom(self):
        """既定(横型)はzoom先行=従来動作のまま。"""
        types = [e["type"] for e in self._run(dim_priority=False)]
        self.assertEqual(types, ["zoom"])

    def test_dim_priority_picks_dim(self):
        """dim優先(縦型)は同じスロットがdimになり、同一カットにzoomは入らない。"""
        types = [e["type"] for e in self._run(dim_priority=True)]
        self.assertEqual(types, ["dim"])

    def test_dim_priority_zoom_survives_in_other_cut(self):
        """dimのカット外のzoom候補(hype)は引き続き選ばれる。"""
        slots = [
            make_slot("e1", "emphasis", 10000, 15000),
            make_slot("h1", "hype", 40000, 45000),
        ]
        cuts = [
            {"id": "cut_001", "start_ms": 0, "end_ms": 30000, "face_box": None},
            {"id": "cut_002", "start_ms": 30000, "end_ms": 60000, "face_box": None},
        ]
        effects = select_video_effects(
            slots,
            identity_segments(60000),
            enabled={"dim": True},
            cuts=cuts,
            dim_priority=True,
        )
        self.assertEqual(sorted(e["type"] for e in effects), ["dim", "zoom"])
