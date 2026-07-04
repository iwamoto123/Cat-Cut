import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from step04_filler_detect import _detect_fillers


def _char_words(text: str, start_id: int, start_ms: int, char_ms: int = 100, gap_ms: int = 0):
    """1文字1wordのword列を生成するテストヘルパー (ElevenLabs STT を模す)。"""
    words = []
    t = start_ms
    for i, ch in enumerate(text):
        words.append({
            "id": f"w-{start_id + i:04d}",
            "text": ch,
            "start_ms": t,
            "end_ms": t + char_ms,
        })
        t += char_ms + gap_ms
    return words


def _punct_word(word_id: str, text: str, ms: int):
    return {"id": word_id, "text": text, "start_ms": ms, "end_ms": ms}


class FillerDetectCharConcatTests(unittest.TestCase):
    def test_hedging_phrase_detected_from_one_char_words_with_boundary_pause(self):
        # 「あの、まー、」を一文字1wordで構成 (ElevenLabs STT 相当)
        words = _char_words("あの", 0, 0)
        words.append(_punct_word("w-0002", "、", 200))
        words += _char_words("まー", 3, 240)
        words.append(_punct_word("w-0005", "、", 440))

        sentences = [{"id": "s0", "text": "あの、まー、", "word_ids": [w["id"] for w in words]}]

        fillers = _detect_fillers(words, sentences)

        ano_entries = [f for f in fillers if f["word_id"] in ("w-0000", "w-0001")]
        maa_entries = [f for f in fillers if f["word_id"] in ("w-0003", "w-0004")]

        self.assertEqual(len(ano_entries), 2)
        self.assertEqual(len(maa_entries), 2)
        for entry in ano_entries:
            self.assertEqual(entry["type"], "hedging")
            self.assertGreaterEqual(entry["confidence"], 0.6)
            self.assertEqual(entry["text"], words[int(entry["word_id"].split("-")[1])]["text"])
        for entry in maa_entries:
            self.assertEqual(entry["type"], "hedging")
            self.assertGreaterEqual(entry["confidence"], 0.6)

    def test_ano_hito_ga_is_not_flagged_as_confident_filler(self):
        # 「あの人が」: 「あの」の直後に間なく通常語「人」が続く指示語ケース → フィラー出力しない
        words = _char_words("あの人が", 0, 0)
        sentences = [{"id": "s0", "text": "あの人が", "word_ids": [w["id"] for w in words]}]

        fillers = _detect_fillers(words, sentences)

        ano_entries = [f for f in fillers if f["word_id"] in ("w-0000", "w-0001")]
        self.assertEqual(len(ano_entries), 0)

    def test_regex_pattern_stretch_detected_from_one_char_words(self):
        # 「あーーー」: 辞書の完全一致キーには無い伸ばし棒の連続 (regexパターンで検出)
        words = _char_words("あーーー", 0, 0)
        words.append(_punct_word("w-0004", "。", 400))
        sentences = [{"id": "s0", "text": "あーーー。", "word_ids": [w["id"] for w in words]}]

        fillers = _detect_fillers(words, sentences)

        matched_ids = {f["word_id"] for f in fillers}
        self.assertEqual(matched_ids, {"w-0000", "w-0001", "w-0002", "w-0003"})
        for f in fillers:
            self.assertEqual(f["type"], "hesitation")
            self.assertEqual(f["source"], "regex")
            self.assertGreaterEqual(f["confidence"], 0.6)

    def test_no_false_positive_on_unrelated_text(self):
        words = _char_words("こんにちは", 0, 0)
        sentences = [{"id": "s0", "text": "こんにちは", "word_ids": [w["id"] for w in words]}]
        fillers = _detect_fillers(words, sentences)
        self.assertEqual(fillers, [])

    def test_multi_char_word_not_matched_when_boundary_misaligned(self):
        # 複数文字wordの一部分だけにマッチが重なる場合は不採用
        words = [
            {"id": "w-0000", "text": "うあの", "start_ms": 0, "end_ms": 300},
            {"id": "w-0001", "text": "です", "start_ms": 300, "end_ms": 500},
        ]
        sentences = [{"id": "s0", "text": "うあのです", "word_ids": ["w-0000", "w-0001"]}]
        fillers = _detect_fillers(words, sentences)
        # "あの" は "うあの" の後半にしか一致せず、word境界と一致しないため検出されない
        self.assertEqual(fillers, [])

    def test_output_schema_keeps_single_word_id_per_entry(self):
        words = _char_words("あの", 0, 0)
        words.append({"id": "w-0002", "text": "、", "start_ms": 200, "end_ms": 250})
        sentences = [{"id": "s0", "text": "あの、", "word_ids": [w["id"] for w in words]}]
        fillers = _detect_fillers(words, sentences)
        for f in fillers:
            self.assertIsInstance(f["word_id"], str)
            self.assertIn("text", f)
            self.assertIn("type", f)
            self.assertIn("action", f)
            self.assertIn("confidence", f)
            self.assertIn("start_ms", f)
            self.assertIn("end_ms", f)
            self.assertIn("source", f)
            self.assertIn("word_ids", f)


if __name__ == "__main__":
    unittest.main()
