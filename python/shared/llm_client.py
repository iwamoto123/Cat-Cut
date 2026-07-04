"""Shared LLM client utilities for AI pipeline steps (step05 / step06b)."""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any, Callable, Literal, Optional, TypeVar

ProviderName = Literal["anthropic", "openai", "gemini"]
ProviderArg = Literal["auto", "anthropic", "openai", "gemini"]

PROVIDER_PRIORITY: list[ProviderName] = ["anthropic", "openai", "gemini"]

DEFAULT_MODELS: dict[ProviderName, str] = {
    "anthropic": "claude-sonnet-5",
    "openai": "gpt-5.4-mini",
    "gemini": "gemini-3-flash",
}

API_KEY_ENV: dict[ProviderName, str] = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "gemini": "GEMINI_API_KEY",
}

MODEL_ENV: dict[ProviderName, str] = {
    "anthropic": "ANTHROPIC_MODEL",
    "openai": "OPENAI_MODEL",
    "gemini": "GEMINI_MODEL",
}

ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
OPENAI_API_URL = "https://api.openai.com/v1/chat/completions"
GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"

DEFAULT_TIMEOUT = 300.0
RETRY_DELAY_SEC = 2.0

T = TypeVar("T")


def find_env_key(env_var: str, repo_root: Path) -> str:
    """環境変数を優先し、無ければ `.env` ファイルからキーを探す。"""
    key = os.environ.get(env_var, "").strip()
    if key:
        return key
    env_path = repo_root / ".env"
    if not env_path.exists():
        return ""
    try:
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            if k.strip() == env_var:
                return v.strip().strip('"').strip("'")
    except OSError:
        return ""
    return ""


def find_provider_key(provider: ProviderName, repo_root: Path) -> str:
    return find_env_key(API_KEY_ENV[provider], repo_root)


def resolve_model(provider: ProviderName, model_override: Optional[str] = None) -> str:
    if model_override:
        return model_override
    env_model = os.environ.get(MODEL_ENV[provider], "").strip()
    return env_model or DEFAULT_MODELS[provider]


def resolve_provider_and_key(
    provider_arg: ProviderArg = "auto",
    repo_root: Path | None = None,
) -> tuple[Optional[ProviderName], str, str]:
    """プロバイダ・APIキー・モデルを解決する。キーが無ければ (None, "", "")。"""
    root = repo_root or Path(__file__).resolve().parents[2]
    env_provider = os.environ.get("AI_REFINE_PROVIDER", "").strip().lower()
    if provider_arg == "auto" and env_provider in PROVIDER_PRIORITY:
        preferred: list[ProviderName] = [env_provider]  # type: ignore[list-item]
        for p in PROVIDER_PRIORITY:
            if p not in preferred:
                preferred.append(p)
    elif provider_arg != "auto":
        preferred = [provider_arg]  # type: ignore[list-item]
    else:
        preferred = list(PROVIDER_PRIORITY)

    for provider in preferred:
        key = find_provider_key(provider, root)
        if key:
            return provider, key, resolve_model(provider)
    return None, "", ""


_JSON_TRAILING_COMMA_OBJ_RE = re.compile(r",(\s*})")
_JSON_TRAILING_COMMA_ARR_RE = re.compile(r",(\s*])")
_CONTROL_CHAR_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

JSON_PARSE_RETRY_SUFFIX = (
    "\n\n前回の応答はJSONとして解析できませんでした。"
    "説明文・コードフェンス・コメントを含めず、有効なJSONオブジェクトのみを返してください"
)


def _repair_json_text(text: str, step: Literal["trailing_comma", "fullwidth_quotes", "control_chars"]) -> str:
    if step == "trailing_comma":
        text = _JSON_TRAILING_COMMA_OBJ_RE.sub(r"\1", text)
        return _JSON_TRAILING_COMMA_ARR_RE.sub(r"\1", text)
    if step == "fullwidth_quotes":
        return text.replace("\u201c", '"').replace("\u201d", '"')
    return _CONTROL_CHAR_RE.sub("", text)


def _extract_json(text: str) -> dict[str, Any]:
    """LLMのレスポンステキストから最初のJSONオブジェクトを取り出す。"""
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.DOTALL)
    if fence:
        text = fence.group(1)
    else:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            text = text[start : end + 1]

    candidates = [text]
    repaired = _repair_json_text(text, "trailing_comma")
    if repaired != text:
        candidates.append(repaired)
    repaired = _repair_json_text(repaired, "fullwidth_quotes")
    if repaired not in candidates:
        candidates.append(repaired)
    repaired = _repair_json_text(repaired, "control_chars")
    if repaired not in candidates:
        candidates.append(repaired)

    last_error: Optional[json.JSONDecodeError] = None
    for index, candidate in enumerate(candidates):
        try:
            result = json.loads(candidate)
            if index > 0:
                print("[llm_client] repaired json")
            if not isinstance(result, dict):
                raise json.JSONDecodeError("expected JSON object", candidate, 0)
            return result
        except json.JSONDecodeError as exc:
            last_error = exc
    if last_error is not None:
        raise last_error
    raise json.JSONDecodeError("no JSON object found", text, 0)


