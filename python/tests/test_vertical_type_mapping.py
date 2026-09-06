"""フェーズW26: 縦型ショート用type mapping(vertical_type_styles)のテスト。"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shared.telop_types import ANIMATION_IN_TYPES, SEMANTIC_TYPES, load_type_mapping_entries

# 縦型デザインシステムで許可するプリセット(4スタイル集約。Fable v5「1画面1スタイル」原則)
VERTICAL_AD_PRESETS = {"ad_gothic_impact", "ad_mincho_impact", "ad_highlight_band", "ad_urgent_band"}


class TestVerticalTypeMapping(unittest.TestCase):
    def test_vertical_overrides_all_types_with_ad_presets(self):
        """縦型は全typeが広告デザインシステム(4スタイル)へ集約される。"""
        entries = load_type_mapping_entries(orientation="vertical")
        for semantic_type in SEMANTIC_TYPES:
            entry = entries[semantic_type]
            self.assertIn(
                entry["style"], VERTICAL_AD_PRESETS,
                f"{semantic_type} が広告プリセット以外にマップされている: {entry['style']}",
            )
            # W26: 全typeに強いアニメが割当たっている(動きが弱い対策)
            self.assertIn(entry.get("animation_in"), ANIMATION_IN_TYPES)
            self.assertNotEqual(entry.get("animation_in"), "none")

    def test_horizontal_unchanged(self):
        """横型(orientation未指定・horizontal)は従来のマッピングのまま。"""
        for orientation in (None, "horizontal"):
            entries = load_type_mapping_entries(orientation=orientation)
            self.assertEqual(entries["default"]["style"], "fact_yellow")
            self.assertEqual(entries["cta"]["style"], "cta_yellow")

    def test_user_horizontal_styles_do_not_break_vertical(self):
        """フェーズW30: ユーザーJSONの type_styles(横型デザインテーマの保存値)は
        縦型デザインシステムを壊さない。

        実データ: 2026-07-07保存のユーザーJSONが全typeを横型スタイルへ戻し、
        縦型の広告スタイルとアクセント割当(斜め・特大・縦書き)が全滅していた。
        """
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump({"type_styles": {"default": "fact_yellow", "cta": "cta_yellow"}}, f)
            user_file = f.name
        try:
            entries = load_type_mapping_entries(user_file=user_file, orientation="vertical")
            self.assertEqual(entries["default"]["style"], "ad_gothic_impact")
            self.assertEqual(entries["cta"]["style"], "ad_highlight_band")
            # 横型ではユーザー上書きが従来どおり効く
            horizontal = load_type_mapping_entries(user_file=user_file, orientation="horizontal")
            self.assertEqual(horizontal["default"]["style"], "fact_yellow")
        finally:
            Path(user_file).unlink(missing_ok=True)

    def test_user_vertical_styles_win_over_vertical_defaults(self):
        """ユーザーJSONが縦型用(vertical_type_styles)を明示した場合のみ縦型既定を上書きする。"""
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(
                {
                    "type_styles": {"default": "fact_yellow"},
                    "vertical_type_styles": {"default": "biz_white"},
                },
                f,
            )
            user_file = f.name
        try:
            entries = load_type_mapping_entries(user_file=user_file, orientation="vertical")
            self.assertEqual(entries["default"]["style"], "biz_white")
            # 明示していないtypeは縦型既定のまま
            self.assertEqual(entries["cta"]["style"], "ad_highlight_band")
        finally:
            Path(user_file).unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
