"""フェーズW26: 縦型バンド系スタイル(黄帯CTA・赤帯)の連発抑制テスト。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shared.direction import (
    VERTICAL_BAND_FALLBACK_STYLE,
    VERTICAL_BAND_MIN_GAP_MS,
    moderate_vertical_band_styles,
)


def _make(cut_id, start_ms, telops):
    cut = {
        "cut_id": cut_id,
        "timeline": {"start_ms": start_ms, "end_ms": start_ms + 30000},
        "telop": {"pages": [{"id": t["id"], "style": t["style"]} for t in telops]},
    }
    vcut = {"id": cut_id, "telops": telops}
    return cut, vcut


class TestBandModeration(unittest.TestCase):
    def test_demotes_bands_within_min_gap(self):
        telops = [
            {"id": "p0", "style": "ad_highlight_band", "start": 0.0},
            {"id": "p1", "style": "ad_highlight_band", "start": 4.0},
            {"id": "p2", "style": "ad_highlight_band", "start": 8.0},
            {"id": "p3", "style": "ad_highlight_band", "start": 20.0},
        ]
        cut, vcut = _make("cut_001", 0, telops)
        demoted = moderate_vertical_band_styles([cut], [vcut])
        self.assertEqual(demoted, 2)
        # 先頭は帯のまま、15秒未満の2件は標準へ、20秒後は帯のまま
        self.assertEqual(telops[0]["style"], "ad_highlight_band")
        self.assertEqual(telops[1]["style"], VERTICAL_BAND_FALLBACK_STYLE)
        self.assertEqual(telops[2]["style"], VERTICAL_BAND_FALLBACK_STYLE)
        self.assertEqual(telops[3]["style"], "ad_highlight_band")
        # timeline pages側も同じIDでdemoteされる
        pages = cut["telop"]["pages"]
        self.assertEqual(pages[1]["style"], VERTICAL_BAND_FALLBACK_STYLE)
        self.assertEqual(pages[3]["style"], "ad_highlight_band")

    def test_respects_user_override(self):
        telops = [
            {"id": "p0", "style": "ad_highlight_band", "start": 0.0},
            {"id": "p1", "style": "ad_urgent_band", "start": 3.0, "style_overridden": True},
        ]
        cut, vcut = _make("cut_001", 0, telops)
        demoted = moderate_vertical_band_styles([cut], [vcut])
        self.assertEqual(demoted, 0)
        self.assertEqual(telops[1]["style"], "ad_urgent_band")

    def test_counts_across_cuts(self):
        """帯の間隔判定はカットを跨いだタイムライン絶対msで行う。"""
        t1 = [{"id": "a0", "style": "ad_highlight_band", "start": 0.0}]
        t2 = [{"id": "b0", "style": "ad_highlight_band", "start": 1.0}]
        cut1, vcut1 = _make("cut_001", 0, t1)
        cut2, vcut2 = _make("cut_002", VERTICAL_BAND_MIN_GAP_MS - 5000, t2)
        demoted = moderate_vertical_band_styles([cut1, cut2], [vcut1, vcut2])
        self.assertEqual(demoted, 1)
        self.assertEqual(t2[0]["style"], VERTICAL_BAND_FALLBACK_STYLE)

    def test_non_band_styles_untouched(self):
        telops = [
            {"id": "p0", "style": "ad_gothic_impact", "start": 0.0},
            {"id": "p1", "style": "ad_mincho_impact", "start": 2.0},
        ]
        cut, vcut = _make("cut_001", 0, telops)
        self.assertEqual(moderate_vertical_band_styles([cut], [vcut]), 0)


if __name__ == "__main__":
    unittest.main()
