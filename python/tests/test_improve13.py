"""改善13: AI校正の本格化 (step05_ai_retake / step06b 拡張) のテスト。"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import step05_ai_retake as ai_retake
import step06b_ai_refine as ai_refine


def _make_stt(path: Path, sentences: list[dict]) -> None:
    words = []
    for sentence in sentences:
        for index, ch in enumerate(str(sentence["text"])):
            words.append({
                "id": f"w-{sentence['id']}-{index}",
                "text": ch,
                "start_ms": index * 100,
                "end_ms": (index + 1) * 100,
            })
        sentence["word_ids"] = [f"w-{sentence['id']}-{i}" for i in range(len(str(sentence["text"])))]
    path.write_text(json.dumps({"sentences": sentences, "words": words}, ensure_ascii=False), encoding="utf-8")


class ApplyLlmResponseTests(unittest.TestCase):
    def setUp(self):
        self.sentences = [
            {"id": "s-001", "text": "今日は"},
            {"id": "s-002", "text": "今日は天気"},
            {"id": "s-003", "text": "今日は天気がいい"},
            {"id": "s-004", "text": "崩れた文"},
            {"id": "s-005", "text": "正常文"},
        ]
        for sentence in self.sentences:
            sentence["word_ids"] = [f"w-{sentence['id']}-{i}" for i in range(len(str(sentence["text"])))]
        self.sentence_map = {s["id"]: s for s in self.sentences}
        self.word_map = {}
        for sentence in self.sentences:
            for wid in sentence["word_ids"]:
                self.word_map[wid] = {
                    "id": wid,
                    "text": "x",
                    "start_ms": 0,
                    "end_ms": 100,
                }

    def test_sentence_id_resolves_to_word_ids_for_retakes(self):
        response = {
            "retakes": [{"reason": "言い直し", "remove_sentence_ids": ["s-001", "s-002"]}],
            "needs_review": [],
        }
        retakes, needs, count, fillers_removed, _suspects = ai_retake.apply_llm_response(
            response, self.sentences, self.sentence_map, self.word_map,
        )
        self.assertEqual(count, 1)
        self.assertEqual(len(retakes), 1)
        self.assertEqual(retakes[0]["keep"], "retry")
        self.assertEqual(retakes[0]["original_sentence_ids"], self.sentences[0]["word_ids"] + self.sentences[1]["word_ids"])
        self.assertEqual(len(needs), 0)

    def test_unknown_sentence_id_is_ignored(self):
        response = {
            "retakes": [{"reason": "言い直し", "remove_sentence_ids": ["s-999"]}],
            "needs_review": [{"sentence_ids": ["s-404"], "reason": "missing"}],
        }
        retakes, needs, count, fillers_removed, _suspects = ai_retake.apply_llm_response(
            response, self.sentences, self.sentence_map, self.word_map,
        )
        self.assertEqual(retakes, [])
        self.assertEqual(count, 0)
        self.assertEqual(needs, [])

    def test_many_retakes_are_still_applied(self):
        response = {
            "retakes": [
                {"reason": "言い直し", "remove_sentence_ids": ["s-001", "s-002", "s-003"]},
            ],
            "needs_review": [],
        }
        retakes, needs, count, fillers_removed, _suspects = ai_retake.apply_llm_response(
            response, self.sentences, self.sentence_map, self.word_map,
        )
        self.assertEqual(count, 1)
        self.assertEqual(len(retakes), 1)
        self.assertEqual(len(needs), 0)
        expected_word_ids = (
            self.sentences[0]["word_ids"]
            + self.sentences[1]["word_ids"]
            + self.sentences[2]["word_ids"]
        )
        self.assertEqual(retakes[0]["original_sentence_ids"], expected_word_ids)

    def test_partial_retake_removes_only_matched_span(self):
        # フェーズW29: 文中の言い直しは remove_surface の範囲だけ word 単位でカットする
        sentences = [
            {"id": "s-101", "text": "全部やらないと不安だったりここを捨てるのが不安という"},
            {"id": "s-102", "text": "ここを捨てるのが怖いという感情が先に来てしまうからです"},
        ]
        word_map = {}
        for sentence in sentences:
            wids = []
            for i, ch in enumerate(sentence["text"]):
                wid = f"w-{sentence['id']}-{i}"
                wids.append(wid)
                word_map[wid] = {"id": wid, "text": ch, "start_ms": i * 100, "end_ms": (i + 1) * 100}
            sentence["word_ids"] = wids
        sentence_map = {s["id"]: s for s in sentences}
        response = {
            "partial_retakes": [
                {"sentence_id": "s-101", "remove_surface": "ここを捨てるのが不安という",
                 "reason": "文中の言い直し: 直後に言い直している"},
                {"sentence_id": "s-101", "remove_surface": "存在しない文言", "reason": "幻覚"},
                {"sentence_id": "s-101", "remove_surface": "全部", "reason": "3文字未満は無視"},
            ],
        }
        retakes, needs, count, fillers_removed, _suspects = ai_retake.apply_llm_response(
            response, sentences, sentence_map, word_map,
        )
        self.assertEqual(count, 1)
        self.assertEqual(len(retakes), 1)
        removed_text = "".join(word_map[w]["text"] for w in retakes[0]["original_sentence_ids"])
        self.assertEqual(removed_text, "ここを捨てるのが不安という")
        self.assertEqual(needs, [])

    def test_needs_review_resolves_word_span(self):
        response = {
            "retakes": [],
            "needs_review": [{"sentence_ids": ["s-004"], "reason": "復元困難"}],
        }
        retakes, needs, count, fillers_removed, _suspects = ai_retake.apply_llm_response(
            response, self.sentences, self.sentence_map, self.word_map,
        )
        self.assertEqual(retakes, [])
        self.assertEqual(count, 0)
        self.assertEqual(len(needs), 1)
        self.assertEqual(needs[0]["word_ids"], self.sentences[3]["word_ids"])
        self.assertEqual(needs[0]["reason"], "復元困難")


class RunStepRetakeTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self._tmp.name)
        self.run_dir = self.tmp_path / "run"
        self.run_dir.mkdir()
        self.stt_path = self.run_dir / "stt.json"
        _make_stt(self.stt_path, [
            {"id": "s-001", "text": "あ"},
            {"id": "s-002", "text": "い"},
            {"id": "s-003", "text": "う"},
            {"id": "s-004", "text": "え"},
            {"id": "s-005", "text": "お"},
        ])
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

    def test_no_key_writes_empty_retakes_and_disabled_review(self):
        result = ai_retake.run_step(
            str(self.run_dir),
            str(self.stt_path),
            str(self.fillers_path),
            str(self.retakes_path),
            str(self.review_path),
            api_key="",
        )
        self.assertFalse(result["enabled"])
        retakes = json.loads(self.retakes_path.read_text(encoding="utf-8"))
        review = json.loads(self.review_path.read_text(encoding="utf-8"))
        self.assertEqual(retakes, {"retakes": []})
        self.assertFalse(review["enabled"])

    def test_mock_llm_writes_step07_compatible_retakes(self):
        def fake_llm(provider, api_key, model, prompt):
            return {
                "retakes": [{"reason": "言い直し", "remove_sentence_ids": ["s-001"]}],
                "needs_review": [],
            }

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
        retakes = json.loads(self.retakes_path.read_text(encoding="utf-8"))
        self.assertEqual(len(retakes["retakes"]), 1)
        entry = retakes["retakes"][0]
        self.assertEqual(entry["keep"], "retry")
        self.assertTrue(entry["original_sentence_ids"])
        self.assertEqual(entry["retry_sentence_ids"], [])


SAMPLE_TELOP_TXT = """# Cat-Cut テロップ確認ファイル
#

