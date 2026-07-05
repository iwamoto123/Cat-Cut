"""改善20: ページ詰め修正・超過チャンク分割・漢数字変換拡充のテスト。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shared.budoux_layout import split_pages
from shared.telop_builder import _normalize_kanji_numbers, build_telop_pages


class PagePackingImprove20Tests(unittest.TestCase):
    """20-A: 超過チャンクが後続にあってもDPが実行不能にならず、短いチャンクが詰められる。"""

    REPRO_TEXT = (
        "そもそもLinkedInってどういう媒体なの？みたいな。勉強会的な。"
        "インスタなのかYouTubeなのかXなのかいろいろあるけれども、"
    )

    def test_repro_case_packs_short_chunks(self):
        pages = split_pages(text=self.REPRO_TEXT, max_chars_per_line=16, max_lines_per_page=1)
        lines = ["".join(p["lines"]) for p in pages]
        # 「そも」「そも」「どう」「いう」のような1チャンク=1ページに退化しない
        self.assertNotIn("そも", lines)
        self.assertNotIn("どう", lines)
        self.assertIn("そもそもLinkedInって", lines)
        self.assertIn("どういう媒体なの？", lines)

    def test_repro_case_no_tiny_pages(self):
        pages = split_pages(text=self.REPRO_TEXT, max_chars_per_line=16, max_lines_per_page=1)
        # 極端に短い(3文字未満)ページが発生しない
        for page in pages:
            self.assertGreaterEqual(len("".join(page["lines"])), 3)

    def test_page_char_indices_cover_text(self):
        pages = split_pages(text=self.REPRO_TEXT, max_chars_per_line=16, max_lines_per_page=1)
        self.assertEqual(pages[0]["startCharIndex"], 0)
        self.assertEqual(pages[-1]["endCharIndex"], len(self.REPRO_TEXT))
        for prev, cur in zip(pages, pages[1:]):
            self.assertEqual(prev["endCharIndex"], cur["startCharIndex"])


class OversizedChunkSplitTests(unittest.TestCase):
    """20-B(Python): 行バジェットを超える単一BudouXチャンクを自然な位置で分割する。"""

    def test_oversized_chunk_is_split_at_word_boundary(self):
        # 「インスタなのかYouTubeなのかXなのかいろいろ」は1つのBudouXチャンク(25字)
        pages = split_pages(
            text="インスタなのかYouTubeなのかXなのかいろいろ",
            max_chars_per_line=16,
            max_lines_per_page=1,
        )
        self.assertGreaterEqual(len(pages), 2)
        for page in pages:
            for line in page["lines"]:
                self.assertLessEqual(len(line), 16, f"行バジェット超過: {line!r}")

    def test_split_does_not_break_alnum_run(self):
        pages = split_pages(
            text="インスタなのかYouTubeなのかXなのかいろいろ",
            max_chars_per_line=16,
            max_lines_per_page=1,
        )
        joined = [line for page in pages for line in page["lines"]]
        # 英数字連(YouTube)の内部で分割されない
        self.assertTrue(
            any("YouTube" in line for line in joined),
            f"英数字連が分断された: {joined}",
        )

    def test_unbreakable_long_alnum_run_stays_single_line(self):
        # 行バジェットを超える英数字連は分割できないため、超過1行として許容される
        # (DPがinfにならず前後のレイアウトが破綻しないことの確認)
        text = "これはsupercalifragilisticexpialidociousという言葉"
        pages = split_pages(text=text, max_chars_per_line=12, max_lines_per_page=1)
        joined = "".join(line for page in pages for line in page["lines"])
        self.assertEqual(joined, text)


class KanjiNumberImprove20Tests(unittest.TestCase):
    """20-C: 万・億の単位を残した算用化、アポ/社/倍カウンタ、数・何始まりの保護。"""

    def test_man_unit_kept(self):
        self.assertEqual(_normalize_kanji_numbers("十五万"), "15万")
        self.assertEqual(_normalize_kanji_numbers("五十万"), "50万")

    def test_apo_counter(self):
        self.assertEqual(_normalize_kanji_numbers("千アポ"), "1000アポ")
        self.assertEqual(_normalize_kanji_numbers("十アポ"), "10アポ")

    def test_sha_bai_counters(self):
        self.assertEqual(_normalize_kanji_numbers("五十社"), "50社")
        self.assertEqual(_normalize_kanji_numbers("二十社"), "20社")
        self.assertEqual(_normalize_kanji_numbers("十倍"), "10倍")

    def test_su_prefix_not_converted(self):
        self.assertEqual(_normalize_kanji_numbers("数百万"), "数百万")
        self.assertEqual(_normalize_kanji_numbers("数百万円"), "数百万円")

    def test_nan_prefix_not_converted(self):
        self.assertEqual(_normalize_kanji_numbers("何十人"), "何十人")

    def test_idiom_protection(self):
        for idiom in ("万一", "万全", "万歳", "万能", "億劫"):
            self.assertEqual(_normalize_kanji_numbers(idiom), idiom)

    def test_oku_regression(self):
        self.assertEqual(_normalize_kanji_numbers("一億人"), "1億人")

    def test_build_telop_pages_applies_man_conversion(self):
        pages = build_telop_pages(
            "売上は十五万円になりました",
            cut_id="cut_001",
            max_chars_per_line=16,
            max_lines_per_page=1,
            text_rules={"normalize_numbers": True},
        )
        joined = "".join(line for page in pages for line in page["lines"])
        self.assertIn("15万円", joined)


if __name__ == "__main__":
    unittest.main()
