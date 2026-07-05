"""Step 6c: Direction - シーン演出決定エンジン (フェーズT2 / AIパス3)。

telop.mode: directed のときのみ実行する。校正済み keep_segments(word timing付き)を
決定的な前処理で2〜4秒粒度の「テロップ表示スロット」に機械分割し(shared/direction.py)、
AIには各スロットの発話テキストを提示して次の3つ「だけ」を決めさせる:
1. 表示テロップ文言 (口語の冗長さを削った1〜2行の整形文。意味の創作は禁止)
2. style (telop_presets.yaml のT1プリセットIDから配色ルールに基づき選択)
3. highlight_words (数字・金額・固有名詞などの部分強調)

加えて、動画全体を見たチャプター分割(overlays.chapter_title用)と
オーバーレイ提案(profile_card / list_stack / cta_banner)を受け取る。
タイミングはAIに決めさせない(スロット境界はword timingから機械算出)。

AIが返した文言はスロットの元発話と照合し、乖離が大きい(元テキストに無い内容語が過半)
場合はそのスロットを元テキストのままにフォールバックする(安全弁)。

APIキーが未設定・API呼び出しに失敗した場合は、全スロットを元テキスト+fact_yellowの
フォールバックディレクティブとして書き出す(directedモードのパイプラインは壊さない)。

Usage:
    python step06c_direction.py <run_dir> \
        --proposal ../runs/{run}/step07_cut_proposal/cut_proposal.json \
        --stt ../runs/{run}/step02b_transcript_correct/stt_corrected.json \
        --project ../templates/horizontal.yaml \
        [--output ../runs/{run}/telop_directives.json] \
        [--provider auto|anthropic|openai|gemini]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Callable, Optional

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from shared.direction import (  # noqa: E402
    build_slots,
    sanitize_chapters,
    sanitize_overlay_suggestion,
    sanitize_slot_directive,
)
from shared.project_config import load_project_config  # noqa: E402
from shared.telop_types import SEMANTIC_TYPES, load_type_mapping  # noqa: E402
from shared.llm_client import (  # noqa: E402
    FATAL_LLM_ERROR_KINDS,
    ProviderArg,
    ProviderName,
    call_llm,
    call_llm_json,
    classify_llm_error,
    get_usage_summary,
    print_usage_summary,
    reset_usage_tracking,
    resolve_model,
    resolve_provider_and_key,
    summarize_error_kinds,
    truncate_error_detail,
)

DIRECTIVES_VERSION = "1.1"  # T2.5-4: slots[].type (semantic type) を追加
SLOTS_PER_CHUNK = 60
# 1行の文字数バジェット既定値(project.yaml未指定時。横型テンプレートの telop.max_chars_per_line と同値)
DEFAULT_MAX_CHARS_PER_LINE = 16
# チャプター用のカット本文プレビュー長 (全カットを1プロンプトに収めるため切り詰める)
CHAPTER_CUT_PREVIEW_CHARS = 60


# ---------------------------------------------------------------------------
# プロンプト構築
# ---------------------------------------------------------------------------

def build_slot_prompt(
    slots: list[dict[str, Any]],
    video_title: str = "",
    max_text_chars: int = 2 * DEFAULT_MAX_CHARS_PER_LINE,
) -> str:
    """スロットチャンク用プロンプト。文言・シーン種類(type)・強調語だけを決めさせる。"""
    payload = [{"slot_id": s["slot_id"], "text": s["text"]} for s in slots]
    slots_json = json.dumps(payload, ensure_ascii=False, indent=2)
    title_section = f"\n# 動画タイトル(文脈ヒント)\n{video_title.strip()}\n" if video_title.strip() else ""
    types = " / ".join(SEMANTIC_TYPES)
    return f"""あなたは日本語トーク動画の演出担当です。動画は2〜4秒ごとの「テロップ表示スロット」に
機械分割済みです。各スロットの発話テキストを読み、表示テロップの文言・シーンの種類・強調語を決めてください。
表示タイミングは機械側で決定済みのため、変更・提案は不要です。
{title_section}
## 1. text (表示テロップ文言)
- 口語の冗長さ(「えー」「なんですけれども」「やっぱり」等のつなぎ)を削った簡潔な文にする
  (例: 「〜なんですけれども、やっぱり」→「〜ですが」)
