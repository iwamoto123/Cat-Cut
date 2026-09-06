"""テロップ生成。

BudouX + DP で自然な改行 + 禁則処理。
「。」は表示テキストから除去する。「、」は行中のみ保持し、ページ先頭の句読点は禁止。
text_rules による正規化 (列挙数字変換、誤認識補正) を適用する。

Cat-Cut の字幕ページ生成で共通利用する。
"""

import difflib
import re
from typing import Any, Dict, List, Optional, Tuple

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
        # text_rules による正規化。text_rules 未設定(学習ルール無し)の run でも
        # 漢数字の算用化・固有名詞の正式表記は常に適用する(2026-07-06: 「五割」「一万回」等が
        # 学習ルールの無い run でそのまま残るバグの修正。normalize_* の既定はTrue)
        cleaned_lines = [_normalize_text(line, text_rules or {}) for line in cleaned_lines]
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
    "点|パー|％|%|倍|問|割|語|周|ミス|"
    "パーセント|"
    "キロ|キロメートル|キログラム|グラム|メートル|メーター|センチ|ミリ|トン|"
    "ヘルツ|ボルト|アンペア|ワット|リットル|"
    "フォロワー|名|社|店|アポ|"
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
    "万全",
    "万歳",
    "万能",
    "億劫",
    "三味線",
    "一語一語",
    "八百屋",
    "八百長",
    "何百",
    "何千",
)

# 正規表現: 漢数字列 + 助数詞 を一括マッチ
# 改善20-C: 「数百万円」「何十人」のような概数（数/何 始まり）は漢数字のまま残すため、
# 漢数字列の直前が 数/何（および漢数字の途中からのマッチ）にならないようにする。
_KANJI_NUM_PATTERN = re.compile(
    rf"(?<![数何{_KANJI_NUM_CHARS}])([{_KANJI_NUM_CHARS}]+)({_COUNTER_SUFFIXES_STR})"
)

# 改善19-D: 助数詞なし単独漢数字 (百/千/万/億いずれかの単位を含む2文字以上)
# 改善20-C: 数/何 始まりの概数は対象外。
_STANDALONE_KANJI_NUM_PATTERN = re.compile(
    rf"(?<![数何{_KANJI_NUM_CHARS}])([{_KANJI_NUM_CHARS}]{{2,}})(?![{_KANJI_NUM_CHARS}])"
)

# 改善20-C: 単独漢数字の変換対象とする単位文字（万・億は単位として残し前の数を算用化する）
_STANDALONE_UNIT_CHARS = ("百", "千", "万", "億")

# 改善22-C: 並列漢数字（「二、3件」「二 30社」）の前半用の単純な漢数字→算用数字マップ
_PARALLEL_KANJI_DIGIT = {
    "一": "1", "二": "2", "三": "3", "四": "4", "五": "5",
    "六": "6", "七": "7", "八": "8", "九": "9",
}

# 改善22-C: 漢数字1〜9 ＋ 読点orスペース ＋ 算用数字 ＋ 助数詞 の並列パターン。
# 「一、しかし…」のような列挙読点と誤爆しないよう、直後が算用数字＋助数詞の場合のみ変換する。
# 助数詞付き変換の後段で適用するため、後半は算用化済み（「二、三件」→「二、3件」→ここで前半を変換）。
_PARALLEL_KANJI_NUM_PATTERN = re.compile(
    rf"(?<![数何{_KANJI_NUM_CHARS}])([一二三四五六七八九])[、,\s　]+(\d[\d万億兆]*(?:{_COUNTER_SUFFIXES_STR}))"
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

    def _replace_standalone(m: re.Match) -> str:
        kanji_str = m.group(1)
        if not any(unit in kanji_str for unit in _STANDALONE_UNIT_CHARS):
            return m.group(0)
        try:
            num = _kanji2number(kanji_str)
        except (ValueError, KeyError):
            return m.group(0)
        return _format_number(num)

    text = _STANDALONE_KANJI_NUM_PATTERN.sub(_replace_standalone, text)

    # 改善22-C: 並列漢数字の前半を算用化（「二、3件」→「2、3件」。区切りは読点に正規化）
    text = _PARALLEL_KANJI_NUM_PATTERN.sub(
        lambda m: _PARALLEL_KANJI_DIGIT[m.group(1)] + "、" + m.group(2), text
    )

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
    # 改善22-B: 汎用サービス名のカナ表記→正式表記 (ニッチな固有社名は入れない)
    "ユーチューブ": "YouTube",
    "インスタグラム": "Instagram",
    "ツイッター": "X",
    "フェイスブック": "Facebook",
    "リンクトイン": "LinkedIn",
    "リンクドイン": "LinkedIn",
    "ティックトック": "TikTok",
}


