"""Step 2 STT 正規化: 括弧のみのイベントトークン除去のテスト。

IMG_5952 実機テストで「(6秒停止)」のような ElevenLabs STT の
イベント説明トークンが word として混入し、テロップ・クラスタリングに
そのまま乗ってしまう問題への対応 (改善6-2)。
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from step02_stt import _is_event_token, _strip_event_tokens


class IsEventTokenTests(unittest.TestCase):
    def test_japanese_parenthesized_event_is_detected(self):
        self.assertTrue(_is_event_token("(6秒停止)"))

    def test_english_parenthesized_event_is_detected(self):
        self.assertTrue(_is_event_token("(laughs)"))

    def test_fullwidth_parentheses_event_is_detected(self):
        self.assertTrue(_is_event_token("（笑）"))

    def test_bracket_style_event_is_detected(self):
        self.assertTrue(_is_event_token("【BGM】"))
        self.assertTrue(_is_event_token("[拍手]"))

    def test_normal_word_is_not_event_token(self):
        self.assertFalse(_is_event_token("た"))
        self.assertFalse(_is_event_token("。"))
        self.assertFalse(_is_event_token("相談"))

    def test_word_with_surrounding_text_is_not_event_token(self):
        # 括弧が単語の一部として文中に混じっているだけの場合は除去しない
        self.assertFalse(_is_event_token("笑（本当）です"))

    def test_unmatched_or_only_opening_bracket_is_not_event_token(self):
        self.assertFalse(_is_event_token("("))
        self.assertFalse(_is_event_token("(abc"))

    def test_empty_parentheses_is_not_event_token(self):
        self.assertFalse(_is_event_token("()"))


class StripEventTokensTests(unittest.TestCase):
    def _base_words(self):
        return [
            {"id": "w-0000", "text": "た", "start_ms": 0, "end_ms": 100, "confidence": 0.0},
            {"id": "w-0001", "text": "。", "start_ms": 100, "end_ms": 100, "confidence": 0.0},
            {"id": "w-0002", "text": "(6秒停止)", "start_ms": 200, "end_ms": 6200, "confidence": 0.0},
            {"id": "w-0003", "text": "お", "start_ms": 6300, "end_ms": 6400, "confidence": 0.0},
        ]

    def test_event_token_word_is_removed_from_words(self):
        result = {"words": self._base_words(), "sentences": []}
        out = _strip_event_tokens(result)
        remaining_ids = [w["id"] for w in out["words"]]
        self.assertNotIn("w-0002", remaining_ids)
        self.assertEqual(remaining_ids, ["w-0000", "w-0001", "w-0003"])
        self.assertEqual(out["event_tokens_removed"], 1)

    def test_normal_words_are_untouched(self):
        result = {"words": self._base_words(), "sentences": []}
        out = _strip_event_tokens(result)
        kept = {w["id"]: w for w in out["words"]}
        self.assertEqual(kept["w-0000"], {"id": "w-0000", "text": "た", "start_ms": 0, "end_ms": 100, "confidence": 0.0})
        self.assertEqual(kept["w-0003"], {"id": "w-0003", "text": "お", "start_ms": 6300, "end_ms": 6400, "confidence": 0.0})

    def test_sentence_word_ids_and_text_are_recomputed_without_event_token(self):
        words = self._base_words()
        sentences = [
            {
                "id": "sent_0",
                "text": "た。(6秒停止)お",
                "start_ms": 0,
                "end_ms": 6400,
                "word_ids": ["w-0000", "w-0001", "w-0002", "w-0003"],
            }
        ]
        result = {"words": words, "sentences": sentences}
        out = _strip_event_tokens(result)
        self.assertEqual(len(out["sentences"]), 1)
        sent = out["sentences"][0]
        self.assertEqual(sent["word_ids"], ["w-0000", "w-0001", "w-0003"])
        self.assertEqual(sent["text"], "た。お")
        self.assertEqual(sent["start_ms"], 0)
        self.assertEqual(sent["end_ms"], 6400)

    def test_sentence_consisting_only_of_event_tokens_is_dropped(self):
        words = [
            {"id": "w-0000", "text": "(laughs)", "start_ms": 0, "end_ms": 500, "confidence": 0.0},
        ]
        sentences = [
            {"id": "sent_0", "text": "(laughs)", "start_ms": 0, "end_ms": 500, "word_ids": ["w-0000"]},
        ]
        result = {"words": words, "sentences": sentences}
        out = _strip_event_tokens(result)
        self.assertEqual(out["words"], [])
        self.assertEqual(out["sentences"], [])

    def test_no_event_tokens_present_leaves_result_unchanged(self):
        words = [
            {"id": "w-0000", "text": "た", "start_ms": 0, "end_ms": 100, "confidence": 0.0},
        ]
        sentences = [
            {"id": "sent_0", "text": "た", "start_ms": 0, "end_ms": 100, "word_ids": ["w-0000"]},
        ]
        result = {"words": words, "sentences": sentences}
        out = _strip_event_tokens(result)
        self.assertEqual(out["words"], words)
        self.assertEqual(out["sentences"], sentences)
        self.assertEqual(out["event_tokens_removed"], 0)


if __name__ == "__main__":
    unittest.main()
