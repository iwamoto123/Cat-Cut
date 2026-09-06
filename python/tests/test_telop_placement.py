"""フェーズW24 Phase A-2: telop_placement(縦型セーフゾーン・顔回避配置)のテスト。

ケース表 remotion/tests/adSafeZoneCases.json は generate_ad_safe_zone_cases.py が
Python実装の実出力から生成し、TS側(remotion/desktop の adSafeZone.test.ts)も
同じ表を検証する。ここではPython実装がケース表と一致し続けること(=生成後に
実装だけ変えた場合の検出)と、定数の同期を確認する。
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from shared import telop_placement as tp

CASES_PATH = os.path.abspath(os.path.join(
    os.path.dirname(__file__), "..", "..", "remotion", "tests", "adSafeZoneCases.json",
))


def load_cases():
    with open(CASES_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


class TelopPlacementCaseTableTests(unittest.TestCase):
    """TS(adSafeZone.ts)と共有する同一ケース表での検証。"""

    def test_constants_match_case_table(self):
        data = load_cases()
        self.assertEqual(data["constants"], {
            "TELOP_BAND_TOP": tp.TELOP_BAND_TOP,
            "TELOP_BAND_BOTTOM": tp.TELOP_BAND_BOTTOM,
            "VERTICAL_DEFAULT_TELOP_Y": tp.VERTICAL_DEFAULT_TELOP_Y,
            "LOWER_BAND_TOP": tp.LOWER_BAND_TOP,
            "LOWER_BAND_BOTTOM": tp.LOWER_BAND_BOTTOM,
            "UPPER_BAND_TOP": tp.UPPER_BAND_TOP,
            "UPPER_BAND_BOTTOM": tp.UPPER_BAND_BOTTOM,
            "VERTICAL_UPPER_DEFAULT_TELOP_Y": tp.VERTICAL_UPPER_DEFAULT_TELOP_Y,
            "FACE_TELOP_MARGIN": tp.FACE_TELOP_MARGIN,
            "DEFAULT_BLOCK_HEIGHT_RATIO": tp.DEFAULT_BLOCK_HEIGHT_RATIO,
        })

    def test_all_cases_match(self):
        data = load_cases()
        self.assertGreaterEqual(len(data["cases"]), 10)
        for case in data["cases"]:
            params = case["input"]
            with self.subTest(case["name"]):
                actual = tp.resolve_cut_telop_y(
                    orientation=params["orientation"],
                    base_telop_y=params["base_telop_y"],
                    face_box=params.get("face_box"),
                    block_height_ratio=params.get(
                        "block_height_ratio", tp.DEFAULT_BLOCK_HEIGHT_RATIO,
                    ),
                    style_offset=params.get("style_offset", 0.0),
                )
                self.assertEqual(actual, case["expected"])


class TelopPlacementBehaviorTests(unittest.TestCase):
    """ケース表を補完する性質テスト(帯の不変条件・概算高さ)。"""

    def test_vertical_results_always_inside_band(self):
        """縦型の結果は顔の位置によらず必ず許容帯(0.30〜0.72)内。"""
        for y in (0.0, 0.2, 0.4, 0.6, 0.8):
            for h in (0.1, 0.3, 0.5, 0.9):
                result = tp.resolve_cut_telop_y(
                    orientation="vertical",
                    base_telop_y=0.75,
                    face_box={"x": 0.3, "y": y, "w": 0.4, "h": h},
                )
                self.assertGreaterEqual(result, tp.TELOP_BAND_TOP)
                self.assertLessEqual(result, tp.TELOP_BAND_BOTTOM)

    def test_horizontal_never_touches_base(self):
        """横型はクランプも丸めもせず素通し(完全従来動作)。"""
        self.assertEqual(
            tp.resolve_cut_telop_y(orientation="horizontal", base_telop_y=0.85001),
            0.85001,
        )

    def test_estimate_block_height_ratio(self):
        # 1行: (1*1.4*52 + 0) / 1920
        self.assertAlmostEqual(
            tp.estimate_block_height_ratio(1, 52, 1920), (1.4 * 52) / 1920,
        )
        # 2行: (2*1.4*52 + 8) / 1920 (行間ギャップ8px込み)
        self.assertAlmostEqual(
            tp.estimate_block_height_ratio(2, 52, 1920), (2 * 1.4 * 52 + 8) / 1920,
        )
        # 高さ不明(0)は既定比率へフォールバック
        self.assertEqual(
            tp.estimate_block_height_ratio(2, 52, 0), tp.DEFAULT_BLOCK_HEIGHT_RATIO,
        )
        # 0行は1行として扱う
        self.assertAlmostEqual(
            tp.estimate_block_height_ratio(0, 52, 1920), (1.4 * 52) / 1920,
        )


if __name__ == "__main__":
    unittest.main()
