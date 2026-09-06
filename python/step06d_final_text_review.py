"""Step 6d: AI最終チェック (W16-7)。

検品最終段階で、現在の表示テキスト全シーンをLLMで一括再チェックする。
本文は書き換えず、誤字脱字・変換ミス・語尾欠落・文脈上おかしい表現を
{scene_id, 該当文字列, 提案, 理由} で列挙する。

Usage:
    python step06d_final_text_review.py \\
        --input <scenes.json> --output <issues.json> \\
        [--correction-history <path>] [--provider auto]

入力 scenes.json: {"scenes": [{"scene_id": "...", "text": "..."}]}（表示順）
出力 issues.json: {"enabled": true, "issues": [{"scene_id", "surface", "suggestion", "reason"}]}
APIキー無し・LLM失敗は non-fatal（enabled: false + reason を書いて正常終了する）。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Callable, Optional

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from shared.transcript_correction import (  # noqa: E402
    load_correction_history,
    top_correction_examples,
)
from shared.llm_client import (  # noqa: E402
    ProviderArg,
    ProviderName,
    call_llm,
    call_llm_json,
    classify_llm_error,
    get_usage_summary,
    print_usage_summary,
    reset_usage_tracking,
    resolve_provider_and_key,
    truncate_error_detail,
)

REPO_ROOT = ROOT.parent

# step05と同じ既定(頻度上位30ペアをプロンプトへ注入)。
CORRECTION_EXAMPLES_LIMIT = 30

ISSUE_SURFACE_MAX_CHARS = 30
MAX_ISSUES = 50


def load_scenes(input_path: Path) -> list[dict[str, str]]:
    """入力scenes.jsonを読み、{scene_id, text}のリスト(表示順)へ正規化する。"""
    data = json.loads(input_path.read_text(encoding="utf-8"))
    raw_scenes = data.get("scenes") or []
    scenes: list[dict[str, str]] = []
    for entry in raw_scenes:
        if not isinstance(entry, dict):
            continue
        scene_id = str(entry.get("scene_id") or "")
        text = str(entry.get("text") or "")
        if not scene_id or not text.strip():
            continue
        scenes.append({"scene_id": scene_id, "text": text})
    return scenes


def build_correction_examples_section(correction_examples: Optional[list[dict[str, Any]]]) -> str:
    """W14-2の修正例をプロンプト節に整形する(空なら空文字=注入なし)。"""
    if not correction_examples:
        return ""
    lines = []
    for example in correction_examples:
        before = str(example.get("before") or "")
        after = str(example.get("after") or "")
        if not before or not after:
            continue
        count = int(example.get("count") or 1)
        lines.append(f"- 「{before}」→「{after}」（{count}回修正）")
    if not lines:
        return ""
    examples_list = "\n".join(lines)
    return f"""
## ユーザーが過去に確定した修正例
以下は過去の動画で編集者が実際に直した「誤→正」の表記です。左側の表記が本文に現れたら
誤変換の疑いとして issues に報告し、suggestion に右側の表記を書いてください。
ただし文脈で判断し、別の意味で正しく使われている場合は報告しないでください。
{examples_list}
"""


def build_prompt(
    scenes: list[dict[str, str]],
    correction_examples: Optional[list[dict[str, Any]]] = None,
) -> str:
    scenes_json = json.dumps(scenes, ensure_ascii=False, indent=2)
    correction_examples_section = build_correction_examples_section(correction_examples)
    return f"""あなたは日本語トーク動画のテロップ校正者です。以下は編集済み動画の全シーンの
表示テキスト(テロップ)です。動画全体の文脈を踏まえて最終チェックを行い、
問題のある箇所を列挙してください。本文は書き換えないでください。

## 報告するもの
- 誤字・脱字・変換ミス(同音異義語の誤変換を含む)
- 語尾の欠落(助動詞・終助詞が途中で切れて文が不自然に終わっている)
- 文脈上おかしい表現(前後のシーンと矛盾する語・表記ゆれ・数値や固有名詞の不一致)

## 報告ルール
- surface は対象シーン(scene_id の text)に**実際に含まれる部分文字列**をそのまま書くこと
- suggestion は正しい表記が確信を持って推測できる場合のみ書く(創作しない)
- スタイルの好み・言い換え提案はしない
- 最大{MAX_ISSUES}件(問題が大きい順)
{correction_examples_section}
## 出力ルール
出力は次のJSON形式のみ。説明文やコードフェンスは不要です:
{{
  "issues": [
    {{"scene_id": "scene-003", "surface": "新学校", "suggestion": "進学校", "reason": "文脈上「進学校」の誤変換の疑い"}}
  ]
}}

