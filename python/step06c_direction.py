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
import re
import sys
from pathlib import Path
from typing import Any, Callable, Optional

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from shared.direction import (  # noqa: E402
    build_slots,
    sanitize_chapters,
    sanitize_op_picks,
    sanitize_op_title,
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

DIRECTIVES_VERSION = "1.4"  # フェーズW4: op_title(AI生成のOPタイトル)を追加
SLOTS_PER_CHUNK = 60
# 1行の文字数バジェット既定値(project.yaml未指定時。横型テンプレートの telop.max_chars_per_line と同値)
DEFAULT_MAX_CHARS_PER_LINE = 16
# チャプター用のカット本文プレビュー長 (全カットを1プロンプトに収めるため切り詰める)
CHAPTER_CUT_PREVIEW_CHARS = 60
# フェーズW: OPディレクター第2パスへ渡す候補スロットの上限(チャンク推薦+刺さり系type)
OP_DIRECTOR_MAX_CANDIDATES = 60
# 刺さりスコアが付きやすいtype(チャンク推薦に漏れた候補の補完に使う)
OP_CANDIDATE_TYPES = ("hype", "punchline", "surprise", "emphasis", "quote", "harsh", "question")
from shared.editing_learning import build_editing_examples_section, load_prompt_examples, select_editing_examples
from shared.textwidth import glyph_length


# ---------------------------------------------------------------------------
# プロンプト構築
# ---------------------------------------------------------------------------

def build_slot_prompt(
    slots: list[dict[str, Any]],
    video_title: str = "",
    max_text_chars: int = 2 * DEFAULT_MAX_CHARS_PER_LINE,
    edit_examples: Optional[list[dict[str, Any]]] = None,
    editing_examples: Optional[list[dict[str, Any]]] = None,
) -> str:
    """スロットチャンク用プロンプト。文言・シーン種類(type)・強調語だけを決めさせる。"""
    payload = [{"slot_id": s["slot_id"], "text": s["text"]} for s in slots]
    slots_json = json.dumps(payload, ensure_ascii=False, indent=2)
    title_section = f"\n# 動画タイトル(文脈ヒント)\n{video_title.strip()}\n" if video_title.strip() else ""
    restored_examples = []
    for example in edit_examples or []:
        before = str(example.get("before") or "").strip()
        after = str(example.get("after") or "").strip()
        source = str(example.get("source") or "").strip()
        # AI表示より人間の確定文が長い例は「省略しすぎて内容を戻した」学習例として特に有効。
        if not before or not after or len(after) <= len(before):
            continue
        restored_examples.append(
            f'- 元発話「{source[:80]}」 / AI表示「{before[:80]}」 / 編集者の確定「{after[:80]}」'
        )
        if len(restored_examples) >= 12:
            break
    edit_examples_section = ""
    if restored_examples:
        edit_examples_section = (
            "\n# 過去にAIが省略しすぎ、編集者が情報を戻した実例\n"
            "# 同じ傾向を繰り返さず、編集者の確定文の情報量を基準にしてください:\n"
            + "\n".join(restored_examples)
            + "\n"
        )
    edit_examples_section += build_editing_examples_section(
        editing_examples, {"proofreading", "scene_boundary", "line_break"}, " ".join(s["text"] for s in slots),
    )
    if select_editing_examples(editing_examples or [], {"scene_boundary"}, " ".join(s["text"] for s in slots)):
        edit_examples_section += (
            "\n### 編集例を参考にした短い表示シーンの結合\n"
            "隣接する2スロットが同じ発話のまとまりで、不自然に分かれている場合に限り、"
            "先のスロットへ merge_with_next:true を付けてよい。"
            "textには2スロットの発話を順序どおり、省略・言い換えずすべて含めること。"
            "両スロットとも通常どおりslots配列へ返す。システムが同じカット・同じ話者・連続した時間・"
            f"{max_text_chars}文字以内を検証し、表示時間も2枠分へ結合する。"
            "結合できない場合は元の2枠を維持する。動画のカット区間は変更しない。\n"
        )
    types = " / ".join(SEMANTIC_TYPES)
    max_chars_per_line = max(4, max_text_chars // 2)
    return f"""あなたは日本語トーク動画の演出担当です。動画は2〜4秒ごとの「テロップ表示スロット」に
機械分割済みです。各スロットの発話テキストを読み、表示テロップの文言・シーンの種類・強調語を決めてください。
表示タイミングは機械側で決定済みのため、変更・提案は不要です。
{title_section}
## 1. text (表示テロップ文言)
- **要約・情報の省略は禁止**。主語・目的語・条件・理由・結論など、発話の意味を担う語を残す
- 削除してよいのは「えー」「あのー」等の意味を持たないフィラーと、明白な言い直しの重複だけ
- 「なんですけれども」「やっぱり」等も、話者のニュアンスや文の接続に必要なら残す
- 意味の創作・言い換えは禁止。元の発話を読みやすく整えるだけにし、短く要約しない
- 句読点(。、！？)は含めない

### 1a. スロット境界の断片処理(最重要)
スロット一覧は連続する発話を時間で機械分割したもので、境界が文や単語の途中に落ちることがある。
断片をそのまま表示すると「す私たち白谷塾」「〜しており、そ」のような壊れたテロップになるため、必ず直す:
- スロット先頭が前スロット末尾の語の断片で始まる場合、断片を削除する
  (例: 前スロットが「〜できま」で終わり自スロットが「す私たちは」→「私たちは」)
- スロット末尾が次スロットへ続く言いかけの断片で終わる場合、断片を削除して自然な切れ目で終える
  (例: 「〜多数在籍しており、そ」→「〜多数在籍しており」)
- 自スロット末尾の語が次スロット先頭に断片として続いている場合は、次スロット側の断片を取り込んで
  自スロットで語を完結させてよい (例: 自「具体的にアドバイスをすることができま」+次「す私たちは」
  → 自「具体的にアドバイスをすることができます」)
- スロット全体が断片・言いかけだけで、その内容を隣接スロットへ吸収した(または吸収される)場合は、
  そのスロットに "drop": true を付けて text は空にする(テロップ自体を表示しない)
  (例: 前「今すぐお申し」+自「込みください」→ 前を「今すぐお申し込みください」に完結させ、
   自は {{"slot_id": "...", "drop": true, "text": ""}} とする。
   「模試の」だけのような極端に短い言いかけスロットも同様に前後へ吸収して drop する)
- 断片処理の判断は必ず前後のスロットの text を読んで行う

### 1b. 音声認識の誤変換修正
- 明らかな誤変換・重複・脱字は文脈から正しい表記に直す
  (例: 「オンライン教室室は」→「オンライン教室は」、「申し込なく」→「お申し込み」、
   「全頭マーク模試」→「全統マーク模試」のような固有名詞の誤変換も文脈から判断して直す)
- 「〜」等の認識ノイズ記号は削除する(意図的な伸ばし表現を除く)
- 直すのは表記だけ。発話にない内容の追加は禁止
- **数値は絶対に変えない**。漢数字を算用数字にする場合は値を正確に変換する
  (「十七年」→「17年」。「19年」等の違う値にした場合は機械側で全文差し戻される)
- 目安は20文字以内。ただし元発話が長い場合は無理に削らず忠実さを優先してよい
  (元発話より8文字以上長くなると機械側で元発話に差し戻される)
- 文言が{max_chars_per_line}文字(全角換算)を超える場合のみ、意味の切れ目に改行(\\n)を1つ入れて2行にする
  - 改行は文節の終わり=助詞(「は」「が」「を」「に」「で」等)や接続の直後で行う
  - **2行目を付属語(助詞・助動詞・「して」「という」「っていう」「ので」「とか」「ところ」等)で始めない**
    - NG「共通テスト模試\\nを受けられると思う」 → OK「共通テスト模試を\\n受けられると思う」
    - NG「国語担当\\nしていまして」 → OK「国語担当していまして」(改行しない)
    - NG「手厚い塾\\nっていうところを」 → OK「僕らは日本一熱く\\n手厚い塾っていうところを」
  - 単語・固有名詞・数字の途中で改行しない(例: 「山口県立\\n大学」はNG、「山口県立大学を\\n受験します」はOK)
  - 2行の長さは極端に偏らないようにする
  - {max_chars_per_line}文字以内に収まる文言には改行を入れない
{edit_examples_section}

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

## 5. op_picks (動画冒頭の予告ダイジェスト候補の推薦)
- 動画の冒頭に「予告ダイジェスト」を置きます。この一覧の中から、冒頭で見せると
  続きが気になるスロットの slot_id を最大5個推薦してください(最終選定は別工程で行います)
- 推薦基準: 断定・言い切り / 逆説・常識否定 / 具体的な数字・金額・実績 / 誰もが知る固有名詞 /
  意見の対立 / 未回答の問い / 感情の強い一言 (「へえ、なぜ？」と思わせる瞬間)
- 挨拶・相槌・前提説明・つなぎだけのスロットは推薦しない。良い候補が無ければ空配列でよい
- 効果の高い順に並べる

出力は次のJSON形式のみを返してください。説明文やコードフェンスは不要です。
slots には入力の全スロットを slot_id 順に含めてください:
{{
  "slots": [
    {{"slot_id": "cut_001_s00", "text": "整形後の文言", "type": "default", "highlight_words": ["30万円"]}}
  ],
  "overlays": [],
  "op_picks": ["cut_001_s00"]
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


def build_op_director_prompt(
    candidates: list[dict[str, Any]],
    video_title: str = "",
) -> str:
    """フェーズW: OPディレクター第2パス用プロンプト。

    候補スロット(チャンク推薦+刺さり系type)を動画全体の文脈で見直し、OP(10〜15秒の
    予告ダイジェスト)に使う3〜5クリップを最終選定させる。あわせて各クリップの
    「フックワード」(発話を1〜2語に凝縮した画面いっぱいの一言)と核心語の色を決めさせる。
    選定・凝縮の基準は参考実例の分析(OP編集ガイド: 予告編型OPの共通文法)に基づく。
    """
    payload = [
        {
            "slot_id": c["slot_id"],
            "text": c["text"],
            "type": c.get("type", "default"),
        }
        for c in candidates
    ]
    candidates_json = json.dumps(payload, ensure_ascii=False, indent=2)
    title_section = f"\n# 動画タイトル(文脈ヒント)\n{video_title.strip()}\n" if video_title.strip() else ""
    return f"""あなたは切り抜き動画のOP(冒頭の予告ダイジェスト)専門の編集者です。
本編から「この先を見る理由」を作る10〜15秒の予告モンタージュを組みます。
以下は本編の見どころ候補スロットです。この中からOPに使うものを3〜5個選び、
再生順に並べ、各クリップの見せ方を決めてください。
{title_section}
# 選定基準(刺さり要素を含む発話を優先)
- 断定・言い切り (「〜だ」「〜べき」と強く締める)
- 逆説・常識否定 (世間の常識をひっくり返す)
- 具体的な数字・金額・実績 (桁の大きい数字、率)
- 誰もが知る固有名詞
- 対立・意見の割れ / 未回答の問い / 感情の強い一言
- 除外: 挨拶・相槌・前提説明・文脈がないと意味が通らない発話

# 並べ方(この順で再生されます)
- 先頭(role=hook_open): 最も過激・逆説的な最強の1つを置く
- 中盤(role=punch): 残りをテンポよく畳みかける
- 最後(role=cliffhanger): 答えを知りたくなる「引き」で締める。hook_text は
  疑問形「?」か三点リーダー「…」で終え、答えは見せない
- 1つの話題に偏らず、動画全体から選ぶ

# 各クリップの見せ方 (display)
- "hook": 発話の全文ではなく、核となる1〜2語に凝縮したフックワード(hook_text)を
  画面いっぱいに大きく出す。基本はこちらを使う
- "verbatim": 発話テロップをそのまま出す。発話自体が短く既に尖っている場合のみ

# hook_text(フックワード)の作り方 (display=hook のとき必須)
- 1行は全角10文字以内。改行(\\n)で最大2行(上下2段で対比・積み上げの勢いを出す)
- 発話からいちばん尖った語を抜く。短くするための意訳・疑問形化はよいが、
  発話に無い内容の創作は禁止
- 例: 「定時8時なんていうのは非人道的な制度じゃないですか」→「定時8時\\n非人道的」
- 例: 「学校の始業時間を遅らせましょう」→「始業時間 遅らせる」
- 例: 「朝練やめた方がいいと思う」→「朝練は廃止?」

# keyword / keyword_color (核心語の色分け)
- keyword: hook_text の中で最も重要な語を1つ(部分文字列)。全体が1語ならその語
- keyword_color: yellow=キーワード・結論・肯定(基本色) / red=ネガ・断定・警告 / white=中立

# title (OPに表示する動画タイトル)
- OPの中央に大きく出す、この動画全体を一言で表すタイトルを1つ作ってください
- 全角15文字以内・1行。サムネイルの文言のように具体的で「見たくなる」表現にする
- 動画の内容(候補スロットの発話)に基づくこと。内容に無い実績・数字の創作は禁止
- 例: 「定時8時は非人道的」「共通テスト国語の攻略法」「朝練廃止論の真相」

出力は次のJSON形式のみを返してください。説明文やコードフェンスは不要です:
{{
  "title": "定時8時は非人道的",
  "op_picks": [
    {{"slot_id": "cut_001_s00", "role": "hook_open", "display": "hook",
      "hook_text": "定時8時\\n非人道的", "keyword": "非人道的", "keyword_color": "red"}}
  ]
}}

# 候補スロット一覧
{candidates_json}
"""


def build_op_director_candidates(
    directives: list[dict[str, Any]],
    nominated_ids: list[str],
    max_candidates: int = OP_DIRECTOR_MAX_CANDIDATES,
) -> list[dict[str, Any]]:
    """OPディレクター第2パスへ渡す候補を組み立てる。

    チャンクパスの推薦(nominated_ids)を必ず含め、不足分は刺さり系type
    (OP_CANDIDATE_TYPES)のスロットを出現順に補完する(上限 max_candidates)。
    フォールバックスロット(AI整形なし)も候補から外さない(発話自体は有効なため)。
    """
    by_id = {str(d.get("slot_id", "")): d for d in directives}
    candidates: list[dict[str, Any]] = []
    seen: set = set()

    def add(directive: dict[str, Any]) -> None:
        slot_id = str(directive.get("slot_id", ""))
        if not slot_id or slot_id in seen or len(candidates) >= max_candidates:
            return
        text = str(directive.get("text", "") or "").replace("\n", " ").strip()
        if not text:
            return
        candidates.append({"slot_id": slot_id, "text": text, "type": str(directive.get("type", "default"))})
        seen.add(slot_id)

    for slot_id in nominated_ids:
        directive = by_id.get(str(slot_id))
        if directive:
            add(directive)
    for directive in directives:
        if str(directive.get("type", "")) in OP_CANDIDATE_TYPES:
            add(directive)
    # 候補は時系列(slot_id順=出現順)で提示する(AIが動画の流れを把握しやすい)
    candidates.sort(key=lambda c: c["slot_id"])
    return candidates


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
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str], int]:
    """チャンク応答群を検証し、(最終スロットディレクティブ, オーバーレイ, op_picks, fallback数)を返す。

    応答に含まれないスロットは元テキストのままのフォールバックになる。
    op_picks はチャンク横断で提案順に集約し、実在slot_id・上限5件へsanitizeする
    (フェーズW: これは「チャンク推薦」であり、後段のOPディレクター第2パスが成功すれば
    その最終選定で上書きされる。第2パス失敗時のフォールバックとしても機能する)。
    """
    raw_by_slot_id: dict[str, dict[str, Any]] = {}
    raw_overlays: list[Any] = []
    raw_op_picks: list[Any] = []
    for response in responses:
        for item in response.get("slots") or []:
            if isinstance(item, dict) and item.get("slot_id"):
                raw_by_slot_id[str(item["slot_id"])] = item
        overlays = response.get("overlays")
        if isinstance(overlays, list):
            raw_overlays.extend(overlays)
        op_picks_raw = response.get("op_picks")
        if isinstance(op_picks_raw, list):
            raw_op_picks.extend(op_picks_raw)

    # フェーズW27: 忠実性チェックは前後スロット込みの文脈で行う(境界断片の取り込みを許可)
    directives = [
        sanitize_slot_directive(
            slot,
            raw_by_slot_id.get(slot["slot_id"]),
            type_mapping=type_mapping,
            max_text_chars=max_text_chars,
            context_text="".join(
                str(slots[j].get("text", ""))
                for j in (index - 1, index, index + 1)
                if 0 <= j < len(slots)
            ),
        )
        for index, slot in enumerate(slots)
    ]
    # Optional display-only merge. Time boundaries come exclusively from the
    # current slots; exact source-text coverage prevents silently losing a phrase.
    merged_directives = []
    aliases: dict[str, str] = {}
    protected_slots: set[int] = set()
    index = 0
    while index < len(slots):
        first = slots[index]
        raw = raw_by_slot_id.get(first["slot_id"], {})
        second = slots[index + 1] if index + 1 < len(slots) else None
        compact_text = lambda value: re.sub(r"[\s。、，,.！？!?]+", "", str(value or ""))
        can_merge = (
            raw.get("merge_with_next") is True and raw.get("drop") is not True and second is not None
            and first.get("cut_id") == second.get("cut_id")
            and first.get("speaker") == second.get("speaker")
            and first.get("source_end_ms") == second.get("source_start_ms")
            and 0 < second["source_end_ms"] - first["source_start_ms"] <= 8000
            and compact_text(raw.get("text")) == compact_text(first.get("text")) + compact_text(second.get("text"))
            and glyph_length(compact_text(raw.get("text")), "weighted_cpl") <= (max_text_chars or 32)
        )
        if can_merge:
            combined = {**first, "text": str(first.get("text", "")) + str(second.get("text", "")),
                        "source_end_ms": second["source_end_ms"]}
            if "end_ms" in second:
                combined["end_ms"] = second["end_ms"]
            directive = sanitize_slot_directive(combined, raw, type_mapping=type_mapping, max_text_chars=max_text_chars)
            if not directive["fallback"]:
                merged_directives.append({**directive, "merged_slot_ids": [first["slot_id"], second["slot_id"]]})
                aliases[second["slot_id"]] = first["slot_id"]
                index += 2
                continue
        # An invalid merge must not keep the combined phrase in the first slot
        # (which would duplicate the next phrase). Restore the untouched source.
        if raw.get("merge_with_next") is True or index in protected_slots:
            merged_directives.append(sanitize_slot_directive(first, None, type_mapping=type_mapping, max_text_chars=max_text_chars))
            if raw.get("merge_with_next") is True:
                protected_slots.add(index + 1)
        else:
            merged_directives.append(directives[index])
        index += 1
    directives = merged_directives
    fallback_count = sum(1 for d in directives if d["fallback"])

    slots_by_id = {slot["slot_id"]: slot for slot in slots}
    overlays: list[dict[str, Any]] = []
    for raw in raw_overlays:
        overlay = sanitize_overlay_suggestion(raw, slots_by_id, len(overlays))
        if overlay is not None:
            overlays.append(overlay)

    remapped_picks = [({**item, "slot_id": aliases.get(str(item.get("slot_id")), item.get("slot_id"))}
                       if isinstance(item, dict) else aliases.get(str(item), item)) for item in raw_op_picks]
    op_picks = sanitize_op_picks(remapped_picks, slots)

    return directives, overlays, op_picks, fallback_count


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
    edit_examples_path: Optional[str] = None,
    call_direction_fn: Optional[Callable[[ProviderName, str, str, str], dict[str, Any]]] = None,
) -> dict[str, Any]:
    """演出決定ステップ本体。キー無し/API失敗時はフォールバックディレクティブを書き出す。"""
    run_dir_path = Path(run_dir)
    output_file = Path(output_path) if output_path else run_dir_path / "telop_directives.json"
    caller = call_direction_fn or call_llm

    print("[Step 6c] Direction (scene direction engine / AI pass 3)")
    reset_usage_tracking()
    edit_examples: list[dict[str, Any]] = []
    editing_examples = load_prompt_examples(run_dir, telop_mode="directed")
    if edit_examples_path and Path(edit_examples_path).exists():
        try:
            raw_examples = _load_json(edit_examples_path)
            edit_examples = [
                item for item in raw_examples.get("entries", []) if isinstance(item, dict)
            ]
            # 内容を戻した量が大きい例からプロンプトへ渡す。
            edit_examples.sort(
                key=lambda item: len(str(item.get("after") or "")) - len(str(item.get("before") or "")),
                reverse=True,
            )
            print(f"  edit learning examples: {len(edit_examples)}")
        except (OSError, json.JSONDecodeError, AttributeError):
            edit_examples = []

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

    # フェーズW30: スロットは意味の塊(文・文節)単位で分割する。
    # 目標=1行分(max_chars_per_line)、上限=2行分。縦型(1行11字前後)は1テロップ1文節になる
    slots = build_slots(
        keep_segments,
        words,
        target_chars=float(max_chars_per_line),
        max_chars=float(2 * max_chars_per_line),
    )
    video_title = (title or "").strip() or extract_title_from_run_dir(run_dir)
    print(f"  cuts: {len(keep_segments)}, slots: {len(slots)}")

    base_result: dict[str, Any] = {
        "version": DIRECTIVES_VERSION,
        "mode": "directed",
        "video_title": video_title,
        "chapters": [],
        "overlays": [],
        "op_picks": [],
        "op_title": "",
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
        prompt = build_slot_prompt(
            chunk,
            video_title=video_title,
            max_text_chars=max_text_chars,
            edit_examples=edit_examples,
            editing_examples=editing_examples,
        )
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

    directives, overlays, op_picks, fallback_count = apply_slot_responses(
        slots, successful_responses, type_mapping=type_mapping, max_text_chars=max_text_chars,
    )

    # 1.5 フェーズW: OPディレクター第2パス (動画全体の候補から3〜5クリップを最終選定し、
    #     フックワード・役割・核心語の色を決める。失敗時はチャンク推薦のまま=verbatim表示)
    # フェーズW4: あわせてOPタイトル(op_title)も生成する。失敗・不成立は空文字=
    # step08が従来のフォールバック(ユーザー入力→動画ファイル名)を使う
    op_title = ""
    if not fatal_stop and successful_responses:
        candidates = build_op_director_candidates(
            directives, [pick["slot_id"] for pick in op_picks],
        )
        if candidates:
            op_prompt = build_op_director_prompt(candidates, video_title=video_title)
            try:
                op_response = call_llm_json(
                    resolved_provider, resolved_key, resolved_model, op_prompt, caller=caller,
                )
                directed_picks = sanitize_op_picks(op_response.get("op_picks"), slots)
                if directed_picks:
                    op_picks = directed_picks
                op_title = sanitize_op_title(op_response.get("title"))
                hook_count = sum(1 for pick in op_picks if pick.get("display") == "hook")
                print(f"  op director: {len(op_picks)} picks ({hook_count} hook), title={op_title!r}")
            except Exception as exc:  # noqa: BLE001
                error_kind = classify_llm_error(exc)
                error_kinds.append(error_kind)
                error_details.append(truncate_error_detail(f"{type(exc).__name__}: {exc}"))
                print(
                    f"  op director call failed [error_kind={error_kind}] "
                    f"({type(exc).__name__}: {exc}) - using chunk nominations"
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
        "op_picks": op_picks,
        "op_title": op_title,
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
    parser.add_argument(
        "--edit-examples",
        default=None,
        help="編集者の確定例(source/before/after)JSON。省略しすぎ防止の学習例として使用",
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
        edit_examples_path=args.edit_examples,
    )


if __name__ == "__main__":
    main()
