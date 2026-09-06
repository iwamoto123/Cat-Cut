"""改善8-A-4: テロップページ=基本1行のテスト。

BudouX+DP のページDPは max_lines_per_page を上限としたページ長を選ぶため、
max_lines_per_page=1 を渡せば必ず1ページ=1行になる。ここでは
- 既定値 (プロジェクト未指定時) が1行/12文字になっていること
- 縦横それぞれのテンプレート既定値
- 文の区切り (句点) で自然にページが割れること
- 短い文を無理に分割しないこと
を確認する。
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shared.budoux_layout import split_pages
from shared.project_config import load_project_config
from shared.telop_builder import build_telop_pages


class DefaultConfigTests(unittest.TestCase):
    def test_default_telop_config_is_one_line(self):
        cfg = load_project_config(None)
        self.assertEqual(cfg["telop"]["max_lines_per_page"], 1)
        self.assertEqual(cfg["telop"]["max_chars_per_line"], 12)

    def test_vertical_template_is_one_line_11_chars(self):
        # W30: 12→11字(フィット幅86%で84px級フォントが縮小なしで入る行長)
        project_root = Path(__file__).resolve().parents[2]
        cfg = load_project_config(str(project_root / "templates" / "vertical.yaml"))
        self.assertEqual(cfg["telop"]["max_lines_per_page"], 1)
        self.assertEqual(cfg["telop"]["max_chars_per_line"], 11)

    def test_horizontal_template_is_one_line_16_chars(self):
        project_root = Path(__file__).resolve().parents[2]
        cfg = load_project_config(str(project_root / "templates" / "horizontal.yaml"))
        self.assertEqual(cfg["telop"]["max_lines_per_page"], 1)
        self.assertEqual(cfg["telop"]["max_chars_per_line"], 16)


class BuildTelopPagesDefaultTests(unittest.TestCase):
    def test_default_max_lines_per_page_argument_is_one(self):
        pages = build_telop_pages("今日はとても良い天気ですね。散歩に出かけましょう。", cut_id="cut_001")
        self.assertGreater(len(pages), 0)
        for page in pages:
            self.assertEqual(len(page["lines"]), 1)

    def test_long_transcript_splits_at_sentence_boundary(self):
        text = "今日はとても良い天気ですね。散歩に出かけましょう。"
        pages = build_telop_pages(text, cut_id="cut_001", max_chars_per_line=12, max_lines_per_page=1)
        self.assertEqual(len(pages), 2)
        self.assertEqual(pages[0]["lines"], ["今日はとても良い天気ですね"])
        self.assertEqual(pages[1]["lines"], ["散歩に出かけましょう"])

    def test_short_sentence_is_not_split_unnecessarily(self):
        pages = build_telop_pages("お願いします", cut_id="cut_001", max_chars_per_line=12, max_lines_per_page=1)
        self.assertEqual(len(pages), 1)
        self.assertEqual(pages[0]["lines"], ["お願いします"])

    def test_horizontal_16_chars_fits_more_per_page_than_vertical_12(self):
        text = "動画編集の副業で月に十万円を目指しましょう"
        pages_vertical = build_telop_pages(text, cut_id="cut_001", max_chars_per_line=12, max_lines_per_page=1)
        pages_horizontal = build_telop_pages(text, cut_id="cut_001", max_chars_per_line=16, max_lines_per_page=1)
        self.assertGreaterEqual(len(pages_vertical), len(pages_horizontal))
        for page in pages_horizontal:
            self.assertEqual(len(page["lines"]), 1)


class SplitPagesForcedSingleLineTests(unittest.TestCase):
    def test_max_lines_per_page_one_forces_one_line_pages_regardless_of_length(self):
        text = "これは長い文章のテストです、途中で読点もあります、最後まで一行ずつになるはずです。"
        pages = split_pages(text, max_chars_per_line=12, max_lines_per_page=1)
        for page in pages:
            self.assertEqual(len(page["lines"]), 1)


if __name__ == "__main__":
    unittest.main()
