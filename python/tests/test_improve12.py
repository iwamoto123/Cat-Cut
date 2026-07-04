"""改善12: AI校正のマルチプロバイダ対応 (step06b_ai_refine.py) のテスト。"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import step06b_ai_refine as ai_refine


SAMPLE_TELOP_TXT = """# Cat-Cut テロップ確認ファイル
#

# cut_001_p00 [00:00.00-00:02.00]
はい今日わね
テーマですです
"""


def _write_stt(path: Path, sentences_text: list[str]) -> None:
    data = {
        "sentences": [{"id": f"s{i}", "text": t} for i, t in enumerate(sentences_text)],
        "words": [],
    }
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


class FindEnvKeyTests(unittest.TestCase):
    def setUp(self):
        self._orig_env = dict(os.environ)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._orig_env)

    def test_env_var_priority(self):
        os.environ["OPENAI_API_KEY"] = "env-openai"
        self.assertEqual(ai_refine.find_env_key("OPENAI_API_KEY", Path("/nonexistent")), "env-openai")

    def test_dotenv_fallback(self):
        os.environ.pop("GEMINI_API_KEY", None)
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            (tmp_path / ".env").write_text("GEMINI_API_KEY=gemini-from-file\n", encoding="utf-8")
            self.assertEqual(ai_refine.find_env_key("GEMINI_API_KEY", tmp_path), "gemini-from-file")


class ResolveProviderTests(unittest.TestCase):
    def setUp(self):
        self._orig_env = dict(os.environ)
        for key in ("AI_REFINE_PROVIDER", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"):
            os.environ.pop(key, None)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._orig_env)

    def test_auto_picks_anthropic_first(self):
        os.environ["ANTHROPIC_API_KEY"] = "ant"
        os.environ["OPENAI_API_KEY"] = "oai"
        provider, key, model = ai_refine.resolve_provider_and_key("auto")
        self.assertEqual(provider, "anthropic")
        self.assertEqual(key, "ant")

    def test_auto_priority_openai_when_no_anthropic(self):
        os.environ["OPENAI_API_KEY"] = "oai"
        os.environ["GEMINI_API_KEY"] = "gem"
        provider, key, _ = ai_refine.resolve_provider_and_key("auto")
        self.assertEqual(provider, "openai")
        self.assertEqual(key, "oai")

    def test_auto_only_gemini(self):
        os.environ["GEMINI_API_KEY"] = "gem"
        provider, key, model = ai_refine.resolve_provider_and_key("auto")
        self.assertEqual(provider, "gemini")
        self.assertEqual(key, "gem")
        self.assertEqual(model, ai_refine.DEFAULT_MODELS["gemini"])

    def test_ai_refine_provider_env_overrides_priority(self):
        os.environ["AI_REFINE_PROVIDER"] = "gemini"
        os.environ["ANTHROPIC_API_KEY"] = "ant"
        os.environ["GEMINI_API_KEY"] = "gem"
        provider, key, _ = ai_refine.resolve_provider_and_key("auto")
        self.assertEqual(provider, "gemini")
        self.assertEqual(key, "gem")

    def test_explicit_provider(self):
        os.environ["OPENAI_API_KEY"] = "oai"
        provider, key, _ = ai_refine.resolve_provider_and_key("openai")
        self.assertEqual(provider, "openai")
        self.assertEqual(key, "oai")

    def test_no_keys_returns_none(self):
        provider, key, model = ai_refine.resolve_provider_and_key("auto")
        self.assertIsNone(provider)
        self.assertEqual(key, "")
        self.assertEqual(model, "")


class CallProviderTests(unittest.TestCase):
    def test_call_openai_parses_choices(self):
        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {
            "choices": [{"message": {"content": '{"corrections": {}, "cuts": []}'}}],
        }
        with patch("httpx.post", return_value=mock_response) as post:
            result = ai_refine.call_openai("key", "gpt-5.4-mini", "prompt")
        self.assertEqual(result, {"corrections": {}, "cuts": []})
        body = post.call_args.kwargs["json"]
        self.assertEqual(body["max_completion_tokens"], 8192)
        self.assertEqual(post.call_args.kwargs["headers"]["Authorization"], "Bearer key")

    def test_call_gemini_parses_candidates(self):
        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {
            "candidates": [{"content": {"parts": [{"text": '{"corrections": {"a": "b"}}'}]}}],
        }
        with patch("httpx.post", return_value=mock_response) as post:
            result = ai_refine.call_gemini("key", "gemini-3-flash", "prompt")
        self.assertEqual(result, {"corrections": {"a": "b"}})
        url = post.call_args.args[0]
        self.assertIn("gemini-3-flash:generateContent", url)
        self.assertEqual(post.call_args.kwargs["headers"]["x-goog-api-key"], "key")


class RunStepProviderTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self._tmp.name)
        self.run_dir = self.tmp_path / "run"
        self.run_dir.mkdir()
        self.telop_path = self.run_dir / "telop.txt"
        self.telop_path.write_text(SAMPLE_TELOP_TXT, encoding="utf-8")
        self.stt_path = self.tmp_path / "stt.json"
        _write_stt(self.stt_path, ["はい今日は。", "テーマです。"])
        self.output_path = self.run_dir / "step06b_ai_refine" / "refine.json"
        self._orig_env = dict(os.environ)
        for key in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "AI_REFINE_PROVIDER"):
            os.environ.pop(key, None)

    def tearDown(self):
        self._tmp.cleanup()
        os.environ.clear()
        os.environ.update(self._orig_env)

    def test_gemini_only_records_provider_in_refine_json(self):
        os.environ["GEMINI_API_KEY"] = "gem-key"

        def fake_caller(provider, api_key, model, prompt):
            self.assertEqual(provider, "gemini")
            self.assertEqual(api_key, "gem-key")
            return {"corrections": {}, "cuts": []}

        result = ai_refine.run_step(
            str(self.run_dir),
            str(self.stt_path),
            str(self.output_path),
            call_refine_fn=fake_caller,
        )
        self.assertTrue(result["enabled"])
        self.assertEqual(result["provider"], "gemini")
        saved = json.loads(self.output_path.read_text(encoding="utf-8"))
        self.assertEqual(saved["provider"], "gemini")

    def test_openai_only_records_provider(self):
        os.environ["OPENAI_API_KEY"] = "oai-key"

        def fake_caller(provider, api_key, model, prompt):
            self.assertEqual(provider, "openai")
            return {"corrections": {}, "cuts": []}

        result = ai_refine.run_step(
            str(self.run_dir),
            str(self.stt_path),
            str(self.output_path),
            call_refine_fn=fake_caller,
        )
        self.assertTrue(result["enabled"])
        self.assertEqual(result["provider"], "openai")

    def test_no_key_skips_with_reason(self):
        original = self.telop_path.read_text(encoding="utf-8")
        result = ai_refine.run_step(
            str(self.run_dir),
            str(self.stt_path),
            str(self.output_path),
        )
        self.assertFalse(result["enabled"])
        self.assertEqual(result["reason"], "no AI provider key set")
        self.assertEqual(self.telop_path.read_text(encoding="utf-8"), original)


if __name__ == "__main__":
    unittest.main()
