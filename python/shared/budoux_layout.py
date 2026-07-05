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

    # 改善20-B: 行バジェットを超える単一チャンクは自然な位置（助詞直後・文字種境界）で
    # 事前分割する。超過トークンが残ると行DPが実行不能(dp=inf)になり、そのトークンより
    # 前の全域が「1トークン=1行」に退化するため（改善20-Aの根本原因）。
    tokens = _split_oversized_tokens(
        tokens,
        budget=float(max_chars_per_line),
        width_mode=layout_cfg["width_mode"],
        weights=layout_cfg["weights"],
        forbidden_spans=forbidden_spans,
        kinsoku_sets=kinsoku_sets,
    )

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


# 改善20-B: 超過チャンク分割で「直後で切ってよい」助詞
_SPLIT_AFTER_PARTICLES = set("かのとやもでにはを")


def _is_ascii_alnum(ch: str) -> bool:
    """半角英数字か（英数字連の途中では分割しない判定に使う）."""
    return ("0" <= ch <= "9") or ("A" <= ch <= "Z") or ("a" <= ch <= "z")


def _char_class(ch: str) -> str:
    """分割候補の文字種境界判定用の粗い文字クラス."""
    if _is_ascii_alnum(ch):
        return "alnum"
    code = ord(ch)
    if 0x3040 <= code <= 0x309F:
        return "hiragana"
    if 0x30A0 <= code <= 0x30FF or ch == "ー":
        return "katakana"
    if 0x4E00 <= code <= 0x9FFF or 0x3400 <= code <= 0x4DBF:
        return "kanji"
    return "other"


def _split_cost_at(text: str, idx: int, kinsoku_sets: Dict[str, Set[str]]) -> Optional[float]:
    """超過チャンク内の位置 idx（この直前で改行）の分割コストを返す.

    Returns:
        None: 分割禁止（禁則・英数字連の内部）
        float: 分割コスト（小さいほど自然な位置）
    """
    prev_ch = text[idx - 1]
    next_ch = text[idx]

    # 禁則: 行頭禁止文字の直前・行末禁止文字（開き括弧等）の直後では切らない
    if next_ch in kinsoku_sets["head"] or prev_ch in kinsoku_sets["tail"]:
        return None
    # 英数字連（LinkedIn / YouTube 等）の内部では切らない
    if _is_ascii_alnum(prev_ch) and _is_ascii_alnum(next_ch):
        return None

    # 助詞の直後（かな→次語）が最も自然。ただし次の文字も助詞になり得る文字なら
    # 助詞連続（「なのか」等）の途中の可能性が高いので通常境界として扱う。
    if prev_ch in _SPLIT_AFTER_PARTICLES and next_ch not in _SPLIT_AFTER_PARTICLES:
        return 0.2
    # 英数字連の切れ目（かな↔英数字）
    prev_class = _char_class(prev_ch)
    next_class = _char_class(next_ch)
    if prev_class == "alnum" or next_class == "alnum":
        return 0.3
    # その他の文字種境界（かな↔漢字等）
    if prev_class != next_class:
        return 0.6
    # 同一文字種の途中（最後の手段）
    return 2.0


def _split_oversized_tokens(
    tokens: List[Token],
    budget: float,
    width_mode: str,
    weights: Optional[Dict[str, float]],
    forbidden_spans: List[Tuple[int, int]],
    kinsoku_sets: Dict[str, Set[str]],
) -> List[Token]:
    """行バジェットを超えるトークンを自然な位置で複数トークンに事前分割する.

    分割位置は助詞直後・文字種境界を優先し、各ピースがバジェット以内に収まるよう
    小さなDPでコスト最小の分割を選ぶ。分割禁止範囲(forbidden_spans)の内部では切らない。
    """
    result: List[Token] = []
    for token in tokens:
        if glyph_length(token.text, width_mode, weights) <= budget:
            result.append(token)
            continue
        result.extend(
            _split_one_token(token, budget, width_mode, weights, forbidden_spans, kinsoku_sets)
        )
    return result


