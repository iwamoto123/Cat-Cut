"""Step 5: AI Retake Detection - 言い直しカット + 復元困難箇所の検出 (改善13 パス1 / 改善14 チャンク分割・フィラーAI判定)。

STT全文(文単位)をLLMに渡し、言い直し(不完全な方をカット)と復元困難区間(要確認)を検出する。
出力は step07 互換の retakes.json と ai_review.json。

Usage:
    python step05_ai_retake.py <run_dir> \\
        --stt ../runs/{run}/step02b_transcript_correct/stt_corrected.json \\
        --fillers ../runs/{run}/step04_filler_detect/fillers.json \\
        --retakes-output ../runs/{run}/step05_retake_detect/retakes.json \\
        --review-output ../runs/{run}/step05_ai_retake/ai_review.json \\
        [--provider auto]
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
    FATAL_LLM_ERROR_KINDS,
    ProviderArg,
    ProviderName,
    call_llm,
    call_llm_json,
    classify_llm_error,
    get_usage_summary,
    print_usage_summary,
    reset_usage_tracking,
    resolve_provider_and_key,
    summarize_error_kinds,
    truncate_error_detail,
)

REPO_ROOT = ROOT.parent

SENTENCES_PER_CHUNK = 100
CONTEXT_SENTENCES = 5

# W14-2: プロンプトへ注入する「ユーザーが過去に確定した修正例」の既定件数(頻度上位)。
CORRECTION_EXAMPLES_LIMIT = 30


def build_correction_examples_section(correction_examples: Optional[list[dict[str, Any]]]) -> str:
    """W14-2: correction_history 由来の修正例をプロンプト節に整形する(空なら空文字=従来動作)。

    step05は本文を書き換えないため、「誤」表記を見つけたら suspicious_words として報告し
    suggestion に「正」を書くよう促す(決定的置換にはしない=同音異義語の誤爆防止)。
    """
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
誤変換の疑いとして suspicious_words に積極的に報告し、suggestion に右側の表記を書いてください。
ただし文脈で判断し、別の意味で正しく使われている場合は報告しないでください。
{examples_list}
"""


def load_stt(stt_path: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, dict[str, Any]]]:
    data = json.loads(stt_path.read_text(encoding="utf-8"))
    words = data.get("words") or []
    sentences = data.get("sentences") or []
    sentence_map = {str(s.get("id", "")): s for s in sentences if s.get("id")}
    return words, sentences, sentence_map


def build_word_to_sentence(sentence_map: dict[str, dict[str, Any]]) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for sid, sentence in sentence_map.items():
        for wid in sentence.get("word_ids") or []:
            mapping[str(wid)] = sid
    return mapping


