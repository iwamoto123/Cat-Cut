"""改善19: word_split_flags・漢数字変換・プロンプト強化のテスト。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shared.telop_builder import _normalize_kanji_numbers
from step06b_ai_refine import build_prompt
from step07_cut_proposal import _apply_word_split_merge


class KanjiNumberImprove19Tests(unittest.TestCase):
    def test_meter_katakana_variation(self):
        self.assertEqual(_normalize_kanji_numbers("三百四十メーター毎秒"), "340メーター毎秒")

    def test_hertz(self):
        self.assertEqual(_normalize_kanji_numbers("八百二十ヘルツ"), "820ヘルツ")
        self.assertEqual(_normalize_kanji_numbers("千二十ヘルツ"), "1020ヘルツ")

    def test_standalone_hundred_thousand(self):
        self.assertEqual(_normalize_kanji_numbers("九百六十と七百七十"), "960と770")

    def test_idiom_protect_yaoiya(self):
        self.assertEqual(_normalize_kanji_numbers("八百屋さんで"), "八百屋さんで")

    def test_idiom_protect_nanhyaku(self):
        self.assertEqual(_normalize_kanji_numbers("何百回も"), "何百回も")

    def test_non_regression_ichiban(self):
        self.assertEqual(_normalize_kanji_numbers("一番"), "一番")

    def test_non_regression_hitorihitori(self):
        self.assertEqual(_normalize_kanji_numbers("一人一人"), "一人一人")

    def test_non_regression_ichijiki(self):
        self.assertEqual(_normalize_kanji_numbers("一時期"), "一時期")


class WordSplitFlagTests(unittest.TestCase):
    def test_budoux_inside_gap_exceeded_flags(self):
        # V8-6: マージ上限は超えるがフラグ上限(1200ms)以内のギャップはフラグ化する
        segments = [
            {"start_ms": 0, "end_ms": 1000, "text": "この部分をボル"},
            {"start_ms": 2000, "end_ms": 8000, "text": "トマン定数と呼ぼう"},
        ]
        merged, count, flags = _apply_word_split_merge(segments, [], max_gap_ms=800)
        self.assertEqual(count, 0)
        self.assertEqual(len(merged), 2)
        self.assertEqual(len(flags), 1)
        self.assertIn("ボル", flags[0]["tail_text"])
        self.assertIn("トマン", flags[0]["head_text"])
        self.assertGreater(flags[0]["gap_ms"], 800)

    def test_particle_comma_head_flags(self):
        # 末尾が文末記号のため自動結合はしないが、次頭が「助詞+読点」で始まる=
        # 直前カットで文が千切れた疑いがあるのでフラグ化する(ギャップ上限以内)
        segments = [
            {"start_ms": 0, "end_ms": 1000, "text": "物理は結構極められる。"},
            {"start_ms": 2000, "end_ms": 8000, "text": "は、まあ比較的6割取れてるので"},
        ]
        merged, count, flags = _apply_word_split_merge(segments, [], max_gap_ms=1500)
        self.assertEqual(count, 0)
        self.assertEqual(len(flags), 1)
        self.assertTrue(flags[0]["head_text"].startswith("は、"))

    def test_small_gap_inside_budoux_merges_without_flag(self):
        segments = [
            {"start_ms": 0, "end_ms": 1000, "text": "大"},
            {"start_ms": 1200, "end_ms": 3000, "text": "まかに授業"},
        ]
        merged, count, flags = _apply_word_split_merge(segments, [], max_gap_ms=1500)
        self.assertEqual(count, 1)
        self.assertEqual(len(flags), 0)
        self.assertEqual(len(merged), 1)

    def test_large_gap_is_intentional_pause_no_flag(self):
        # V8-6: 実データの誤検知(gap 1610ms / 2210ms)。フラグ上限1200ms超は
        # 「意図的な間」とみなしフラグを出さない
        for gap_ms in (1610, 2210):
            segments = [
                {"start_ms": 0, "end_ms": 1000, "text": "記憶に残りやすい"},
                {"start_ms": 1000 + gap_ms, "end_ms": 1000 + gap_ms + 3000, "text": "なと思って"},
            ]
            merged, count, flags = _apply_word_split_merge(segments, [], max_gap_ms=1500)
            self.assertEqual(count, 0)
            self.assertEqual(len(flags), 0, f"gap={gap_ms}ms は意図的な間としてフラグ化しない")

    def test_flag_max_gap_configurable(self):
        # フラグ上限は設定で広げられる(旧挙動相当の検証)
        segments = [
            {"start_ms": 0, "end_ms": 1000, "text": "この部分をボル"},
            {"start_ms": 5411, "end_ms": 8000, "text": "トマン定数と呼ぼう"},
        ]
        merged, count, flags = _apply_word_split_merge(
            segments, [], max_gap_ms=1500, flag_max_gap_ms=10000,
        )
        self.assertEqual(count, 0)
        self.assertEqual(len(flags), 1)


class PromptImprove19Tests(unittest.TestCase):
    def test_build_prompt_includes_duplicate_artifact_rule(self):
        prompt = build_prompt("テスト", [], 12, 2)
        self.assertIn("書書いてある", prompt)
        self.assertIn("重複アーティファクト", prompt)
        self.assertIn("人々", prompt)


if __name__ == "__main__":
    unittest.main()