def _split_one_token(
    token: Token,
    budget: float,
    width_mode: str,
    weights: Optional[Dict[str, float]],
    forbidden_spans: List[Tuple[int, int]],
    kinsoku_sets: Dict[str, Set[str]],
) -> List[Token]:
    """単一の超過トークンをバジェット以内のピース列に分割するDP."""
    text = token.text
    n = len(text)

    # 各文字境界（ピース内位置 1..n-1）の分割コスト。None は分割禁止。
    costs: List[Optional[float]] = [None] * (n + 1)
    for idx in range(1, n):
        if _is_in_forbidden_span(token.start + idx - 1, forbidden_spans):
            continue
        costs[idx] = _split_cost_at(text, idx, kinsoku_sets)

    # dp[i]: text[i:] を分割する最小コスト
    inf = float("inf")
    dp = [inf] * (n + 1)
    nxt = [-1] * (n + 1)
    dp[n] = 0.0
    for i in range(n - 1, -1, -1):
        width = 0.0
        for j in range(i + 1, n + 1):
            width += glyph_length(text[j - 1], width_mode, weights)
            if width > budget and j > i + 1:
                break
            split_cost = 0.0 if j == n else costs[j]
            if split_cost is None:
                continue
            # ピースがバジェットに近いほど良い（過剰な細切れを防ぐ）
            balance = score_balance(width, budget)
            cost = split_cost + balance + dp[j]
            if cost < dp[i]:
                dp[i] = cost
                nxt[i] = j
            if width > budget:
                break

    if dp[0] == inf:
        return [token]

    pieces: List[Token] = []
    i = 0
    while i < n:
        j = nxt[i]
        if j <= i:
            j = n
        pieces.append(Token(text=text[i:j], start=token.start + i, end=token.start + j))
        i = j
    return pieces


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
    # 改善20-A: 行幅上限を超える単一トークンを1行として許容する際の超過ペナルティ
    w_overflow = penalties.get("overflow", 8.0)
    max_ratio = limits["line_max_ratio"]

    n = len(tokens)
    dp = [float("inf")] * (n + 1)
    next_break = [-1] * (n + 1)
    dp[n] = 0.0

    for i in range(n - 1, -1, -1):
        width = 0.0
        text_acc = ""
        last_token = None
        candidate_found = False
        for j in range(i + 1, n + 1):
            tok = tokens[j - 1]
            text_acc += tok.text
            width += glyph_length(tok.text, width_mode, weight_table)

            # 改善20-A: 幅超過でも候補ゼロのまま打ち切らない。単一トークンが上限を超える場合に
            # dp[i]=inf のまま残ると、そのトークンより前の全域で DP が実行不能になり
            # 「1トークン=1行」に退化する（そも/そも/どう/いう が各1ページになった根本原因）。
            # 超過候補には超過ペナルティを付けて許容し、必ず1つは候補を作る。
            overflow = width > target_width * max_ratio
            if overflow and candidate_found:
                break

            boundary_char_idx = max(tokens[j - 1].end - 1, 0) if j - 1 < len(tokens) else tokens[-1].end - 1

            # 分割禁止範囲内での分割は禁止
            if _is_in_forbidden_span(boundary_char_idx, forbidden_spans):
                last_token = tok
                continue

            penalty = w_rag * score_balance(width, target_width)
            if overflow:
                penalty += w_overflow * ((width - target_width) / max(target_width, 1e-6)) ** 2

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
            candidate_found = True
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
            overflow_cost = 0.0
            if total_width > target_width * max_ratio:
                # 改善20-A: 単一行のページは幅超過でも許容する（行DPと同様、候補ゼロによる
                # DP実行不能→ページ詰め退化を防ぐ）。複数行の超過ページは従来どおり除外。
                if len(chunk) > 1:
                    continue
                overflow_cost = penalties.get("overflow", 8.0) * (
                    (total_width - target_width) / max(target_width, 1e-6)
                ) ** 2

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

            cost = balance_cost + qty_cost + lone_cost + end_cost + overflow_cost + dp[j]
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