- 意味の創作・言い換えすぎは禁止。元の発話に無い内容を追加しない
- 句読点(。、！？)は含めない。改行も含めない(折り返しは機械側で行う)
- 目安は20文字以内。{max_text_chars}文字(全角換算)を超えると機械側で元発話に差し戻される

## 2. type (シーンの意味種類。次の10種から1つ選択)
デザインは種類ごとのユーザー設定で自動適用されるため、見た目ではなく発話の意味で判定すること:
- default: 説明・事実・データの提示 (迷ったらこれ)
- surprise: 「実は〜」のような意外な事実・驚きの新情報
- harsh: 辛辣・毒舌・厳しい指摘 (「正直ダメ」「甘すぎる」等)
- quote: 名言・格言・心に残る言い切り (しみじみ響く一言)
- emphasis: 強調・断言・危機感 (「絶対〜」「マジで」等)
- question: 聞き手の質問・ツッコミ・問いかけ
- reply: 相槌・軽い返し・同意 (「そうですね」「なるほど」等)
- punchline: 話の要点・結論・オチ (その話題の締めの一言)
- hype: 強い煽り・特別感の演出
- cta: 行動喚起 (チャンネル登録・申込・LINE登録等)
選択可能な種類: {types}

## 3. highlight_words (部分強調)
- 数字・金額・固有名詞・キーワードなど、そのスロットで最も重要な語を0〜2個
- text 内に実際に含まれる文字列のみ (無ければ空配列)

## 4. overlays (オーバーレイ提案。該当がなければ空配列)
- profile_card: 話者やゲストの名前が初めて紹介されるスロット
  {{"type": "profile_card", "slot_id": "...", "text": "名前", "subtitle": "肩書き"}}
- list_stack: 「3つのポイント」のような列挙が始まるスロット
  {{"type": "list_stack", "slot_id": "...", "lines": ["項目1", "項目2", "項目3"]}}
- cta_banner: チャンネル登録・申込などの行動喚起をしているスロット
  {{"type": "cta_banner", "slot_id": "...", "lines": ["チャンネル登録", "お願いします"]}}

出力は次のJSON形式のみを返してください。説明文やコードフェンスは不要です。
slots には入力の全スロットを slot_id 順に含めてください:
{{
  "slots": [
    {{"slot_id": "cut_001_s00", "text": "整形後の文言", "type": "default", "highlight_words": ["30万円"]}}
  ],
  "overlays": []
}}

# スロット一覧 (slot_id と元の発話テキスト)
{slots_json}
"""


def build_chapter_prompt(
    cuts_payload: list[dict[str, Any]],
    video_title: str = "",
) -> str:
    """チャプター分割用プロンプト。動画全体のカット一覧から章立てを決めさせる。"""
    cuts_json = json.dumps(cuts_payload, ensure_ascii=False, indent=2)
    title_section = f"\n# 動画タイトル(文脈ヒント)\n{video_title.strip()}\n" if video_title.strip() else ""
    return f"""あなたは日本語トーク動画の構成作家です。以下はジェットカット済み動画のカット一覧
(cut_id と発話テキストの先頭部分)です。動画全体を2〜6個のチャプターに分割し、
各チャプターの開始カットと章見出しを決めてください。
{title_section}
ルール:
- 章見出しは画面の左上に常時表示されるラベルです。全角12文字以内の簡潔な名詞句にする
- 話題の転換点でチャプターを区切る。細かく分けすぎない(2〜6個)
- 最初のチャプターは必ず先頭のカットから始める
- start_cut_id は入力に実在する cut_id のみを使う

出力は次のJSON形式のみを返してください。説明文やコードフェンスは不要です:
{{
  "chapters": [
    {{"start_cut_id": "cut_001", "title": "オープニング"}}
  ]
}}

