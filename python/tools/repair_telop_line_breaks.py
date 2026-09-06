#!/usr/bin/env python3
"""既存runのテロップ改行を修復する（行頭の付属語を解消する）.

AIが「名詞 / 助詞」「名詞 / して」の位置に改行を入れてしまった既存runを、
再解析（step06c の再実行）なしで直す。対象は次の2ファイル。

- `telop_directives.json` の slots[].text（書き出しの正本）
- `scene_edits_draft.json` の scenes[].telopText（検品UIの下書き）
  ※ `telopEdited: true`（人が手で直したシーン）は既定で触らない

使い方:
    .venv/bin/python python/tools/repair_telop_line_breaks.py runs/<run名>
    .venv/bin/python python/tools/repair_telop_line_breaks.py runs/<run名> --dry-run
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shared.line_break_rules import repair_line_breaks  # noqa: E402


def _repair_directives(path: Path, dry_run: bool) -> List[Tuple[str, str]]:
    data: Dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    slots = data.get("slots")
    if not isinstance(slots, list):
        return []
    changes: List[Tuple[str, str]] = []
    for slot in slots:
        if not isinstance(slot, dict):
            continue
        text = str(slot.get("text", ""))
        fixed = repair_line_breaks(text)
        if fixed != text:
            slot["text"] = fixed
            changes.append((text, fixed))
    if changes and not dry_run:
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return changes


def _repair_draft(path: Path, dry_run: bool, include_edited: bool) -> List[Tuple[str, str]]:
    data: Dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    scenes = data.get("scenes")
    if not isinstance(scenes, list):
        return []
    changes: List[Tuple[str, str]] = []
    for scene in scenes:
        if not isinstance(scene, dict):
            continue
        if scene.get("telopEdited") and not include_edited:
            continue
        text = str(scene.get("telopText") or "")
        fixed = repair_line_breaks(text)
        if fixed != text:
            scene["telopText"] = fixed
            changes.append((text, fixed))
    if changes and not dry_run:
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return changes


def main() -> int:
    parser = argparse.ArgumentParser(description="テロップの不自然な改行(行頭の付属語)を修復する")
    parser.add_argument("run_dir", help="runディレクトリ (例: runs/20260816_080618_...)")
    parser.add_argument("--dry-run", action="store_true", help="書き込まずに差分だけ表示する")
    parser.add_argument(
        "--include-edited",
        action="store_true",
        help="人が手編集したシーン(telopEdited)も修復対象にする",
    )
    args = parser.parse_args()

    run_dir = Path(args.run_dir)
    if not run_dir.is_dir():
        print(f"run ディレクトリが見つかりません: {run_dir}", file=sys.stderr)
        return 1

    total = 0
    for name, repair in (
        ("telop_directives.json", lambda p: _repair_directives(p, args.dry_run)),
        ("scene_edits_draft.json", lambda p: _repair_draft(p, args.dry_run, args.include_edited)),
    ):
        path = run_dir / name
        if not path.exists():
            print(f"- {name}: なし（スキップ）")
            continue
        changes = repair(path)
        total += len(changes)
        print(f"- {name}: {len(changes)}件修復{'（dry-run）' if args.dry_run else ''}")
        for before, after in changes:
            print(f"    {before!r}")
            print(f"  → {after!r}")

    if total and not args.dry_run:
        print("\n修復しました。検品UIでプロジェクトを開き直すと反映されます。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
