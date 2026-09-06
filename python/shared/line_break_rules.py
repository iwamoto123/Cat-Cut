"""テロップ改行位置の付属語ルール（行頭に助詞・助動詞を置かない）.

日本語テロップの改行は文節の切れ目（助詞・助動詞の直後）で行うのが自然で、
「名詞 + 助詞」「名詞 + して」のように付属語が続く箇所で切ると読みづらくなる。

    NG: 共通テスト模試 / を受けられると思う
    OK: 共通テスト模試を / 受けられると思う

    NG: 国語担当 / していまして
    OK: 国語担当していまして

このモジュールは「改行直後のテキストが付属語で始まるか」を決定的に判定する
（形態素解析器は使わない）。BudouX の行DP・AI文言のサニタイズ・
TypeScript 側の折返し（desktop/src/lib/telopLineBreak.ts）が同じ規則を共有する。
"""

from __future__ import annotations

from typing import List, Tuple

# 行頭に置くと不自然な付属語（長いものから順に一致させる）。
# 「できるだけ」「まず」等の自立語として使われ得る語は入れない（過剰検出でDPの
# 選択肢を潰さないため）。
_DEPENDENT_PREFIXES: Tuple[str, ...] = (
    # 複合格助詞・連語
    "について",
    "によって",
    "における",
    "において",
    "に対して",
    "とともに",
    "として",
    "による",
    # 引用・体言化
    "っていう",
    "という",
    "といった",
    "といって",
    "とゆう",
    "って",
    # 接続助詞・理由
    "なんです",
    "なので",
    "なのか",
    "んです",
    "んじゃ",
    "ので",
    "のに",
    "んで",
    "んだ",
    "から",
    "けれど",
    "けど",
    "ながら",
    "つつ",
    # 助動詞・丁寧形
    "でした",
    "ました",
    "ましょう",
    "ません",
    "まして",
    "です",
    "ます",
    "だった",
    # 補助動詞（サ変・受身・使役・「〜ていう」「〜ている」）
    "している",
    "してる",
    "しない",
    "します",
    "して",
    "した",
    "される",
    "され",
    "させ",
    "せて",
    "いました",
    "います",
    "いない",
    "いう",
    "いる",
    "いて",
    "いた",
    "しまっ",
    "しまう",
    # W26: 「〜てきた」「〜てきて」等の補助動詞と依頼の「ください」
    # (「送り出して / きた塾の講師なら」「お申し込み / ください」の分断を防ぐ)
    "きました",
    "きます",
    "きた",
    "きて",
    "ください",
    # 形式名詞
    "ところ",
    "つもり",
    "こと",
    "もの",
    "とき",
    "わけ",
    "はず",
    "ため",
    "まま",
    "ほう",
    "ほど",
    # 副助詞・並立助詞
    "ばかり",
    "くらい",
    "ぐらい",
    "なんて",
    "とか",
    "など",
    "だけ",
    "しか",
    "まで",
    "より",
    "ずつ",
    # 助詞の連続
    "では",
    "には",
    "にも",
    "でも",
    "とは",
    "とも",
    "との",
)

# 単独で行頭に来ると不自然な1文字助詞。
_SINGLE_PARTICLES = frozenset("はがをにでともへやのかねよばさぞ")

# 直前がこれらで終わる場合は文・節が閉じているため、行頭が付属語でも不自然にならない。
_CLOSING_CHARS = frozenset("。、．，！？!?…‥」』）)】〉》")


def _is_hiragana(ch: str) -> bool:
    return "ぁ" <= ch <= "ん" or ch == "ー"


def dependent_head_length(text: str) -> int:
    """text の先頭にある付属語の長さを返す（付属語で始まらないなら0）."""
    if not text:
        return 0
    for prefix in _DEPENDENT_PREFIXES:
        if text.startswith(prefix):
            return len(prefix)
    head = text[0]
    if head in _SINGLE_PARTICLES:
        # 「を」は語頭に立たないので常に助詞。他の1文字はひらがなが続く場合
        # 「がんばる」「はい」等の自立語の可能性があるため助詞と見なさない。
        if head == "を" or len(text) == 1 or not _is_hiragana(text[1]):
            return 1
    return 0


def is_dependent_line_head(text: str) -> bool:
    """text（改行直後のテキスト）が付属語で始まるか."""
    return dependent_head_length(text) > 0


def is_bad_break(before: str, after: str) -> bool:
    """before / after の間で改行するのが不自然か（付属語が行頭に来るか）."""
    if not before or not after:
        return False
    if before[-1] in _CLOSING_CHARS:
        return False
    return is_dependent_line_head(after)


def has_bad_line_break(lines: List[str]) -> bool:
    """複数行のうち1つでも付属語始まりの行があるか."""
    for index in range(1, len(lines)):
        before = "".join(lines[:index])
        if is_bad_break(before, lines[index]):
            return True
    return False


def bad_break_positions(text: str) -> List[int]:
    """text 内の「その位置で改行すると不自然」な文字インデックスを列挙する.

    位置 p は「text[p-1] と text[p] の間で改行する」ことを意味する。
    """
    positions: List[int] = []
    for pos in range(1, len(text)):
        if is_bad_break(text[:pos], text[pos:]):
            positions.append(pos)
    return positions


def dependent_break_penalty(before: str, after: str, weight: float = 1.0) -> float:
    """改行位置の付属語ペナルティ（行DP用）.

    禁止ではなくペナルティにするのは、全候補が禁止になった場合にDPが実行不能へ
    退化するのを避けるため（改善20-Aと同じ理由）。
    """
    return weight if is_bad_break(before, after) else 0.0


def repair_line_breaks(text: str) -> str:
    """付属語が行頭に来る改行だけを取り除く（自然な改行は残す）.

    改行が全て解消された場合は1行になるので、呼び出し側の自動折返しに委ねる。
    """
    lines = [line.strip() for line in (text or "").split("\n") if line.strip()]
    if len(lines) < 2:
        return text
    merged: List[str] = [lines[0]]
    for line in lines[1:]:
        if is_bad_break(merged[-1], line):
            merged[-1] += line
        else:
            merged.append(line)
    return "\n".join(merged)
