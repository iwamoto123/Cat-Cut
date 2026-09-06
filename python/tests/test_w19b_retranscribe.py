"""W19-B1: 弱い区間の再文字起こし (step05b_retranscribe) のテスト。"""
import json
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import step05b_retranscribe as retranscribe


class CollectWeakRangesTests(unittest.TestCase):
    def test_needs_review_and_suspects_without_suggestion(self):
        ai_review = {
            "needs_review": [
                {"start_ms": 1000, "end_ms": 2000, "word_ids": ["w-1"]},
            ],
            "suspect_words": [
                {"start_ms": 5000, "end_ms": 5500, "suggestion": "既に候補あり"},
                {"start_ms": 8000, "end_ms": 8200},
            ],
        }
        self.assertEqual(
            retranscribe.collect_weak_ranges(ai_review),
            [(1000, 2000), (8000, 8200)],
        )

    def test_invalid_entries_are_discarded(self):
        ai_review = {
            "needs_review": [
                {"start_ms": -10, "end_ms": 100},
                {"start_ms": 500, "end_ms": 300},
                {"start_ms": "broken"},
                "not-a-dict",
                {"start_ms": 100, "end_ms": 100},
            ],
        }
        # 開始<0・逆転・型不正は捨てる。start==end(点区間)は有効。
        self.assertEqual(retranscribe.collect_weak_ranges(ai_review), [(100, 100)])

    def test_empty_review_returns_empty(self):
        self.assertEqual(retranscribe.collect_weak_ranges({}), [])


class MergeWeakIntervalsTests(unittest.TestCase):
    def test_padding_is_applied_and_clamped_at_zero(self):
        merged = retranscribe.merge_weak_intervals([(200, 1000)], padding_ms=500)
        self.assertEqual(merged, [{"start_ms": 0, "end_ms": 1500}])

    def test_overlapping_intervals_are_merged(self):
        merged = retranscribe.merge_weak_intervals(
            [(3000, 4000), (1000, 2000), (1800, 2500)], padding_ms=0,
        )
        self.assertEqual(merged, [
            {"start_ms": 1000, "end_ms": 2500},
            {"start_ms": 3000, "end_ms": 4000},
        ])

    def test_padding_can_join_nearby_intervals(self):
        merged = retranscribe.merge_weak_intervals(
            [(1000, 2000), (2600, 3000)], padding_ms=500,
        )
        self.assertEqual(merged, [{"start_ms": 500, "end_ms": 3500}])

    def test_long_interval_is_clamped_to_max_duration(self):
        merged = retranscribe.merge_weak_intervals(
            [(0, 60_000)], padding_ms=0, max_duration_ms=15_000,
        )
        self.assertEqual(merged, [{"start_ms": 0, "end_ms": 15_000}])

    def test_interval_count_is_capped_in_start_order(self):
        ranges = [(i * 10_000, i * 10_000 + 1000) for i in range(30)]
        merged = retranscribe.merge_weak_intervals(ranges, padding_ms=0, max_count=20)
        self.assertEqual(len(merged), 20)
        self.assertEqual(merged[0]["start_ms"], 0)
        self.assertEqual(merged[-1]["start_ms"], 190_000)

    def test_empty_returns_empty(self):
        self.assertEqual(retranscribe.merge_weak_intervals([]), [])


class AttachIntervalWordsTests(unittest.TestCase):
    WORDS = [
        {"id": "w-1", "text": "今日は", "start_ms": 0, "end_ms": 500},
        {"id": "w-2", "text": "晴れ", "start_ms": 500, "end_ms": 900},
        {"id": "w-3", "text": "です", "start_ms": 900, "end_ms": 1200},
        {"id": "w-4", "text": "明日", "start_ms": 5000, "end_ms": 5400},
    ]

    def test_words_and_old_text_are_attached(self):
        candidates = retranscribe.attach_interval_words(
            [{"start_ms": 400, "end_ms": 1000}], self.WORDS,
        )
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["interval_id"], "iv-001")
        self.assertEqual(candidates[0]["word_ids"], ["w-1", "w-2", "w-3"])
        self.assertEqual(candidates[0]["old_text"], "今日は晴れです")

    def test_interval_without_words_is_discarded(self):
        candidates = retranscribe.attach_interval_words(
            [{"start_ms": 2000, "end_ms": 3000}], self.WORDS,
        )
        self.assertEqual(candidates, [])


