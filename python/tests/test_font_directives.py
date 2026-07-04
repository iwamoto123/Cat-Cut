import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from apply_font_directives import apply_plan_to_composition, parse_directives


class FontDirectivesTests(unittest.TestCase):
    def test_parses_pattern_count_and_font_profiles(self):
        plan = parse_directives(
            "\n".join(
                [
                    "使うフォントパターンは3つ。",
                    "通常は、太めで読みやすいゴシック。",
                    "強調は、丸みがあって目立つフォント。",
                    "注意は、角ばって強い印象のフォント。",
                ]
            )
        )

        self.assertEqual(plan["pattern_count"], 3)
        self.assertEqual([p["preset"] for p in plan["patterns"]], ["default", "highlight", "warning"])
        self.assertEqual([p["profile"] for p in plan["patterns"]], ["readable_gothic", "rounded_gothic", "strong_gothic"])

    def test_applies_font_family_to_composition_styles(self):
        plan = parse_directives("使うフォントパターンは2つ。\n通常は読みやすく。\n強調は丸ゴシック。")
        composition = {
            "timeline": {
                "telop_styles": {
                    "default": {"font_size": 72},
                    "highlight": {"font_size": 96},
                }
            }
        }

        apply_plan_to_composition(composition, plan)

        styles = composition["timeline"]["telop_styles"]
        self.assertIn("font_family", styles["default"])
        self.assertIn("font_family", styles["highlight"])
        self.assertEqual(composition["timeline"]["font_plan"]["pattern_count"], 2)

    def test_parses_explicit_google_font_and_parameters(self):
        plan = parse_directives("使うフォントパターンは1つ。\n通常は、フォント[Noto Sans JP] 太さ[700] サイズ[80]。")
        pattern = plan["patterns"][0]

        self.assertEqual(pattern["google_font"], "Noto Sans JP")
        self.assertEqual(pattern["font_weight"], 700)
        self.assertEqual(pattern["font_size"], 80)
        self.assertIn("Noto Sans JP", pattern["font_family"])

    def test_one_pattern_applies_to_all_presets(self):
        plan = parse_directives("使うフォントパターンは1つ。\n全テロップをMochiy Pop Oneみたいな可愛いポップ体にする。")
        composition = {
            "timeline": {
                "telop_styles": {
                    "default": {"font_size": 72},
                    "highlight": {"font_size": 96},
                    "question": {"font_size": 68},
                }
            }
        }

        apply_plan_to_composition(composition, plan)

        styles = composition["timeline"]["telop_styles"]
        self.assertIn("Mochiy Pop One", styles["default"]["font_family"])
        self.assertIn("Mochiy Pop One", styles["highlight"]["font_family"])
        self.assertIn("Mochiy Pop One", styles["question"]["font_family"])
        self.assertEqual(styles["highlight"]["font_weight"], 400)

    def test_cli_writes_plan_without_api(self):
        # Keeps the parser importable and JSON-serializable for the Electron app.
        plan = parse_directives("三つ。通常はゴシック。強調は丸く。注意は明朝。")
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "font_plan.json"
            path.write_text(json.dumps(plan, ensure_ascii=False), encoding="utf-8")
            loaded = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(loaded["pattern_count"], 3)


if __name__ == "__main__":
    unittest.main()
