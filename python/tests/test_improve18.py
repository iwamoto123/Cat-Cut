"""改善18: LLMトークン使用量トラッキング・概算コストのテスト。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shared.llm_client import (
    estimate_cost_usd,
    extract_anthropic_usage,
    extract_gemini_usage,
    extract_openai_usage,
    get_usage_summary,
    record_usage,
    reset_usage_tracking,
)


class ExtractUsageTests(unittest.TestCase):
    def test_extract_anthropic_usage(self):
        data = {"usage": {"input_tokens": 1000, "output_tokens": 200}}
        self.assertEqual(extract_anthropic_usage(data), (1000, 200))

    def test_extract_anthropic_usage_missing(self):
        self.assertEqual(extract_anthropic_usage({}), (None, None))
        self.assertEqual(extract_anthropic_usage({"usage": {"input_tokens": 1}}), (None, None))

    def test_extract_openai_usage(self):
        data = {"usage": {"prompt_tokens": 3000, "completion_tokens": 500}}
        self.assertEqual(extract_openai_usage(data), (3000, 500))

    def test_extract_openai_usage_missing(self):
        self.assertEqual(extract_openai_usage({}), (None, None))

    def test_extract_gemini_usage(self):
        data = {"usageMetadata": {"promptTokenCount": 4500, "candidatesTokenCount": 900}}
        self.assertEqual(extract_gemini_usage(data), (4500, 900))

    def test_extract_gemini_usage_missing(self):
        self.assertEqual(extract_gemini_usage({}), (None, None))


class UsageTrackingTests(unittest.TestCase):
    def setUp(self):
        reset_usage_tracking()

    def test_get_usage_summary_empty(self):
        self.assertIsNone(get_usage_summary())

    def test_record_and_summarize(self):
        record_usage("anthropic", "claude-sonnet-5", 45200, 8900)
        record_usage("anthropic", "claude-sonnet-5", 100, 50)
        summary = get_usage_summary()
        self.assertIsNotNone(summary)
        assert summary is not None
        self.assertEqual(summary["calls"], 2)
        self.assertEqual(summary["input_tokens"], 45300)
        self.assertEqual(summary["output_tokens"], 8950)
        self.assertEqual(summary["provider"], "anthropic")
        self.assertEqual(summary["model"], "claude-sonnet-5")
        self.assertIsNotNone(summary["estimated_cost_usd"])

    def test_record_without_tokens_counts_call_only(self):
        record_usage("openai", "gpt-5.4-mini", None, None)
        summary = get_usage_summary()
        self.assertIsNotNone(summary)
        assert summary is not None
        self.assertEqual(summary["calls"], 1)
        self.assertEqual(summary["input_tokens"], 0)
        self.assertEqual(summary["output_tokens"], 0)

    def test_reset_clears_tracker(self):
        record_usage("gemini", "gemini-3-flash", 100, 50)
        reset_usage_tracking()
        self.assertIsNone(get_usage_summary())


class EstimateCostTests(unittest.TestCase):
    def test_claude_sonnet(self):
        cost = estimate_cost_usd("claude-sonnet-5", 1_000_000, 1_000_000)
        self.assertAlmostEqual(cost, 3.0 + 15.0)

    def test_gpt_mini(self):
        cost = estimate_cost_usd("gpt-5.4-mini", 1_000_000, 1_000_000)
        self.assertAlmostEqual(cost, 0.15 + 0.60)

    def test_gemini_flash(self):
        cost = estimate_cost_usd("gemini-3-flash", 1_000_000, 1_000_000)
        self.assertAlmostEqual(cost, 0.10 + 0.40)

    def test_unknown_model_returns_none(self):
        self.assertIsNone(estimate_cost_usd("unknown-model-x", 1000, 500))

    def test_partial_tokens_cost(self):
        cost = estimate_cost_usd("claude-sonnet-5", 45200, 8900)
        expected = (45200 * 3.0 + 8900 * 15.0) / 1_000_000
        self.assertAlmostEqual(cost, expected)


if __name__ == "__main__":
    unittest.main()
