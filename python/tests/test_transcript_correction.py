import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shared.transcript_correction import (
    Correction,
    apply_transcript_corrections,
    corrections_from_sources,
)


class TranscriptCorrectionTests(unittest.TestCase):
    def test_exact_word_and_sentence_correction(self):
        stt = {
            "words": [
                {"id": "w-0000", "text": "手六", "start_ms": 0, "end_ms": 200},
                {"id": "w-0001", "text": "です", "start_ms": 200, "end_ms": 400},
            ],
            "sentences": [
                {
                    "id": "sent_0000",
                    "text": "手六です",
                    "start_ms": 0,
                    "end_ms": 400,
                    "word_ids": ["w-0000", "w-0001"],
                }
            ],
            "raw_text": "手六です",
        }

        corrected, patch = apply_transcript_corrections(
            stt,
            [Correction("手六", "テロップ", "domain_terms")],
        )

        self.assertEqual(corrected["words"][0]["text"], "テロップ")
        self.assertEqual(corrected["sentences"][0]["text"], "テロップです")
        self.assertEqual(corrected["raw_text"], "テロップです")
        self.assertEqual(patch["stats"]["word_patches"], 1)
        self.assertEqual(patch["stats"]["sentence_patches"], 1)

    def test_phrase_correction_across_words_preserves_ids(self):
        stt = {
            "words": [
                {"id": "w-0000", "text": "キャット", "start_ms": 0, "end_ms": 200},
                {"id": "w-0001", "text": "カット", "start_ms": 200, "end_ms": 400},
                {"id": "w-0002", "text": "です", "start_ms": 400, "end_ms": 600},
            ],
            "sentences": [
                {
                    "id": "sent_0000",
                    "text": "キャットカットです",
                    "start_ms": 0,
                    "end_ms": 600,
                    "word_ids": ["w-0000", "w-0001", "w-0002"],
                }
            ],
            "raw_text": "キャットカットです",
        }

        corrected, patch = apply_transcript_corrections(
            stt,
            [Correction("キャットカットです", "Cat-Cutです", "domain_terms")],
        )

        self.assertEqual(
            "".join(w["text"] for w in corrected["words"]),
            "Cat-Cutです",
        )
        self.assertEqual(
            [w["id"] for w in corrected["words"]],
            ["w-0000", "w-0001", "w-0002"],
        )
        self.assertEqual(patch["word_patches"][0]["mode"], "phrase")

    def test_project_corrections_are_included(self):
        corrections = corrections_from_sources(
            {"proper_nouns": {"キャットカット": "Cat-Cut"}},
            {"text_rules": {"corrections": {"てろっぷ": "テロップ"}}},
        )

        pairs = {(c.source, c.target, c.category) for c in corrections}
        self.assertIn(("キャットカット", "Cat-Cut", "proper_nouns"), pairs)
        self.assertIn(("てろっぷ", "テロップ", "project_text_rules"), pairs)

    def test_user_dictionary_overrides_domain(self):
        corrections = corrections_from_sources(
            {"common_misrecognitions": {"難下": "難化"}},
            {},
            {"entries": [{"from": "難下", "to": "ユーザー修正"}]},
        )
        pairs = [(c.source, c.target, c.category) for c in corrections]
        self.assertIn(("難下", "ユーザー修正", "user_dictionary"), pairs)

    def test_user_dictionary_skipped_when_missing(self):
        from shared.transcript_correction import load_user_dictionary

        self.assertEqual(load_user_dictionary("/nonexistent/path.json"), {})


if __name__ == "__main__":
    unittest.main()