class NormalizeForCompareTests(unittest.TestCase):
    def test_whitespace_and_punctuation_are_removed(self):
        self.assertEqual(
            retranscribe.normalize_for_compare("今日は、 晴れです。"),
            retranscribe.normalize_for_compare("今日は晴れです"),
        )

    def test_different_texts_stay_different(self):
        self.assertNotEqual(
            retranscribe.normalize_for_compare("小学館"),
            retranscribe.normalize_for_compare("小学官"),
        )


class SanitizeVerdictsTests(unittest.TestCase):
    CANDIDATES = [
        {
            "interval_id": "iv-001",
            "start_ms": 1000,
            "end_ms": 2000,
            "word_ids": ["w-1", "w-2"],
            "old_text": "小学館っていうとこです",
            "new_text": "松山までっていうとこです",
        },
        {
            "interval_id": "iv-002",
            "start_ms": 5000,
            "end_ms": 6000,
            "word_ids": ["w-9"],
            "old_text": "医師薬科専門",
            "new_text": "医歯薬歯専門",
        },
    ]

    def _sanitize(self, verdicts):
        return retranscribe.sanitize_verdicts({"verdicts": verdicts}, self.CANDIDATES)

    def test_retranscribed_uses_new_text_as_suggestion(self):
        items = self._sanitize([
            {"interval_id": "iv-001", "verdict": "retranscribed", "reason": "再STTが正しい"},
        ])
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["suggestion"], "松山までっていうとこです")
        self.assertEqual(items[0]["word_ids"], ["w-1", "w-2"])
        self.assertEqual(items[0]["old_text"], "小学館っていうとこです")

    def test_revised_uses_llm_suggestion(self):
        items = self._sanitize([
            {"interval_id": "iv-002", "verdict": "revised", "suggestion": "医歯薬科専門", "reason": "両方誤り"},
        ])
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["suggestion"], "医歯薬科専門")

    def test_original_verdict_is_not_an_item(self):
        self.assertEqual(
            self._sanitize([{"interval_id": "iv-001", "verdict": "original"}]), [],
        )

    def test_hallucinated_interval_id_is_discarded(self):
        self.assertEqual(
            self._sanitize([{"interval_id": "iv-999", "verdict": "retranscribed"}]), [],
        )

    def test_unknown_verdict_is_discarded(self):
        self.assertEqual(
            self._sanitize([{"interval_id": "iv-001", "verdict": "banana"}]), [],
        )

    def test_revised_without_suggestion_is_discarded(self):
        self.assertEqual(
            self._sanitize([{"interval_id": "iv-001", "verdict": "revised", "suggestion": ""}]), [],
        )

    def test_suggestion_equal_to_old_text_is_discarded(self):
        items = self._sanitize([
            {"interval_id": "iv-001", "verdict": "revised", "suggestion": "小学館っていうとこです。"},
        ])
        self.assertEqual(items, [])

    def test_too_long_suggestion_is_discarded(self):
        items = self._sanitize([
            {"interval_id": "iv-001", "verdict": "revised", "suggestion": "あ" * 301},
        ])
        self.assertEqual(items, [])

    def test_duplicate_interval_ids_keep_first(self):
        items = self._sanitize([
            {"interval_id": "iv-001", "verdict": "retranscribed"},
            {"interval_id": "iv-001", "verdict": "revised", "suggestion": "2回目"},
        ])
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["suggestion"], "松山までっていうとこです")

    def test_non_list_verdicts_returns_empty(self):
        self.assertEqual(
            retranscribe.sanitize_verdicts({"verdicts": "broken"}, self.CANDIDATES), [],
        )
        self.assertEqual(retranscribe.sanitize_verdicts({}, self.CANDIDATES), [])