def call_llm_json(
    provider: ProviderName,
    api_key: str,
    model: str,
    prompt: str,
    caller: Optional[Callable[[ProviderName, str, str, str], dict[str, Any]]] = None,
) -> dict[str, Any]:
    """LLMを呼び出しJSONを返す。JSON解析失敗時は1回だけ厳格JSON指示付きで再送する。"""
    llm = caller or call_llm
    try:
        return llm(provider, api_key, model, prompt)
    except json.JSONDecodeError as exc:
        print(
            f"[llm_client] JSON parse failed ({type(exc).__name__}: {exc}); "
            "retrying once with strict JSON instruction"
        )
        return llm(provider, api_key, model, prompt + JSON_PARSE_RETRY_SUFFIX)


def _is_retryable_error(exc: Exception) -> bool:
    import httpx

    if isinstance(exc, httpx.TimeoutException):
        return True
    if isinstance(exc, httpx.ConnectError):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code >= 500
    return False


def _with_retry(operation: Callable[[], T], label: str) -> T:
    try:
        return operation()
    except Exception as exc:  # noqa: BLE001
        if not _is_retryable_error(exc):
            raise
        print(
            f"[llm_client] {label} failed ({type(exc).__name__}: {exc}); "
            f"retrying once after {RETRY_DELAY_SEC:.0f}s"
        )
        time.sleep(RETRY_DELAY_SEC)
        return operation()


def call_claude(api_key: str, model: str, prompt: str, timeout: float = DEFAULT_TIMEOUT) -> dict[str, Any]:
    import httpx

    def _request(payload: dict[str, Any]) -> dict[str, Any]:
        response = httpx.post(
            ANTHROPIC_API_URL,
            headers={
                "x-api-key": api_key,
                "anthropic-version": ANTHROPIC_VERSION,
                "content-type": "application/json",
            },
            json=payload,
            timeout=timeout,
        )
        response.raise_for_status()
        return response.json()

    def _post() -> dict[str, Any]:
        # thinking系モデル(claude-sonnet-5等)は既定で内部思考にmax_tokensを使い切り、
        # 本文が空になることがある(実測: thinking_tokens=8192, text=0)。
        # 構造化JSON出力タスクでは思考を無効化する。未対応モデルで400になったら外して再送。
        payload: dict[str, Any] = {
            "model": model,
            "max_tokens": 16384,
            "thinking": {"type": "disabled"},
            "messages": [{"role": "user", "content": prompt}],
        }
        try:
            data = _request(payload)
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 400 and "thinking" in payload:
                payload.pop("thinking")
                data = _request(payload)
            else:
                raise
        text_parts = [
            block.get("text", "")
            for block in data.get("content", [])
            if isinstance(block, dict) and block.get("type") == "text"
        ]
        raw_text = "".join(text_parts)
        if not raw_text.strip() and data.get("stop_reason") == "max_tokens":
            raise ValueError(
                "anthropic returned empty text (max_tokens consumed by thinking); "
                "consider a shorter chunk or non-thinking model"
            )
        return _extract_json(raw_text)

    return _with_retry(_post, f"anthropic/{model}")


def call_openai(api_key: str, model: str, prompt: str, timeout: float = DEFAULT_TIMEOUT) -> dict[str, Any]:
    import httpx

    def _post() -> dict[str, Any]:
        response = httpx.post(
            OPENAI_API_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "content-type": "application/json",
            },
            json={
                "model": model,
                "max_completion_tokens": 8192,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=timeout,
        )
        response.raise_for_status()
        data = response.json()
        choices = data.get("choices") or []
        if not choices:
            raise ValueError("OpenAI response has no choices")
        message = choices[0].get("message") or {}
        raw_text = str(message.get("content", ""))
        return _extract_json(raw_text)

    return _with_retry(_post, f"openai/{model}")


def call_gemini(api_key: str, model: str, prompt: str, timeout: float = DEFAULT_TIMEOUT) -> dict[str, Any]:
    import httpx

    def _post() -> dict[str, Any]:
        url = f"{GEMINI_API_BASE}/{model}:generateContent"
        response = httpx.post(
            url,
            headers={
                "x-goog-api-key": api_key,
                "content-type": "application/json",
            },
            json={
                "contents": [{"parts": [{"text": prompt}]}],
            },
            timeout=timeout,
        )
        response.raise_for_status()
        data = response.json()
        candidates = data.get("candidates") or []
        if not candidates:
            raise ValueError("Gemini response has no candidates")
        parts = candidates[0].get("content", {}).get("parts") or []
        raw_text = "".join(str(part.get("text", "")) for part in parts if isinstance(part, dict))
        return _extract_json(raw_text)

    return _with_retry(_post, f"gemini/{model}")


def call_llm(provider: ProviderName, api_key: str, model: str, prompt: str) -> dict[str, Any]:
    if provider == "anthropic":
        return call_claude(api_key, model, prompt)
    if provider == "openai":
        return call_openai(api_key, model, prompt)
    return call_gemini(api_key, model, prompt)