# カット一覧
{cuts_json}
"""


def build_cuts_payload_for_chapters(
    keep_segments: list[dict[str, Any]],
    preview_chars: int = CHAPTER_CUT_PREVIEW_CHARS,
) -> list[dict[str, Any]]:
    payload = []
    for i, seg in enumerate(keep_segments):
        text = str(seg.get("text", "")).strip()
        if len(text) > preview_chars:
            text = text[:preview_chars] + "…"
        payload.append({"cut_id": f"cut_{i + 1:03d}", "text": text})
    return payload


def chunk_slots(slots: list[dict[str, Any]], chunk_size: int = SLOTS_PER_CHUNK) -> list[list[dict[str, Any]]]:
    """スロットを一定数ごとに分割する(step06bのチャンク分割と同じ枠組み)。"""
    return [slots[i : i + chunk_size] for i in range(0, len(slots), chunk_size)]


# ---------------------------------------------------------------------------
# 応答の検証・組み立て
# ---------------------------------------------------------------------------

def apply_slot_responses(
    slots: list[dict[str, Any]],
    responses: list[dict[str, Any]],
    type_mapping: Optional[dict[str, str]] = None,
    max_text_chars: Optional[float] = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], int]:
    """チャンク応答群を検証し、(最終スロットディレクティブ, オーバーレイ, fallback数)を返す。

    応答に含まれないスロットは元テキストのままのフォールバックになる。
    """
    raw_by_slot_id: dict[str, dict[str, Any]] = {}
    raw_overlays: list[Any] = []
    for response in responses:
        for item in response.get("slots") or []:
            if isinstance(item, dict) and item.get("slot_id"):
                raw_by_slot_id[str(item["slot_id"])] = item
        overlays = response.get("overlays")
        if isinstance(overlays, list):
            raw_overlays.extend(overlays)

    directives = [
        sanitize_slot_directive(
            slot,
            raw_by_slot_id.get(slot["slot_id"]),
            type_mapping=type_mapping,
            max_text_chars=max_text_chars,
        )
        for slot in slots
    ]
    fallback_count = sum(1 for d in directives if d["fallback"])

    slots_by_id = {slot["slot_id"]: slot for slot in slots}
    overlays: list[dict[str, Any]] = []
    for raw in raw_overlays:
        overlay = sanitize_overlay_suggestion(raw, slots_by_id, len(overlays))
        if overlay is not None:
            overlays.append(overlay)

    return directives, overlays, fallback_count


def build_fallback_directives(
    slots: list[dict[str, Any]],
    type_mapping: Optional[dict[str, str]] = None,
) -> list[dict[str, Any]]:
    """AI無しで動くフォールバック: 全スロット元テキスト+既定type(default)のスタイル。"""
    return [sanitize_slot_directive(slot, None, type_mapping=type_mapping) for slot in slots]


# ---------------------------------------------------------------------------
# メインフロー
# ---------------------------------------------------------------------------

def _write_result(output_path: Path, result: dict[str, Any]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _attach_usage(payload: dict[str, Any]) -> dict[str, Any]:
    usage = get_usage_summary()
    if usage:
        payload["usage"] = usage
    return payload


def extract_title_from_run_dir(run_dir: str) -> str:
    """runs/<timestamp>_<title> から動画タイトル部分を緩く復元する(step06bと同じ規則)。"""
    name = Path(run_dir).name
    parts = name.split("_", 2)
    if len(parts) >= 3:
        return parts[2].replace("_", " ")
    return ""


def _load_json(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def run_step(
    run_dir: str,
    proposal_path: str,
    stt_path: str,
    output_path: Optional[str] = None,
    title: Optional[str] = None,
    provider: ProviderArg = "auto",
    model: Optional[str] = None,
    api_key: Optional[str] = None,
    project_path: Optional[str] = None,
    type_mapping_path: Optional[str] = None,
    call_direction_fn: Optional[Callable[[ProviderName, str, str, str], dict[str, Any]]] = None,
) -> dict[str, Any]:
    """演出決定ステップ本体。キー無し/API失敗時はフォールバックディレクティブを書き出す。"""
    run_dir_path = Path(run_dir)
    output_file = Path(output_path) if output_path else run_dir_path / "telop_directives.json"
    caller = call_direction_fn or call_llm

    print("[Step 6c] Direction (scene direction engine / AI pass 3)")
    reset_usage_tracking()

    proposal = _load_json(proposal_path)
    stt_result = _load_json(stt_path)
    keep_segments = proposal.get("keep_segments", [])
    words = stt_result.get("words", [])

    # T2.5-1d: 文言の全角換算上限 = 2行 × max_chars_per_line (超過はAI再依頼せず元発話へフォールバック)
    max_chars_per_line = DEFAULT_MAX_CHARS_PER_LINE
    if project_path:
        try:
            project_cfg = load_project_config(project_path)
            max_chars_per_line = int(
                project_cfg.get("telop", {}).get("max_chars_per_line", DEFAULT_MAX_CHARS_PER_LINE)
            )
        except Exception as exc:  # noqa: BLE001
            print(f"  warn: project config load failed ({exc}) - using default max_chars_per_line")
    max_text_chars = 2 * max_chars_per_line

    # T2.5-4: type → preset マッピング(既定YAML + ユーザーJSON)
    type_mapping = load_type_mapping(user_file=type_mapping_path)

    slots = build_slots(keep_segments, words)
    video_title = (title or "").strip() or extract_title_from_run_dir(run_dir)
    print(f"  cuts: {len(keep_segments)}, slots: {len(slots)}")

    base_result: dict[str, Any] = {
        "version": DIRECTIVES_VERSION,
        "mode": "directed",
        "video_title": video_title,
        "chapters": [],
        "overlays": [],
        "slots": [],
        "stats": {
            "total_cuts": len(keep_segments),
            "total_slots": len(slots),
            "fallback_slots": 0,
        },
    }

    if not slots:
        result = {**base_result, "enabled": False, "reason": "no slots", "provider": None, "model": model}
        print("  skip: no slots (empty keep_segments)")
        _write_result(output_file, result)
        return result

    # プロバイダ解決 (step06bと同じ規約: 明示キー > 環境変数/.env)
    resolved_provider: Optional[ProviderName]
    if api_key is not None:
        if api_key.strip():
            resolved_provider = provider if provider != "auto" else "anthropic"
            resolved_key = api_key.strip()
            resolved_model = resolve_model(resolved_provider, model)
        else:
            resolved_provider, resolved_key, resolved_model = None, "", model or ""
    else:
        resolved_provider, resolved_key, resolved_model = resolve_provider_and_key(provider)
        if model:
            resolved_model = model

    if not resolved_provider or not resolved_key:
        print("  no AI provider key set - writing fallback directives (source text + default style)")
        directives = build_fallback_directives(slots, type_mapping=type_mapping)
        result = {
            **base_result,
            "enabled": False,
            "reason": "no AI provider key set",
            "provider": None,
            "model": resolved_model or None,
            "slots": directives,
            "stats": {**base_result["stats"], "fallback_slots": len(directives)},
        }
        _write_result(output_file, result)
        print(f"[Step 6c] Done (fallback): {output_file}")
        return result

    print(f"  provider: {resolved_provider}, model: {resolved_model}")

    # 1. スロット演出 (チャンク分割してAIへ)
    slot_chunks = chunk_slots(slots)
    print(f"  slot chunks: {len(slot_chunks)}")
    successful_responses: list[dict[str, Any]] = []
    failed_chunks = 0
    error_kinds: list[str] = []
    error_details: list[str] = []
    fatal_stop = False

    for chunk_index, chunk in enumerate(slot_chunks):
        prompt = build_slot_prompt(chunk, video_title=video_title, max_text_chars=max_text_chars)
        try:
            response = call_llm_json(resolved_provider, resolved_key, resolved_model, prompt, caller=caller)
            successful_responses.append(response)
            print(f"  chunk {chunk_index + 1}/{len(slot_chunks)}: ok")
        except Exception as exc:  # noqa: BLE001
            failed_chunks += 1
            error_kind = classify_llm_error(exc)
            error_kinds.append(error_kind)
            error_details.append(truncate_error_detail(f"{type(exc).__name__}: {exc}"))
            print(
                f"  chunk {chunk_index + 1}/{len(slot_chunks)} failed "
                f"[error_kind={error_kind}] ({type(exc).__name__}: {exc})"
            )
            # billing/auth はリトライ・続行が無意味なので残チャンクをスキップして即時中断
            if error_kind in FATAL_LLM_ERROR_KINDS:
                remaining = len(slot_chunks) - chunk_index - 1
                if remaining > 0:
                    failed_chunks += remaining
                    print(f"  fatal error ({error_kind}) - skipping remaining {remaining} chunks")
                fatal_stop = True
                break

    directives, overlays, fallback_count = apply_slot_responses(
        slots, successful_responses, type_mapping=type_mapping, max_text_chars=max_text_chars,
    )

    # 2. チャプター分割 (動画全体を1プロンプトで)
    chapters: list[dict[str, Any]] = []
    if not fatal_stop:
        chapter_prompt = build_chapter_prompt(
            build_cuts_payload_for_chapters(keep_segments), video_title=video_title,
        )
        try:
            chapter_response = call_llm_json(
                resolved_provider, resolved_key, resolved_model, chapter_prompt, caller=caller,
            )
            chapters = sanitize_chapters(chapter_response.get("chapters"), keep_segments)
            print(f"  chapters: {len(chapters)}")
        except Exception as exc:  # noqa: BLE001
            error_kind = classify_llm_error(exc)
            error_kinds.append(error_kind)
            error_details.append(truncate_error_detail(f"{type(exc).__name__}: {exc}"))
            print(f"  chapter call failed [error_kind={error_kind}] ({type(exc).__name__}: {exc}) - no chapters")

    enabled = bool(successful_responses)
    result: dict[str, Any] = {
        **base_result,
        "enabled": enabled,
        "provider": resolved_provider,
        "model": resolved_model,
        "chapters": chapters,
        "overlays": overlays,
        "slots": directives,
        "stats": {
            **base_result["stats"],
            "fallback_slots": fallback_count,
            "chunks_total": len(slot_chunks),
            "chunks_failed": failed_chunks,
        },
    }
    if not enabled:
        result["reason"] = f"api_error: all {len(slot_chunks)} chunks failed"
    if failed_chunks > 0 or error_details:
        result["error_kind"] = summarize_error_kinds(error_kinds)
        result["error_detail"] = error_details[0] if error_details else ""
    _attach_usage(result)
    _write_result(output_file, result)
    print(
        f"  directives: {len(directives)} slots "
        f"({fallback_count} fallback), {len(overlays)} overlays, {len(chapters)} chapters"
    )
    print_usage_summary()
    print(f"[Step 6c] Done: {output_file}")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Step 6c: Direction (scene direction engine)")
    parser.add_argument("run_dir", help="runs/<run_name> へのパス")
    parser.add_argument("--proposal", required=True, help="cut_proposal.json のパス")
    parser.add_argument("--stt", required=True, help="STT (stt_corrected.json 等) のパス")
    parser.add_argument("--output", default=None, help="telop_directives.json の出力先 (省略時 run_dir直下)")
    parser.add_argument(
        "--provider",
        default=os.environ.get("AI_REFINE_PROVIDER", "auto"),
        choices=["auto", "anthropic", "openai", "gemini"],
        help="LLMプロバイダ (auto=キー優先順 anthropic>openai>gemini)",
    )
    parser.add_argument("--model", default=None, help="モデル名 (省略時はプロバイダ既定+環境変数)")
    parser.add_argument("--title", default=None, help="動画タイトル(文脈ヒント)。省略時はrun名から復元")
    parser.add_argument("--project", default=None, help="プロジェクトYAML (telop.max_chars_per_line を文字数上限に使用)")
    parser.add_argument(
        "--type-mapping", default=None,
        help="ユーザー type→preset マッピングJSON (省略時は templates/telop_type_mapping.yaml のみ)",
    )
    args = parser.parse_args()

    run_step(
        args.run_dir,
        args.proposal,
        args.stt,
        output_path=args.output,
        title=args.title,
        provider=args.provider,
        model=args.model,
        project_path=args.project,
        type_mapping_path=args.type_mapping,
    )


if __name__ == "__main__":
    main()
