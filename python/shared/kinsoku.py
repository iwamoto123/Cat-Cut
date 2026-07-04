"""Japanese kinsoku (line-break prohibition) utilities."""

from __future__ import annotations

from typing import Dict, Iterable, Set


_DEFAULT_HEAD = set(")] }）】〙〛〉》」』、。.,!?！？:;・…")
_DEFAULT_TAIL = set("([{（【〈《「『")
_DEFAULT_OPEN = set("『「（【《〈")
_DEFAULT_CLOSE = set("』」）)】〙〗〉》")

# Common Japanese particles / connective endings that should not end a line/page
_DEFAULT_LINE_SUFFIX = set("はがをにとものでへやかのとてでしな")
_DEFAULT_CONNECTIVE_SUFFIX = set("てでしなく")


def _to_set(values: Iterable[str] | None, fallback: Set[str]) -> Set[str]:
    if not values:
        return set(fallback)
    return set(values)


def build_kinsoku_sets(config: Dict | None) -> Dict[str, Set[str]]:
    """Return configured kinsoku character sets."""

    cfg = config or {}
    return {
        "head": _to_set(cfg.get("head_forbidden"), _DEFAULT_HEAD),
        "tail": _to_set(cfg.get("tail_forbidden"), _DEFAULT_TAIL),
        "open": _to_set(cfg.get("open_quotes"), _DEFAULT_OPEN),
        "close": _to_set(cfg.get("close_quotes"), _DEFAULT_CLOSE),
        "line_suffix": _to_set(cfg.get("line_suffix_forbidden"), _DEFAULT_LINE_SUFFIX),
        "connective_suffix": _to_set(
            cfg.get("connective_suffix_forbidden"), _DEFAULT_CONNECTIVE_SUFFIX
        ),
    }


def kinsoku_penalty(prev_last: str, next_first: str, sets: Dict[str, Set[str]] | None = None) -> float:
    """Return penalty units based on forbidden line breaks."""

    table = sets or build_kinsoku_sets(None)
    penalty = 0.0
    if next_first and next_first in table["head"]:
        penalty += 1.0
    if prev_last and prev_last in table["tail"]:
        penalty += 1.0
    if (next_first and next_first in table["open"]) or (prev_last and prev_last in table["open"]):
        penalty += 0.5
    return penalty


def break_quality(prev_last: str, next_first: str, sets: Dict[str, Set[str]] | None = None) -> float:
    """Return a cost (0-1) expressing how unnatural the break point is."""

    table = sets or build_kinsoku_sets(None)
    if not prev_last:
        return 0.4
    if prev_last in set("。？！?.!…‥"):
        return 0.0
    if prev_last in set("、，,;；：:"):
        return 0.15
    # Avoid breaking after particles or connective endings
    if prev_last in table["line_suffix"]:
        return 0.8
    if prev_last in table["connective_suffix"]:
        return 0.7
    if next_first and (next_first in table["close"] or next_first in set("、，,;；：:")):
        return 0.2
    if prev_last in table["open"]:
        return 0.7
    return 0.45


def page_end_quality(last_char: str, next_first_char: str | None, sets: Dict[str, Set[str]] | None = None) -> float:
    """Return page-end penalty units (0 best)."""

    table = sets or build_kinsoku_sets(None)
    if not last_char:
        return 0.4
    if last_char in set("。？！?.!…‥"):
        return 0.0
    # Strongly penalize page ending with particles/connectives
    if last_char in table["line_suffix"] or last_char in table["connective_suffix"]:
        return 0.9
    if last_char in table["close"]:
        return 0.1
    if last_char in table["open"]:
        return 0.8
    if next_first_char and next_first_char in set("、。？！?.!」』）)］】》>"):
        return 0.3
    return 0.4


