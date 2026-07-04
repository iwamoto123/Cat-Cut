"""BudouX-based layout for natural line and page breaks.

縦型/横型の両方に対応 (orientation パラメータで切替).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Set, Tuple

from budoux import load_default_japanese_parser

from shared.kinsoku import break_quality, build_kinsoku_sets, kinsoku_penalty, page_end_quality
from shared.textwidth import glyph_length, score_balance


@dataclass
class Token:
    """トークン（BudouXによる分かち書き単位）."""

    text: str
    start: int
    end: int


def split_pages(
    text: str,
    max_chars_per_line: int = 12,
    max_lines_per_page: int = 1,
    forbidden_spans: Optional[List[Tuple[int, int]]] = None,
    dp_overrides: Optional[Dict] = None,
) -> List[Dict]:
    """テキストをページに分割（BudouX + DP + 禁則処理）.

    Args:
        text: 分割するテキスト
        max_chars_per_line: 1行あたりの最大文字数
        max_lines_per_page: 1ページあたりの最大行数
        forbidden_spans: 分割禁止範囲 [(start, end), ...]
        dp_overrides: DPペナルティのオーバーライド (templates/*.yaml の dp セクション)

    Returns:
        List[Dict]: ページ情報
            [
                {
                    "lines": ["動画編集の副業で", "月10万円"],
                    "startCharIndex": 0,
                    "endCharIndex": 14
                }
            ]
    """
    if not text.strip():
        return []

    parser = load_default_japanese_parser()
    forbidden_spans = forbidden_spans or []
    dp_overrides = dp_overrides or {}

    # デフォルト: 縦型ショート向けペナルティ
    penalties = {
        "rag": 1.0,
        "widow": dp_overrides.get("widow", 2.5),
        "break_quality": 1.0,
        "kinsoku": dp_overrides.get("kinsoku", 15.0),
        "anchor_bonus": dp_overrides.get("anchor_bonus", 2.0),
        "protected_break": 2.0,
        "page_balance": 1.0,
        "page_qty": 0.5,
        "page_lone": dp_overrides.get("page_lone", 3.0),
        "page_end": dp_overrides.get("page_end", 1.5),
    }
    limits = {
        "line_max_ratio": dp_overrides.get("line_max_ratio", 1.4),
        "page_max_ratio": dp_overrides.get("page_max_ratio", 1.4),
    }

    layout_cfg = {
        "target_line": float(max_chars_per_line),
        "target_page": float(max_chars_per_line * max_lines_per_page),
        "max_lines": max_lines_per_page,
        "width_mode": "cpl",
        "weights": None,
        "kinsoku": {},
        "penalties": penalties,
        "limits": limits,
    }

    kinsoku_sets = build_kinsoku_sets(layout_cfg.get("kinsoku"))

    # 句読点位置を記録（アンカーポイント）
    strong_anchors, weak_anchors = _find_anchor_indices(text)

    # Step 1: トークン化（BudouX）
    tokens = _tokenize_with_spans(parser, text)

    # Step 2: 行分割（DP）
    lines = _layout_lines(
        tokens=tokens,
        layout_cfg=layout_cfg,
        strong_anchors=strong_anchors,
        weak_anchors=weak_anchors,
        protected_indices=set(),
        forbidden_spans=forbidden_spans,
        kinsoku_sets=kinsoku_sets,
    )

    # Step 3: ページ分割（DP）
    pages = _layout_pages(
        lines=lines,
        layout_cfg=layout_cfg,
        full_text=text,
        forbidden_spans=forbidden_spans,
        kinsoku_sets=kinsoku_sets,
    )

    return pages


def _find_anchor_indices(text: str) -> Tuple[Set[int], Set[int]]:
    """句読点の位置を特定（2段階アンカー）.

    Args:
        text: 元テキスト

    Returns:
        (strong, weak):
            strong: 「。！？」の位置（ほぼ強制改行）
            weak: 「、」の位置（優先改行）
    """
    strong = set()
    weak = set()
    for i, char in enumerate(text):
        if char in "。！？":
            strong.add(i)
        elif char in "、":
            weak.add(i)
    return strong, weak


def _tokenize_with_spans(parser, text: str) -> List[Token]:
    """BudouXでトークン化.

    Args:
        parser: BudouXパーサー
        text: 元テキスト

    Returns:
        List[Token]: トークンリスト
    """
    tokens = []
    if not text:
        return tokens

    spans = parser.parse(text)
    if not spans:
        spans = list(text)

    idx = 0
    for item in spans:
        length = len(item)
        tokens.append(Token(text=item, start=idx, end=idx + length))
        idx += length
    return tokens


def _is_in_forbidden_span(idx: int, forbidden_spans: List[Tuple[int, int]]) -> bool:
    """インデックスが分割禁止範囲の内部にあるかチェック.

    Args:
        idx: チェックする文字インデックス
        forbidden_spans: 分割禁止範囲のリスト

    Returns:
        bool: True if splitting at idx would break a forbidden span
    """
    for start, end in forbidden_spans:
        if start <= idx < end - 1:
            return True
    return False


def _layout_lines(
    tokens: Sequence[Token],
    layout_cfg: Dict,
    strong_anchors: Set[int],
    weak_anchors: Set[int],
    protected_indices: Set[int],
    forbidden_spans: List[Tuple[int, int]],
    kinsoku_sets: Dict[str, Set[str]],
) -> List[Dict]:
    """行分割を決定するDP.

    Args:
        tokens: トークンリスト
        layout_cfg: レイアウト設定
        strong_anchors: 「。！？」位置（ほぼ強制改行）
        weak_anchors: 「、」位置（優先改行）
        protected_indices: 保護境界
        forbidden_spans: 分割禁止範囲
        kinsoku_sets: 禁則処理設定

    Returns:
        List[Dict]: 行情報
    """
    if not tokens:
        return []

    target_width = max(float(layout_cfg["target_line"]), 1.0)
    width_mode = layout_cfg["width_mode"]
    weight_table = layout_cfg.get("weights")
    penalties = layout_cfg["penalties"]
    limits = layout_cfg["limits"]

    w_rag = penalties["rag"]
    w_widow = penalties["widow"]
    w_break = penalties["break_quality"]
    w_kinsoku = penalties["kinsoku"]
    w_anchor = penalties.get("anchor_bonus", 0.0)
    w_protected = penalties.get("protected_break", 0.0)
    max_ratio = limits["line_max_ratio"]

    n = len(tokens)
    dp = [float("inf")] * (n + 1)
    next_break = [-1] * (n + 1)
    dp[n] = 0.0

    for i in range(n - 1, -1, -1):
        width = 0.0
        text_acc = ""
        last_token = None
        for j in range(i + 1, n + 1):
            tok = tokens[j - 1]
            text_acc += tok.text
            width += glyph_length(tok.text, width_mode, weight_table)

            if width > target_width * max_ratio:
                break

            boundary_char_idx = max(tokens[j - 1].end - 1, 0) if j - 1 < len(tokens) else tokens[-1].end - 1

            # 分割禁止範囲内での分割は禁止
            if _is_in_forbidden_span(boundary_char_idx, forbidden_spans):
                last_token = tok
                continue

            penalty = w_rag * score_balance(width, target_width)

            if last_token is not None:
                prev_last = last_token.text[-1] if last_token.text else ""
                next_first = tok.text[0] if tok.text else ""
                penalty += w_kinsoku * kinsoku_penalty(prev_last, next_first, kinsoku_sets)
                penalty += w_break * break_quality(prev_last, next_first, kinsoku_sets)

            if width < target_width * 0.35:
                penalty += w_widow

            # 句読点位置での改行を優遇（2段階）
            if boundary_char_idx in strong_anchors:
                penalty -= 10.0  # 「。！？」: ほぼ強制改行
            elif boundary_char_idx in weak_anchors:
                penalty -= w_anchor  # 「、」: 優先改行（既存値 2.0）
            elif boundary_char_idx in protected_indices:
                penalty += w_protected

            cost = penalty + dp[j]
            if cost < dp[i]:
                dp[i] = cost
                next_break[i] = j
            last_token = tok

    lines: List[Dict] = []
    index = 0
    while index < n:
        j = next_break[index]
        if j == -1 or j <= index:
            j = index + 1
        segment = tokens[index:j]
        line_text = "".join(t.text for t in segment)
        lines.append(
            {
                "text": line_text,
                "start": segment[0].start,
                "end": segment[-1].end,
                "width": glyph_length(line_text, width_mode, weight_table),
                "end_anchor": (segment[-1].end - 1) in strong_anchors or (segment[-1].end - 1) in weak_anchors,
            }
        )
        index = j

    return lines


def _layout_pages(
    lines: Sequence[Dict],
    layout_cfg: Dict,
    full_text: str,
    forbidden_spans: List[Tuple[int, int]],
    kinsoku_sets: Dict[str, Set[str]],
) -> List[Dict]:
    """ページ分割を決定するDP.

    Args:
        lines: 行情報
        layout_cfg: レイアウト設定
        full_text: 元テキスト
        forbidden_spans: 分割禁止範囲
        kinsoku_sets: 禁則処理設定

    Returns:
        List[Dict]: ページ情報
    """
    if not lines:
        return []

    max_lines = max(1, int(layout_cfg["max_lines"]))
    target_width = max(float(layout_cfg["target_page"]), 1.0)
    penalties = layout_cfg["penalties"]
    limits = layout_cfg["limits"]
    max_ratio = limits["page_max_ratio"]

    n = len(lines)
    dp = [float("inf")] * (n + 1)
    choice = [-1] * (n + 1)
    meta: Dict[int, Dict[str, float]] = {}
    dp[n] = 0.0

    for i in range(n - 1, -1, -1):
        for j in range(i + 1, min(n, i + max_lines) + 1):
            # Check if page boundary falls inside a forbidden span
            if j < n:
                page_boundary_char = lines[j - 1]["end"] - 1
                if _is_in_forbidden_span(page_boundary_char, forbidden_spans):
                    continue

            chunk = lines[i:j]
            total_width = sum(entry["width"] for entry in chunk)
            if total_width > target_width * max_ratio:
                continue

            balance_cost = 0.0
            if len(chunk) > 1:
                avg_width = total_width / len(chunk)
                balance_cost = sum(abs(entry["width"] - avg_width) for entry in chunk)
                balance_cost /= max(target_width, 1e-6)
            balance_cost *= penalties["page_balance"]

            qty_cost = ((total_width - target_width) / max(target_width, 1e-6)) ** 2
            qty_cost *= penalties["page_qty"]

            lone_cost = penalties["page_lone"] if len(chunk) == 1 and j < n else 0.0

            last_char = _char_at(full_text, chunk[-1]["end"] - 1)
            next_first = _char_at(full_text, lines[j]["start"]) if j < n else None
            end_cost = penalties["page_end"] * page_end_quality(last_char, next_first, kinsoku_sets)
            if chunk[-1].get("end_anchor"):
                end_cost *= 0.5

            cost = balance_cost + qty_cost + lone_cost + end_cost + dp[j]
            if cost < dp[i]:
                dp[i] = cost
                choice[i] = j
                meta[i] = {
                    "balance_cost": balance_cost,
                    "qty_cost": qty_cost,
                    "lone_cost": lone_cost,
                    "end_cost": end_cost,
                    "total_width": total_width,
                }

    pages: List[Dict] = []
    idx = 0
    while idx < n:
        j = choice[idx]
        if j == -1 or j <= idx:
            j = min(n, idx + max_lines)
        chunk = lines[idx:j]
        stats = meta.get(
            idx,
            {
                "balance_cost": 0.0,
                "qty_cost": 0.0,
                "lone_cost": 0.0,
                "end_cost": 0.0,
                "total_width": sum(entry["width"] for entry in chunk),
            },
        )
        pages.append(
            {
                "lines": [entry["text"] for entry in chunk],
                "startCharIndex": chunk[0]["start"],
                "endCharIndex": chunk[-1]["end"],
                "stats": stats,
            }
        )
        idx = j

    return pages


def _char_at(text: str, index: int) -> str | None:
    """指定インデックスの文字を取得.

    Args:
        text: テキスト
        index: インデックス

    Returns:
        str | None: 文字（範囲外ならNone）
    """
    if index < 0 or index >= len(text):
        return None
    return text[index]
