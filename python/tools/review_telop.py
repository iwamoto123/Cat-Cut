"""Review and safely clean telop.txt before export.

This tool is intentionally deterministic so the desktop app can test it and
show the exact findings before rendering a video. Paid AI review can be added
as a separate BYOK provider on top of this artifact later.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shared.transcript_correction import corrections_from_sources, load_correction_dictionary


PAGE_HEADER_RE = re.compile(r"^#\s*(cut_\d+_p\d+)\b")
PUNCT_RE = re.compile(r"[\s\u3000。、，,.!?！？「」『』（）()\[\]【】・…:：;；\"'`]+")
FILLER_ONLY_TEXTS = {
    "あ",
    "え",
    "えー",
    "えっと",
    "あの",
    "その",
    "まあ",
    "なんか",
    "ね",
    "で",
}


@dataclass
class TelopPage:
    page_id: str
    header: str
    body: list[str]


def parse_telop(text: str) -> tuple[list[str], list[TelopPage]]:
    preamble: list[str] = []
    pages: list[TelopPage] = []
    current: TelopPage | None = None

    for raw in text.splitlines():
        line = raw.rstrip("\r")
        match = PAGE_HEADER_RE.match(line.strip())
        if match:
            if current is not None:
                pages.append(current)
            current = TelopPage(page_id=match.group(1), header=line, body=[])
            continue

        if current is None:
            preamble.append(line)
        else:
            current.body.append(line)

    if current is not None:
        pages.append(current)
    return preamble, pages


def render_telop(preamble: list[str], pages: list[TelopPage]) -> str:
    lines = list(preamble)
    if lines and lines[-1] != "":
        lines.append("")

    for page in pages:
        lines.append(page.header)
        lines.extend(page.body)
        if not lines or lines[-1] != "":
            lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def visible_lines(page: TelopPage) -> list[tuple[int, int, str]]:
    result: list[tuple[int, int, str]] = []
    visible_index = 0
    for body_index, line in enumerate(page.body):
        if line.strip() == "" or line.lstrip().startswith("#"):
            continue
        result.append((body_index, visible_index, line))
        visible_index += 1
    return result


def normalized_page_text(page: TelopPage) -> str:
    text = "".join(line for _, _, line in visible_lines(page))
    return PUNCT_RE.sub("", text)


def load_dictionary_corrections(path: str | None):
    if not path:
        return []
    dictionary = load_correction_dictionary(path)
    return corrections_from_sources(dictionary)


def make_finding(
    *,
    finding_type: str,
    severity: str,
    page_id: str,
    message: str,
    source: str | None = None,
    suggestion: str | None = None,
    line_index: int | None = None,
    before: str | None = None,
    after: str | None = None,
) -> dict[str, Any]:
    seed = "|".join(
        str(part)
        for part in (finding_type, page_id, line_index, source, suggestion, before)
        if part is not None
    )
    safe_seed = re.sub(r"[^A-Za-z0-9_-]+", "_", seed).strip("_")[:96] or finding_type
    digest = hashlib.sha1(seed.encode("utf-8")).hexdigest()[:8]
    finding_id = f"{safe_seed}_{digest}"
    return {
        "id": finding_id,
        "type": finding_type,
        "severity": severity,
        "page_id": page_id,
        "line_index": line_index,
        "message": message,
        "source": source,
        "suggestion": suggestion,
        "before": before,
        "after": after,
    }


def review_pages(pages: list[TelopPage], corrections) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []

    for page in pages:
        lines = visible_lines(page)
        joined = normalized_page_text(page)
        if joined in FILLER_ONLY_TEXTS:
            findings.append(
                make_finding(
                    finding_type="filler_only",
                    severity="high",
                    page_id=page.page_id,
                    message="フィラーだけのテロップです。削除候補です。",
                    source=joined,
                    suggestion="",
                    before="\n".join(line for _, _, line in lines),
                    after="",
                )
            )

        for body_index, line_index, line in lines:
            del body_index
            occupied_spans: list[tuple[int, int]] = []
            for correction in corrections:
                search_from = 0
                while True:
                    start = line.find(correction.source, search_from)
                    if start < 0:
                        break
                    end = start + len(correction.source)
                    search_from = end
                    if any(start < used_end and end > used_start for used_start, used_end in occupied_spans):
                        continue
                    occupied_spans.append((start, end))
                    after = line.replace(correction.source, correction.target)
                    findings.append(
                        make_finding(
                            finding_type="dictionary",
                            severity="high",
                            page_id=page.page_id,
                            line_index=line_index,
                            message=f"誤認識の可能性: {correction.source} -> {correction.target}",
                            source=correction.source,
                            suggestion=correction.target,
                            before=line,
                            after=after,
                        )
                    )

        for index in range(1, len(lines)):
            _, prev_line_index, prev_line = lines[index - 1]
            _, line_index, line = lines[index]
            if prev_line.strip() and prev_line.strip() == line.strip():
                findings.append(
                    make_finding(
                        finding_type="duplicate_line",
                        severity="medium",
                        page_id=page.page_id,
                        line_index=line_index,
                        message="同じ行が連続しています。重複表示の可能性があります。",
                        source=line,
                        suggestion="",
                        before=f"{prev_line}\n{line}",
                        after=prev_line,
                    )
                )

        for index in range(1, len(lines)):
            prev_body_index, prev_line_index, prev_line = lines[index - 1]
            body_index, line_index, line = lines[index]
            stripped = line.lstrip()
            if prev_line.rstrip().endswith("も") and stripped.startswith("しくは"):
                next_line = line.replace("しくは", "もしくは", 1)
                prev_fixed = prev_line.rstrip()[:-1]
                findings.append(
                    make_finding(
                        finding_type="line_break",
                        severity="high",
                        page_id=page.page_id,
                        line_index=prev_line_index,
                        message="「もしくは」が改行で分断されています。",
                        source=f"{prev_line}\n{line}",
                        suggestion=f"{prev_fixed}\n{next_line}",
                        before=f"{prev_line}\n{line}",
                        after=f"{prev_fixed}\n{next_line}",
                    )
                )
                continue

            if stripped.startswith("しくは"):
                findings.append(
                    make_finding(
                        finding_type="line_prefix",
                        severity="medium",
                        page_id=page.page_id,
                        line_index=line_index,
                        message="行頭の「しくは」は「もしくは」の欠落かもしれません。",
                        source=line,
                        suggestion=line.replace("しくは", "もしくは", 1),
                        before=line,
                        after=line.replace("しくは", "もしくは", 1),
                    )
                )
            del prev_body_index, body_index

    return findings


def apply_safe_changes(pages: list[TelopPage], corrections) -> tuple[list[TelopPage], list[dict[str, Any]]]:
    applied: list[dict[str, Any]] = []
    kept_pages: list[TelopPage] = []

    for page in pages:
        body = list(page.body)

        lines = visible_lines(TelopPage(page.page_id, page.header, body))
        for index in range(1, len(lines)):
            prev_body_index, _, prev_line = lines[index - 1]
            body_index, _, line = lines[index]
            stripped = line.lstrip()
            if prev_line.rstrip().endswith("も") and stripped.startswith("しくは"):
                body[prev_body_index] = prev_line.rstrip()[:-1]
                body[body_index] = line.replace("しくは", "もしくは", 1)
                applied.append(
                    {
                        "type": "line_break",
                        "page_id": page.page_id,
                        "before": f"{prev_line}\n{line}",
                        "after": f"{body[prev_body_index]}\n{body[body_index]}",
                    }
                )

        for idx, line in enumerate(body):
            if line.strip() == "" or line.lstrip().startswith("#"):
                continue
            before = line
            after = line
            for correction in corrections:
                after = after.replace(correction.source, correction.target)
            if after != before:
                body[idx] = after
                applied.append(
                    {
                        "type": "dictionary",
                        "page_id": page.page_id,
                        "source": before,
                        "suggestion": after,
                    }
                )

        for idx, line in enumerate(body):
            if line.strip() == "" or line.lstrip().startswith("#"):
                continue
            stripped = line.lstrip()
            if stripped.startswith("しくは"):
                body[idx] = line.replace("しくは", "もしくは", 1)
                applied.append(
                    {
                        "type": "line_prefix",
                        "page_id": page.page_id,
                        "before": line,
                        "after": body[idx],
                    }
                )

        deduped: list[str] = []
        previous_visible: str | None = None
        for line in body:
            if line.strip() == "" or line.lstrip().startswith("#"):
                deduped.append(line)
                continue
            if previous_visible is not None and line.strip() == previous_visible:
                applied.append({"type": "duplicate_line", "page_id": page.page_id, "source": line})
                continue
            deduped.append(line)
            previous_visible = line.strip()

        updated_page = TelopPage(page_id=page.page_id, header=page.header, body=deduped)
        if normalized_page_text(updated_page) in FILLER_ONLY_TEXTS:
            applied.append(
                {
                    "type": "filler_only",
                    "page_id": page.page_id,
                    "source": "\n".join(line for _, _, line in visible_lines(updated_page)),
                }
            )
            continue

        kept_pages.append(updated_page)

    return kept_pages, applied


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("run_dir", help="runs/<run_name> へのパス")
    parser.add_argument("--telop", default=None, help="telop.txt のパス")
    parser.add_argument("--dictionary", default=None, help="補正辞書 YAML/JSON")
    parser.add_argument("--output", default=None, help="レビューJSONの出力先")
    parser.add_argument("--apply-safe", action="store_true", help="安全な自動修正を telop.txt に反映する")
    args = parser.parse_args()

    run_dir = Path(args.run_dir).resolve()
    telop_path = Path(args.telop) if args.telop else run_dir / "telop.txt"
    output_path = Path(args.output) if args.output else run_dir / "telop_review.json"

    if not telop_path.exists():
        sys.exit(f"telop.txt not found: {telop_path}")

    corrections = load_dictionary_corrections(args.dictionary)
    preamble, pages = parse_telop(telop_path.read_text(encoding="utf-8"))
    findings = review_pages(pages, corrections)
    initial_findings = list(findings)
    applied: list[dict[str, Any]] = []

    if args.apply_safe:
        pages, applied = apply_safe_changes(pages, corrections)
        telop_path.write_text(render_telop(preamble, pages), encoding="utf-8")
        findings = review_pages(pages, corrections)

    report = {
        "version": "1.0.0",
        "review_mode": "deterministic",
        "telop": str(telop_path),
        "dictionary": str(Path(args.dictionary).resolve()) if args.dictionary else None,
        "stats": {
            "pages": len(pages),
            "findings": len(initial_findings),
            "remaining_findings": len(findings),
            "applied": len(applied),
            "dictionary_hits": sum(1 for item in initial_findings if item["type"] == "dictionary"),
            "filler_only_pages": sum(1 for item in initial_findings if item["type"] == "filler_only"),
        },
        "findings": initial_findings,
        "remaining_findings": findings,
        "applied": applied,
    }

    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"reviewed {telop_path}")
    print(f"  findings: {len(initial_findings)}")
    print(f"  remaining: {len(findings)}")
    print(f"  applied: {len(applied)}")
    print(f"  report: {output_path}")


if __name__ == "__main__":
    main()
