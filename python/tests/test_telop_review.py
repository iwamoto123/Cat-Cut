import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from shared.transcript_correction import Correction
from review_telop import apply_safe_changes, parse_telop, render_telop, review_pages


class TelopReviewTests(unittest.TestCase):
    def test_safe_review_fixes_known_telop_mistakes(self):
        text = """# Cat-Cut telop file

# cut_001_p00 [00:00.00-00:02.00]
キャット カットも
しくはテロップ作成

# cut_002_p00 [00:02.00-00:03.00]
で

# cut_003_p00 [00:03.00-00:04.00]
お願いします
お願いします
"""
        corrections = [
            Correction("キャット カット", "Cat-Cut", "domain_terms"),
            Correction("テロップ作成", "テロップ制作", "domain_terms"),
        ]

        preamble, pages = parse_telop(text)
        findings = review_pages(pages, corrections)
        self.assertTrue(any(item["type"] == "dictionary" for item in findings))
        self.assertTrue(any(item["type"] == "line_break" for item in findings))
        self.assertTrue(any(item["type"] == "filler_only" for item in findings))
        self.assertTrue(any(item["type"] == "duplicate_line" for item in findings))

        cleaned_pages, applied = apply_safe_changes(pages, corrections)
        cleaned = render_telop(preamble, cleaned_pages)

        self.assertIn("Cat-Cut\nもしくはテロップ制作", cleaned)
        self.assertNotIn("\nで\n", cleaned)
        self.assertEqual(cleaned.count("お願いします"), 1)
        self.assertGreaterEqual(len(applied), 4)

    def test_cli_writes_review_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            telop_path = run_dir / "telop.txt"
            dictionary_path = run_dir / "dict.yaml"
            telop_path.write_text(
                "# cut_001_p00 [00:00.00-00:01.00]\nキャットカットで編集\n",
                encoding="utf-8",
            )
            dictionary_path.write_text("domain_terms:\n  キャットカット: Cat-Cut\n", encoding="utf-8")

            from review_telop import main

            old_argv = sys.argv
            try:
                sys.argv = [
                    "review_telop.py",
                    str(run_dir),
                    "--dictionary",
                    str(dictionary_path),
                    "--apply-safe",
                ]
                main()
            finally:
                sys.argv = old_argv

            self.assertIn("Cat-Cutで編集", telop_path.read_text(encoding="utf-8"))
            self.assertTrue((run_dir / "telop_review.json").exists())


if __name__ == "__main__":
    unittest.main()
