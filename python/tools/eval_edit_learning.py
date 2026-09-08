"""学習データ(catcut-learning-*.json)の集約・共有・評価用分割ツール(開発機用)。

各PC(自分・社員)のCat-Cutで「学習済み修正 → 学習データを書き出す」が生成した
エクスポートJSONを取り込み、次を行う:

1. 集約: 全PCの編集履歴(元テキスト/表示テキスト/編集後)を1つのデータセットへ統合
2. 共有: 修正ペアと確定編集例を、ローカル観測とは別の共有正本へマージ
   (step05/step06b のプロンプト注入が全PC分の修正例で賢くなる)
3. 記述統計: 既知ペア被覆率と素材単位の評価用分割を出力(AIの精度測定ではない)

Usage:
    # エクスポートを集約してレポートだけ見る
    .venv/bin/python python/tools/eval_edit_learning.py exports/*.json

    # 自分のMacのruns/も直接取り込む場合
    .venv/bin/python python/tools/eval_edit_learning.py exports/*.json --local

    # 共有正本へ公開する場合(各PCのローカル観測履歴は上書きしない)
    .venv/bin/python python/tools/eval_edit_learning.py exports/*.json --merge-history
"""

from __future__ import annotations

import argparse
import json
import hashlib
import socket
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from shared.app_paths import default_correction_history_path  # noqa: E402
from shared.editing_learning import merge_editing_corpora, split_corpus_holdout, timestamp_rank  # noqa: E402

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
    history_record: Dict[str, Any] = {"version": "1.0.0", "pairs": []}
    if correction_history_path.is_file():
        try:
            with open(correction_history_path, "r", encoding="utf-8") as f:
                raw = json.load(f)
            if isinstance(raw, dict) and isinstance(raw.get("pairs"), list):
                history_record = raw
        except (OSError, json.JSONDecodeError):
            pass
    corpus_path = correction_history_path.parent / "editing_learning_corpus.json"
    try:
        corpus = json.loads(corpus_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        corpus = {}
    return {
        "version": "1.0.0",
        "kind": "catcut-learning-export",
        "machine": socket.gethostname(),
        "exportedAt": datetime.now().isoformat(),
        "runs": runs,
        "correctionHistory": history_record,
        "editingCorpus": merge_editing_corpora([corpus]),
    }


# ---------------------------------------------------------------------------
# 集約・マージ(純関数)
# ---------------------------------------------------------------------------

def _export_stamp(export: Dict[str, Any]) -> str:
    return str(export.get("exportedAt") or max(
        (str(entry.get("ts") or "") for run in export.get("runs", []) if isinstance(run, dict)
         for entry in run.get("entries", []) if isinstance(entry, dict)), default=""))


def latest_exports(exports: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Full snapshots from one machine replace each other, never accumulate."""
    latest: Dict[str, Dict[str, Any]] = {}
    for export in exports:
        if not isinstance(export, dict):
            continue
        identity = str(export.get("machine") or "unknown")
        previous = latest.get(identity)
        tie = json.dumps(export, ensure_ascii=False, sort_keys=True)
        rank = (timestamp_rank(_export_stamp(export)), hashlib.sha256(tie.encode()).hexdigest())
        if previous is None or rank > (timestamp_rank(_export_stamp(previous)), hashlib.sha256(json.dumps(previous, ensure_ascii=False, sort_keys=True).encode()).hexdigest()):
            latest[identity] = export
    return [latest[key] for key in sorted(latest)]


def build_shared_correction_history(exports: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Keep per-machine provenance so published counts cannot become new votes."""
    candidates = []
    for export in latest_exports(exports):
        history = export.get("correctionHistory") or {}
        if not isinstance(history, dict):
            continue
        if history.get("origin") == "aggregate":
            for contribution in history.get("contributions") or []:
                if isinstance(contribution, dict) and contribution.get("machine"):
                    candidates.append({"machine": contribution["machine"], "exportedAt": contribution.get("exportedAt", ""),
                                       "runs": [], "correctionHistory": {"pairs": contribution.get("pairs") or []}})
        else:
            candidates.append(export)
    contributions = [{"machine": export.get("machine") or "unknown", "exportedAt": _export_stamp(export),
                      "pairs": merge_correction_pairs([(export.get("correctionHistory") or {}).get("pairs") or []])}
                     for export in latest_exports(candidates)]
    return {"version": "1.1.0", "origin": "aggregate", "contributions": contributions,
            "pairs": merge_correction_pairs([item["pairs"] for item in contributions])}

def build_dataset(exports: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """全エクスポートのシーン編集を1つのデータセット(1行=1シーン編集)へ統合する。

    PCごとの最新全件snapshotを採用し、同一sceneは最新tsを採用する。
    """
    by_key: Dict[str, Dict[str, Any]] = {}
    for export in latest_exports(exports):
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
                candidate = {
                    "machine": machine,
                    "run": run_name,
                    "scene_id": scene_id,
                    "source": str(entry.get("source") or ""),
                    "before": before,
                    "after": after,
                    "ts": str(entry.get("ts") or ""),
                }
                if key not in by_key or timestamp_rank(candidate["ts"]) >= timestamp_rank(by_key[key]["ts"]):
                    by_key[key] = candidate
    return list(by_key.values())


def merge_correction_pairs(histories: List[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """複数PCの修正ペアをcount合算で統合する(上限はLRUでなくcount降順で切る)。"""
    merged: Dict[str, Dict[str, Any]] = {}
    for pairs in histories:
        for entry in pairs or []:
            if not isinstance(entry, dict):
                continue
            before = str(entry.get("before") or "").strip()
            after = str(entry.get("after") or "").strip()
            if not before or not after or before == after or max(len(before), len(after)) > 40:
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
    corpus: Dict[str, Any] | None = None,
    holdout: Dict[str, Any] | None = None,
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
    lines.append("## 既知ペアによる被覆率（記述統計・AI精度ではありません）")
    lines.append("")
    lines.append(
        f"- 編集 {evaluation['total_edits']}件中 **{evaluation['covered_by_known_pairs']}件"
        f"({evaluation['coverage_rate']:.1%})** は学習済みペアで説明可能"
    )
    lines.append("- 同じ収集データ由来の語ペアとの一致を数えた値です。AI推論・未見動画での改善は測定していません。")
    if corpus is not None and holdout is not None:
        counts = {}
        for project in corpus["projects"]:
            for example in project["examples"]:
                counts[example["kind"]] = counts.get(example["kind"], 0) + 1
        lines.extend(["", "## 書き出し確定済みの編集例と評価用分割", "",
                      f"- 種類別件数: {json.dumps(counts, ensure_ascii=False)}",
                      f"- 参照用 {len(holdout['train']['projects'])}プロジェクト / 評価用 {len(holdout['holdout']['projects'])}プロジェクト",
                      "- 同一素材の複製は同じ側へ配置します。参照用と評価用の素材重複は0件です。",
                      "- AIを実行した評価結果はありません。カット過剰削除ms・境界誤差・文字誤り率などは未測定です。"])
        if holdout["reason"] != "holdout_ready":
            lines.append("- 独立した素材が2件未満のため、評価用分割はまだ成立しません。")
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
    lines.append("- `--merge-history` は共有用正本を公開します。各PCのローカル観測履歴へ統合件数を書き戻しません。")
    lines.append("- 回数が多い確定的な誤記はユーザー辞書(user_dictionary.json)への昇格を検討")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Cat-Cut学習データの集約・共有・評価用分割")
    parser.add_argument("exports", nargs="*", help="catcut-learning-*.json (社員PCからの書き出し)")
    parser.add_argument("--local", action="store_true", help="このPCのruns/とcorrection_historyも取り込む")
    parser.add_argument(
        "--merge-history",
        action="store_true",
        help="統合修正ペアと確定編集例を共有正本へ公開する(ローカル観測履歴は変更しない)",
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
    shared_history = build_shared_correction_history(exports)
    merged_pairs = shared_history["pairs"]
    corpus = merge_editing_corpora([export.get("editingCorpus") or {} for export in exports])
    holdout = split_corpus_holdout(corpus)
    evaluation = evaluate_dataset(dataset, merged_pairs)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M")

    dataset_path = output_dir / f"dataset_{stamp}.json"
    with open(dataset_path, "w", encoding="utf-8") as f:
        json.dump({"version": "1.1.0", "entries": dataset, "editingCorpus": corpus}, f, ensure_ascii=False, indent=2)

    for label in ["train", "holdout"]:
        (output_dir / f"editing_{label}_{stamp}.json").write_text(
            json.dumps(holdout[label], ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
        )

    report = build_report(latest_exports(exports), dataset, merged_pairs, evaluation, corpus, holdout)
    report_path = output_dir / f"report_{stamp}.md"
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(report)

    if args.merge_history:
        publish_dir = find_nextcloud_learning_dir() or output_dir
        publish_dir.mkdir(parents=True, exist_ok=True)
        for filename, payload in [("shared_correction_history.json", shared_history),
                                  ("shared_editing_learning_corpus.json", corpus)]:
            shared_path = publish_dir / filename
            tmp_path = publish_dir / f".{filename}.tmp"
            tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            tmp_path.replace(shared_path)
            print(f"共有用正本: {shared_path}")

    print("")
    print(f"データセット: {dataset_path}")
    print(f"レポート:     {report_path}")
    print(
        f"編集{evaluation['total_edits']}件 / 既知ペアカバー率 {evaluation['coverage_rate']:.1%} / "
        f"統合ペア{len(merged_pairs)}件"
    )


if __name__ == "__main__":
    main()
