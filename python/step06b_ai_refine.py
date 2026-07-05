"""Step 6b: AI Refine - LLM API によるテロップ本文の自動校正 (改善8-A-5 / 改善12)。

rough-cut の `.claude/skills/generate/SKILL.md` Step 6 (誤字脱字レビュー) /
Step 8.5b (telop.txt のAI校正) に相当する工程を無人化するステップ。

STT全文 (文脈) と telop.txt (BudouXによるページ分割案) を LLM API に渡し、
1. 誤字脱字の修正 (corrections 形式: {"誤": "正"})
2. ページ境界 (カット内の改行位置) の調整 - 文末・文節の切れ目に揃える
3. 不自然な改行の修正
を構造化JSONで受け取り、telop.txt に適用する (ID行・空行構造は維持)。

Anthropic / OpenAI / Google Gemini のいずれか1つのAPIキーがあれば動作する。
キーが未設定、または API 呼び出しに失敗した場合は警告を出してスキップし、
telop.txt はBudouXの出力のまま変更しない (パイプラインは壊さない)。

Usage:
    python step06b_ai_refine.py <run_dir> \
        --stt ../runs/{run}/step02b_transcript_correct/stt_corrected.json \
        --project ../templates/vertical.yaml \
        --output ../runs/{run}/step06b_ai_refine/refine.json \
        [--provider auto|anthropic|openai|gemini]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any, Callable, Literal, Optional

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))

from review_telop import TelopPage, parse_telop, render_telop  # noqa: E402
from shared.llm_client import (  # noqa: E402
    API_KEY_ENV,
    DEFAULT_MODELS,
    FATAL_LLM_ERROR_KINDS,
    MODEL_ENV,
    PROVIDER_PRIORITY,
    ProviderArg,
    ProviderName,
    _extract_json,
    call_claude,
    call_gemini,
    call_llm,
    call_llm_json,
    call_openai,
    classify_llm_error,
    find_env_key,
    find_provider_key,
    get_usage_summary,
    print_usage_summary,
    reset_usage_tracking,
    resolve_model,
    resolve_provider_and_key,
    summarize_error_kinds,
    truncate_error_detail,
)
from shared.project_config import load_project_config  # noqa: E402
from shared.telop_builder import _PROPER_NOUN_MAP  # noqa: E402
from shared.text_cleaning import apply_deterministic_text_cleaning, clean_telop_line  # noqa: E402
from shared.transcript_correction import load_correction_dictionary  # noqa: E402

REPO_ROOT = ROOT.parent

PUNCT_TO_REMOVE_RE = re.compile(r"[。、！？!?,.]")
CUTS_PER_CHUNK = 50


def find_api_key(repo_root: Path = REPO_ROOT) -> str:
    """後方互換: ANTHROPIC_API_KEY のみを返す。"""
    return find_env_key("ANTHROPIC_API_KEY", repo_root)


# ---------------------------------------------------------------------------
# telop.txt <-> per-cut page grouping
# ---------------------------------------------------------------------------

def _cut_id_of(page_id: str) -> str:
    return page_id.rsplit("_p", 1)[0]


def _group_pages_by_cut(pages: list[TelopPage]) -> list[tuple[str, list[TelopPage]]]:
    """ページ列を cut_id ごとの連続したまとまりにグルーピングする (順序維持)。"""
    groups: list[tuple[str, list[TelopPage]]] = []
    current_cut: Optional[str] = None
    current_list: list[TelopPage] = []
    for page in pages:
        cut_id = _cut_id_of(page.page_id)
        if cut_id != current_cut:
            if current_list:
                groups.append((current_cut, current_list))
            current_cut = cut_id
            current_list = []
        current_list.append(page)
    if current_list:
        groups.append((current_cut, current_list))
    return groups


def _page_text(page: TelopPage) -> str:
    return "".join(line for line in page.body if line.strip() and not line.lstrip().startswith("#"))


def build_transcript_context(stt_path: Path, max_chars: int = 6000) -> str:
    """STT全文 (文脈) を構築する。sentences があれば優先し、無ければwordsを連結する。"""
    try:
        data = json.loads(stt_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return ""
    sentences = data.get("sentences") or []
    if sentences:
        text = "".join(str(s.get("text", "")) for s in sentences)
    else:
        text = "".join(str(w.get("text", "")) for w in data.get("words", []))
    if len(text) > max_chars:
        text = text[:max_chars] + "…"
    return text


def build_cuts_payload(pages: list[TelopPage]) -> list[dict[str, Any]]:
    """LLM に渡す「現在のページ分割案」を cut_id ごとに構築する。"""
    payload = []
    for cut_id, cut_pages in _group_pages_by_cut(pages):
        payload.append({
            "cut_id": cut_id,
            "pages": [_page_text(p) for p in cut_pages],
        })
    return payload


def extract_title_from_run_dir(run_dir: str) -> str:
    """runs/<timestamp>_<title> から動画タイトル部分を緩く復元する。"""
    name = Path(run_dir).name
    parts = name.split("_", 2)
    if len(parts) >= 3:
        return parts[2].replace("_", " ")
    return ""


def chunk_cuts_payload(
    cuts: list[dict[str, Any]],
    chunk_size: int = CUTS_PER_CHUNK,
) -> list[list[dict[str, Any]]]:
    """カットpayloadを一定数ごとに分割する。"""
    return [cuts[i : i + chunk_size] for i in range(0, len(cuts), chunk_size)]


def merge_refine_responses(responses: list[dict[str, Any]]) -> dict[str, Any]:
    """複数チャンクのLLM応答をマージする (correctionsは辞書マージ、他は連結)。"""
    merged_corrections: dict[str, str] = {}
    merged_cuts: list[dict[str, Any]] = []
    merged_needs: list[dict[str, Any]] = []
    merged_dismissed: list[str] = []

    for response in responses:
        raw_corrections = response.get("corrections")
        if isinstance(raw_corrections, dict):
            for key, value in raw_corrections.items():
                if isinstance(key, str) and key and value is not None:
                    merged_corrections[key] = str(value)
        merged_cuts.extend(response.get("cuts") or [])
        merged_needs.extend(response.get("needs_review") or [])
        dismissed = response.get("dismissed_finding_ids") or []
        if isinstance(dismissed, list):
            merged_dismissed.extend(str(fid) for fid in dismissed if fid)

    return {
        "corrections": merged_corrections,
        "cuts": merged_cuts,
        "needs_review": merged_needs,
        "dismissed_finding_ids": list(dict.fromkeys(merged_dismissed)),
    }


# ---------------------------------------------------------------------------
# 表記揺れ候補の抽出 (改善22-B)
# ---------------------------------------------------------------------------

# カタカナ語 (3文字以上) と英数字語 (2文字以上)
_KATAKANA_WORD_RE = re.compile(r"[ァ-ヶー]{3,}")
_ALNUM_WORD_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9&+.\-]{1,}")


def _notation_key(word: str) -> str:
    """表記揺れグループ化用の正規化キー (NFKC → 既知カナ表記の正式化 → 長音/中点除去 → 大文字化)。"""
    normalized = unicodedata.normalize("NFKC", word)
    # ユーチューブ/YouTube のようなカナ↔英字の揺れは決定的マップでキーを同一視する
    normalized = _PROPER_NOUN_MAP.get(normalized, normalized)
    normalized = normalized.replace("ー", "").replace("・", "")
    return normalized.upper()


def _edit_distance_at_most(s1: str, s2: str, limit: int) -> bool:
    """編集距離が limit 以下かを判定する (語は短いので単純DPで十分)。"""
    if abs(len(s1) - len(s2)) > limit:
        return False
    prev = list(range(len(s2) + 1))
    for i, c1 in enumerate(s1, 1):
        cur = [i]
        for j, c2 in enumerate(s2, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (c1 != c2)))
        prev = cur
    return prev[-1] <= limit


def extract_notation_variants(full_text: str, min_count: int = 2) -> list[dict[str, Any]]:
    """全文から表記揺れ候補を抽出する (改善22-B)。

    1. カタカナ語・英数字語を正規化キーでグループ化し、同一キーに複数表記があるもの
    2. 編集距離1〜2の近似カタカナ語ペア (両方とも出現 min_count 回以上)
    を候補として返す。パス2はチャンク単位で処理するため、動画全体の表記一貫性は
    ここで抽出した候補を全チャンク共通のプロンプト節として注入して担保する。

    Returns:
        [{"canonical": 多数派表記, "variants": [(表記, 出現数), ...出現数降順]}]
    """
    words = _KATAKANA_WORD_RE.findall(full_text) + _ALNUM_WORD_RE.findall(full_text)
    counts = Counter(words)

    groups: dict[str, dict[str, int]] = {}
    for word, count in counts.items():
        groups.setdefault(_notation_key(word), {})[word] = count

    candidates: list[dict[str, Any]] = []
    seen_words: set[str] = set()
    for variants in groups.values():
        if len(variants) < 2:
            continue
        ordered = sorted(variants.items(), key=lambda kv: (-kv[1], kv[0]))
        candidates.append({"canonical": ordered[0][0], "variants": ordered})
        seen_words.update(variants)

    # 近似カタカナ語ペア (例: フォーメイ業/フォーム営業 のカナ部分)。過剰検出を避けるため
    # 両方とも min_count 回以上出現する語に限定する
    kata_counts = {
        w: c for w, c in counts.items()
        if c >= min_count and _KATAKANA_WORD_RE.fullmatch(w)
    }
    kata_words = sorted(kata_counts)
    for i, w1 in enumerate(kata_words):
        for w2 in kata_words[i + 1:]:
            if w1 in seen_words and w2 in seen_words:
                continue
            # 短いカタカナ語同士の偶然の近似 (ツール/ハードル等) の誤爆を抑えるため、
            # 先頭2文字が一致するペアに限定する
            if w1[:2] != w2[:2]:
                continue
            if not _edit_distance_at_most(w1, w2, 2):
                continue
            pair = sorted(
                [(w1, kata_counts[w1]), (w2, kata_counts[w2])],
                key=lambda kv: (-kv[1], kv[0]),
            )
            candidates.append({"canonical": pair[0][0], "variants": pair})
            seen_words.update((w1, w2))

    return candidates


# ---------------------------------------------------------------------------
# Prompt / LLM API 呼び出し
# ---------------------------------------------------------------------------

def build_dictionary_hint(dictionary_path: Optional[str]) -> str:
    """domain_dictionary.yaml から文脈ヒント用の語彙リストを構築する。"""
    if not dictionary_path:
        return ""
    try:
        dictionary = load_correction_dictionary(dictionary_path)
    except (OSError, ImportError, ValueError):
        return ""
    terms: list[str] = []
    for key in ("context", "proper_nouns", "domain_terms", "common_misrecognitions"):
        block = dictionary.get(key)
        if isinstance(block, dict):
            for source, target in block.items():
                if source:
                    terms.append(str(source))
                if target and str(target) != str(source):
                    terms.append(str(target))
        elif isinstance(block, list):
            terms.extend(str(item) for item in block if item)
    likely = dictionary.get("context", {}).get("likely_terms") if isinstance(dictionary.get("context"), dict) else None
    if isinstance(likely, list):
        terms.extend(str(item) for item in likely if item)
    unique = list(dict.fromkeys(t.strip() for t in terms if str(t).strip()))
    if not unique:
        return ""
    return json.dumps(unique[:80], ensure_ascii=False)


def build_review_findings_payload(review_path: Optional[str]) -> list[dict[str, Any]]:
    if not review_path:
        return []
    path = Path(review_path)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    findings = data.get("findings") or []
    payload = []
    for finding in findings:
        if not isinstance(finding, dict):
            continue
        payload.append({
            "id": finding.get("id"),
            "type": finding.get("type"),
            "message": finding.get("message"),
            "source": finding.get("source"),
            "page_id": finding.get("page_id"),
        })
    return payload


def build_prompt(
    transcript: str,
    cuts: list[dict[str, Any]],
    max_chars_per_line: int,
    max_lines_per_page: int,
    dictionary_hint: str = "",
    review_findings: Optional[list[dict[str, Any]]] = None,
    video_title: str = "",
    notation_variants: Optional[list[dict[str, Any]]] = None,
) -> str:
    cuts_json = json.dumps(cuts, ensure_ascii=False, indent=2)
    title_section = ""
    if video_title.strip():
        title_section = f"""
