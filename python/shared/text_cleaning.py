"""決定的テキストクリーニング (改善14-C)。

AI不要で常時適用するテロップ/シーンテキストの正規化。
telop_builder・step06b・UI側 telopTextNormalize と整合させる。
"""

from __future__ import annotations

import re

_FULLWIDTH_DIGIT = str.maketrans("０１２３４５６７８９", "0123456789")
_CONSECUTIVE_COMMA_RE = re.compile(r"、{2,}")
_CONSECUTIVE_FULLWIDTH_COMMA_RE = re.compile(r"，{2,}")
_TRAILING_COMMA_RE = re.compile(r"[、，]+$")
_QUESTION_EXCLAM_COMMA_RE = re.compile(r"([？！])[、，]+")
# 改善16-C: STTローマ字アーティファクト (かな/漢字直後の desu/masu)
_ROMAJI_DESU_RE = re.compile(r"([ぁ-んァ-ヶー一-龠])(desu)(?=$|[、。，．,.])", re.IGNORECASE)
_ROMAJI_MASU_RE = re.compile(r"([ぁ-んァ-ヶー一-龠])(masu)(?=$|[、。，．,.])", re.IGNORECASE)
# 改善17-B: 行末の読点+フィラー断片 (長い順にマッチ)
_TRAILING_FILLER_FRAGMENTS = ("まあ", "ま", "ね")
_TRAILING_COMMA_CHARS = "、，"


def normalize_romaji_stt_artifacts(text: str) -> str:
    """かな/漢字直後の desu/masu を保守的に です/ます へ正規化する。"""
    text = _ROMAJI_DESU_RE.sub(r"\1です", text)
    text = _ROMAJI_MASU_RE.sub(r"\1ます", text)
    return text


def normalize_fullwidth_digits(text: str) -> str:
    """全角数字を半角数字に変換する (例: ６月 → 6月)。"""
    return text.translate(_FULLWIDTH_DIGIT)


def clean_telop_commas(text: str) -> str:
    """連続読点を1個にし、末尾の読点(、，)を除去する。"""
    text = _CONSECUTIVE_COMMA_RE.sub("、", text)
    text = _CONSECUTIVE_FULLWIDTH_COMMA_RE.sub("，", text)
    text = _TRAILING_COMMA_RE.sub("", text)
    return text


def strip_trailing_filler_fragments(line: str) -> str:
    """行末の「、ね」「、ま」「、まあ」等のフィラー断片を除去する。"""
    for fragment in _TRAILING_FILLER_FRAGMENTS:
        for comma in _TRAILING_COMMA_CHARS:
            suffix = comma + fragment
            if line.endswith(suffix):
                return line[: -len(suffix)]
    return line


def clean_telop_line(line: str) -> str:
    """行単位: 「？、」「！、」を正規化し、行末フィラー・読点(、，)を除去する。"""
    line = _QUESTION_EXCLAM_COMMA_RE.sub(r"\1", line)
    line = strip_trailing_filler_fragments(line)
    line = _TRAILING_COMMA_RE.sub("", line)
    return line


def apply_deterministic_text_cleaning(text: str) -> str:
    """決定的クリーニングを一括適用する。"""
    text = normalize_fullwidth_digits(text)
    text = normalize_romaji_stt_artifacts(text)
    text = clean_telop_commas(text)
    return text
