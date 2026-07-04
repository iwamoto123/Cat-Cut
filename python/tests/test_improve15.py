"""改善15: JSONリトライ/修復・失敗テイクプロンプト・行末読点クリーニングのテスト。"""
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
from shared.llm_client import JSON_PARSE_RETRY_SUFFIX, _extract_json, call_llm_json
from shared.text_cleaning import clean_telop_line


class ExtractJsonRepairTests(unittest.TestCase):
    def test_trailing_comma_in_object(self):
        result = _extract_json('{"retakes": [], "needs_review": [],}')
        self.assertEqual(result["retakes"], [])

    def test_trailing_comma_in_array(self):
        result = _extract_json('{"retakes": [{"remove_sentence_ids": ["s-001"],}], "needs_review": []}')
        self.assertEqual(result["retakes"][0]["remove_sentence_ids"], ["s-001"])

    def test_fullwidth_quotes_repaired(self):
        text = '{"corrections": {"誤": "正"}, "cuts": []}'
        text = text.replace('"corrections"', '\u201ccorrections\u201d')
        result = _extract_json(text)
        self.assertIn("corrections", result)

    def test_control_chars_removed(self):
        result = _extract_json('{"retakes": [],\x0b "needs_review": []}')
        self.assertEqual(result["needs_review"], [])


class CallLlmJsonRetryTests(unittest.TestCase):
    def test_retries_once_on_json_decode_error(self):
        calls: list[str] = []

        def fake_llm(provider, api_key, model, prompt):
            calls.append(prompt)
            if len(calls) == 1:
                raise json.JSONDecodeError("Expecting ',' delimiter", prompt, 0)
            return {"retakes": [{"remove_sentence_ids": ["s-001"]}], "needs_review": []}

        result = call_llm_json("anthropic", "key", "model", "base prompt", caller=fake_llm)
        self.assertEqual(len(calls), 2)
        self.assertIn(JSON_PARSE_RETRY_SUFFIX, calls[1])
        self.assertEqual(result["retakes"][0]["remove_sentence_ids"], ["s-001"])

    def test_second_failure_propagates(self):
        def fake_llm(provider, api_key, model, prompt):
            raise json.JSONDecodeError("invalid", prompt, 0)

        with self.assertRaises(json.JSONDecodeError):
            call_llm_json("anthropic", "key", "model", "prompt", caller=fake_llm)


class CleanTelopLineTests(unittest.TestCase):
    def test_trailing_comma_removed(self):
        self.assertEqual(clean_telop_line("それでは奉仕インタビューということで、"), "それでは奉仕インタビューということで")

    def test_question_exclamation_comma_normalized(self):
        self.assertEqual(clean_telop_line("正社員だったんですか？、"), "正社員だったんですか？")

    def test_mid_line_question_comma(self):
        self.assertEqual(clean_telop_line("本当ですか？、そうです"), "本当ですか？そうです")


class BuildPromptRecordingMetaTests(unittest.TestCase):
    def test_prompt_includes_confident_cut_and_few_shot(self):
        prompt = ai_retake.build_prompt(
            [{"id": "s-001", "text": "テスト", "word_ids": ["w-001"]}],
        )
        self.assertIn("確信を持ってカットするもの", prompt)
        self.assertIn("収録の進行に関する発話", prompt)
        self.assertIn("もう1回お願いしていいですか", prompt)
        self.assertIn("編集するんで", prompt)
        self.assertIn("完璧です", prompt)
        self.assertIn("needs_review は**発話内容として意味があるか本当に判断できない場合のみ**", prompt)
        self.assertIn("意図的な繰り返し", prompt)
        self.assertIn("対比例", prompt)


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


class ChunkedJsonRetryIntegrationTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self._tmp.name)
        self.run_dir = self.tmp_path / "20260704_test_run"
        self.run_dir.mkdir()
        self.stt_path = self.run_dir / "stt.json"
        _make_stt(self.stt_path, 10)
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

    def test_json_retry_merges_successful_chunk(self):
        calls = {"n": 0}

        def fake_llm(provider, api_key, model, prompt):
            calls["n"] += 1
            if calls["n"] == 1:
                raise json.JSONDecodeError("bad json", prompt, 0)
            return {
                "retakes": [{"remove_sentence_ids": ["s-001"]}],
                "needs_review": [],
                "remove_filler_word_ids": [],
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
        self.assertEqual(result["retakes_applied"], 1)
        self.assertNotIn("failed_chunks", result)
        retakes = json.loads(self.retakes_path.read_text(encoding="utf-8"))
        self.assertEqual(len(retakes["retakes"]), 1)


if __name__ == "__main__":
    unittest.main()