# 動画タイトル（文脈ヒント）
{video_title.strip()}
（タイトルに含まれる固有名詞・キーワードを正しい表記の手がかりとして活用してください。
 例: タイトルに「白谷塾」があれば「平谷塾」は白谷塾の誤認識です）

"""
    dictionary_section = ""
    if dictionary_hint:
        dictionary_section = f"""
# 参考: ドメイン辞書の語彙(専門用語・固有名詞の文脈ヒント)
{dictionary_hint}
"""
    # 改善22-B: 全文から機械抽出した表記揺れ候補を全チャンク共通で注入する
    notation_section = ""
    if notation_variants:
        notation_lines = []
        for group in notation_variants:
            variants_str = " / ".join(v for v, _ in group["variants"])
            counts_str = " vs ".join(f"{c}回" for _, c in group["variants"])
            notation_lines.append(f"- {variants_str} → {group['canonical']}（出現: {counts_str}）")
        notation_list = "\n".join(notation_lines)
        notation_section = f"""
# この動画内で表記が揺れている語 (全文からの機械抽出)。
# 同一の語・固有名詞を指す場合は、すべて多数派の表記 (→ の右側) に統一してください。
# 別の語である場合 (単なる類似語) は統一しないでください:
{notation_list}
"""
    review_section = ""
    if review_findings:
        findings_json = json.dumps(review_findings, ensure_ascii=False, indent=2)
        review_section = f"""
