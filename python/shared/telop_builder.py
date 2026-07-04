"""テロップ生成。

BudouX + DP で自然な改行 + 禁則処理。
「。」は表示テキストから除去する。「、」は行中のみ保持し、ページ先頭の句読点は禁止。
text_rules による正規化 (列挙数字変換、誤認識補正) を適用する。

Cat-Cut の字幕ページ生成で共通利用する。
"""

import re
from typing import Any, Dict, List, Optional

from shared.budoux_layout import split_pages
from shared.text_cleaning import apply_deterministic_text_cleaning, clean_telop_line


# 改善9-A-3: テロップ表示から除去する句読点 (「。」のみ)
_PERIOD_TO_REMOVE = re.compile(r"[。]")
# ページ先頭に置けない句読点
_PAGE_LEADING_FORBIDDEN = set("、。！？!?…")

# 漢数字→アラビア数字の列挙パターン
_KANJI_ENUM_PATTERNS = [
    (re.compile(r"一つ目"), "1つ目"),
    (re.compile(r"二つ目"), "2つ目"),
    (re.compile(r"三つ目"), "3つ目"),
    (re.compile(r"四つ目"), "4つ目"),
    (re.compile(r"五つ目"), "5つ目"),
    (re.compile(r"六つ目"), "6つ目"),
    (re.compile(r"七つ目"), "7つ目"),
    (re.compile(r"八つ目"), "8つ目"),
    (re.compile(r"九つ目"), "9つ目"),
    (re.compile(r"十つ目"), "10つ目"),
    (re.compile(r"一個目"), "1個目"),
    (re.compile(r"二個目"), "2個目"),
    (re.compile(r"三個目"), "3個目"),
    (re.compile(r"一番目"), "1番目"),
    (re.compile(r"二番目"), "2番目"),
    (re.compile(r"三番目"), "3番目"),
    # 「一つ」「二つ」(列挙の文脈)
    (re.compile(r"一つの"), "1つの"),
    (re.compile(r"二つの"), "2つの"),
    (re.compile(r"三つの"), "3つの"),
]


def build_telop_pages(
    transcript: str,
    cut_id: str,
    max_chars_per_line: int = 12,
    max_lines_per_page: int = 1,
    text_rules: Optional[Dict[str, Any]] = None,
    dp_overrides: Optional[Dict] = None,
) -> List[Dict[str, Any]]:
    """transcript を TelopPage[] に変換。

    Args:
        transcript: カットのトランスクリプト
        cut_id: カットID（ページIDのプレフィックスに使用）
        max_chars_per_line: 1行の最大文字数
        max_lines_per_page: 1ページの最大行数
        text_rules: テキスト正規化ルール (project config の text_rules セクション)
        dp_overrides: BudouX DPペナルティのオーバーライド (templates/*.yaml の dp セクション)

    Returns:
        TelopPage[] 互換の dict リスト
    """
    if not transcript.strip():
        return []

    cleaned_transcript = apply_deterministic_text_cleaning(transcript)

    raw_pages = split_pages(
        text=cleaned_transcript,
        max_chars_per_line=max_chars_per_line,
        max_lines_per_page=max_lines_per_page,
        dp_overrides=dp_overrides,
    )

    pages = []
    for i, raw in enumerate(raw_pages):
        # 改善9-A-3(a): 「。」のみ除去。「、」等は行中で保持する。
        cleaned_lines = [_remove_periods(line) for line in raw["lines"]]
        # text_rules による正規化
        if text_rules:
            cleaned_lines = [_normalize_text(line, text_rules) for line in cleaned_lines]
        # 改善15-C: BudouX分割後の行末読点を除去
        cleaned_lines = [clean_telop_line(line) for line in cleaned_lines]
        # 空行を除外
        cleaned_lines = [line for line in cleaned_lines if line.strip()]
        if not cleaned_lines:
            continue

        page = {
            "id": f"{cut_id}_p{i:02d}",
            "lines": cleaned_lines,
        }
        pages.append(page)

    pages = _fix_page_leading_punctuation(pages)
    return pages


