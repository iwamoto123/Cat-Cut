"""フェーズW5-1: AI疑義ワード抽出 (suspicious_words -> ai_review.suspect_words) のテスト。"""
import json
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import step05_ai_retake as ai_retake


def _build_fixture(sentences_spec: list[tuple[str, list[str]]]):
    """(sentence_id, [wordテキスト,...]) のリストから sentences / sentence_map / word_map を作る。"""
    sentences = []
    word_map: dict[str, dict] = {}
    ms = 0
    for sid, word_texts in sentences_spec:
        word_ids = []
        for index, text in enumerate(word_texts):
            wid = f"w-{sid}-{index}"
            word_ids.append(wid)
            word_map[wid] = {"id": wid, "text": text, "start_ms": ms, "end_ms": ms + 100}
            ms += 100
        sentences.append({"id": sid, "text": "".join(word_texts), "word_ids": word_ids})
    sentence_map = {s["id"]: s for s in sentences}
    return sentences, sentence_map, word_map


class ResolveSuspectWordsTests(unittest.TestCase):
    def setUp(self):
        self.sentences, self.sentence_map, self.word_map = _build_fixture([
            # 1文字word(実機ElevenLabs相当)と複数文字wordの混在
            ("s-001", ["参", "考", "書", "は", "シロ", "チャート", "が", "いい"]),
            ("s-002", ["そう", "です", "よ", "、", "s", "o", "です", "よ"]),
            ("s-003", ["新", "学", "校", "です"]),
        ])

    def _resolve(self, items):
        return ai_retake.resolve_suspect_words(
            {"suspicious_words": items}, self.sentence_map, self.word_map,
        )

    def test_surface_resolves_across_multiple_words(self):
        results = self._resolve([
            {"sentence_id": "s-001", "surface": "シロチャート", "reason": "誤変換の疑い", "suggestion": "白チャート"},
        ])
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["word_ids"], ["w-s-001-4", "w-s-001-5"])
        self.assertEqual(results[0]["text"], "シロチャート")
        self.assertEqual(results[0]["suggestion"], "白チャート")
        self.assertEqual(results[0]["start_ms"], self.word_map["w-s-001-4"]["start_ms"])
        self.assertEqual(results[0]["end_ms"], self.word_map["w-s-001-5"]["end_ms"])

    def test_surface_in_middle_of_sentence_resolves(self):
        # 半角英字混入(全角/半角混在の文)。surfaceが文の途中にある場合。
        results = self._resolve([
            {"sentence_id": "s-002", "surface": "so", "reason": "英字混入"},
        ])
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["word_ids"], ["w-s-002-4", "w-s-002-5"])
        self.assertEqual(results[0]["text"], "so")

    def test_partial_word_match_includes_owner_word(self):
        # surfaceが1文字wordの列にまたがるケース(「新学校」= 3つの1文字word)。
        results = self._resolve([
            {"sentence_id": "s-003", "surface": "新学校", "reason": "文脈では進学校", "suggestion": "進学校"},
        ])
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["word_ids"], ["w-s-003-0", "w-s-003-1", "w-s-003-2"])

    def test_unknown_sentence_id_is_discarded(self):
        results = self._resolve([
            {"sentence_id": "s-999", "surface": "シロチャート", "reason": "x"},
        ])
        self.assertEqual(results, [])

    def test_unmatched_surface_is_discarded(self):
        # 幻覚サーフェス(文に含まれない部分文字列)は捨てる。
        results = self._resolve([
            {"sentence_id": "s-001", "surface": "アオチャート", "reason": "x"},
        ])
        self.assertEqual(results, [])

    def test_empty_and_too_long_surface_are_discarded(self):
        results = self._resolve([
            {"sentence_id": "s-001", "surface": "", "reason": "x"},
            {"sentence_id": "s-001", "surface": "あ" * 21, "reason": "x"},
        ])
        self.assertEqual(results, [])

    def test_duplicate_entries_are_deduped(self):
        results = self._resolve([
            {"sentence_id": "s-001", "surface": "シロチャート", "reason": "a"},
            {"sentence_id": "s-001", "surface": "シロチャート", "reason": "b"},
        ])
        self.assertEqual(len(results), 1)

    def test_non_list_and_non_dict_inputs_are_ignored(self):
        self.assertEqual(
            ai_retake.resolve_suspect_words({"suspicious_words": "x"}, self.sentence_map, self.word_map),
            [],
        )
        self.assertEqual(self._resolve(["not-a-dict", 42]), [])

    def test_suggestion_is_optional(self):
        results = self._resolve([
            {"sentence_id": "s-001", "surface": "シロチャート", "reason": "x"},
        ])
        self.assertEqual(len(results), 1)
        self.assertNotIn("suggestion", results[0])