class RunStepTests(unittest.TestCase):
    def _make_run(self, tmp: Path, ai_review, stt=None):
        review_path = tmp / "ai_review.json"
        review_path.write_text(json.dumps(ai_review, ensure_ascii=False), encoding="utf-8")
        stt_path = tmp / "stt_corrected.json"
        stt_payload = stt or {
            "words": [
                {"id": "w-1", "text": "小学館", "start_ms": 1000, "end_ms": 1500},
                {"id": "w-2", "text": "です", "start_ms": 1500, "end_ms": 1900},
            ],
            "sentences": [
                {"id": "s-1", "text": "小学館です", "start_ms": 1000, "end_ms": 1900, "word_ids": ["w-1", "w-2"]},
            ],
        }
        stt_path.write_text(json.dumps(stt_payload, ensure_ascii=False), encoding="utf-8")
        audio_path = tmp / "audio.wav"
        audio_path.write_bytes(b"fake-wav")
        return review_path, stt_path, audio_path

    ENABLED_REVIEW = {
        "enabled": True,
        "needs_review": [{"start_ms": 1000, "end_ms": 1900}],
        "suspect_words": [],
    }

    def _run(self, tmp: Path, ai_review, **kwargs):
        review_path, stt_path, audio_path = self._make_run(tmp, ai_review)
        output_path = tmp / "retranscribe.json"
        result = retranscribe.run_step(
            str(tmp),
            str(review_path),
            str(stt_path),
            str(audio_path),
            str(output_path),
            **kwargs,
        )
        written = json.loads(output_path.read_text(encoding="utf-8"))
        return result, written

    def test_disabled_ai_review_skips(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            result, written = self._run(Path(tmp_dir), {"enabled": False})
        self.assertFalse(result["enabled"])
        self.assertEqual(written["items"], [])

    def test_no_weak_intervals_skips(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            result, _ = self._run(
                Path(tmp_dir), {"enabled": True, "needs_review": [], "suspect_words": []},
            )
        self.assertFalse(result["enabled"])
        self.assertEqual(result["reason"], "no weak intervals")

    def test_no_llm_key_skips_before_stt(self):
        calls = []

        def transcribe(path):
            calls.append(path)
            return "テキスト"

        original = retranscribe.resolve_provider_and_key
        retranscribe.resolve_provider_and_key = lambda provider, root: (None, "", "")
        try:
            with tempfile.TemporaryDirectory() as tmp_dir:
                result, _ = self._run(
                    Path(tmp_dir), self.ENABLED_REVIEW, transcribe_fn=transcribe,
                )
        finally:
            retranscribe.resolve_provider_and_key = original
        self.assertFalse(result["enabled"])
        self.assertEqual(result["reason"], "no AI provider key set")
        # LLMキーが無い場合は再STT(コスト)をかけない
        self.assertEqual(calls, [])

    def test_no_stt_key_skips(self):
        original_resolve = retranscribe.resolve_provider_and_key
        original_key = retranscribe.find_env_key
        retranscribe.resolve_provider_and_key = lambda provider, root: ("anthropic", "k", "m")
        retranscribe.find_env_key = lambda env_var, root: ""
        try:
            with tempfile.TemporaryDirectory() as tmp_dir:
                result, _ = self._run(Path(tmp_dir), self.ENABLED_REVIEW)
        finally:
            retranscribe.resolve_provider_and_key = original_resolve
            retranscribe.find_env_key = original_key
        self.assertFalse(result["enabled"])
        self.assertEqual(result["reason"], "no ELEVEN_API_KEY set")

    def test_identical_retranscription_yields_no_items(self):
        original_resolve = retranscribe.resolve_provider_and_key
        original_extract = retranscribe.extract_audio_interval
        retranscribe.resolve_provider_and_key = lambda provider, root: ("anthropic", "k", "m")
        retranscribe.extract_audio_interval = lambda *args, **kwargs: None
        try:
            with tempfile.TemporaryDirectory() as tmp_dir:
                result, written = self._run(
                    Path(tmp_dir),
                    self.ENABLED_REVIEW,
                    transcribe_fn=lambda path: "小学館です。",
                    call_llm_fn=lambda *args: self.fail("LLM must not be called"),
                )
        finally:
            retranscribe.resolve_provider_and_key = original_resolve
            retranscribe.extract_audio_interval = original_extract
        self.assertTrue(result["enabled"])
        self.assertEqual(written["items"], [])

    def test_diff_goes_through_llm_and_items_are_written(self):
        def fake_llm(provider, key, model, prompt):
            self.assertIn("iv-001", prompt)
            return {
                "verdicts": [
                    {"interval_id": "iv-001", "verdict": "retranscribed", "reason": "再STTが正しい"},
                    {"interval_id": "iv-999", "verdict": "revised", "suggestion": "幻覚"},
                ]
            }

        original_resolve = retranscribe.resolve_provider_and_key
        original_extract = retranscribe.extract_audio_interval
        retranscribe.resolve_provider_and_key = lambda provider, root: ("anthropic", "k", "m")
        retranscribe.extract_audio_interval = lambda *args, **kwargs: None
        try:
            with tempfile.TemporaryDirectory() as tmp_dir:
                result, written = self._run(
                    Path(tmp_dir),
                    self.ENABLED_REVIEW,
                    transcribe_fn=lambda path: "松山までです",
                    call_llm_fn=fake_llm,
                )
        finally:
            retranscribe.resolve_provider_and_key = original_resolve
            retranscribe.extract_audio_interval = original_extract
        self.assertTrue(result["enabled"])
        self.assertEqual(len(written["items"]), 1)
        item = written["items"][0]
        self.assertEqual(item["old_text"], "小学館です")
        self.assertEqual(item["new_text"], "松山までです")
        self.assertEqual(item["suggestion"], "松山までです")
        self.assertEqual(item["word_ids"], ["w-1", "w-2"])

    def test_llm_failure_is_non_fatal(self):
        def failing_llm(provider, key, model, prompt):
            raise RuntimeError("boom")

        original_resolve = retranscribe.resolve_provider_and_key
        original_extract = retranscribe.extract_audio_interval
        retranscribe.resolve_provider_and_key = lambda provider, root: ("anthropic", "k", "m")
        retranscribe.extract_audio_interval = lambda *args, **kwargs: None
        try:
            with tempfile.TemporaryDirectory() as tmp_dir:
                result, written = self._run(
                    Path(tmp_dir),
                    self.ENABLED_REVIEW,
                    transcribe_fn=lambda path: "松山までです",
                    call_llm_fn=failing_llm,
                )
        finally:
            retranscribe.resolve_provider_and_key = original_resolve
            retranscribe.extract_audio_interval = original_extract
        self.assertFalse(result["enabled"])
        self.assertIn("api_error", result["reason"])
        self.assertEqual(written["items"], [])

    def test_all_stt_failures_skip(self):
        def failing_transcribe(path):
            raise RuntimeError("stt down")

        original_resolve = retranscribe.resolve_provider_and_key
        original_extract = retranscribe.extract_audio_interval
        retranscribe.resolve_provider_and_key = lambda provider, root: ("anthropic", "k", "m")
        retranscribe.extract_audio_interval = lambda *args, **kwargs: None
        try:
            with tempfile.TemporaryDirectory() as tmp_dir:
                result, _ = self._run(
                    Path(tmp_dir), self.ENABLED_REVIEW, transcribe_fn=failing_transcribe,
                )
        finally:
            retranscribe.resolve_provider_and_key = original_resolve
            retranscribe.extract_audio_interval = original_extract
        self.assertFalse(result["enabled"])
        self.assertEqual(result["reason"], "all intervals failed to retranscribe")

    def test_missing_review_file_skips(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            output_path = tmp / "retranscribe.json"
            result = retranscribe.run_step(
                str(tmp),
                str(tmp / "missing.json"),
                str(tmp / "stt.json"),
                str(tmp / "audio.wav"),
                str(output_path),
            )
        self.assertFalse(result["enabled"])
        self.assertEqual(result["reason"], "ai_review not found")


if __name__ == "__main__":
    unittest.main()
