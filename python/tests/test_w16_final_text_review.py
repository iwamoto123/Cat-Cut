"""W16-7: AI最終チェック (step06d_final_text_review) のテスト。"""
import json
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import step06d_final_text_review as final_review


SCENES = [
    {"scene_id": "scene-001", "text": "今日は新学校の話をします"},
    {"scene_id": "scene-002", "text": "共通テストは6割ぐらいじゃないで"},
]


class ResolveIssuesTests(unittest.TestCase):
    def _resolve(self, items):
        return final_review.resolve_issues({"issues": items}, SCENES)

    def test_valid_issue_resolves_with_suggestion(self):
        results = self._resolve([
            {"scene_id": "scene-001", "surface": "新学校", "suggestion": "進学校", "reason": "誤変換の疑い"},
        ])
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["scene_id"], "scene-001")
        self.assertEqual(results[0]["surface"], "新学校")
        self.assertEqual(results[0]["suggestion"], "進学校")
        self.assertEqual(results[0]["reason"], "誤変換の疑い")

    def test_hallucinated_surface_is_discarded(self):
        # 本文に含まれない部分文字列(幻覚)は捨てる。
        results = self._resolve([
            {"scene_id": "scene-001", "surface": "進学校です", "reason": "x"},
        ])
        self.assertEqual(results, [])

    def test_unknown_scene_id_is_discarded(self):
        results = self._resolve([
            {"scene_id": "scene-999", "surface": "新学校", "reason": "x"},
        ])
        self.assertEqual(results, [])

    def test_empty_and_too_long_surface_are_discarded(self):
        results = self._resolve([
            {"scene_id": "scene-001", "surface": "", "reason": "x"},
            {"scene_id": "scene-001", "surface": "あ" * 31, "reason": "x"},
        ])
        self.assertEqual(results, [])

    def test_duplicates_are_removed(self):
        results = self._resolve([
            {"scene_id": "scene-001", "surface": "新学校", "reason": "1回目"},
            {"scene_id": "scene-001", "surface": "新学校", "reason": "2回目"},
        ])
        self.assertEqual(len(results), 1)

    def test_suggestion_equal_to_surface_is_dropped(self):
        results = self._resolve([
            {"scene_id": "scene-001", "surface": "新学校", "suggestion": "新学校", "reason": "x"},
        ])
        self.assertEqual(len(results), 1)
        self.assertNotIn("suggestion", results[0])

    def test_non_dict_response_returns_empty(self):
        self.assertEqual(final_review.resolve_issues({"issues": "broken"}, SCENES), [])
        self.assertEqual(final_review.resolve_issues({}, SCENES), [])


class BuildPromptTests(unittest.TestCase):
    def test_prompt_contains_scenes_and_rules(self):
        prompt = final_review.build_prompt(SCENES)
        self.assertIn("scene-001", prompt)
        self.assertIn("今日は新学校の話をします", prompt)
        self.assertIn("本文は書き換えないでください", prompt)

    def test_prompt_injects_correction_examples(self):
        prompt = final_review.build_prompt(
            SCENES,
            correction_examples=[{"before": "新学校", "after": "進学校", "count": 3}],
        )
        self.assertIn("「新学校」→「進学校」（3回修正）", prompt)

    def test_prompt_without_examples_has_no_examples_section(self):
        prompt = final_review.build_prompt(SCENES)
        self.assertNotIn("ユーザーが過去に確定した修正例", prompt)


class RunStepTests(unittest.TestCase):
    def _write_input(self, tmp: Path, scenes) -> Path:
        input_path = tmp / "scenes.json"
        input_path.write_text(json.dumps({"scenes": scenes}, ensure_ascii=False), encoding="utf-8")
        return input_path

    def test_run_step_with_fake_llm_writes_issues(self):
        def fake_call_llm(provider, key, model, prompt):
            return {
                "issues": [
                    {"scene_id": "scene-001", "surface": "新学校", "suggestion": "進学校", "reason": "誤変換"},
                    {"scene_id": "scene-999", "surface": "新学校", "reason": "存在しないシーン"},
                ]
            }

        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            input_path = self._write_input(tmp, SCENES)
            output_path = tmp / "issues.json"
            # resolve_provider_and_key は環境依存のため差し替える(キー無し環境でも通す)。
            original = final_review.resolve_provider_and_key
            final_review.resolve_provider_and_key = lambda provider, root: ("anthropic", "test-key", "test-model")
            try:
                result = final_review.run_step(
                    str(input_path), str(output_path), call_llm_fn=fake_call_llm,
                )
            finally:
                final_review.resolve_provider_and_key = original

        self.assertTrue(result["enabled"])
        self.assertEqual(len(result["issues"]), 1)
        self.assertEqual(result["issues"][0]["surface"], "新学校")

    def test_run_step_llm_failure_is_non_fatal(self):
        def failing_call_llm(provider, key, model, prompt):
            raise RuntimeError("boom")

        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            input_path = self._write_input(tmp, SCENES)
            output_path = tmp / "issues.json"
            original = final_review.resolve_provider_and_key
            final_review.resolve_provider_and_key = lambda provider, root: ("anthropic", "test-key", "test-model")
            try:
                result = final_review.run_step(
                    str(input_path), str(output_path), call_llm_fn=failing_call_llm,
                )
            finally:
                final_review.resolve_provider_and_key = original
            written = json.loads(output_path.read_text(encoding="utf-8"))

        self.assertFalse(result["enabled"])
        self.assertIn("api_error", result["reason"])
        self.assertEqual(written["issues"], [])

    def test_run_step_without_input_writes_disabled(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            result = final_review.run_step(
                str(tmp / "missing.json"), str(tmp / "issues.json"),
            )
        self.assertFalse(result["enabled"])

    def test_load_scenes_skips_invalid_entries(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            input_path = self._write_input(tmp, [
                {"scene_id": "scene-001", "text": "本文あり"},
                {"scene_id": "", "text": "idなし"},
                {"scene_id": "scene-002", "text": "   "},
                "not-a-dict",
            ])
            scenes = final_review.load_scenes(input_path)
        self.assertEqual([s["scene_id"] for s in scenes], ["scene-001"])


if __name__ == "__main__":
    unittest.main()