class ApplyLlmResponseSuspectWordsTests(unittest.TestCase):
    def setUp(self):
        self.sentences, self.sentence_map, self.word_map = _build_fixture([
            ("s-001", ["シロ", "チャート"]),
            ("s-002", ["崩", "れ", "た", "文"]),
        ])

    def test_apply_returns_suspect_words_and_keeps_existing_parsing(self):
        response = {
            "retakes": [{"reason": "言い直し", "remove_sentence_ids": ["s-002"]}],
            "needs_review": [{"sentence_ids": ["s-002"], "reason": "復元困難"}],
            "suspicious_words": [
                {"sentence_id": "s-001", "surface": "シロチャート", "reason": "誤変換", "suggestion": "白チャート"},
            ],
        }
        retakes, needs, count, fillers_removed, suspects = ai_retake.apply_llm_response(
            response, self.sentences, self.sentence_map, self.word_map,
        )
        # 既存の retakes / needs_review パースが壊れていない
        self.assertEqual(count, 1)
        self.assertEqual(len(retakes), 1)
        self.assertEqual(len(needs), 1)
        self.assertEqual(needs[0]["reason"], "復元困難")
        self.assertEqual(fillers_removed, 0)
        # suspect_words が返る
        self.assertEqual(len(suspects), 1)
        self.assertEqual(suspects[0]["text"], "シロチャート")

    def test_missing_suspicious_words_key_is_empty(self):
        retakes, needs, count, fillers_removed, suspects = ai_retake.apply_llm_response(
            {"retakes": [], "needs_review": []}, self.sentences, self.sentence_map, self.word_map,
        )
        self.assertEqual(suspects, [])


class PromptTests(unittest.TestCase):
    def test_prompt_contains_suspicious_words_instructions(self):
        prompt = ai_retake.build_prompt([{"id": "s-001", "text": "あ", "word_ids": ["w-1"]}])
        self.assertIn("suspicious_words", prompt)
        self.assertIn("1〜2文字", prompt)
        self.assertIn("surface", prompt)
        self.assertIn("suggestion", prompt)


class MergeResponsesTests(unittest.TestCase):
    def test_merge_concatenates_suspicious_words(self):
        merged = ai_retake.merge_llm_responses([
            {"suspicious_words": [{"sentence_id": "s-001", "surface": "あ"}]},
            {"suspicious_words": [{"sentence_id": "s-002", "surface": "い"}]},
            {},
        ])
        self.assertEqual(len(merged["suspicious_words"]), 2)


REAL_RUN_STT = (
    Path(__file__).resolve().parents[2]
    / "runs"
    / "20260707_204610_中川さん2"
    / "step02b_transcript_correct"
    / "stt_corrected.json"
)


@unittest.skipUnless(REAL_RUN_STT.exists(), "実データrunが無い環境ではスキップ")
class RealDataResolutionTests(unittest.TestCase):
    """検証チェックリスト3: 実runの stt_corrected.json に対しモック応答で word_ids が解決されること。"""

    @classmethod
    def setUpClass(cls):
        words, sentences, sentence_map = ai_retake.load_stt(REAL_RUN_STT)
        cls.sentences = sentences
        cls.sentence_map = sentence_map
        cls.word_map = {str(w.get("id", "")): w for w in words if w.get("id")}

    def _sentence_containing(self, needle: str) -> str:
        for sentence in self.sentences:
            if needle in str(sentence.get("text", "")):
                return str(sentence["id"])
        self.fail(f"実データに {needle} を含む文が見つかりません")

    def test_mock_response_resolves_word_ids_on_real_data(self):
        mock_response = {
            "retakes": [],
            "needs_review": [],
            "suspicious_words": [
                {
                    "sentence_id": self._sentence_containing("シロチャート"),
                    "surface": "シロチャート",
                    "reason": "参考書の文脈では「白チャート」の誤変換の疑い",
                    "suggestion": "白チャート",
                },
                {
                    "sentence_id": self._sentence_containing("新学校"),
                    "surface": "新学校",
                    "reason": "文脈上「進学校」の誤変換の疑い",
                    "suggestion": "進学校",
                },
            ],
        }
        _retakes, _needs, _count, _fillers, suspects = ai_retake.apply_llm_response(
            mock_response, self.sentences, self.sentence_map, self.word_map,
        )
        self.assertEqual(len(suspects), 2)
        for entry in suspects:
            self.assertTrue(entry["word_ids"], "word_idsが解決されている")
            for wid in entry["word_ids"]:
                self.assertIn(wid, self.word_map, "実在するword_idのみ")
            self.assertGreater(entry["end_ms"], 0)
        texts = [entry["text"] for entry in suspects]
        self.assertTrue(any("シロチャート" in text for text in texts))
        self.assertTrue(any("新学校" in text for text in texts))


if __name__ == "__main__":
    unittest.main()