# 機械検査の候補(findings)。各候補について人間の確認が必要か判定してください。
# needs_human_review が false の finding id は dismissed_finding_ids に、
# true のものは needs_review に理由(と修正案があれば suggestion)を付けて報告してください。
{findings_json}
"""
    return f"""あなたは日本語トーク動画のテロップ校正者です。以下のSTT文字起こし全文(文脈)と、
自動生成されたテロップのページ分割案(BudouXによる機械的な分割、句読点は除去済み)を読み、
次の項目を修正・判定してください。
{title_section}
1. 誤字脱字の修正 (STTの音声認識ミス)
   - 音の類似による固有名詞の誤認識 (例: マスターリサプリ→スタディサプリ、平谷塾→白谷塾)
   - 同音異義語の文脈判断 (例: 化学の話での「勇気」→「有機」、指導の話での「強化指導」→「教科指導」)
   - 語頭欠け (例: 「びた教科」→「伸びた教科」)
   - 固有名詞・数字の脱落・語頭の「あ」の欠落等
   - **タイトル・辞書との網羅照合(必ず実施)**: 動画タイトルとドメイン辞書に含まれる各語について、
     テロップ内に音が近い別表記(1〜2音の違い・濁点/清音違い・同音の別漢字)が無いか全ページを確認し、
     あればすべて corrections に含める (例: タイトルが「講師インタビュー」なら「奉仕インタビュー」は誤認識)
   - 有名な企業・サービス・ブランド名はカタカナ発音表記ではなく正式表記に直す
     (例: ゼット会→Z会、ユーチューブ→YouTube、ライン→LINE)