# 全シーンの表示テキスト (scene_id / text) — 表示順
{scenes_json}
"""


def resolve_issues(
    response: dict[str, Any],
    scenes: list[dict[str, str]],
) -> list[dict[str, str]]:
    """LLM応答のissuesを検証・正規化する。

    実在しない scene_id・本文に含まれない surface(幻覚)・空/過長 surface は捨て、
    (scene_id, surface) で重複排除して最大 MAX_ISSUES 件に丸める。
    """
    raw_items = response.get("issues")
    if not isinstance(raw_items, list):
        return []
    text_by_id = {scene["scene_id"]: scene["text"] for scene in scenes}

    results: list[dict[str, str]] = []
    seen_keys: set[tuple[str, str]] = set()
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        scene_id = str(item.get("scene_id") or "")
        surface = str(item.get("surface") or "")
        if not surface or len(surface) > ISSUE_SURFACE_MAX_CHARS:
            continue
        scene_text = text_by_id.get(scene_id)
        if scene_text is None or surface not in scene_text:
            continue
        key = (scene_id, surface)
        if key in seen_keys:
            continue
        seen_keys.add(key)
        entry: dict[str, str] = {
            "scene_id": scene_id,
            "surface": surface,
            "reason": str(item.get("reason") or "表記の疑い"),
        }
        suggestion = str(item.get("suggestion") or "")
        if suggestion and suggestion != surface:
            entry["suggestion"] = suggestion
        results.append(entry)
        if len(results) >= MAX_ISSUES:
            break
    return results


def _attach_usage(payload: dict[str, Any]) -> dict[str, Any]:
    usage = get_usage_summary()
    if usage:
        payload["usage"] = usage
    return payload


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def run_step(
    input_path: str,
    output_path: str,
    provider: ProviderArg = "auto",
    correction_history_path: Optional[str] = None,
    call_llm_fn: Optional[Callable[[ProviderName, str, str, str], dict[str, Any]]] = None,
) -> dict[str, Any]:
    """AI最終チェック本体。キーなし/エラー時は enabled: false を書いて安全に終了する。"""
    print("[Step 6d] Final text review (LLM)")
    reset_usage_tracking()
    caller = call_llm_fn or call_llm
    input_file = Path(input_path)
    output_file = Path(output_path)

    if not input_file.exists():
        payload = {"enabled": False, "reason": "input not found", "issues": []}
        _write_json(output_file, payload)
        return payload

    scenes = load_scenes(input_file)
    if not scenes:
        payload = {"enabled": False, "reason": "no scenes", "issues": []}
        _write_json(output_file, payload)
        return payload

    resolved_provider, resolved_key, resolved_model = resolve_provider_and_key(provider, REPO_ROOT)
    if not resolved_provider or not resolved_key:
        print("  no AI provider key set - skipping final text review")
        payload = {"enabled": False, "reason": "no AI provider key set", "issues": []}
        _write_json(output_file, payload)
        return payload

    print(f"  provider: {resolved_provider}, model: {resolved_model}, scenes: {len(scenes)}")

    correction_examples = top_correction_examples(
        load_correction_history(correction_history_path), CORRECTION_EXAMPLES_LIMIT,
    )
    if correction_examples:
        print(f"  correction examples: {len(correction_examples)} pairs")

    prompt = build_prompt(scenes, correction_examples=correction_examples or None)
    try:
        response = call_llm_json(
            resolved_provider, resolved_key, resolved_model, prompt,
            caller=caller,
        )
    except Exception as exc:  # noqa: BLE001
        error_kind = classify_llm_error(exc)
        detail = truncate_error_detail(f"{type(exc).__name__}: {exc}")
        print(f"  LLM call failed [error_kind={error_kind}] ({detail})")
        payload = _attach_usage({
            "enabled": False,
            "reason": f"api_error: {detail}",
            "error_kind": error_kind,
            "provider": resolved_provider,
            "issues": [],
        })
        _write_json(output_file, payload)
        print_usage_summary()
        return payload

    issues = resolve_issues(response, scenes)
    payload = _attach_usage({
        "enabled": True,
        "provider": resolved_provider,
        "model": resolved_model,
        "issues": issues,
    })
    _write_json(output_file, payload)
    print(f"  issues: {len(issues)}")
    print_usage_summary()
    print(f"[Step 6d] Done: {output_file}")
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(description="Step 6d: AI Final Text Review (W16-7)")
    parser.add_argument("--input", required=True, help="scenes.json パス ({scenes: [{scene_id, text}]})")
    parser.add_argument("--output", required=True, help="issues.json 出力先")
    parser.add_argument(
        "--provider",
        default="auto",
        choices=["auto", "anthropic", "openai", "gemini"],
        help="LLMプロバイダ",
    )
    parser.add_argument(
        "--correction-history",
        default=None,
        help="W14-2: correction_history.json パス (Electron userData。省略時は注入なし)",
    )
    args = parser.parse_args()

    run_step(
        args.input,
        args.output,
        provider=args.provider,
        correction_history_path=args.correction_history,
    )


if __name__ == "__main__":
    main()
