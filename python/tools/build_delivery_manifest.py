"""Build delivery manifest JSON for SNS publishing pipelines."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def summarize_telop(composition: dict[str, Any], max_chars: int = 280) -> str:
    lines: list[str] = []
    for cut in composition.get("timeline", {}).get("cuts", []):
        for page in cut.get("telop", {}).get("pages", []):
            page_lines = page.get("lines", [])
            if page_lines:
                lines.append("".join(page_lines))
    text = " / ".join(lines[:6])
    if len(text) > max_chars:
        return text[: max_chars - 1] + "…"
    return text


def build_manifest(
    run_dir: Path,
    *,
    title: str,
    customer_id: str,
    episode_description: str = "",
) -> dict[str, Any]:
    composition_path = run_dir / "step08_composition" / "composition.json"
    composition = load_json(composition_path)
    meta = composition.get("meta", {})
    timeline = composition.get("timeline", {})

    render_info_path = run_dir / "output" / "render_output.json"
    final_video = run_dir / "output" / "final.mp4"
    if render_info_path.exists():
        render_info = load_json(render_info_path)
        final_video = Path(render_info.get("finalVideo") or final_video)

    description = episode_description or summarize_telop(composition, max_chars=500)
    duration_ms = timeline.get("total_duration_ms") or meta.get("edited_duration_ms", 0)
    orientation = meta.get("orientation", "horizontal")
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    main_video = str(final_video.resolve()) if final_video.exists() else ""

    return {
        "version": "1.0.0",
        "created_at": now,
        "customer_id": customer_id,
        "run_id": run_dir.name,
        "main_episode": {
            "title": title,
            "description": description,
            "video_path": main_video,
            "audio_path": "",
            "duration_ms": duration_ms,
            "orientation": orientation,
            "source_video": meta.get("source_video", ""),
        },
        "clips": [],
        "posts": [
            {
                "id": "youtube_main",
                "platform": "youtube",
                "kind": "main",
                "media_path": main_video,
                "title": title,
                "description": description,
                "scheduled_at": None,
                "status": "draft",
            },
            {
                "id": "x_teaser",
                "platform": "x",
                "kind": "text",
                "media_path": "",
                "title": title,
                "description": description[:280],
                "scheduled_at": None,
                "status": "draft",
            },
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Build delivery manifest for a Cat-Cut run")
    parser.add_argument("run_dir", help="Run directory relative to repo root or absolute path")
    parser.add_argument("--title", required=True, help="Episode title")
    parser.add_argument("--customer-id", default="", help="Customer identifier")
    parser.add_argument("--description", default="", help="Override episode description")
    parser.add_argument(
        "--output",
        default="",
        help="Output path (default: <run_dir>/delivery_manifest.json)",
    )
    args = parser.parse_args()

    run_dir = Path(args.run_dir).resolve()
    manifest = build_manifest(
        run_dir,
        title=args.title,
        customer_id=args.customer_id,
        episode_description=args.description,
    )

    output_path = Path(args.output).resolve() if args.output else run_dir / "delivery_manifest.json"
    output_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[delivery_manifest] wrote: {output_path}")


if __name__ == "__main__":
    main()
