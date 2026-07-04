"""Text width estimation helpers."""

from __future__ import annotations

from typing import Dict


DEFAULT_WEIGHTS: Dict[str, float] = {
    "ascii_alnum": 0.55,
    "ascii_space": 0.30,
    "ascii_punct": 0.50,
    "cjk_punct": 0.50,
    "small_kana": 0.85,
    "long_dash": 0.90,
    "default": 1.00,
}


def glyph_length(text: str, mode: str, weights: Dict[str, float] | None = None) -> float:
    weight_table = weights or DEFAULT_WEIGHTS
    if mode == "weighted_cpl":
        return sum(weight_table.get(_classify(ch), weight_table["default"]) for ch in text)
    if mode == "cpl":
        return float(len(text))
    raise ValueError(f"Unsupported width mode: {mode}")


def _classify(ch: str) -> str:
    if ch == " ":
        return "ascii_space"
    if "0" <= ch <= "9" or "A" <= ch <= "Z" or "a" <= ch <= "z":
        return "ascii_alnum"
    code = ord(ch)
    if 0x3000 <= code <= 0x303F:
        return "cjk_punct"
    if ch in {"ー", "―"}:
        return "long_dash"
    if ch in {"ぁ", "ぃ", "ぅ", "ぇ", "ぉ", "ゃ", "ゅ", "ょ"}:
        return "small_kana"
    if ch in {"!", "?", ",", ".", "-", "'", '"'}:
        return "ascii_punct"
    return "default"


def score_balance(current_width: float, target_width: float) -> float:
    if target_width <= 0:
        return 0.0
    ratio = current_width / target_width
    return (1.0 - ratio) ** 2


def score_quantity(lines: int, max_lines: int) -> float:
    if max_lines <= 0:
        return 0.0
    return max(0, lines - max_lines)


