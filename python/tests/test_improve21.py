"""改善21: LLMエラー分類・レスポンス本文ログ・billing/auth即時失敗のテスト。"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import step05_ai_retake as ai_retake
import step06b_ai_refine as ai_refine
from shared.llm_client import (
    _is_retryable_error,
    _raise_with_response_body,
    classify_llm_error,
    summarize_error_kinds,
    truncate_error_detail,
)


def _http_status_error(status_code: int, body: str = "") -> httpx.HTTPStatusError:
    request = httpx.Request("POST", "https://api.example.com/v1/messages")
    response = httpx.Response(status_code, text=body, request=request)
    return httpx.HTTPStatusError(
        f"Client error '{status_code}' for url 'https://api.example.com/v1/messages'",
        request=request,
        response=response,
    )


ANTHROPIC_BILLING_BODY = (
    '{"type":"error","error":{"type":"invalid_request_error",'
    '"message":"Your credit balance is too low to access the Anthropic API. '
    'Please go to Plans & Billing to upgrade or purchase credits."}}'
)


class ClassifyLlmErrorTests(unittest.TestCase):
    def test_billing_anthropic_credit_balance(self):
        exc = _http_status_error(400, ANTHROPIC_BILLING_BODY)
        try:
            _raise_with_response_body(exc)
        except httpx.HTTPStatusError as wrapped:
            self.assertEqual(classify_llm_error(wrapped), "billing")

    def test_billing_openai_insufficient_quota(self):
        exc = _http_status_error(429, '{"error":{"code":"insufficient_quota"}}')
        try:
            _raise_with_response_body(exc)
        except httpx.HTTPStatusError as wrapped:
            # 429でも本文がクォータ切れならbilling優先
            self.assertEqual(classify_llm_error(wrapped), "billing")

    def test_auth_401(self):
        self.assertEqual(classify_llm_error(_http_status_error(401)), "auth")

    def test_auth_invalid_api_key_message(self):
        exc = _http_status_error(400, '{"error":{"message":"invalid x-api-key"}}')
        try:
            _raise_with_response_body(exc)
        except httpx.HTTPStatusError as wrapped:
            self.assertEqual(classify_llm_error(wrapped), "auth")

    def test_rate_limit_429(self):
        self.assertEqual(classify_llm_error(_http_status_error(429)), "rate_limit")

    def test_overloaded_529(self):
        self.assertEqual(classify_llm_error(_http_status_error(529)), "overloaded")

    def test_overloaded_503(self):
        self.assertEqual(classify_llm_error(_http_status_error(503)), "overloaded")

    def test_timeout(self):
        self.assertEqual(classify_llm_error(httpx.ReadTimeout("timed out")), "timeout")

    def test_other(self):
        self.assertEqual(classify_llm_error(ValueError("boom")), "other")


class RaiseWithResponseBodyTests(unittest.TestCase):
    def test_message_includes_body(self):
        exc = _http_status_error(400, ANTHROPIC_BILLING_BODY)
        with self.assertRaises(httpx.HTTPStatusError) as ctx:
            _raise_with_response_body(exc)
        self.assertIn("credit balance is too low", str(ctx.exception))
        # 型・ステータスコードは維持される(thinkingフォールバックの400判定用)
        self.assertEqual(ctx.exception.response.status_code, 400)

    def test_body_truncated_to_500_chars(self):
        exc = _http_status_error(400, "x" * 2000)
        with self.assertRaises(httpx.HTTPStatusError) as ctx:
            _raise_with_response_body(exc)
        self.assertLess(len(str(ctx.exception)), 700)

    def test_truncate_error_detail(self):
        self.assertEqual(truncate_error_detail("abc"), "abc")
        self.assertEqual(len(truncate_error_detail("y" * 900)), 501)


class RetryableTests(unittest.TestCase):
    def test_billing_not_retryable(self):
        exc = _http_status_error(529, ANTHROPIC_BILLING_BODY)
        try:
            _raise_with_response_body(exc)
        except httpx.HTTPStatusError as wrapped:
            self.assertFalse(_is_retryable_error(wrapped))

    def test_auth_not_retryable(self):
        self.assertFalse(_is_retryable_error(_http_status_error(401)))

    def test_529_still_retryable(self):
        self.assertTrue(_is_retryable_error(_http_status_error(529)))

    def test_429_still_not_retryable(self):
        self.assertFalse(_is_retryable_error(_http_status_error(429)))


class SummarizeErrorKindsTests(unittest.TestCase):
    def test_empty_returns_other(self):
        self.assertEqual(summarize_error_kinds([]), "other")

    def test_most_frequent(self):
        self.assertEqual(summarize_error_kinds(["other", "billing", "billing"]), "billing")

    def test_tie_returns_first(self):
        self.assertEqual(summarize_error_kinds(["timeout", "billing"]), "timeout")


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


class Step05FatalErrorTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self._tmp.name)
        self.run_dir = self.tmp_path / "20260704_200955_videoplayback_6"
        self.run_dir.mkdir()
        self.stt_path = self.run_dir / "stt.json"
        _make_stt(self.stt_path, 250)  # 3チャンクになる
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

    def test_billing_error_skips_remaining_chunks(self):
        call_count = {"n": 0}

        def fake_llm(provider, api_key, model, prompt):
            call_count["n"] += 1
            exc = _http_status_error(400, ANTHROPIC_BILLING_BODY)
            try:
                _raise_with_response_body(exc)
            except httpx.HTTPStatusError as wrapped:
                raise wrapped

        result = ai_retake.run_step(
            str(self.run_dir),
            str(self.stt_path),
            str(self.fillers_path),
            str(self.retakes_path),
            str(self.review_path),
            api_key="dummy",
            call_llm_fn=fake_llm,
        )
        # billingは最初のチャンクで即時失敗し、残チャンクを呼ばない
        self.assertEqual(call_count["n"], 1)
        self.assertFalse(result["enabled"])
        self.assertEqual(result["error_kind"], "billing")
        self.assertEqual(result["provider"], "anthropic")
        self.assertIn("credit balance is too low", result["error_detail"])
        review = json.loads(self.review_path.read_text(encoding="utf-8"))
        self.assertEqual(review["error_kind"], "billing")
        self.assertEqual(review["failed_chunks"], 3)
        self.assertIn("all 3 chunks failed", review["reason"])

    def test_timeout_error_continues_all_chunks(self):
        call_count = {"n": 0}

        def fake_llm(provider, api_key, model, prompt):
            call_count["n"] += 1
            raise httpx.ReadTimeout("The read operation timed out")

        result = ai_retake.run_step(
            str(self.run_dir),
            str(self.stt_path),
            str(self.fillers_path),
            str(self.retakes_path),
            str(self.review_path),
            api_key="dummy",
            call_llm_fn=fake_llm,
        )
        # timeoutは致命エラーではないので全チャンクを試行する
        self.assertEqual(call_count["n"], 3)
        self.assertEqual(result["error_kind"], "timeout")


class Step06bFatalErrorTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self._tmp.name)
        self.run_dir = self.tmp_path / "20260704_run"
        self.run_dir.mkdir()
        self.stt_path = self.run_dir / "stt.json"
        _make_stt(self.stt_path, 10)
        # 51カット→2チャンクのtelop.txtを作る
        pages = []
        for i in range(51):
            pages.append(f"# cut_{i + 1:03d}_p00\nテキスト{i}\n")
        (self.run_dir / "telop.txt").write_text("\n".join(pages), encoding="utf-8")
        self.output_path = self.run_dir / "refine.json"
        self._orig_env = dict(os.environ)
        for key in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"):
            os.environ.pop(key, None)

    def tearDown(self):
        self._tmp.cleanup()
        os.environ.clear()
        os.environ.update(self._orig_env)

    def test_billing_error_writes_error_kind(self):
        call_count = {"n": 0}

        def fake_llm(provider, api_key, model, prompt):
            call_count["n"] += 1
            exc = _http_status_error(400, ANTHROPIC_BILLING_BODY)
            try:
                _raise_with_response_body(exc)
            except httpx.HTTPStatusError as wrapped:
                raise wrapped

        result = ai_refine.run_step(
            str(self.run_dir),
            str(self.stt_path),
            str(self.output_path),
            api_key="dummy",
            call_refine_fn=fake_llm,
        )
        self.assertEqual(call_count["n"], 1)
        self.assertFalse(result["enabled"])
        self.assertEqual(result["error_kind"], "billing")
        self.assertIn("credit balance is too low", result["error_detail"])
        refine = json.loads(self.output_path.read_text(encoding="utf-8"))
        self.assertEqual(refine["error_kind"], "billing")
        self.assertEqual(refine["failed_chunks"], 2)


if __name__ == "__main__":
    unittest.main()
