"""W15: 学習データ(catcut-learning-*.json)の集約・再学習・評価ツール(開発機用)。

各PC(自分・社員)のCat-Cutで「学習済み修正 → 学習データを書き出す」が生成した
エクスポートJSONを取り込み、次を行う:

1. 集約: 全PCの編集履歴(元テキスト/表示テキスト/編集後)を1つのデータセットへ統合
2. 再学習: 修正ペアを開発機の correction_history.json へマージ
   (step05/step06b のプロンプト注入が全PC分の修正例で賢くなる)
3. 評価: 既知ペアが編集をどれだけカバーできているか等のレポートを出力

Usage:
    # エクスポートを集約してレポートだけ見る
    .venv/bin/python python/tools/eval_edit_learning.py exports/*.json

    # 自分のMacのruns/も直接取り込む場合
    .venv/bin/python python/tools/eval_edit_learning.py exports/*.json --local

    # 開発機の correction_history.json へマージ(再学習)まで行う場合
    .venv/bin/python python/tools/eval_edit_learning.py exports/*.json --merge-history
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from shared.app_paths import default_correction_history_path  # noqa: E402

CORRECTION_HISTORY_MAX_PAIRS = 500  # desktop/main/editLearning.cjs と同じ上限


def find_nextcloud_learning_dir() -> Path | None:
    """学習データ共有用のNextcloudフォルダ(<Nextcloud>/CatCut-learning)を探す。

    desktop/main/index.cjs の nextcloudLearningDir() と同じ探索規則。
    環境変数 CATCUT_NEXTCLOUD_DIR で上書き可。見つからなければ None。
    """
    import os

    home = Path.home()
    override = os.environ.get("CATCUT_NEXTCLOUD_DIR")
    candidates = (
        [Path(override)]
        if override
        else [home / "Desktop" / "NextCloud", home / "Nextcloud", home / "NextCloud"]
    )
    for base in candidates:
        if base.is_dir():
            return base / "CatCut-learning"
    return None


# ---------------------------------------------------------------------------
# 取り込み
# ---------------------------------------------------------------------------

def load_export(path: str) -> Dict[str, Any]:
    """エクスポートJSONを読み、最低限の形へ正規化する。"""
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict) or data.get("kind") != "catcut-learning-export":
        raise ValueError(f"学習データのエクスポート形式ではありません: {path}")
    return data


def collect_local_export(runs_root: Path, correction_history_path: Path) -> Dict[str, Any]:
    """開発機のruns/とcorrection_history.jsonを直接エクスポート相当の形へ集める。"""
    runs: List[Dict[str, Any]] = []
    if runs_root.is_dir():
        for run_dir in sorted(runs_root.iterdir()):
            history_path = run_dir / "edit_history.json"
            if not history_path.is_file():
                continue
            try:
                with open(history_path, "r", encoding="utf-8") as f:
                    history = json.load(f)
            except (OSError, json.JSONDecodeError):
                continue
            entries = history.get("entries") if isinstance(history, dict) else None
            if isinstance(entries, list) and entries:
                runs.append({"run": run_dir.name, "entries": entries})
    pairs: List[Dict[str, Any]] = []
    if correction_history_path.is_file():
        try:
            with open(correction_history_path, "r", encoding="utf-8") as f:
                raw = json.load(f)
            if isinstance(raw, dict) and isinstance(raw.get("pairs"), list):
                pairs = raw["pairs"]
        except (OSError, json.JSONDecodeError):
            pass
    return {
        "version": "1.0.0",
        "kind": "catcut-learning-export",
        "machine": "local",
        "exportedAt": datetime.now().isoformat(),
        "runs": runs,
        "correctionHistory": {"version": "1.0.0", "pairs": pairs},
    }


# ---------------------------------------------------------------------------
# 集約・マージ(純関数)
# ---------------------------------------------------------------------------

def build_dataset(exports: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """全エクスポートのシーン編集を1つのデータセット(1行=1シーン編集)へ統合する。

    同一 machine+run+scene_id は後勝ち(エクスポートが新しいほど後ろに並ぶ想定)。
    """
    by_key: Dict[str, Dict[str, Any]] = {}
    for export in exports:
        machine = str(export.get("machine") or "unknown")
        for run in export.get("runs") or []:
            run_name = str(run.get("run") or "")
            for entry in run.get("entries") or []:
                scene_id = str(entry.get("scene_id") or "")
                if not scene_id:
                    continue
                before = str(entry.get("before") or "")
                after = str(entry.get("after") or "")
                if before == after:
                    continue
                key = f"{machine}\u0000{run_name}\u0000{scene_id}"
                by_key[key] = {
                    "machine": machine,
                    "run": run_name,
                    "scene_id": scene_id,
                    "source": str(entry.get("source") or ""),
                    "before": before,
                    "after": after,
                    "ts": str(entry.get("ts") or ""),
                }
    return list(by_key.values())


def merge_correction_pairs(histories: List[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """複数PCの修正ペアをcount合算で統合する(上限はLRUでなくcount降順で切る)。"""
    merged: Dict[str, Dict[str, Any]] = {}
    for pairs in histories:
        for entry in pairs or []:
            before = str(entry.get("before") or "").strip()
            after = str(entry.get("after") or "").strip()
            if not before or not after or before == after:
                continue
            try:
                count = max(1, int(entry.get("count") or 1))
            except (TypeError, ValueError):
                count = 1
            key = f"{before}\u0000{after}"
            if key in merged:
                merged[key]["count"] += count
                merged[key]["updatedAt"] = max(
                    str(merged[key].get("updatedAt") or ""), str(entry.get("updatedAt") or ""),
                )
            else:
                merged[key] = {
                    "before": before,
                    "after": after,
                    "count": count,
                    "updatedAt": str(entry.get("updatedAt") or ""),
                }
    ordered = sorted(merged.values(), key=lambda p: (-p["count"], p["before"]))
    return ordered[:CORRECTION_HISTORY_MAX_PAIRS]


# ---------------------------------------------------------------------------
# 評価(純関数)
# ---------------------------------------------------------------------------

def evaluate_dataset(
    dataset: List[Dict[str, Any]],
    pairs: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """データセットを既知の修正ペアで評価する。

    - covered: 編集(before→after)のうち、既知ペアで説明できるもの
      (pair.before が編集前に含まれ、pair.after が編集後に含まれる)
    - telop_only: 表示テキストが元テキスト(STT生)から既に変わっていた編集
      (AI整形が絡むシーン。校正プロンプトの評価対象として重要)
    """
    covered = 0
    uncovered_samples: List[Dict[str, str]] = []
    telop_only = 0
    for entry in dataset:
        before = entry["before"]
        after = entry["after"]
        if entry.get("source") and entry["source"] != before:
            telop_only += 1
        matched = any(
            pair["before"] in before and pair["after"] in after and pair["before"] not in after
            for pair in pairs
        )
        if matched:
            covered += 1
        elif len(uncovered_samples) < 20:
            uncovered_samples.append({"before": before, "after": after})
    total = len(dataset)
    return {
        "total_edits": total,
        "covered_by_known_pairs": covered,
        "coverage_rate": round(covered / total, 3) if total else 0.0,
        "source_differs_from_display": telop_only,
        "uncovered_samples": uncovered_samples,
    }


def build_report(
    exports: List[Dict[str, Any]],
    dataset: List[Dict[str, Any]],
    merged_pairs: List[Dict[str, Any]],
    evaluation: Dict[str, Any],
) -> str:
    """人間が読むMarkdownレポートを組み立てる。"""
    lines: List[str] = []
    lines.append(f"# Cat-Cut 学習データ評価レポート ({datetime.now().strftime('%Y-%m-%d %H:%M')})")
    lines.append("")
    lines.append("## 取り込み元")
    lines.append("")
    lines.append("| PC | run数 | 編集数 | 修正ペア数 |")
    lines.append("|---|---|---|---|")
    for export in exports:
        runs = export.get("runs") or []
        edits = sum(len(r.get("entries") or []) for r in runs)
        pair_count = len((export.get("correctionHistory") or {}).get("pairs") or [])
        lines.append(f"| {export.get('machine') or 'unknown'} | {len(runs)} | {edits} | {pair_count} |")
    lines.append("")
    lines.append("## 統合結果")
    lines.append("")
    lines.append(f"- シーン編集データ: **{len(dataset)}件**(元テキスト/表示テキスト/編集後の3層)")
    lines.append(f"- 統合修正ペア: **{len(merged_pairs)}件**")
    lines.append(
        f"- 表示テキストがSTT生テキストと異なる編集: {evaluation['source_differs_from_display']}件"
        "(AI整形済みシーンへの追加修正)"
    )
    lines.append("")
    lines.append("## 既知ペアによるカバレッジ")
    lines.append("")
    lines.append(
        f"- 編集 {evaluation['total_edits']}件中 **{evaluation['covered_by_known_pairs']}件"
        f"({evaluation['coverage_rate']:.1%})** は学習済みペアで説明可能"
    )
    lines.append("- 未カバーの編集ほど「AIがまだ拾えていない修正」= プロンプト・辞書改善の候補")
    lines.append("")
    lines.append("## 頻度上位の修正ペア(プロンプト注入対象・上位30)")
    lines.append("")
    lines.append("| 誤 | 正 | 回数 |")
    lines.append("|---|---|---|")
    for pair in merged_pairs[:30]:
        lines.append(f"| {pair['before']} | {pair['after']} | {pair['count']} |")
    lines.append("")
    if evaluation["uncovered_samples"]:
        lines.append("## 未カバー編集のサンプル(最大20件)")
        lines.append("")
        for sample in evaluation["uncovered_samples"]:
            lines.append(f"- 「{sample['before'][:40]}」→「{sample['after'][:40]}」")
        lines.append("")
    lines.append("## 次のアクション")
    lines.append("")
    lines.append("- `--merge-history` を付けて再実行すると、統合ペアが開発機の correction_history.json へ")
    lines.append("  反映され、以降の解析(step05/step06b)のプロンプト注入が全PC分の修正例で動く")
    lines.append("- 回数が多い確定的な誤記はユーザー辞書(user_dictionary.json)への昇格を検討")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Cat-Cut学習データの集約・再学習・評価")
    parser.add_argument("exports", nargs="*", help="catcut-learning-*.json (社員PCからの書き出し)")
    parser.add_argument("--local", action="store_true", help="このPCのruns/とcorrection_historyも取り込む")
    parser.add_argument(
        "--merge-history",
        action="store_true",
        help="統合修正ペアを開発機の correction_history.json へ書き戻す(再学習)",
    )
    parser.add_argument(
        "--output-dir",
        default=str(ROOT.parent / "learning_data"),
        help="データセット・レポートの出力先 (default: editor/learning_data)",
    )
    args = parser.parse_args()

    # 引数なしのときはNextcloud共有フォルダ(CatCut-learning/exports/)の全エクスポートを取り込む
    export_paths = list(args.exports)
    if not export_paths:
        learning_dir = find_nextcloud_learning_dir()
        exports_dir = learning_dir / "exports" if learning_dir else None
        if exports_dir and exports_dir.is_dir():
            export_paths = sorted(str(p) for p in exports_dir.glob("catcut-learning-*.json"))
            if export_paths:
                print(f"Nextcloud共有フォルダから取り込みます: {exports_dir}")

    exports: List[Dict[str, Any]] = []
    for export_path in export_paths:
        exports.append(load_export(export_path))
        print(f"取り込み: {export_path}")
    if args.local:
        exports.append(collect_local_export(ROOT.parent / "runs", default_correction_history_path()))
        print("取り込み: このPCの runs/ + correction_history.json")
    if not exports:
        parser.error(
            "エクスポートJSONが見つかりません。パスを指定するか --local を付けてください"
            "(Nextcloudの CatCut-learning/exports/ も自動探索します)"
        )

    dataset = build_dataset(exports)
    merged_pairs = merge_correction_pairs(
        [(export.get("correctionHistory") or {}).get("pairs") or [] for export in exports],
    )
    evaluation = evaluate_dataset(dataset, merged_pairs)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M")

    dataset_path = output_dir / f"dataset_{stamp}.json"
    with open(dataset_path, "w", encoding="utf-8") as f:
        json.dump({"version": "1.0.0", "entries": dataset}, f, ensure_ascii=False, indent=2)

    report = build_report(exports, dataset, merged_pairs, evaluation)
    report_path = output_dir / f"report_{stamp}.md"
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(report)

    if args.merge_history:
        history_path = default_correction_history_path()
        history_path.parent.mkdir(parents=True, exist_ok=True)
        with open(history_path, "w", encoding="utf-8") as f:
            json.dump({"version": "1.0.0", "pairs": merged_pairs}, f, ensure_ascii=False, indent=2)
        print(f"再学習: {history_path} へ {len(merged_pairs)}ペアを反映しました")

        # 統合結果をNextcloudへ公開する。各PCのCat-Cutが解析時に自動で参照する
        # (shared_correction_history.json の書き手はこのツール=開発機だけ。コンフリクトしない)
        learning_dir = find_nextcloud_learning_dir()
        if learning_dir:
            learning_dir.mkdir(parents=True, exist_ok=True)
            shared_path = learning_dir / "shared_correction_history.json"
            tmp_path = learning_dir / ".shared_correction_history.json.tmp"
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump({"version": "1.0.0", "pairs": merged_pairs}, f, ensure_ascii=False, indent=2)
            tmp_path.replace(shared_path)
            print(f"共有公開: {shared_path} へ {len(merged_pairs)}ペアを公開しました(全PCが次回解析から参照)")

    print("")
    print(f"データセット: {dataset_path}")
    print(f"レポート:     {report_path}")
    print(
        f"編集{evaluation['total_edits']}件 / 既知ペアカバー率 {evaluation['coverage_rate']:.1%} / "
        f"統合ペア{len(merged_pairs)}件"
    )


if __name__ == "__main__":
    main()
