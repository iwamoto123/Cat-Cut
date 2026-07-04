"""Deterministic transcript correction utilities.

The correction layer keeps STT raw output intact and writes a corrected copy.
It is designed for desktop-app use: deterministic inputs, JSON artifacts, and
small patch records that can be inspected or tested.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Tuple

try:
    import yaml
    _HAS_YAML = True
except ImportError:
    _HAS_YAML = False


@dataclass(frozen=True)
class Correction:
    source: str
    target: str
    category: str


def load_correction_dictionary(path: str | None) -> Dict[str, Any]:
    """Load a YAML/JSON correction dictionary."""
    if not path:
        return {}

    abs_path = os.path.abspath(path)
    if not os.path.exists(abs_path):
        raise FileNotFoundError(f"Correction dictionary not found: {abs_path}")

    with open(abs_path, "r", encoding="utf-8") as f:
        content = f.read()

    ext = os.path.splitext(abs_path)[1].lower()
    if ext in (".yaml", ".yml"):
        if not _HAS_YAML:
            raise ImportError("PyYAML is required to load YAML dictionaries")
        return yaml.safe_load(content) or {}
    if ext == ".json":
        return json.loads(content)

    if _HAS_YAML:
        return yaml.safe_load(content) or {}
    return json.loads(content)


def corrections_from_sources(
    dictionary: Dict[str, Any] | None = None,
    project_config: Dict[str, Any] | None = None,
    user_dictionary: Dict[str, Any] | None = None,
) -> List[Correction]:
    """Collect corrections from dictionary YAML, project text_rules, and user dictionary."""
    result: List[Correction] = []
    dictionary = dictionary or {}
    project_config = project_config or {}

    for category in ("proper_nouns", "domain_terms", "common_misrecognitions"):
        entries = dictionary.get(category, {}) or {}
        if isinstance(entries, dict):
            for source, target in entries.items():
                if source and target and source != target:
                    result.append(Correction(str(source), str(target), category))

    text_rules = project_config.get("text_rules", {}) or {}
    project_corrections = text_rules.get("corrections", {}) or {}
    if isinstance(project_corrections, dict):
        for source, target in project_corrections.items():
            if source and target and source != target:
                result.append(Correction(str(source), str(target), "project_text_rules"))

    # ユーザー辞書 (domain_dictionary より後に適用 = 優先)
    for source, target in _iter_user_dictionary_entries(user_dictionary):
        result.append(Correction(source, target, "user_dictionary"))

    # Longer phrases first so phrase corrections win over shorter word fixes.
    result.sort(key=lambda c: len(c.source), reverse=True)
    return result


def load_user_dictionary(path: str | None) -> Dict[str, Any]:
    """Load user_dictionary.json ({entries: [{from, to}, ...]})."""
    if not path:
        return {}
    abs_path = os.path.abspath(path)
    if not os.path.exists(abs_path):
        return {}
    with open(abs_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data if isinstance(data, dict) else {}


def _iter_user_dictionary_entries(data: Dict[str, Any] | None) -> List[Tuple[str, str]]:
    """Yield (from, to) pairs from user dictionary format."""
    if not data:
        return []
    entries = data.get("entries", [])
    if not isinstance(entries, list):
        return []
    pairs: List[Tuple[str, str]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        source = str(entry.get("from") or "").strip()
        target = str(entry.get("to") or "").strip()
        if source and target and source != target:
            pairs.append((source, target))
    return pairs


def apply_transcript_corrections(
    stt_result: Dict[str, Any],
    corrections: Iterable[Correction],
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """Apply corrections to a copy of stt_result and return patch metadata."""
    corrected = json.loads(json.dumps(stt_result, ensure_ascii=False))
    correction_list = list(corrections)

    word_patches = _apply_word_corrections(corrected.get("words", []), correction_list)
    sentence_patches = _apply_text_field_corrections(
        corrected.get("sentences", []),
        correction_list,
        field="text",
        id_field="id",
        target_type="sentence",
    )

    raw_before = corrected.get("raw_text", "")
    raw_after, raw_patches = replace_text(raw_before, correction_list)
    corrected["raw_text"] = raw_after

    patch = {
        "version": "1.0.0",
        "stats": {
            "corrections_available": len(correction_list),
            "word_patches": len(word_patches),
            "sentence_patches": len(sentence_patches),
            "raw_text_patches": len(raw_patches),
        },
        "word_patches": word_patches,
        "sentence_patches": sentence_patches,
        "raw_text_patches": [
            {"source": c.source, "target": c.target, "category": c.category, "count": count}
            for c, count in raw_patches
        ],
    }

    corrected["correction"] = {
        "applied": True,
        "patch_stats": patch["stats"],
    }
    return corrected, patch


def replace_text(text: str, corrections: Iterable[Correction]) -> Tuple[str, List[Tuple[Correction, int]]]:
    """Apply plain string replacements and return counts."""
    result = text
    patches: List[Tuple[Correction, int]] = []
    for correction in corrections:
        count = result.count(correction.source)
        if count:
            result = result.replace(correction.source, correction.target)
            patches.append((correction, count))
    return result, patches


def _apply_text_field_corrections(
    items: List[Dict[str, Any]],
    corrections: List[Correction],
    field: str,
    id_field: str,
    target_type: str,
) -> List[Dict[str, Any]]:
    patches = []
    for item in items:
        before = item.get(field, "")
        after, applied = replace_text(before, corrections)
        if after == before:
            continue
        item[field] = after
        for correction, count in applied:
            patches.append({
                "type": target_type,
                "id": item.get(id_field),
                "source": correction.source,
                "target": correction.target,
                "category": correction.category,
                "count": count,
                "before": before,
                "after": after,
            })
    return patches


def _apply_word_corrections(
    words: List[Dict[str, Any]],
    corrections: List[Correction],
) -> List[Dict[str, Any]]:
    """Apply exact and phrase corrections to words while preserving timings.

    Phrase corrections are mapped onto the concatenated word text. The first
    word in the matched span receives the replacement and remaining words in
    the span become empty strings, preserving word IDs and timestamps for cut
    logic while making downstream joined text corrected.
    """
    patches: List[Dict[str, Any]] = []

    # Exact single-word replacements first.
    for word in words:
        before = word.get("text", "")
        for correction in corrections:
            if before == correction.source:
                word["text"] = correction.target
                patches.append({
                    "type": "word",
                    "mode": "exact",
                    "word_ids": [word.get("id")],
                    "source": correction.source,
                    "target": correction.target,
                    "category": correction.category,
                    "before": before,
                    "after": correction.target,
                })
                break

    # Phrase replacements across one or more words.
    occupied: set[int] = set()
    while True:
        joined, spans = _join_words_with_spans(words)
        match = _find_next_phrase_match(joined, spans, corrections, occupied)
        if match is None:
            break

        correction, start_idx, end_idx, before = match
        word_ids = [words[i].get("id") for i in range(start_idx, end_idx + 1)]
        words[start_idx]["text"] = correction.target
        for i in range(start_idx + 1, end_idx + 1):
            words[i]["text"] = ""
        occupied.update(range(start_idx, end_idx + 1))
        patches.append({
            "type": "word",
            "mode": "phrase",
            "word_ids": word_ids,
            "source": correction.source,
            "target": correction.target,
            "category": correction.category,
            "before": before,
            "after": correction.target,
        })

    return patches


def _join_words_with_spans(words: List[Dict[str, Any]]) -> Tuple[str, List[Tuple[int, int]]]:
    parts = []
    spans: List[Tuple[int, int]] = []
    cursor = 0
    for word in words:
        text = word.get("text", "")
        start = cursor
        parts.append(text)
        cursor += len(text)
        spans.append((start, cursor))
    return "".join(parts), spans


def _find_next_phrase_match(
    joined: str,
    spans: List[Tuple[int, int]],
    corrections: List[Correction],
    occupied: set[int],
) -> Tuple[Correction, int, int, str] | None:
    for correction in corrections:
        if len(correction.source) <= 1:
            continue
        pos = joined.find(correction.source)
        while pos >= 0:
            end = pos + len(correction.source)
            indices = [
                i for i, (s, e) in enumerate(spans)
                if e > pos and s < end
            ]
            if indices and not any(i in occupied for i in indices):
                start_idx = indices[0]
                end_idx = indices[-1]
                before = joined[spans[start_idx][0]:spans[end_idx][1]]
                return correction, start_idx, end_idx, before
            pos = joined.find(correction.source, pos + 1)
    return None