def _remove_periods(text: str) -> str:
    """表示用テキストから句点「。」を除去。"""
    return _PERIOD_TO_REMOVE.sub("", text).strip()


def _fix_page_leading_punctuation(pages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """改善9-A-3(b)(c): ページ先頭の句読点を前ページ末尾へ送るか除去する。"""
    if not pages:
        return pages

    result: List[Dict[str, Any]] = []
    for page in pages:
        lines = list(page.get("lines", []))
        if not lines:
            result.append(page)
            continue

        while lines and lines[0]:
            ch = lines[0][0]
            if ch not in _PAGE_LEADING_FORBIDDEN:
                break
            if result and result[-1].get("lines"):
                prev_lines = result[-1]["lines"]
                prev_lines[-1] = prev_lines[-1] + ch
            lines[0] = lines[0][1:].lstrip()
            if not lines[0]:
                lines.pop(0)

        if lines:
            result.append({**page, "lines": lines})

    return result


def _normalize_text(text: str, text_rules: Dict[str, Any]) -> str:
    """text_rules に基づいてテキストを正規化。

    適用順序:
    1. 共通正規化 (normalize_numbers=true 時)
       - 漢数字→算用数字
       - 固有名詞の正式表記
    2. corrections (誤認識補正) - 個別の修正
    3. enumeration_style (列挙数字変換) - 漢数字→アラビア数字 (旧互換)
    """
    # 1. 共通正規化
    if text_rules.get("normalize_numbers", True):
        text = _normalize_kanji_numbers(text)
    if text_rules.get("normalize_proper_nouns", True):
        text = _normalize_proper_nouns(text)

    # 2. corrections: STT 誤認識の自動置換
    corrections = text_rules.get("corrections", {})
    for wrong, correct in corrections.items():
        text = text.replace(wrong, correct)

    # 3. enumeration_style: 列挙数字の変換 (旧互換)
    style = text_rules.get("enumeration_style", "as_is")
    if style == "arabic":
        for pattern, replacement in _KANJI_ENUM_PATTERNS:
            text = pattern.sub(replacement, text)

    return text


# ── 漢数字→算用数字 変換 ──────────────────────────────────

try:
    from kanjize import kanji2number as _kanji2number
    _HAS_KANJIZE = True
except ImportError:
    _HAS_KANJIZE = False

# 漢数字の文字セット
_KANJI_NUM_CHARS = "〇零一二三四五六七八九十百千万億兆"

# 助数詞リスト (漢数字の直後に来る文字列)
_COUNTER_SUFFIXES_STR = (
    "円|個|本|人|回|件|枚|台|匹|頭|冊|杯|"
    "度|時|分|秒|時間|日|週間|ヶ月|か月|カ月|年|月|"
    "点|パー|％|%|倍|問|"
    "パーセント|"
    "キロ|キロメートル|キログラム|グラム|メートル|センチ|ミリ|トン|"
    "フォロワー|名|社|店|"
    "ぐらい|くらい|以上|以下|以内|未満"
)

# 改善10-A: 漢数字→算用数字変換から保護する熟語・慣用表現
_KANJI_IDIOM_PROTECT = (
    "一人一人",
    "一人ひとり",
    "一番",
    "一緒",
    "一体",
    "一部",
    "一方",
    "第一に",
    "第一",
    "一応",
    "一旦",
    "一種",
    "一意",
    "一般",
    "一時期",
    "一時的",
    "一時間目",
    "三角",
    "十分",
    "万一",
    "三味線",
)

# 正規表現: 漢数字列 + 助数詞 を一括マッチ
_KANJI_NUM_PATTERN = re.compile(
    rf"([{_KANJI_NUM_CHARS}]+)({_COUNTER_SUFFIXES_STR})"
)


def _normalize_kanji_numbers(text: str) -> str:
    """テキスト中の漢数字+助数詞パターンを算用数字に変換。

    「三十八度」→「38度」、「五十六点」→「56点」、「三十パー」→「30パー」
    熟語・慣用表現（一人一人、一番 等）は除外リストで保護する。
    """
    if not _HAS_KANJIZE:
        return text

    placeholders: dict[str, str] = {}
    for i, idiom in enumerate(_KANJI_IDIOM_PROTECT):
        if idiom in text:
            key = f"__KANJI_IDIOM_{i}__"
            placeholders[key] = idiom
            text = text.replace(idiom, key)

    def _replace(m: re.Match) -> str:
        kanji_str = m.group(1)
        suffix = m.group(2)
        try:
            num = _kanji2number(kanji_str)
        except (ValueError, KeyError):
            return m.group(0)

        num_str = _format_number(num)
        return num_str + suffix

    text = _KANJI_NUM_PATTERN.sub(_replace, text)

    for key, idiom in placeholders.items():
        text = text.replace(key, idiom)

    return text


def _format_number(num: int) -> str:
    """数値を日本語表記に適したフォーマットにする。

    万/億/兆の単位は漢字で残す (「10000」ではなく「1万」)。
    1万未満はそのまま数字。1万以上はN万/N億表記。
    """
    if num >= 1_0000_0000_0000:  # 兆
        cho = num // 1_0000_0000_0000
        remainder = num % 1_0000_0000_0000
        if remainder == 0:
            return f"{cho}兆"
        oku = remainder // 1_0000_0000
        return f"{cho}兆{oku}億" if oku else f"{cho}兆"

    if num >= 1_0000_0000:  # 億
        oku = num // 1_0000_0000
        remainder = num % 1_0000_0000
        if remainder == 0:
            return f"{oku}億"
        man = remainder // 1_0000
        return f"{oku}億{man}万" if man else f"{oku}億"

    if num >= 1_0000:  # 万
        man = num // 1_0000
        remainder = num % 1_0000
        if remainder == 0:
            return f"{man}万"
        return f"{man}万{remainder}"

    return str(num)


# ── 固有名詞の正式表記 ──────────────────────────────────

_PROPER_NOUN_MAP = {
    "YOUTUBE": "YouTube",
    "Youtube": "YouTube",
    "youtube": "YouTube",
    "INSTAGRAM": "Instagram",
    "instagram": "Instagram",
    "TIKTOK": "TikTok",
    "Tiktok": "TikTok",
    "tiktok": "TikTok",
    "TWITTER": "X",
    "twitter": "X",
    "Twitter": "X",
    "LINE": "LINE",  # そのまま (正式)
}


def _normalize_proper_nouns(text: str) -> str:
    """固有名詞を正式表記に変換。"""
    for wrong, correct in _PROPER_NOUN_MAP.items():
        if wrong in text:
            text = text.replace(wrong, correct)
    return text


def build_voice_data(
    keep_segments: list,
    words: list,
    telop_pages_by_cut: dict,
    timing_rules: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """VoiceData を構築。word timingは秒単位 (Remotion Telop互換)。"""
    cuts = []

    for i, seg in enumerate(keep_segments):
        cut_id = f"cut_{i + 1:03d}"

        # この区間のwordsを抽出
        words_in_range = [
            w for w in words
            if w["end_ms"] > seg["start_ms"] and w["start_ms"] < seg["end_ms"]
        ]

        # word timingをカット相対時間に変換（秒単位）
        voice_words = []
        for w in words_in_range:
            voice_words.append({
                "text": w["text"],
                "start": max(0, (w["start_ms"] - seg["start_ms"])) / 1000.0,
                "end": max(0, (w["end_ms"] - seg["start_ms"])) / 1000.0,
            })

        # telopマッピング（「。」除去後のテキストでマッチング）
        pages = telop_pages_by_cut.get(cut_id, [])
        telops = _map_pages_to_telops(pages, voice_words, words_in_range)
        _apply_timing_rules(telops, voice_words, timing_rules or {})

        cuts.append({
            "id": cut_id,
            "narration": seg.get("text", ""),
            "voice": {
                "duration_ms": seg["end_ms"] - seg["start_ms"],
                "words": voice_words,
            },
            "telops": telops,
        })

    return {"version": "1.0", "cuts": cuts}


def _apply_timing_rules(telops: list, voice_words: list, timing_rules: Dict[str, Any]) -> None:
    """学習済みの表示タイミング補正を telop に明示 timing として付与する。"""
    if not telops or not voice_words:
        return
    offset_ms = int(timing_rules.get("telop_start_offset_ms", 0) or 0)
    if offset_ms == 0:
        return
    offset_s = offset_ms / 1000.0
    for telop in telops:
        indices = telop.get("word_indices", [])
        if not indices:
            continue
        first_idx = min(indices)
        last_idx = max(indices)
        if first_idx >= len(voice_words) or last_idx >= len(voice_words):
            continue
        start = max(0.0, float(voice_words[first_idx]["start"]) + offset_s)
        end = max(start + 0.1, float(voice_words[last_idx]["end"]) + offset_s)
        telop["start"] = round(start, 3)
        telop["end"] = round(end, 3)


def _map_pages_to_telops(
    pages: list,
    voice_words: list,
    words_in_range: list,
) -> list:
    """TelopPage[] を VoiceTelop[] にマッピング。

    「。」除去後のテロップテキストと、元テキスト（句読点あり）の
    word indices を対応付ける。
    """
    if not pages or not words_in_range:
        return []

    telops = []

    # 「。」のみ除去した元テキストでマッチング
    full_text_raw = "".join(w["text"] for w in words_in_range)
    full_text_clean = _remove_periods(full_text_raw)

    # 元テキストの文字位置 → word index マッピング
    char_to_word_idx: Dict[int, int] = {}
    char_pos = 0
    for wi, w in enumerate(words_in_range):
        for _ in w["text"]:
            char_to_word_idx[char_pos] = wi
            char_pos += 1

    # クリーンテキストの文字位置 → 元テキストの文字位置マッピング
    clean_to_raw: Dict[int, int] = {}
    clean_pos = 0
    for raw_pos, ch in enumerate(full_text_raw):
        if not _PERIOD_TO_REMOVE.match(ch):
            clean_to_raw[clean_pos] = raw_pos
            clean_pos += 1

    page_clean_offset = 0
    for page in pages:
        page_text = "".join(page["lines"])
        page_len = len(page_text)

        # クリーンテキスト内での位置を探す
        match_pos = full_text_clean.find(page_text, page_clean_offset)
        if match_pos == -1:
            match_pos = page_clean_offset

        # word indices を特定（クリーン → raw → word_idx）
        word_indices = set()
        for ci in range(match_pos, min(match_pos + page_len, len(full_text_clean))):
            raw_pos = clean_to_raw.get(ci)
            if raw_pos is not None and raw_pos in char_to_word_idx:
                word_indices.add(char_to_word_idx[raw_pos])

        sorted_indices = sorted(word_indices)

        # segments（行単位）
        segments = []
        line_clean_offset = match_pos
        for line_text in page["lines"]:
            line_len = len(line_text)
            line_word_indices = set()
            for ci in range(line_clean_offset, min(line_clean_offset + line_len, len(full_text_clean))):
                raw_pos = clean_to_raw.get(ci)
                if raw_pos is not None and raw_pos in char_to_word_idx:
                    line_word_indices.add(char_to_word_idx[raw_pos])
            segments.append({
                "text": line_text,
                "word_indices": sorted(line_word_indices),
            })
            line_clean_offset += line_len

        telops.append({
            "id": page["id"],
            "text": page_text,
            "word_indices": sorted_indices,
            "segments": segments,
        })

        page_clean_offset = match_pos + page_len

    return telops