def _normalize_proper_nouns(text: str) -> str:
    """固有名詞を正式表記に変換。"""
    for wrong, correct in _PROPER_NOUN_MAP.items():
        if wrong in text:
            text = text.replace(wrong, correct)
    return text


def normalize_directed_display_text(text: str) -> str:
    """directed テロップ文言の共通正規化(フェーズV8-4)。

    fullモードの build_telop_pages が常時適用している _normalize_text
    (漢数字→算用数字・固有名詞の正式表記)を、directed 経路の表示文言にも
    かけるための公開ヘルパー。手動改行("\\n")は行の意図(V7)なので、
    行ごとに正規化して改行位置を壊さない。
    """
    return "\n".join(_normalize_text(line, {}) for line in str(text or "").split("\n"))


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

        # 改善22-A: 完全一致 find の誤マッチ（後方の同一テキストへの飛び）を検査し、
        # 先頭文字欠け・ファジーマッチのフォールバック付きで位置を推定する
        match_pos, match_len = _find_page_position(full_text_clean, page_text, page_clean_offset)

        # word indices を特定（クリーン → raw → word_idx）
        word_indices = set()
        for ci in range(match_pos, min(match_pos + match_len, len(full_text_clean))):
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

        page_clean_offset = match_pos + match_len

    return telops


def _find_page_position(full_text_clean: str, page_text: str, offset: int) -> Tuple[int, int]:
    """クリーンテキスト内でのページ位置を推定する (改善22-A)。

    keep_segment のカット境界で先頭文字が欠けたwords列に対して、
    `find()` の完全一致が後方の同一テキストに誤マッチすると、
    後続ページの word_indices が連鎖的にズレる。
    完全一致の飛び幅検査 + 先頭削りの部分一致 + difflib による近傍ファジーマッチで
    単調前進（offset 以上）を保ちながら位置を復元する。

    Returns:
        (match_pos, match_len): クリーンテキスト内の開始位置と一致長
    """
    page_len = len(page_text)
    # 期待位置からの許容飛び幅。これを超える一致は後方への誤マッチを疑う
    max_jump = max(page_len * 2, 20)

    # 1. 完全一致 (飛び幅検査つき)
    match_pos = full_text_clean.find(page_text, offset)
    if match_pos != -1 and match_pos - offset <= max_jump:
        return match_pos, page_len

    # 2a. ページ先頭の1〜2文字を削った部分文字列で再探索 (カット境界の先頭文字欠け対策)
    for strip in (1, 2):
        sub = page_text[strip:]
        if len(sub) < 2:
            break
        pos = full_text_clean.find(sub, offset)
        if pos != -1 and pos - offset <= max_jump:
            return pos, len(sub)

    # 2b. difflib による offset 近傍のファジーマッチ
    window_end = min(len(full_text_clean), offset + page_len + max_jump)
    window = full_text_clean[offset:window_end]
    if window:
        matcher = difflib.SequenceMatcher(None, page_text, window, autojunk=False)
        best = matcher.find_longest_match(0, page_len, 0, len(window))
        # ページの半分以上が連続一致した場合のみ採用
        if best.size >= max(2, page_len // 2):
            # ページ内の一致開始位置ぶん手前に補正しつつ、後戻りは禁止
            pos = max(offset, offset + best.b - best.a)
            return pos, page_len

    # 3. 最後の手段: 従来どおり期待位置に置く
    return offset, page_len