2. ページ境界(改行位置)の調整: 文の途中や助詞の直前など不自然な位置でページが
   切れている場合、文末・文節の切れ目に揃えて分割し直す
   (同じカット(cut_id)内でのみページの結合・再分割が可能。カットをまたいだ文言の移動は不可)
3. 不自然な改行の修正
4. 明らかに補完できる欠落(語頭の欠け・助詞の欠落など、文脈から一意に決まるもの)は補完する。
   一意に決まらないものは修正しない
5. 専門用語・固有名詞は文脈に合う表記に修正する(参考辞書を活用)
6. 確信が持てない箇所は修正せず needs_review として報告する
7. カットまたぎの単語分断: 隣接カットで前カット末尾が語の途中で切れている疑い
   (例: 前カット末尾「大」/ 次カット先頭「まかに授業」) を見つけたら、
   文言の移動はせず needs_review に報告する
   (reason: 「前のカットと語が分断されています。シーンの結合を検討してください」)
8. 固有名詞の動画内統一: 同一の人物・組織・サービスを指す語が動画内で複数の表記になっている場合、
   最も妥当な1つの表記に統一し corrections に含める
   (人名の漢字が不明な場合はカタカナ/ひらがなの最頻表記でよい)。
   人名・社名の表記が動画内で揺れている場合 (例: 山本/矢本/矢元) は最頻の表記に統一する
9. カット境界の重複文字除去: 隣接カットの末尾と先頭で同じ文字・音が重複している場合
   (ジェットカットのアーティファクト)、後のカットの先頭側の重複文字を削除する
   (自カット内のテキスト修正なので可)。
   例: 前カット「…それが」＋次カット「がめちゃくちゃ…」→ 次カットを「めちゃくちゃ…」に
