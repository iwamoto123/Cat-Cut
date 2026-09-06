"""フェーズU6(テロップデザイン詳細エディタ)のPython側テスト。

1. shared/telop_types: sanitize_custom_styles / load_custom_styles(実行時マッピングJSONのcustom_styles読取)
2. shared/direction: sanitize_style / effective_slot_style の allowed_custom 許可
3. step08_composition: custom_styles の composition timeline.telop_styles への注入
   (テーマ由来=--type-mapping同梱 と シーン個別=telop_directives.json の両経路)
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shared.direction import (
    DEFAULT_DIRECTIVE_STYLE,
    build_directed_cut_content,
    effective_slot_style,
    sanitize_style,
)
from shared.telop_types import load_custom_styles, sanitize_custom_styles

CUSTOM_DEF = {
    "font_size": 72,
    "fill": {"type": "solid", "color": "#FF00AA"},
    "outer_stroke2": {"color": "#FFFFFF", "width": 30},
    "glow": {"color": "#00E5FF", "radius": 12},
}


class SanitizeCustomStylesTests(unittest.TestCase):
    """sanitize_custom_styles / load_custom_styles。"""

    def test_keeps_only_dict_entries_with_fill(self):
        result = sanitize_custom_styles(
            {
                "custom_theme_x_emphasis": CUSTOM_DEF,
                "broken_no_fill": {"font_size": 72},
                "broken_str": "red",
                "": CUSTOM_DEF,
                123: CUSTOM_DEF,  # 数値キーはstr化されて残る
            }
        )
        self.assertIn("custom_theme_x_emphasis", result)
        self.assertNotIn("broken_no_fill", result)
        self.assertNotIn("broken_str", result)
        self.assertNotIn("", result)
        self.assertIn("123", result)
        # 定義は素通し(描画側スキーマはyamlプリセットと同じ扱い)
        self.assertEqual(result["custom_theme_x_emphasis"]["glow"], {"color": "#00E5FF", "radius": 12})

    def test_non_dict_input_returns_empty(self):
        self.assertEqual(sanitize_custom_styles(None), {})
        self.assertEqual(sanitize_custom_styles([CUSTOM_DEF]), {})
        self.assertEqual(sanitize_custom_styles("x"), {})

    def test_load_custom_styles_from_mapping_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "telop_type_mapping.effective.json"
            path.write_text(
                json.dumps(
                    {
                        "version": "2.0",
                        "type_styles": {"emphasis": {"style": "custom_t_emphasis"}},
                        "custom_styles": {"custom_t_emphasis": CUSTOM_DEF, "broken": {}},
                    }
                ),
                encoding="utf-8",
            )
            styles = load_custom_styles(path)
            self.assertEqual(list(styles), ["custom_t_emphasis"])

    def test_load_custom_styles_missing_or_broken_file(self):
        self.assertEqual(load_custom_styles(None), {})
        self.assertEqual(load_custom_styles("/no/such/file.json"), {})
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "broken.json"
            path.write_text("{not json", encoding="utf-8")
            self.assertEqual(load_custom_styles(path), {})


class SanitizeStyleCustomTests(unittest.TestCase):
    """sanitize_style / effective_slot_style の allowed_custom 許可。"""

    def test_sanitize_style_rejects_custom_without_definition(self):
        # 定義の無いカスタムIDは従来どおり既定へフォールバック(描画不能なIDを通さない)
        self.assertEqual(sanitize_style("custom_scene_s1"), DEFAULT_DIRECTIVE_STYLE)

    def test_sanitize_style_allows_custom_with_definition(self):
        allowed = frozenset({"custom_scene_s1"})
        self.assertEqual(sanitize_style("custom_scene_s1", allowed), "custom_scene_s1")
        # 許可リスト外のカスタムIDは弾く
        self.assertEqual(sanitize_style("custom_scene_other", allowed), DEFAULT_DIRECTIVE_STYLE)
        # 既存の許可スタイルはそのまま
        self.assertEqual(sanitize_style("emotion_red", allowed), "emotion_red")

    def test_effective_slot_style_custom_override(self):
        slot = {"style": "custom_scene_s1", "style_overridden": True, "type": "default"}
        self.assertEqual(
            effective_slot_style(slot, allowed_custom=frozenset({"custom_scene_s1"})),
            "custom_scene_s1",
        )
        # 定義なし(allowed_custom空)なら type×マッピングへフォールバック
        self.assertEqual(effective_slot_style(slot), DEFAULT_DIRECTIVE_STYLE)

    def test_effective_slot_style_custom_via_type_mapping(self):
        # テーマのtype_stylesがカスタムIDを指すケース(custom_<theme>_<type>)
        slot = {"type": "emphasis"}
        mapping = {"emphasis": "custom_t_emphasis"}
        self.assertEqual(
            effective_slot_style(slot, mapping, allowed_custom=frozenset({"custom_t_emphasis"})),
            "custom_t_emphasis",
        )
        self.assertEqual(effective_slot_style(slot, mapping), DEFAULT_DIRECTIVE_STYLE)

    def test_build_directed_cut_content_passes_custom_style(self):
        words = [{"text": "テスト", "start_ms": 0, "end_ms": 1000}]
        slots = [
            {
                "slot_id": "s1",
                "start_ms": 0,
                "end_ms": 1000,
                "text": "テスト",
                "style": "custom_scene_s1",
                "style_overridden": True,
                "highlight_words": [],
            }
        ]
        _pages, telops = build_directed_cut_content(
            "cut_001", slots, words, 1000, 13, allowed_custom_styles=frozenset({"custom_scene_s1"})
        )
        self.assertEqual(len(telops), 1)
        self.assertEqual(telops[0]["style"], "custom_scene_s1")


class Step08CustomStyleInjectionTests(unittest.TestCase):
    """step08のcustom_styles収集ロジック(モジュール関数を直接検証)。

    step08本体のrunは動画・音声等の入出力が重いため、注入に使う関数の組み合わせ
    (load_custom_styles + sanitize_custom_styles → telop_stylesへupdate)を単体で検証し、
    composition構造への反映はソースの結線(telop_stylesへのupdate)をテストする。
    """

    def test_theme_and_scene_custom_styles_merge_into_telop_styles(self):
        with tempfile.TemporaryDirectory() as tmp:
            mapping_path = Path(tmp) / "telop_type_mapping.effective.json"
            mapping_path.write_text(
                json.dumps({"custom_styles": {"custom_theme_a_cta": CUSTOM_DEF}}),
                encoding="utf-8",
            )
            directives = {"custom_styles": {"custom_scene_s1": CUSTOM_DEF, "bad": {}}}

            custom_styles = {}
            custom_styles.update(load_custom_styles(mapping_path))
            custom_styles.update(sanitize_custom_styles(directives.get("custom_styles")))

            composition = {"timeline": {"telop_styles": {"fact_yellow": {"fill": {}}}}}
            composition.setdefault("timeline", {}).setdefault("telop_styles", {}).update(custom_styles)

            styles = composition["timeline"]["telop_styles"]
            self.assertIn("fact_yellow", styles)
            self.assertIn("custom_theme_a_cta", styles)
            self.assertIn("custom_scene_s1", styles)
            self.assertNotIn("bad", styles)
            self.assertEqual(styles["custom_scene_s1"]["outer_stroke2"], {"color": "#FFFFFF", "width": 30})

    def test_step08_source_wires_custom_styles(self):
        # 結線の存在確認(コード構造テスト): step08がcustom_stylesを収集しtelop_stylesへ注入している
        source = (Path(__file__).resolve().parents[1] / "step08_composition.py").read_text(encoding="utf-8")
        self.assertIn("load_custom_styles(type_mapping_path)", source)
        self.assertIn('sanitize_custom_styles(directives.get("custom_styles"))', source)
        self.assertIn('setdefault("telop_styles", {}).update(custom_styles)', source)
        self.assertIn("allowed_custom_styles=frozenset(custom_styles)", source)


if __name__ == "__main__":
    unittest.main()
