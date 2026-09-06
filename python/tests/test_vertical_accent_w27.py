"""フェーズW27: 縦型ショートのアクセントスタイル自動割当(特大・縦書き・斜め)のテスト。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shared.direction import (
    VERTICAL_ACCENT_MIN_GAP_MS,
    VERTICAL_STANDARD_ANIMATION_POOL,
    assign_vertical_accent_styles,
    assign_vertical_animation_variety,
)


def _make(cut_id, start_ms, telops):
    cut = {
        "cut_id": cut_id,
        "timeline": {"start_ms": start_ms, "end_ms": start_ms + 60000},
        "telop": {"pages": [{"id": t["id"], "style": t["style"]} for t in telops]},
    }
    vcut = {"id": cut_id, "telops": telops}
    return cut, vcut


class TestAccentAssignment(unittest.TestCase):
    def test_length_and_type_select_accent_style(self):
        """≦8文字は勢い系=特大/決め系=縦書き、9-18文字は斜め、19文字以上は対象外。"""
        telops = [
            {"id": "p0", "style": "ad_mincho_impact", "type": "punchline", "text": "逆転合格", "start": 0.0},
            {"id": "p1", "style": "ad_mincho_impact", "type": "emphasis", "text": "先着15名限定", "start": 20.0},
            {"id": "p2", "style": "ad_gothic_impact", "type": "surprise", "text": "実はこの方法が一番早いです", "start": 40.0},
            {"id": "p3", "style": "ad_mincho_impact", "type": "quote", "text": "これは十八文字の上限を超える長い決めゼリフです", "start": 55.0},
        ]
        cut, vcut = _make("cut_001", 0, telops)
        assigned = assign_vertical_accent_styles([cut], [vcut])
        self.assertEqual(assigned, 3)
        self.assertEqual(telops[0]["style"], "ad_vertical_mincho")  # 決め系の短文=縦書き
        self.assertEqual(telops[0]["animation_in"], "zoom")
        self.assertEqual(telops[1]["style"], "ad_mega_impact")  # 勢い系の短文=特大
        self.assertEqual(telops[1]["animation_in"], "slam")
        self.assertEqual(telops[2]["style"], "ad_slant_impact")  # 中文=斜め
        self.assertEqual(telops[3]["style"], "ad_mincho_impact")  # 長文は対象外
        # pages側も同期する
        self.assertEqual(cut["telop"]["pages"][0]["style"], "ad_vertical_mincho")

    def test_min_gap_prevents_consecutive_accents(self):
        """直前のアクセントから12秒未満は割り当てない(連発防止)。"""
        telops = [
            {"id": "p0", "style": "ad_mincho_impact", "type": "emphasis", "text": "無料", "start": 0.0},
            {"id": "p1", "style": "ad_mincho_impact", "type": "emphasis", "text": "今だけ", "start": 5.0},
            {"id": "p2", "style": "ad_mincho_impact", "type": "emphasis", "text": "先着順", "start": VERTICAL_ACCENT_MIN_GAP_MS / 1000.0 + 1},
        ]
        cut, vcut = _make("cut_001", 0, telops)
        assigned = assign_vertical_accent_styles([cut], [vcut])
        self.assertEqual(assigned, 2)
        self.assertEqual(telops[0]["style"], "ad_mega_impact")
        self.assertEqual(telops[1]["style"], "ad_mincho_impact")  # 5秒後はスキップ
        self.assertEqual(telops[2]["style"], "ad_mega_impact")

    def test_ignores_weak_types_bands_and_overrides(self):
        """default型・帯スタイル・ユーザー上書きは対象外。"""
        telops = [
            {"id": "p0", "style": "ad_gothic_impact", "type": "default", "text": "説明です", "start": 0.0},
            {"id": "p1", "style": "ad_highlight_band", "type": "cta", "text": "登録して", "start": 15.0},
            {
                "id": "p2", "style": "ad_gothic_impact", "type": "emphasis",
                "text": "上書き済み", "start": 30.0, "style_overridden": True,
            },
        ]
        cut, vcut = _make("cut_001", 0, telops)
        self.assertEqual(assign_vertical_accent_styles([cut], [vcut]), 0)
        self.assertEqual(telops[0]["style"], "ad_gothic_impact")
        self.assertEqual(telops[1]["style"], "ad_highlight_band")
        self.assertEqual(telops[2]["style"], "ad_gothic_impact")


class TestAnimationVariety(unittest.TestCase):
    """フェーズW31: 地の文テロップのシンプル系アニメローテーション。"""

    def test_standard_telops_rotate_through_simple_pool(self):
        telops = [
            {"id": f"p{i}", "style": "ad_gothic_impact", "type": "default",
             "text": f"地の文{i}", "start": float(i * 3), "animation_in": "bounce_left"}
            for i in range(6)
        ]
        cut, vcut = _make("cut_001", 0, telops)
        assigned = assign_vertical_animation_variety([cut], [vcut])
        self.assertEqual(assigned, 6)
        pool = VERTICAL_STANDARD_ANIMATION_POOL
        for i, telop in enumerate(telops):
            self.assertEqual(telop["animation_in"], pool[i % len(pool)])
        # pages側も同期する
        self.assertEqual(cut["telop"]["pages"][0].get("animation_in"), pool[0])
        # 同じアニメが連続しない(プールが2種以上ある前提)
        for prev, nxt in zip(telops, telops[1:]):
            self.assertNotEqual(prev["animation_in"], nxt["animation_in"])

    def test_accents_bands_and_overrides_keep_their_animation(self):
        telops = [
            {"id": "p0", "style": "ad_mincho_impact", "type": "emphasis",
             "text": "決めゼリフ", "start": 0.0, "animation_in": "slam"},
            {"id": "p1", "style": "ad_highlight_band", "type": "cta",
             "text": "登録して", "start": 5.0, "animation_in": "rise_bounce"},
            {"id": "p2", "style": "ad_gothic_impact", "type": "harsh",
             "text": "強い言葉", "start": 10.0, "animation_in": "bounce_right"},
            {"id": "p3", "style": "ad_gothic_impact", "type": "default",
             "text": "上書き済み", "start": 15.0, "animation_in": "slam",
             "animation_overridden": True},
        ]
        cut, vcut = _make("cut_001", 0, telops)
        self.assertEqual(assign_vertical_animation_variety([cut], [vcut]), 0)
        self.assertEqual(telops[0]["animation_in"], "slam")
        self.assertEqual(telops[1]["animation_in"], "rise_bounce")
        self.assertEqual(telops[2]["animation_in"], "bounce_right")
        self.assertEqual(telops[3]["animation_in"], "slam")


if __name__ == "__main__":
    unittest.main()
