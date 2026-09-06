# W15: 学習データエクスポートの集約・修正ペア統合・カバレッジ評価のテスト。
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tools.eval_edit_learning import (
    build_dataset,
    collect_local_export,
    evaluate_dataset,
    load_export,
    merge_correction_pairs,
)


def _export(machine, runs, pairs):
    return {
        "version": "1.0.0",
        "kind": "catcut-learning-export",
        "machine": machine,
        "runs": runs,
        "correctionHistory": {"version": "1.0.0", "pairs": pairs},
    }


class BuildDatasetTests(unittest.TestCase):
    def test_merges_multiple_machines(self):
        exports = [
            _export(
                "mac-a",
                [{"run": "run1", "entries": [
                    {"scene_id": "s1", "source": "元", "before": "表示", "after": "編集後", "ts": "t1"},
                ]}],
                [],
            ),
            _export(
                "mac-b",
                [{"run": "run1", "entries": [
                    {"scene_id": "s1", "source": "元b", "before": "表示b", "after": "編集後b", "ts": "t2"},
                ]}],
                [],
            ),
        ]
        dataset = build_dataset(exports)
        # 別マシンの同名run・同名sceneは別エントリとして残る
        self.assertEqual(len(dataset), 2)
        self.assertEqual({entry["machine"] for entry in dataset}, {"mac-a", "mac-b"})

    def test_skips_noop_and_empty_scene_id(self):
        exports = [
            _export("mac-a", [{"run": "run1", "entries": [
                {"scene_id": "s1", "before": "同じ", "after": "同じ", "ts": "t"},
                {"scene_id": "", "before": "a", "after": "b", "ts": "t"},
            ]}], []),
        ]
        self.assertEqual(build_dataset(exports), [])

    def test_same_machine_same_scene_is_deduped_last_wins(self):
        exports = [
            _export("mac-a", [{"run": "run1", "entries": [
                {"scene_id": "s1", "before": "表示", "after": "古い編集", "ts": "t1"},
            ]}], []),
            _export("mac-a", [{"run": "run1", "entries": [
                {"scene_id": "s1", "before": "表示", "after": "新しい編集", "ts": "t2"},
            ]}], []),
        ]
        dataset = build_dataset(exports)
        self.assertEqual(len(dataset), 1)
        self.assertEqual(dataset[0]["after"], "新しい編集")


class MergeCorrectionPairsTests(unittest.TestCase):
    def test_counts_are_summed_across_machines(self):
        merged = merge_correction_pairs([
            [{"before": "平谷塾", "after": "白谷塾", "count": 2}],
            [{"before": "平谷塾", "after": "白谷塾", "count": 3},
             {"before": "協定", "after": "共テ", "count": 1}],
        ])
        self.assertEqual(len(merged), 2)
        self.assertEqual(merged[0]["before"], "平谷塾")  # count降順
        self.assertEqual(merged[0]["count"], 5)

    def test_invalid_pairs_are_dropped(self):
        merged = merge_correction_pairs([
            [{"before": "", "after": "x"}, {"before": "同じ", "after": "同じ"}, {"before": "a", "after": "b"}],
        ])
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["count"], 1)


class EvaluateDatasetTests(unittest.TestCase):
    def test_coverage_and_source_stats(self):
        dataset = [
            # 既知ペア(平谷塾→白谷塾)で説明できる編集
            {"source": "平谷塾です", "before": "平谷塾です", "after": "白谷塾です"},
            # 既知ペアで説明できない編集。表示テキストがSTT生と異なる(AI整形済み)
            {"source": "えー国語はですね", "before": "国語はですね", "after": "現代文はですね"},
        ]
        pairs = [{"before": "平谷塾", "after": "白谷塾", "count": 5}]
        result = evaluate_dataset(dataset, pairs)
        self.assertEqual(result["total_edits"], 2)
        self.assertEqual(result["covered_by_known_pairs"], 1)
        self.assertEqual(result["coverage_rate"], 0.5)
        self.assertEqual(result["source_differs_from_display"], 1)
        self.assertEqual(len(result["uncovered_samples"]), 1)

    def test_empty_dataset(self):
        result = evaluate_dataset([], [])
        self.assertEqual(result["total_edits"], 0)
        self.assertEqual(result["coverage_rate"], 0.0)


class LoadAndCollectTests(unittest.TestCase):
    def test_load_export_rejects_wrong_kind(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "bad.json"
            path.write_text(json.dumps({"kind": "other"}), encoding="utf-8")
            with self.assertRaises(ValueError):
                load_export(str(path))

    def test_collect_local_export_reads_runs_and_history(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            runs_root = Path(tmpdir) / "runs"
            (runs_root / "run1").mkdir(parents=True)
            (runs_root / "run1" / "edit_history.json").write_text(
                json.dumps({"version": "1.0.0", "entries": [
                    {"scene_id": "s1", "source": "元", "before": "表示", "after": "編集後", "ts": "t"},
                ]}, ensure_ascii=False),
                encoding="utf-8",
            )
            (runs_root / "run2").mkdir()  # edit_history無し=含まれない
            history_path = Path(tmpdir) / "correction_history.json"
            history_path.write_text(
                json.dumps({"version": "1.0.0", "pairs": [{"before": "誤", "after": "正", "count": 1}]}),
                encoding="utf-8",
            )
            export = collect_local_export(runs_root, history_path)
            self.assertEqual(export["kind"], "catcut-learning-export")
            self.assertEqual(len(export["runs"]), 1)
            self.assertEqual(export["runs"][0]["run"], "run1")
            self.assertEqual(len(export["correctionHistory"]["pairs"]), 1)

    def test_collect_local_export_missing_paths(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            export = collect_local_export(
                Path(tmpdir) / "nai_runs", Path(tmpdir) / "nai_history.json",
            )
            self.assertEqual(export["runs"], [])
            self.assertEqual(export["correctionHistory"]["pairs"], [])


if __name__ == "__main__":
    unittest.main()
