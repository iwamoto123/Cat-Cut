"""改善14: AI校正信頼性・フィラーAI判定・決定的クリーニングのテスト。"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import step05_ai_retake as ai_retake
import step06b_ai_refine as ai_refine
from shared.text_cleaning import apply_deterministic_text_cleaning


def _make_stt(path: Path, sentence_count: int) -> None:
    sentences = []
    words = []
    for i in range(sentence_count):
        sid = f"s-{i:03d}"
        text = f"文{i}"
        word_ids = []
        for j, ch in enumerate(text):
            wid = f"w-{i:03d}-{j}"
            word_ids.append(wid)
            words.append({
                "id": wid,
                "text": ch,
                "start_ms": i * 1000 + j * 100,
                "end_ms": i * 1000 + (j + 1) * 100,
            })
        sentences.append({"id": sid, "text": text, "word_ids": word_ids})
    path.write_text(json.dumps({"sentences": sentences, "words": words}, ensure_ascii=False), encoding="utf-8")


class ChunkSentencesTests(unittest.TestCase):
    def test_splits_over_100_sentences(self):
        sentences = [{"id": f"s-{i}", "text": f"t{i}"} for i in range(205)]
        chunks = ai_retake.chunk_sentences(sentences, chunk_size=100, context_size=5)
        self.assertEqual(len(chunks), 3)
        self.assertEqual(len(chunks[0][1]), 100)
        self.assertEqual(len(chunks[1][1]), 100)
        self.assertEqual(len(chunks[2][1]), 5)
        self.assertEqual(len(chunks[1][0]), 5)

    def test_merge_llm_responses_concatenates(self):
        merged = ai_retake.merge_llm_responses([
            {"retakes": [{"remove_sentence_ids": ["s-001"]}], "needs_review": [], "remove_filler_word_ids": ["w-1"]},
            {"retakes": [{"remove_sentence_ids": ["s-002"]}], "needs_review": [{"sentence_ids": ["s-010"]}], "remove_filler_word_ids": ["w-2"]},
        ])
        self.assertEqual(len(merged["retakes"]), 2)
        self.assertEqual(len(merged["needs_review"]), 1)
        self.assertEqual(merged["remove_filler_word_ids"], ["w-1", "w-2"])

    def test_merge_llm_responses_keeps_partial_retakes(self):
        # フェーズW29: チャンクマージで partial_retakes を落とさない
        merged = ai_retake.merge_llm_responses([
            {"partial_retakes": [{"sentence_id": "s-001", "remove_surface": "ここを捨てるのが不安という"}]},
            {"partial_retakes": [{"sentence_id": "s-063", "remove_surface": "半年間のスケジュール感-"}]},
        ])
        self.assertEqual(len(merged["partial_retakes"]), 2)


class RemoveFillerWordIdsTests(unittest.TestCase):
    def setUp(self):
        self.sentences = [{"id": "s-001", "text": "その", "word_ids": ["w-001", "w-002"]}]
        self.sentence_map = {"s-001": self.sentences[0]}
        self.word_map = {
            "w-001": {"id": "w-001", "text": "そ", "start_ms": 0, "end_ms": 100},
            "w-002": {"id": "w-002", "text": "の", "start_ms": 100, "end_ms": 200},
            "w-999": {"id": "w-999", "text": "x", "start_ms": 200, "end_ms": 300},
        }

    def test_remove_filler_word_ids_creates_retake_entry(self):
        response = {
            "retakes": [],
            "needs_review": [],
            "remove_filler_word_ids": ["w-001", "w-002", "w-404"],
        }
        retakes, needs, retake_count, fillers_removed, _suspects = ai_retake.apply_llm_response(
            response, self.sentences, self.sentence_map, self.word_map,
        )
        self.assertEqual(retake_count, 0)
        self.assertEqual(fillers_removed, 2)
        self.assertEqual(len(retakes), 1)
        self.assertEqual(retakes[0]["reason"], "フィラー除去(AI判定)")
        self.assertEqual(retakes[0]["original_sentence_ids"], ["w-001", "w-002"])
        self.assertEqual(needs, [])


class DeterministicCleaningTests(unittest.TestCase):
    def test_trailing_comma_removed(self):
        self.assertEqual(apply_deterministic_text_cleaning("志望大学は、"), "志望大学は")

    def test_consecutive_commas_collapsed(self):
        self.assertEqual(apply_deterministic_text_cleaning("質問が、、"), "質問が")

    def test_fullwidth_digits_normalized(self):
        self.assertEqual(apply_deterministic_text_cleaning("６月"), "6月")


class ChunkedRunStepTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self._tmp.name)
        self.run_dir = self.tmp_path / "20260704_100516_白谷塾インタビュー"
        self.run_dir.mkdir()
        self.stt_path = self.run_dir / "stt.json"
        _make_stt(self.stt_path, 150)
        self.fillers_path = self.run_dir / "fillers.json"
        self.fillers_path.write_text(json.dumps({"fillers": []}), encoding="utf-8")
        self.retakes_path = self.run_dir / "step05_retake_detect" / "retakes.json"
        self.review_path = self.run_dir / "step05_ai_retake" / "ai_review.json"
        self._orig_env = dict(os.environ)
        for key in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"):
            os.environ.pop(key, None)

    def tearDown(self):
        self._tmp.cleanup()
        os.environ.clear()
        os.environ.update(self._orig_env)

    def test_partial_chunk_failure_still_enables_review(self):
        call_count = {"n": 0}

        def fake_llm(provider, api_key, model, prompt):
            call_count["n"] += 1
            if call_count["n"] == 1:
                return {"retakes": [], "needs_review": [], "remove_filler_word_ids": []}
            raise TimeoutError("The read operation timed out")

        result = ai_retake.run_step(
            str(self.run_dir),
            str(self.stt_path),
            str(self.fillers_path),
            str(self.retakes_path),
            str(self.review_path),
            api_key="dummy",
            call_llm_fn=fake_llm,
        )
        self.assertTrue(result["enabled"])
        self.assertEqual(result["failed_chunks"], 1)
        review = json.loads(self.review_path.read_text(encoding="utf-8"))
        self.assertEqual(review["failed_chunks"], 1)


class TitleInjectionTests(unittest.TestCase):
    def test_extract_title_from_run_dir(self):
        title = ai_refine.extract_title_from_run_dir(
            "/runs/20260704_100516_白谷塾オンライン生インタビュー",
        )
        self.assertEqual(title, "白谷塾オンライン生インタビュー")

    def test_build_prompt_includes_title(self):
        prompt = ai_refine.build_prompt(
            transcript="全文",
            cuts=[{"cut_id": "cut_001", "pages": ["テスト"]}],
            max_chars_per_line=12,
            max_lines_per_page=1,
            video_title="白谷塾オンライン生インタビュー",
        )
        self.assertIn("動画タイトル（文脈ヒント）", prompt)
        self.assertIn("白谷塾オンライン生インタビュー", prompt)
        self.assertIn("平谷塾", prompt)

    def test_chunk_cuts_payload(self):
        cuts = [{"cut_id": f"cut_{i:03d}", "pages": ["a"]} for i in range(75)]
        chunks = ai_refine.chunk_cuts_payload(cuts, chunk_size=50)
        self.assertEqual(len(chunks), 2)
        self.assertEqual(len(chunks[0]), 50)
        self.assertEqual(len(chunks[1]), 25)

    def test_merge_refine_responses_merges_corrections(self):
        merged = ai_refine.merge_refine_responses([
            {"corrections": {"平谷塾": "白谷塾"}, "cuts": [], "needs_review": [], "dismissed_finding_ids": ["a"]},
            {"corrections": {"勇気": "有機"}, "cuts": [{"cut_id": "cut_001", "pages": ["x"]}], "needs_review": [{"page_id": "p1", "reason": "r"}], "dismissed_finding_ids": ["b"]},
        ])
        self.assertEqual(merged["corrections"]["平谷塾"], "白谷塾")
        self.assertEqual(merged["corrections"]["勇気"], "有機")
        self.assertEqual(len(merged["cuts"]), 1)
        self.assertEqual(len(merged["needs_review"]), 1)
        self.assertEqual(merged["dismissed_finding_ids"], ["a", "b"])


if __name__ == "__main__":
    unittest.main()