# cut_001_p00 [00:00.00-00:02.00]
はい今日わね
"""


class ParseRefineMetadataTests(unittest.TestCase):
    def test_parses_needs_review_and_dismissed(self):
        response = {
            "needs_review": [
                {"page_id": "cut_001_p00", "reason": "数字確認", "suggestion": "100"},
                {"text": "不明語", "reason": "要確認"},
            ],
            "dismissed_finding_ids": ["finding_a", "finding_b"],
        }
        needs, dismissed = ai_refine.parse_refine_metadata(response)
        self.assertEqual(len(needs), 2)
        self.assertEqual(needs[0]["page_id"], "cut_001_p00")
        self.assertEqual(dismissed, ["finding_a", "finding_b"])


class RunStepRefineExtensionTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self._tmp.name)
        self.run_dir = self.tmp_path / "run"
        self.run_dir.mkdir()
        self.telop_path = self.run_dir / "telop.txt"
        self.telop_path.write_text(SAMPLE_TELOP_TXT, encoding="utf-8")
        self.stt_path = self.tmp_path / "stt.json"
        self.stt_path.write_text(json.dumps({"sentences": [{"id": "s0", "text": "はい"}], "words": []}), encoding="utf-8")
        self.review_path = self.run_dir / "telop_review.json"
        self.review_path.write_text(json.dumps({
            "findings": [
                {"id": "f1", "type": "number_check", "message": "数字", "source": "100", "page_id": "cut_001_p00"},
            ],
        }), encoding="utf-8")
        self.output_path = self.run_dir / "step06b_ai_refine" / "refine.json"

    def tearDown(self):
        self._tmp.cleanup()

    def test_refine_json_records_needs_review_and_dismissed(self):
        def fake_caller(provider, api_key, model, prompt):
            self.assertIn("f1", prompt)
            return {
                "corrections": {},
                "cuts": [],
                "needs_review": [{"page_id": "cut_001_p00", "reason": "数字要確認", "suggestion": "100"}],
                "dismissed_finding_ids": ["f1"],
            }

        result = ai_refine.run_step(
            str(self.run_dir),
            str(self.stt_path),
            str(self.output_path),
            review_path=str(self.review_path),
            dictionary_path=str(Path(__file__).resolve().parents[2] / "templates" / "domain_dictionary.yaml"),
            api_key="dummy",
            call_refine_fn=fake_caller,
        )
        self.assertTrue(result["enabled"])
        self.assertEqual(result["dismissed_finding_ids"], ["f1"])
        self.assertEqual(len(result["needs_review"]), 1)
        saved = json.loads(self.output_path.read_text(encoding="utf-8"))
        self.assertEqual(saved["dismissed_finding_ids"], ["f1"])
        self.assertEqual(len(saved["needs_review"]), 1)


if __name__ == "__main__":
    unittest.main()