def load_fillers(fillers_path: Path) -> list[dict[str, Any]]:
    if not fillers_path.exists():
        return []
    try:
        data = json.loads(fillers_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    fillers = data.get("fillers") or []
    return [f for f in fillers if isinstance(f, dict)]


def build_filler_candidates(
    fillers: list[dict[str, Any]],
    sentence_map: dict[str, dict[str, Any]],
    word_to_sentence: dict[str, str],
) -> list[dict[str, Any]]:
    """fillers.json の全候補(warn_only含む)をLLM向けpayloadに変換する。"""
    candidates: list[dict[str, Any]] = []
    for filler in fillers:
        word_ids = filler.get("word_ids")
        if isinstance(word_ids, list) and word_ids:
            primary_id = str(word_ids[0])
        else:
            primary_id = str(filler.get("word_id") or "")
        if not primary_id:
            continue
        sentence_id = word_to_sentence.get(primary_id, "")
        sentence = sentence_map.get(sentence_id)
        sentence_text = str(sentence.get("text", "")) if sentence else ""
        candidates.append({
            "word_id": primary_id,
            "match_text": str(filler.get("match_text") or filler.get("text") or ""),
            "sentence_id": sentence_id,
            "sentence_text": sentence_text,
            "action": str(filler.get("action") or ""),
        })
    return candidates


def build_sentences_payload(sentences: list[dict[str, Any]]) -> list[dict[str, Any]]:
    payload = []
    for sentence in sentences:
        sid = str(sentence.get("id", ""))
        if not sid:
            continue
        word_ids = [str(wid) for wid in (sentence.get("word_ids") or [])]
        payload.append({
            "id": sid,
            "text": str(sentence.get("text", "")),
            "word_ids": word_ids,
        })
    return payload


def chunk_sentences(
    sentences: list[dict[str, Any]],
    chunk_size: int = SENTENCES_PER_CHUNK,
    context_size: int = CONTEXT_SENTENCES,
) -> list[tuple[list[dict[str, Any]], list[dict[str, Any]]]]:
    """文リストを (文脈参考, 判定対象) のチャンク列に分割する。"""
    chunks: list[tuple[list[dict[str, Any]], list[dict[str, Any]]]] = []
    for start in range(0, len(sentences), chunk_size):
        target = sentences[start : start + chunk_size]
        context_start = max(0, start - context_size)
        context = sentences[context_start:start] if start > 0 else []
        chunks.append((context, target))
    return chunks


def merge_llm_responses(responses: list[dict[str, Any]]) -> dict[str, Any]:
    """複数チャンクのLLM応答をマージする。"""
    merged: dict[str, Any] = {
        "retakes": [],
        "partial_retakes": [],
        "needs_review": [],
        "remove_filler_word_ids": [],
        "suspicious_words": [],
    }
    for response in responses:
        merged["retakes"].extend(response.get("retakes") or [])
        merged["partial_retakes"].extend(response.get("partial_retakes") or [])
        merged["needs_review"].extend(response.get("needs_review") or [])
        filler_ids = response.get("remove_filler_word_ids") or []
        if isinstance(filler_ids, list):
            merged["remove_filler_word_ids"].extend(str(fid) for fid in filler_ids if fid)
        suspicious = response.get("suspicious_words") or []
        if isinstance(suspicious, list):
            merged["suspicious_words"].extend(suspicious)
    return merged


def build_prompt(
    sentences_payload: list[dict[str, Any]],
    context_payload: Optional[list[dict[str, Any]]] = None,
    filler_candidates: Optional[list[dict[str, Any]]] = None,
    correction_examples: Optional[list[dict[str, Any]]] = None,
) -> str:
    sentences_json = json.dumps(sentences_payload, ensure_ascii=False, indent=2)
    # W14-2: ユーザーが過去に確定した修正例(全run横断の correction_history 由来)
    correction_examples_section = build_correction_examples_section(correction_examples)
    context_section = ""
    if context_payload:
        context_json = json.dumps(context_payload, ensure_ascii=False, indent=2)
        context_section = f"""
# 文脈参考（この部分は判定対象外。直前の会話の流れを把握するための参考情報）
{context_json}

"""
    filler_section = ""
    if filler_candidates:
        filler_json = json.dumps(filler_candidates, ensure_ascii=False, indent=2)
        filler_section = f"""
## フィラー除去
以下は step04 で検出したフィラー候補です（warn_only 含む全件）。
**基本方針: フィラー候補は基本的にすべて除去してください。**
残すのは、消すと会話が成立しない意味のある応答（質問への返事の「そうですね」「うん」等）だけです。
迷ったら除去してください。

除去するフィラーは remove_filler_word_ids に word_id を列挙してください。

# フィラー候補 (word_id / match_text / sentence_text)
{filler_json}

"""
    return f"""あなたは日本語トーク動画の文字起こし校正者です。以下の文単位の文字起こし全文を読み、
言い直し検出と復元困難箇所の検出を行ってください。
{filler_section}
## 確信を持ってカットするもの（needs_review にしない）
以下は迷わず remove_sentence_ids に入れてカットしてください。

### 収録の進行に関する発話（動画の内容ではなく撮影自体についての会話）
- 「もう1回お願いします」「もう1回いきます」「編集で切ってください」「編集するんで」
- 「カメラ」「マイク」「録画」「完璧です」「いい感じですよ」
- 「大丈夫です」（撮り直し・収録調整の文脈）
- その他、収録スタッフとの進行会話

### やり直しテイク
同じ内容を言い直して撮り直している場合、**古い方のテイクと間の進行会話を丸ごと**カットする。
後のテイクで同じ自己紹介・同じフレーズを言い直しているなら、古いテイク＋「もう1回…」等の間の会話はすべてカット。

### 動画の締めの挨拶より後
収録終了後の雑談・スタッフ会話（「完璧です」「いいことですよ」等）はカット。

## 言い直し検出（上記以外）
- 文が完結せずに言い直している場合、**不完全な方の発話を丸ごとカット対象**にしてください。
- **意図的な繰り返し**(強調・あえて2回言っている等)は残してください。

### 文中の言い直し（partial_retakes・重要）
話者が**文の途中で言いよどんで同じ・類似フレーズを言い直した**場合、文全体を消すと正しい部分まで
消えてしまう。この場合は partial_retakes で「言い直された古い部分だけ」を除去する:
- remove_surface には対象文の text に**実際に含まれる連続部分文字列**をそのまま書く
  (言いよどんだ古いテイク側。直後の言い直しが正となる)
- 例1: 「全部やらないと不安だったり、ここを捨てるのが不安という」の直後の文が
  「ここを捨てるのが怖いという感情が…」と言い直している
  → 前の文に partial_retakes {{"remove_surface": "ここを捨てるのが不安という"}}
- 例2: 1つの文の中で「半年間のスケジュール感-半年のスケジュール感だけでも掴みたい」と言い直している
  → {{"remove_surface": "半年間のスケジュール感-"}}
- 例3: 「どういった形でもZOOM-ZOOM相談可能です」のような単語の言いよどみ
  → {{"remove_surface": "ZOOM-"}}
- 言い直し後のフレーズが**次の文として続いている**場合も同様に、前の文の古いテイク部分を除去する。
  文末に言い直し先頭の断片が残っている場合(「…不安という、ここ」の末尾「ここ」等)は断片も含めて除去する
  (例: 文A「全部やらないと不安だったり、ここを捨てるのが不安という、ここ」+
   文B「を捨てるのが怖いという感情が…」→ 文Aに {{"remove_surface": "ここを捨てるのが不安という、ここ"}}
   とはせず、文Bの「ここを捨てる…」が完全な言い直しになるよう文Aの「ここを捨てるのが不安という、」までを除去し、
   文A末尾の断片「ここ」は文Bの先頭に続く語なので残す。断片が次文と繋がらない場合のみ断片も除去)
- このような**言い直しによる重複は needs_review に回さず、必ずカット**すること。
  **各チャンクで文をまたぐ類似フレーズの繰り返しがないか必ず確認する**こと

## 復元困難検出（needs_review）
- needs_review は**発話内容として意味があるか本当に判断できない場合のみ**使ってください。
- 収録メタ会話・明白なやり直しは迷わずカットし、needs_review に回さないでください。
- 文字起こしが崩れていて、文脈から正しい文を**確信を持って復元できない**区間だけ報告してください。
- 無理に推測して違う内容に直さないでください。

## 疑義ワード検出（suspicious_words）
文字起こし全文を読み、**単語・文節の単位で**「音声認識の誤変換・崩れの疑いがある語」を報告してください。
ここでの目的は「人間が確認すべき箇所に気づかせること」です。**見逃しが最も困る**ため、
文脈上少しでも不自然な語は積極的に報告してください（確信が無くても報告する。直す判断は人間がします）。
- 同音異義語の誤変換の疑い（文脈と合わない漢字・カタカナ。例:「新学校」→文脈上「進学校」、
  「シロチャート」→参考書の文脈なら「白チャート」）
- 話し言葉の略語・専門用語の誤変換（略語は別の同音語として認識されやすい。
  例: 受験動画の「共テ」(共通テスト)が「協定」「教程」等と認識されるケース。
  **同じ動画内で同じ概念を指すはずの語が複数の表記で現れていたら、その全部を報告**し、
  文脈から本来の語が推測できるなら suggestion に書く）
- 文法的に壊れた断片・音の欠落や混入で意味をなさない並び（例:「題の一ました個ぐらい」のような
  崩れた文字列。文全体が崩れているなら needs_review、一部の語だけなら suspicious_words）
- 文末の語尾欠落（W11-6。例:「6割ぐらいじゃないで」のように助動詞・終助詞が途中で切れて
  文が不自然に終わっている文。surface には切れている文末部分を書き、正しい語尾が確信を持って
  補える場合のみ suggestion に補正後の語尾（例:「じゃないですか」）を書く）
- 文の境界の文字切れ（W13-6。文の末尾が単語の途中で不自然に途切れている、または
  次の文の先頭に前の文の末尾の断片（1〜2文字の重複など）が混入しているケース。
  surface には途切れている末尾または重複している先頭の断片を書き、
  正しいつながりが確信を持って推測できる場合のみ suggestion を書く）
- 日本語の発話に不自然に混入した英字・記号（例:「soですよ」）
- 表記ゆれ（同じ固有名詞・用語が動画内で複数の表記になっている場合、少数派の表記）
- 数値・点数・人名・大学名など、聞き間違いだと意味が大きく変わる語で文脈と合わないもの
報告ルール:
- surface は対象文（sentence_id の text）に**実際に含まれる部分文字列**をそのまま書くこと
- 1〜2文字だけの助詞・フィラー・相槌（「の」「が」「ど」「あの」「うん」等）は報告しない
- suggestion は正しい語が確信を持って推測できる場合のみ書く（創作しない）。
  確信が無くても報告自体は行い、reason に「〜の可能性」等と書く
- スタイルの好み・言い換え提案はしない。最大30件（怪しい順）
{correction_examples_section}
## 判定例（few-shot）
入力: 「はい、お願いします／私けいわというふうに／ちょっともう1回お願いしていいですか？／編集するんで／大丈夫です／はい、慣れないですよね／何を言っていいんだっけみたいな／もう1回いきます／はい、じゃあいきます」
→ これらすべて remove_sentence_ids（後のテイクで同じ自己紹介をやり直しているため）

入力: 末尾の「はい、じゃあ完璧です／ありがとうございます（収録終了後）／いいことですよ」
→ すべて remove_sentence_ids（収録終了後の雑談）

対比例: 「とても大切です。大切なんです」→ 強調のための意図的な繰り返しなので**残す**

入力: 「全部やらないと不安だったり、ここを捨てるのが不安という／ここを捨てるのが怖いという感情が先に来てしまうからです」
→ 前の文の末尾「ここを捨てるのが不安という」を partial_retakes で除去（後の文で言い直しているため。文全体は消さない）

## 出力ルール
- remove_sentence_ids / needs_review.sentence_ids には、入力JSONの文 id のみを指定してください。
- remove_filler_word_ids には、フィラー候補の word_id のみを指定してください。
- 存在しない id は無視されます。
- 出力は次のJSON形式のみ。説明文やコードフェンスは不要です:
{{
  "retakes": [
    {{"reason": "言い直し: 前半が未完で後半に言い直し", "remove_sentence_ids": ["s-003"]}}
  ],
  "partial_retakes": [
    {{"sentence_id": "s-015", "remove_surface": "ここを捨てるのが不安という", "reason": "文中の言い直し: 直後に同フレーズを言い直している"}}
  ],
  "needs_review": [
    {{"sentence_ids": ["s-010"], "reason": "音声認識が崩れて文脈から復元できない"}}
  ],
  "remove_filler_word_ids": ["w-0039"],
  "suspicious_words": [
    {{"sentence_id": "s-021", "surface": "シロチャート", "reason": "参考書の文脈では「白チャート」の誤変換の疑い", "suggestion": "白チャート"}}
  ]
}}
{context_section}
# 文単位の文字起こし (id / text / word_ids) — 判定対象
{sentences_json}
"""


def sentence_word_ids(sentence_map: dict[str, dict[str, Any]], sentence_id: str) -> list[str]:
    sentence = sentence_map.get(sentence_id)
    if not sentence:
        return []
    return [str(wid) for wid in (sentence.get("word_ids") or [])]


def resolve_word_span(
    word_ids: list[str],
    word_map: dict[str, dict[str, Any]],
) -> tuple[int, int, str]:
    if not word_ids:
        return 0, 0, ""
    starts = []
    ends = []
    texts = []
    for wid in word_ids:
        word = word_map.get(wid)
        if not word:
            continue
        starts.append(int(word.get("start_ms") or 0))
        ends.append(int(word.get("end_ms") or word.get("start_ms") or 0))
        texts.append(str(word.get("text") or ""))
    if not starts:
        return 0, 0, "".join(texts)
    return min(starts), max(ends), "".join(texts)


SUSPECT_SURFACE_MAX_CHARS = 20


def resolve_surface_word_ids(
    sentence_id: str,
    surface: str,
    sentence_map: dict[str, dict[str, Any]],
    word_map: dict[str, dict[str, Any]],
) -> list[str]:
    """文内の部分文字列 surface に文字を持つ word の id 群を返す(見つからなければ空)。

    文字インデックス→word所有者の対応表方式(resolve_suspect_words と同じ)。
    """
    word_ids = sentence_word_ids(sentence_map, sentence_id)
    concat_text = ""
    char_owner: list[str] = []
    for wid in word_ids:
        word = word_map.get(wid)
        if not word:
            continue
        for ch in str(word.get("text") or ""):
            concat_text += ch
            char_owner.append(wid)
    match_start = concat_text.find(surface)
    if match_start < 0:
        return []
    matched_word_ids: list[str] = []
    for char_index in range(match_start, match_start + len(surface)):
        wid = char_owner[char_index]
        if not matched_word_ids or matched_word_ids[-1] != wid:
            matched_word_ids.append(wid)
    return matched_word_ids


def resolve_suspect_words(
    response: dict[str, Any],
    sentence_map: dict[str, dict[str, Any]],
    word_map: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    """W5-1: LLMの suspicious_words を ai_review.suspect_words 形式に解決する。

    sentence_id の word_ids から各wordのtextを順に連結した文字列に対して surface の
    部分一致検索を行い、マッチ範囲に文字を持つ word の id 群へ逆引きする
    (suspicionQueue.ts の findHeuristicTermRuns と同じ「文字→word所有者」対応表方式)。
    マッチしない項目(幻覚サーフェス)・実在しない sentence_id・空/過長 surface は捨てる。
    """
    raw_items = response.get("suspicious_words")
    if not isinstance(raw_items, list):
        return []

    results: list[dict[str, Any]] = []
    seen_keys: set[tuple[str, str]] = set()
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        sentence_id = str(item.get("sentence_id") or "")
        surface = str(item.get("surface") or "")
        if not surface or len(surface) > SUSPECT_SURFACE_MAX_CHARS:
            continue
        if sentence_id not in sentence_map:
            continue
        matched_word_ids = resolve_surface_word_ids(sentence_id, surface, sentence_map, word_map)
        if not matched_word_ids:
            continue
        dedupe_key = (matched_word_ids[0], surface)
        if dedupe_key in seen_keys:
            continue
        seen_keys.add(dedupe_key)
        start_ms, end_ms, text = resolve_word_span(matched_word_ids, word_map)
        entry: dict[str, Any] = {
            "word_ids": matched_word_ids,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "text": text,
            "reason": str(item.get("reason") or "誤変換の疑い"),
        }
        suggestion = str(item.get("suggestion") or "")
        if suggestion:
            entry["suggestion"] = suggestion
        results.append(entry)
    return results


def apply_llm_response(
    response: dict[str, Any],
    sentences: list[dict[str, Any]],
    sentence_map: dict[str, dict[str, Any]],
    word_map: dict[str, dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], int, int, list[dict[str, Any]]]:
    """LLM応答を retakes.json 形式と ai_review.needs_review / suspect_words 形式に変換する。"""
    retake_entries: list[dict[str, Any]] = []
    needs_review_items: list[dict[str, Any]] = []

    raw_retakes = response.get("retakes") or []
    if isinstance(raw_retakes, list):
        for item in raw_retakes:
            if not isinstance(item, dict):
                continue
            reason = str(item.get("reason") or "言い直し")
            ids = item.get("remove_sentence_ids") or []
            if not isinstance(ids, list):
                continue
            valid_ids = [str(sid) for sid in ids if str(sid) in sentence_map]
            if not valid_ids:
                continue
            word_ids: list[str] = []
            for sid in valid_ids:
                word_ids.extend(sentence_word_ids(sentence_map, sid))
            if word_ids:
                retake_entries.append({
                    "keep": "retry",
                    "original_sentence_ids": word_ids,
                    "retry_sentence_ids": [],
                    "reason": reason,
                })

    # フェーズW29(文中の言い直し部分カット): 文全体ではなく「言い直された古い部分」だけを
    # word単位で除去する。従来は remove_sentence_ids(文単位)しかなく、文中で言い直した
    # ケース(「ここを捨てるのが不安という→ここを捨てるのが怖いという」等)を検出しても
    # カットできず needs_review へ素通りしていた
    raw_partials = response.get("partial_retakes") or []
    if isinstance(raw_partials, list):
        for item in raw_partials:
            if not isinstance(item, dict):
                continue
            sentence_id = str(item.get("sentence_id") or "")
            surface = str(item.get("remove_surface") or "")
            reason = str(item.get("reason") or "文中の言い直し")
            # 誤爆防止: 3文字未満の表面(助詞など)は対象にしない
            if len(surface) < 3 or sentence_id not in sentence_map:
                continue
            matched_ids = resolve_surface_word_ids(sentence_id, surface, sentence_map, word_map)
            if not matched_ids:
                continue
            start_ms, end_ms, _text = resolve_word_span(matched_ids, word_map)
            # 安全弁: 1件で15秒を超える部分カットは文単位削除の誤用の可能性が高いので捨てる
            if end_ms - start_ms > 15000:
                continue
            retake_entries.append({
                "keep": "retry",
                "original_sentence_ids": matched_ids,
                "retry_sentence_ids": [],
                "reason": reason,
            })

    raw_filler_ids = response.get("remove_filler_word_ids") or []
    fillers_removed = 0
    if isinstance(raw_filler_ids, list):
        valid_filler_ids = [str(fid) for fid in raw_filler_ids if str(fid) in word_map]
        if valid_filler_ids:
            retake_entries.append({
                "keep": "retry",
                "original_sentence_ids": valid_filler_ids,
                "retry_sentence_ids": [],
                "reason": "フィラー除去(AI判定)",
            })
            fillers_removed = len(valid_filler_ids)

    raw_needs = response.get("needs_review") or []
    if isinstance(raw_needs, list):
        for item in raw_needs:
            if not isinstance(item, dict):
                continue
            reason = str(item.get("reason") or "要確認")
            ids = item.get("sentence_ids") or []
            if not isinstance(ids, list):
                continue
            for sid in ids:
                sid_str = str(sid)
                if sid_str not in sentence_map:
                    continue
                word_ids = sentence_word_ids(sentence_map, sid_str)
                start_ms, end_ms, text = resolve_word_span(word_ids, word_map)
                needs_review_items.append({
                    "word_ids": word_ids,
                    "start_ms": start_ms,
                    "end_ms": end_ms,
                    "text": text,
                    "reason": reason,
                })

    suspect_word_items = resolve_suspect_words(response, sentence_map, word_map)

    retakes_applied = len([e for e in retake_entries if e.get("reason") != "フィラー除去(AI判定)"])
    return retake_entries, needs_review_items, retakes_applied, fillers_removed, suspect_word_items


def _attach_usage(payload: dict[str, Any]) -> dict[str, Any]:
    """累積使用量があれば payload に usage キーを付与する。"""
    usage = get_usage_summary()
    if usage:
        payload["usage"] = usage
    return payload


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def run_step(
    run_dir: str,
    stt_path: str,
    fillers_path: str,
    retakes_output: str,
    review_output: str,
    provider: ProviderArg = "auto",
    api_key: Optional[str] = None,
    correction_history_path: Optional[str] = None,
    call_llm_fn: Optional[Callable[[ProviderName, str, str, str], dict[str, Any]]] = None,
) -> dict[str, Any]:
    """AI retake ステップ本体。キーなし/エラー時は安全にスキップする。"""
    print("[Step 5 AI] Retake detection (LLM)")
    reset_usage_tracking()
    caller = call_llm_fn or call_llm
    stt_file = Path(stt_path)
    fillers_file = Path(fillers_path)
    retakes_file = Path(retakes_output)
    review_file = Path(review_output)

    if not stt_file.exists():
        print(f"  skip: STT not found ({stt_file})")
        _write_json(retakes_file, {"retakes": []})
        _write_json(review_file, {"enabled": False, "reason": "stt not found"})
        return {"enabled": False, "reason": "stt not found"}

    words, sentences, sentence_map = load_stt(stt_file)
    word_map = {str(w.get("id", "")): w for w in words if w.get("id")}
    word_to_sentence = build_word_to_sentence(sentence_map)
    filler_candidates = build_filler_candidates(
        load_fillers(fillers_file), sentence_map, word_to_sentence,
    )

    resolved_provider: Optional[ProviderName]
    resolved_key: str
    resolved_model: str

    if api_key is not None:
        if api_key.strip():
            resolved_provider = provider if provider != "auto" else "anthropic"
            if resolved_provider == "auto":
                resolved_provider = "anthropic"
            resolved_key = api_key.strip()
            resolved_model = "claude-sonnet-5"
        else:
            resolved_provider, resolved_key, resolved_model = None, "", ""
    else:
        resolved_provider, resolved_key, resolved_model = resolve_provider_and_key(provider, REPO_ROOT)

    if not resolved_provider or not resolved_key:
        print("  no AI provider key set - skipping AI retake detection")
        _write_json(retakes_file, {"retakes": []})
        _write_json(review_file, {"enabled": False, "reason": "no AI provider key set"})
        return {"enabled": False, "reason": "no AI provider key set"}

    print(f"  provider: {resolved_provider}, model: {resolved_model}")

    if not sentences:
        print("  skip: no sentences in STT")
        _write_json(retakes_file, {"retakes": []})
        _write_json(review_file, {"enabled": False, "reason": "no sentences", "provider": resolved_provider})
        return {"enabled": False, "reason": "no sentences"}

    chunks = chunk_sentences(sentences)
    print(f"  sentences: {len(sentences)}, chunks: {len(chunks)}")

    # W14-2: ユーザーが過去に確定した修正例(頻度上位)。履歴が無ければ空=従来動作。
    correction_examples = top_correction_examples(
        load_correction_history(correction_history_path), CORRECTION_EXAMPLES_LIMIT,
    )
    if correction_examples:
        print(f"  correction examples: {len(correction_examples)} pairs")

    successful_responses: list[dict[str, Any]] = []
    failed_chunks = 0
    error_kinds: list[str] = []
    error_details: list[str] = []

    for chunk_index, (context, target) in enumerate(chunks):
        prompt = build_prompt(
            build_sentences_payload(target),
            context_payload=build_sentences_payload(context) if context else None,
            filler_candidates=filler_candidates if chunk_index == 0 else None,
            correction_examples=correction_examples or None,
        )
        try:
            response = call_llm_json(
                resolved_provider, resolved_key, resolved_model, prompt,
                caller=caller,
            )
            successful_responses.append(response)
            print(f"  chunk {chunk_index + 1}/{len(chunks)}: ok")
        except Exception as exc:  # noqa: BLE001
            failed_chunks += 1
            error_kind = classify_llm_error(exc)
            error_kinds.append(error_kind)
            error_details.append(truncate_error_detail(f"{type(exc).__name__}: {exc}"))
            print(
                f"  chunk {chunk_index + 1}/{len(chunks)} failed "
                f"[error_kind={error_kind}] ({type(exc).__name__}: {exc})"
            )
            # billing/auth はリトライ・続行が無意味なので残チャンクをスキップして即時失敗(改善21-A)。
            if error_kind in FATAL_LLM_ERROR_KINDS:
                remaining = len(chunks) - chunk_index - 1
                if remaining > 0:
                    failed_chunks += remaining
                    print(f"  fatal error ({error_kind}) - skipping remaining {remaining} chunks")
                break

    if not successful_responses:
        print(f"  all {len(chunks)} chunks failed - skipping")
        _write_json(retakes_file, {"retakes": []})
        failure_payload = _attach_usage({
            "enabled": False,
            "reason": f"api_error: all {len(chunks)} chunks failed",
            "provider": resolved_provider,
            "failed_chunks": failed_chunks,
            "error_kind": summarize_error_kinds(error_kinds),
            "error_detail": error_details[0] if error_details else "",
        })
        _write_json(review_file, failure_payload)
        print_usage_summary()
        return failure_payload

    merged_response = merge_llm_responses(successful_responses)

    try:
        (
            retake_entries,
            needs_review_items,
            retakes_applied,
            fillers_removed,
            suspect_word_items,
        ) = apply_llm_response(
            merged_response, sentences, sentence_map, word_map,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"  failed to apply response ({type(exc).__name__}: {exc}) - skipping")
        _write_json(retakes_file, {"retakes": []})
        _write_json(review_file, _attach_usage({
            "enabled": False,
            "reason": f"apply_error: {exc}",
            "provider": resolved_provider,
            "failed_chunks": failed_chunks,
        }))
        print_usage_summary()
        return {"enabled": False, "reason": f"apply_error: {exc}"}

    _write_json(retakes_file, {"retakes": retake_entries})
    review_payload: dict[str, Any] = {
        "enabled": True,
        "provider": resolved_provider,
        "model": resolved_model,
        "needs_review": needs_review_items,
        # W5-1: AI疑義ワード(文脈上あやしい語)。旧runのJSONには無い=読み側は欠落を空配列扱い。
        "suspect_words": suspect_word_items,
        "retakes_applied": retakes_applied,
        "fillers_removed_by_ai": fillers_removed,
    }
    if failed_chunks > 0:
        review_payload["failed_chunks"] = failed_chunks
        review_payload["error_kind"] = summarize_error_kinds(error_kinds)
        if error_details:
            review_payload["error_detail"] = error_details[0]
    _attach_usage(review_payload)
    _write_json(review_file, review_payload)

    print(
        f"  retakes: {retakes_applied}, fillers_removed: {fillers_removed}, "
        f"needs_review: {len(needs_review_items)}, failed_chunks: {failed_chunks}"
    )
    print_usage_summary()
    print(f"[Step 5 AI] Done: {review_file}")
    return review_payload


def main() -> None:
    parser = argparse.ArgumentParser(description="Step 5: AI Retake Detection")
    parser.add_argument("run_dir", help="runs/<run_name> へのパス")
    parser.add_argument("--stt", required=True, help="stt_corrected.json パス")
    parser.add_argument("--fillers", required=True, help="fillers.json パス")
    parser.add_argument("--retakes-output", required=True, help="retakes.json 出力先")
    parser.add_argument("--review-output", required=True, help="ai_review.json 出力先")
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
        args.run_dir,
        args.stt,
        args.fillers,
        args.retakes_output,
        args.review_output,
        provider=args.provider,
        correction_history_path=args.correction_history,
    )


if __name__ == "__main__":
    main()