10. STTのローマ字混入: ローマ字で出力された部分 (例: そうdesu) はかな表記 (そうです) に直す
11. STTの重複アーティファクト: 同一の文字や助詞が不自然に連続している場合
   (例: 書書いてある→書いてある、そのの→その、半径径一定→半径一定) は修正する。
   ただし畳語・慣用的な繰り返し (人々、日々、一つ一つ、次々 等) や
   意図的な強調の繰り返しは修正しない

ルール(厳守):
- 各ページは基本1行、目安 {max_chars_per_line}文字以内、最大 {max_lines_per_page}行。
  短い文を無理に分割しない
- 出力テキストに句読点(。、！？?!)を含めない (表示テロップには使わない表記)
- 表記ルール: 漢数字は算用数字に統一する(慣用句・固有名詞は除く)。全角数字は半角数字に統一する
- 話していない内容を創作しない。確信が持てない誤字は直さずそのまま残す
- 各カットの発話内容の意味を変えない(要約・省略はしない。誤字修正と改行位置調整のみ)
- 変更が不要なカットは "cuts" 配列に含めなくてよい
{dictionary_section}{notation_section}{review_section}
出力は次のJSON形式のみを返してください。説明文やコードフェンスは不要です:
{{
  "corrections": {{"誤字表記": "正しい表記"}},
  "cuts": [
    {{"cut_id": "cut_003", "pages": ["1ページ目の本文", "2ページ目の本文"]}}
  ],
  "needs_review": [
    {{"page_id": "cut_003_p00", "reason": "...", "suggestion": "..."}}
  ],
  "dismissed_finding_ids": ["finding_id"]
}}

# STT文字起こし全文(文脈)
{transcript}

