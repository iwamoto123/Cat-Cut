"""行頭の付属語を避ける改行ルールのテスト（実機FB「名詞＋助詞の間で改行される」）."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from shared.direction import sanitize_slot_directive, wrap_directive_lines
from shared.line_break_rules import (
    dependent_head_length,
    has_bad_line_break,
    is_bad_break,
    is_dependent_line_head,
    repair_line_breaks,
)


class TestDependentHead(unittest.TestCase):
    def test_single_particles_are_dependent(self):
        for text in ["を受けられると思う", "が出てくるので", "でキャプテンをしてて", "の動画を上げています"]:
            self.assertTrue(is_dependent_line_head(text), text)

    def test_content_words_starting_with_particle_char_are_not_dependent(self):
        # 「がんばる」「はい」「もう」は自立語なので行頭に置いてよい
        for text in ["がんばって続ける", "はい、わかりました", "もう9月です", "かなり厳しい"]:
            self.assertFalse(is_dependent_line_head(text), text)

    def test_auxiliary_and_formal_nouns_are_dependent(self):
        for text in ["していまして", "っていうところを", "という話です", "ので、あとは", "とかも出してる", "ところで枠を"]:
            self.assertTrue(is_dependent_line_head(text), text)

    def test_longest_prefix_wins(self):
        self.assertEqual(dependent_head_length("っていうところを"), len("っていう"))
        self.assertEqual(dependent_head_length("共通テスト"), 0)

    def test_break_after_sentence_end_is_allowed(self):
        # 直前が句読点なら節が閉じているので行頭が付属語でも不自然でない
        self.assertFalse(is_bad_break("こんにちは。", "でも今日は"))
        self.assertTrue(is_bad_break("こんにちは", "でも今日は"))

    def test_has_bad_line_break(self):
        self.assertTrue(has_bad_line_break(["共通テスト模試", "を受けられると思う"]))
        self.assertFalse(has_bad_line_break(["共通テスト模試を", "受けられると思う"]))
        self.assertFalse(has_bad_line_break(["こんにちは"]))

    def test_repair_line_breaks_drops_bad_break_only(self):
        self.assertEqual(repair_line_breaks("共通テスト模試\nを受けられる"), "共通テスト模試を受けられる")
        self.assertEqual(repair_line_breaks("山口県立大学を\n受験します"), "山口県立大学を\n受験します")

    def test_repair_line_breaks_keeps_natural_breaks(self):
        # 3行のうち不自然な2つ目の改行だけを解消する
        repaired = repair_line_breaks("模試を\n受けられる人は\nっていう話です")
        self.assertEqual(repaired, "模試を\n受けられる人はっていう話です")


class TestWrapDirectiveLines(unittest.TestCase):
    def test_auto_wrap_breaks_after_particle(self):
        lines = wrap_directive_lines("第1回ベネッセ駿台共通テスト模試を受けられると思うんですけども", 12)
        self.assertEqual(len(lines), 2)
        self.assertFalse(has_bad_line_break(lines))
        self.assertTrue(lines[0].endswith("を"))

    def test_auto_wrap_does_not_split_noun_and_auxiliary(self):
        for text in [
            "いろんな共通テスト対策の動画を上げています",
            "高校3年生まで野球部でキャプテンをしてて",
            "私の個人LINEのこう追加のページが出てくるので",
            "僕らは日本一熱く手厚い塾っていうところを",
        ]:
            lines = wrap_directive_lines(text, 12)
            self.assertFalse(has_bad_line_break(lines), f"{text} -> {lines}")

    def test_manual_break_is_kept_when_natural(self):
        self.assertEqual(wrap_directive_lines("山口県立大学を\n受験します", 12), ["山口県立大学を", "受験します"])

    def test_manual_break_before_dependent_word_is_rewrapped(self):
        lines = wrap_directive_lines("僕らは日本一熱く手厚い塾\nっていうところを", 12)
        self.assertFalse(has_bad_line_break(lines))
        self.assertEqual("".join(lines), "僕らは日本一熱く手厚い塾っていうところを")


class TestSanitizeSlotDirective(unittest.TestCase):
    def _slot(self, text: str) -> dict:
        return {
            "slot_id": "s0001",
            "cut_id": "cut_001",
            "source_start_ms": 0,
            "source_end_ms": 2000,
            "text": text,
        }

    def test_ai_bad_break_is_dropped(self):
        source = "僕らは日本一熱く手厚い塾っていうところを目指しています"
        result = sanitize_slot_directive(
            self._slot(source), {"text": "僕らは日本一熱く手厚い塾\nっていうところを目指しています"}
        )
        self.assertNotIn("\n", result["text"])
        self.assertFalse(result["fallback"])

    def test_ai_natural_break_is_kept(self):
        source = "山口県立大学を受験します"
        result = sanitize_slot_directive(self._slot(source), {"text": "山口県立大学を\n受験します"})
        self.assertEqual(result["text"], "山口県立大学を\n受験します")


if __name__ == "__main__":
    unittest.main()
