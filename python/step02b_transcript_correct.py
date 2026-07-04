"""Step 2b: Transcript correction.

Creates a corrected STT artifact without mutating the raw STT result.

Usage:
    .venv/bin/python python/step02b_transcript_correct.py \
        --stt runs/<run>/step02_stt/stt_result.json \
        --dictionary templates/domain_dictionary.yaml \
        --project templates/horizontal.yaml \
        --output runs/<run>/step02b_transcript_correct
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from shared.project_config import load_project_config
from shared.transcript_correction import (
    apply_transcript_corrections,
    corrections_from_sources,
    load_correction_dictionary,
    load_user_dictionary,
)


def run_step(
    stt_result_path: str,
    output_dir: str,
    dictionary_path: str | None = None,
    project_path: str | None = None,
    user_dictionary_path: str | None = None,
) -> dict:
    """Apply deterministic corrections and write app-friendly artifacts."""
    os.makedirs(output_dir, exist_ok=True)

    print("[Step 2b] Transcript Correction")
    print(f"  stt: {stt_result_path}")
    if dictionary_path:
        print(f"  dictionary: {dictionary_path}")
    if project_path:
        print(f"  project: {project_path}")
    if user_dictionary_path:
        print(f"  user_dictionary: {user_dictionary_path}")

    with open(stt_result_path, "r", encoding="utf-8") as f:
        stt_result = json.load(f)

    dictionary = load_correction_dictionary(dictionary_path)
    project_cfg = load_project_config(project_path) if project_path else {}
    user_dictionary = load_user_dictionary(user_dictionary_path)
    corrections = corrections_from_sources(dictionary, project_cfg, user_dictionary)

    corrected, patch = apply_transcript_corrections(stt_result, corrections)
    patch["inputs"] = {
        "stt": os.path.abspath(stt_result_path),
        "dictionary": os.path.abspath(dictionary_path) if dictionary_path else None,
        "project": os.path.abspath(project_path) if project_path else None,
        "user_dictionary": os.path.abspath(user_dictionary_path) if user_dictionary_path else None,
    }

    corrected_path = os.path.join(output_dir, "stt_corrected.json")
    patch_path = os.path.join(output_dir, "transcript_patch.json")
    report_path = os.path.join(output_dir, "app_report.json")

    with open(corrected_path, "w", encoding="utf-8") as f:
        json.dump(corrected, f, ensure_ascii=False, indent=2)
    with open(patch_path, "w", encoding="utf-8") as f:
        json.dump(patch, f, ensure_ascii=False, indent=2)

    report = {
        "step": "step02b_transcript_correct",
        "status": "ok",
        "outputs": {
            "stt_corrected": os.path.abspath(corrected_path),
            "transcript_patch": os.path.abspath(patch_path),
        },
        "stats": patch["stats"],
    }
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print(f"  corrections available: {patch['stats']['corrections_available']}")
    print(f"  word patches: {patch['stats']['word_patches']}")
    print(f"  sentence patches: {patch['stats']['sentence_patches']}")
    print(f"  raw text patches: {patch['stats']['raw_text_patches']}")
    print(f"[Step 2b] Done: {corrected_path}")

    return report


def main():
    parser = argparse.ArgumentParser(description="Step 2b: Transcript Correction")
    parser.add_argument("--stt", required=True, help="Raw STT result JSON path")
    parser.add_argument("--output", required=True, help="Output directory")
    parser.add_argument("--dictionary", default=None, help="Domain correction dictionary YAML/JSON")
    parser.add_argument("--project", default=None, help="Project config YAML/JSON")
    parser.add_argument(
        "--user-dictionary",
        default=None,
        help="User dictionary JSON path (Electron userData/user_dictionary.json)",
    )
    args = parser.parse_args()

    run_step(
        args.stt,
        args.output,
        dictionary_path=args.dictionary,
        project_path=args.project,
        user_dictionary_path=args.user_dictionary,
    )


if __name__ == "__main__":
    main()