# 現在のページ分割案 (cut_id ごとの現在のページ本文)
{cuts_json}
"""


def parse_refine_metadata(response: dict[str, Any]) -> tuple[list[dict[str, Any]], list[str]]:
    """LLM応答から needs_review / dismissed_finding_ids を取り出す。"""
    needs_review: list[dict[str, Any]] = []
    raw_needs = response.get("needs_review") or []
    if isinstance(raw_needs, list):
        for item in raw_needs:
            if not isinstance(item, dict):
                continue
            entry: dict[str, Any] = {"reason": str(item.get("reason") or "要確認")}
            if item.get("page_id"):
                entry["page_id"] = str(item["page_id"])
            if item.get("text"):
                entry["text"] = str(item["text"])
            if item.get("suggestion"):
                entry["suggestion"] = str(item["suggestion"])
            if entry.get("page_id") or entry.get("text"):
                needs_review.append(entry)

    dismissed: list[str] = []
    raw_dismissed = response.get("dismissed_finding_ids") or []
    if isinstance(raw_dismissed, list):
        dismissed = [str(fid) for fid in raw_dismissed if fid]

    return needs_review, dismissed


# ---------------------------------------------------------------------------
# 応答の適用
# ---------------------------------------------------------------------------

def _apply_corrections(text: str, corrections: dict[str, str]) -> str:
    for wrong, correct in corrections.items():
        if wrong:
            text = text.replace(wrong, correct)
    return text


def _rewrap_cut_pages(
    cut_id: str,
    page_texts: list[str],
    max_chars_per_line: int,
    max_lines_per_page: int,
) -> list[TelopPage]:
    """LLMが提案したページ本文群を、BudouX+DPで実際の行に再パッキングする。"""
    from shared.budoux_layout import split_pages

    rewrapped: list[TelopPage] = []
    counter = 0
    for text in page_texts:
        cleaned = apply_deterministic_text_cleaning(PUNCT_TO_REMOVE_RE.sub("", text).strip())
        if not cleaned:
            continue
        sub_pages = split_pages(
            cleaned, max_chars_per_line=max_chars_per_line, max_lines_per_page=max_lines_per_page,
        )
        if not sub_pages:
            sub_pages = [{"lines": [cleaned]}]
        for sub_page in sub_pages:
            page_id = f"{cut_id}_p{counter:02d}"
            counter += 1
            lines = [clean_telop_line(line) for line in sub_page["lines"]]
            rewrapped.append(TelopPage(page_id=page_id, header=f"# {page_id}", body=lines))
    return rewrapped


def apply_refine_response(
    pages: list[TelopPage],
    response: dict[str, Any],
    max_chars_per_line: int,
    max_lines_per_page: int,
) -> tuple[list[TelopPage], dict[str, int]]:
    """LLMの構造化JSON応答を、telop.txtのページ列に適用する。"""
    raw_corrections = response.get("corrections")
    corrections: dict[str, str] = {}
    if isinstance(raw_corrections, dict):
        corrections = {
            str(k): str(v) for k, v in raw_corrections.items()
            if isinstance(k, str) and str(k) and v is not None
        }

    refine_by_cut: dict[str, list[str]] = {}
    for item in response.get("cuts") or []:
        if not isinstance(item, dict):
            continue
        cut_id = item.get("cut_id")
        page_list = item.get("pages")
        if isinstance(cut_id, str) and isinstance(page_list, list):
            texts = [str(p) for p in page_list if str(p).strip()]
            if texts:
                refine_by_cut[cut_id] = texts

    new_pages: list[TelopPage] = []
    cuts_refined = 0
    corrections_applied = 0

    for cut_id, cut_pages in _group_pages_by_cut(pages):
        if cut_id in refine_by_cut:
            proposed = [_apply_corrections(t, corrections) for t in refine_by_cut[cut_id]]
            rewrapped = _rewrap_cut_pages(cut_id, proposed, max_chars_per_line, max_lines_per_page)
            if rewrapped:
                new_pages.extend(rewrapped)
                cuts_refined += 1
                continue
        for page in cut_pages:
            new_body = []
            changed = False
            for line in page.body:
                if line.strip() == "" or line.lstrip().startswith("#"):
                    new_body.append(line)
                    continue
                fixed = _apply_corrections(line, corrections)
                if fixed != line:
                    changed = True
                new_body.append(fixed)
            if changed:
                corrections_applied += 1
            new_pages.append(TelopPage(page_id=page.page_id, header=page.header, body=new_body))

    return new_pages, {"cuts_refined": cuts_refined, "corrections_applied": corrections_applied}


# ---------------------------------------------------------------------------
# メインフロー
# ---------------------------------------------------------------------------

def _write_result(output_path: Path, result: dict[str, Any]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _attach_usage(payload: dict[str, Any]) -> dict[str, Any]:
    """累積使用量があれば payload に usage キーを付与する。"""
    usage = get_usage_summary()
    if usage:
        payload["usage"] = usage
    return payload


def _make_caller(
    call_refine_fn: Optional[Callable[[ProviderName, str, str, str], dict[str, Any]]],
    call_claude_fn: Optional[Callable[[str, str, str], dict[str, Any]]],
) -> Callable[[ProviderName, str, str, str], dict[str, Any]]:
    if call_refine_fn is not None:
        return call_refine_fn
    if call_claude_fn is not None:
        def wrapper(provider: ProviderName, api_key: str, model: str, prompt: str) -> dict[str, Any]:
            if provider != "anthropic":
                raise RuntimeError("call_claude_fn only supports anthropic")
            return call_claude_fn(api_key, model, prompt)
        return wrapper
    return call_llm


def run_step(
    run_dir: str,
    stt_path: str,
    output_path: str,
    telop_path: Optional[str] = None,
    max_chars_per_line: int = 12,
    max_lines_per_page: int = 1,
    model: Optional[str] = None,
    provider: ProviderArg = "auto",
    api_key: Optional[str] = None,
    review_path: Optional[str] = None,
    dictionary_path: Optional[str] = None,
    title: Optional[str] = None,
    call_refine_fn: Optional[Callable[[ProviderName, str, str, str], dict[str, Any]]] = None,
    call_claude_fn: Optional[Callable[[str, str, str], dict[str, Any]]] = None,
) -> dict[str, Any]:
    """AI refineステップ本体。APIキーが無い/エラー時は安全にスキップする。"""
    run_dir_path = Path(run_dir)
    telop_file = Path(telop_path) if telop_path else run_dir_path / "telop.txt"
    output_file = Path(output_path)
    caller = _make_caller(call_refine_fn, call_claude_fn)

    print("[Step 6b] AI Refine (LLM telop correction)")
    reset_usage_tracking()

    if not telop_file.exists():
        result = {
            "enabled": False,
            "reason": "telop.txt not found",
            "provider": None,
            "model": model,
            "needs_review": [],
            "dismissed_finding_ids": [],
        }
        print(f"  skip: telop.txt not found ({telop_file})")
        _write_result(output_file, result)
        return result

    resolved_provider: Optional[ProviderName]
    resolved_key: str
    resolved_model: str

    if api_key is not None:
        if api_key.strip():
            resolved_provider = provider if provider != "auto" else "anthropic"
            if resolved_provider == "auto":
                resolved_provider = "anthropic"
            resolved_key = api_key.strip()
            resolved_model = resolve_model(resolved_provider, model)
        else:
            resolved_provider, resolved_key, resolved_model = None, "", model or ""
    else:
        resolved_provider, resolved_key, resolved_model = resolve_provider_and_key(provider)
        if model:
            resolved_model = model

    if not resolved_provider or not resolved_key:
        print("  no AI provider key set - skipping AI refine (BudouX-only output kept)")
        result = {
            "enabled": False,
            "reason": "no AI provider key set",
            "provider": None,
            "model": resolved_model or None,
            "needs_review": [],
            "dismissed_finding_ids": [],
        }
        _write_result(output_file, result)
        return result

    print(f"  provider: {resolved_provider}, model: {resolved_model}")

    preamble, pages = parse_telop(telop_file.read_text(encoding="utf-8"))
    if not pages:
        result = {
            "enabled": False,
            "reason": "no telop pages",
            "provider": resolved_provider,
            "model": resolved_model,
            "needs_review": [],
            "dismissed_finding_ids": [],
        }
        print("  skip: no telop pages found")
        _write_result(output_file, result)
        return result

    transcript = build_transcript_context(Path(stt_path))
    cuts_payload = build_cuts_payload(pages)
    dictionary_hint = build_dictionary_hint(dictionary_path)
    review_findings = build_review_findings_payload(review_path)
    video_title = (title or "").strip() or extract_title_from_run_dir(run_dir)
    # 改善22-B: 表記揺れ抽出はチャンク横断の一貫性が目的のため、切り詰めない全文を使う
    full_transcript = build_transcript_context(Path(stt_path), max_chars=1_000_000)
    notation_variants = extract_notation_variants(full_transcript)
    if notation_variants:
        print(f"  notation variants: {len(notation_variants)} groups")
    cut_chunks = chunk_cuts_payload(cuts_payload)
    print(f"  cuts: {len(cuts_payload)}, chunks: {len(cut_chunks)}")

    successful_responses: list[dict[str, Any]] = []
    failed_chunks = 0
    error_kinds: list[str] = []
    error_details: list[str] = []

    for chunk_index, chunk_cuts in enumerate(cut_chunks):
        prompt = build_prompt(
            transcript,
            chunk_cuts,
            max_chars_per_line,
            max_lines_per_page,
            dictionary_hint=dictionary_hint,
            review_findings=review_findings or None if chunk_index == 0 else None,
            video_title=video_title,
            notation_variants=notation_variants or None,
        )
        try:
            response = call_llm_json(
                resolved_provider, resolved_key, resolved_model, prompt,
                caller=caller,
            )
            successful_responses.append(response)
            print(f"  chunk {chunk_index + 1}/{len(cut_chunks)}: ok")
        except Exception as exc:  # noqa: BLE001
            failed_chunks += 1
            error_kind = classify_llm_error(exc)
            error_kinds.append(error_kind)
            error_details.append(truncate_error_detail(f"{type(exc).__name__}: {exc}"))
            print(
                f"  chunk {chunk_index + 1}/{len(cut_chunks)} failed "
                f"[error_kind={error_kind}] ({type(exc).__name__}: {exc})"
            )
            # billing/auth はリトライ・続行が無意味なので残チャンクをスキップして即時失敗(改善21-A)。
            if error_kind in FATAL_LLM_ERROR_KINDS:
                remaining = len(cut_chunks) - chunk_index - 1
                if remaining > 0:
                    failed_chunks += remaining
                    print(f"  fatal error ({error_kind}) - skipping remaining {remaining} chunks")
                break

    if not successful_responses:
        print(f"  all {len(cut_chunks)} chunks failed - keeping BudouX output")
        result = _attach_usage({
            "enabled": False,
            "reason": f"api_error: all {len(cut_chunks)} chunks failed",
            "provider": resolved_provider,
            "model": resolved_model,
            "needs_review": [],
            "dismissed_finding_ids": [],
            "failed_chunks": failed_chunks,
            "error_kind": summarize_error_kinds(error_kinds),
            "error_detail": error_details[0] if error_details else "",
        })
        _write_result(output_file, result)
        print_usage_summary()
        return result

    response = merge_refine_responses(successful_responses)

    try:
        new_pages, stats = apply_refine_response(pages, response, max_chars_per_line, max_lines_per_page)
    except Exception as exc:  # noqa: BLE001
        print(
            f"  failed to apply {resolved_provider} response ({type(exc).__name__}: {exc}) "
            "- keeping BudouX output"
        )
        result = _attach_usage({
            "enabled": False,
            "reason": f"apply_error: {exc}",
            "provider": resolved_provider,
            "model": resolved_model,
            "needs_review": [],
            "dismissed_finding_ids": [],
        })
        _write_result(output_file, result)
        print_usage_summary()
        return result

    telop_file.write_text(render_telop(preamble, new_pages), encoding="utf-8")

    needs_review, dismissed_finding_ids = parse_refine_metadata(response)

    result: dict[str, Any] = {
        "enabled": True,
        "provider": resolved_provider,
        "model": resolved_model,
        "pages_before": len(pages),
        "pages_after": len(new_pages),
        "cuts_total": len(cuts_payload),
        "cuts_refined": stats["cuts_refined"],
        "corrections_applied": stats["corrections_applied"],
        "needs_review": needs_review,
        "dismissed_finding_ids": dismissed_finding_ids,
    }
    if failed_chunks > 0:
        result["failed_chunks"] = failed_chunks
        result["error_kind"] = summarize_error_kinds(error_kinds)
        if error_details:
            result["error_detail"] = error_details[0]
    _attach_usage(result)
    _write_result(output_file, result)
    print(
        f"  applied ({resolved_provider}/{resolved_model}): "
        f"{stats['cuts_refined']}/{len(cuts_payload)} cuts refined, "
        f"{len(pages)} -> {len(new_pages)} pages, "
        f"{stats['corrections_applied']} pages with dictionary corrections"
    )
    print_usage_summary()
    print(f"[Step 6b] Done: {output_file}")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Step 6b: AI Refine (LLM telop correction)")
    parser.add_argument("run_dir", help="runs/<run_name> へのパス")
    parser.add_argument("--stt", required=True, help="STT (stt_corrected.json 等) パス")
    parser.add_argument("--telop", default=None, help="telop.txt のパス (省略時 run_dir/telop.txt)")
    parser.add_argument("--output", default=None, help="refine結果JSONの出力先")
    parser.add_argument("--project", default=None, help="プロジェクトYAML (telop.max_chars_per_line等)")
    parser.add_argument(
        "--provider",
        default=os.environ.get("AI_REFINE_PROVIDER", "auto"),
        choices=["auto", "anthropic", "openai", "gemini"],
        help="LLMプロバイダ (auto=キー優先順 anthropic>openai>gemini)",
    )
    parser.add_argument("--model", default=None, help="モデル名 (省略時はプロバイダ既定+環境変数)")
    parser.add_argument("--review", default=None, help="telop_review.json パス (省略可)")
    parser.add_argument("--dictionary", default=None, help="domain_dictionary.yaml パス (省略可)")
    parser.add_argument("--title", default=None, help="動画タイトル(文脈ヒント)。省略時はrun名から復元")
    args = parser.parse_args()

    run_dir = Path(args.run_dir).resolve()
    output_path = Path(args.output) if args.output else run_dir / "step06b_ai_refine" / "refine.json"

    telop_cfg = {}
    if args.project:
        telop_cfg = load_project_config(args.project).get("telop", {})

    run_step(
        str(run_dir),
        args.stt,
        str(output_path),
        telop_path=args.telop,
        max_chars_per_line=telop_cfg.get("max_chars_per_line", 12),
        max_lines_per_page=telop_cfg.get("max_lines_per_page", 1),
        model=args.model,
        provider=args.provider,
        review_path=args.review,
        dictionary_path=args.dictionary,
        title=args.title,
    )


if __name__ == "__main__":
    main()
