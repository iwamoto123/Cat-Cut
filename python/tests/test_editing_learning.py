"""Confirmed editor examples: no APIs, user data, or Nextcloud writes."""
import copy
import json
import io
import os
import sys
import tempfile
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch
from contextlib import redirect_stdout

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shared.editing_learning import (
    build_editing_examples_section, load_editing_corpus, load_prompt_examples,
    merge_editing_corpora, select_editing_examples, split_corpus_holdout,
    source_id_for_media,
)
from tools.eval_edit_learning import (
    build_dataset, build_report, build_shared_correction_history, evaluate_dataset, latest_exports,
)
import step05_ai_retake
import step06b_ai_refine
import step06c_direction
import step06d_final_text_review
import run_headless_pipeline
from tools import eval_edit_learning
from shared.direction import build_directed_cut_content, select_slots_for_cut


def project(project_id="p1", source_id="source1", revision="rev1", confirmed="2026-09-08T10:00:00Z", kind="line_break"):
    before = {"text": "青空の下で\n話します", "scenes": [{"startMs": 100000, "endMs": 102000, "text": "青空の下で\n話します"}],
              "keepSegments": [{"startMs": 100000, "endMs": 102000}]}
    after = {"text": "青空の\n下で話します", "scenes": [{"startMs": 100000, "endMs": 101800, "text": "青空の\n下で話します"}],
             "keepSegments": [{"startMs": 100000, "endMs": 101800}]}
    return {"projectId": project_id, "sourceId": source_id, "revision": revision, "confirmedAt": confirmed,
            "examples": [{"exampleId": project_id + kind, "projectId": project_id, "sourceId": source_id,
                          "revision": revision, "confirmedAt": confirmed, "kind": kind, "before": before, "after": after,
                          "context": {"sourceText": "青空の下で話します", "orientation": "vertical", "telopMode": "directed"}}]}


def corpus(*projects):
    return {"version": "1.0.0", "kind": "catcut-editing-corpus", "projects": list(projects)}


class CorpusTests(unittest.TestCase):
    def test_latest_confirmed_revision_and_empty_tombstone_win_in_any_order(self):
        initial = project()
        newer = project(revision="rev2", confirmed="2026-09-08T11:00:00Z")
        newer["examples"] = []
        for inputs in [[corpus(initial), corpus(newer)], [corpus(newer), corpus(initial), corpus(initial)]]:
            result = merge_editing_corpora(inputs)
            self.assertEqual(result["projects"], [newer])

    def test_unconfirmed_mismatched_and_excluded_examples_never_enter_prompts(self):
        invalid = project()
        invalid.pop("confirmedAt")
        valid = project("p2")
        valid["examples"][0]["revision"] = "another"
        blocked = project("p3")
        data = corpus(invalid, valid, blocked)
        data["excludedExampleIds"] = ["p3line_break"]
        result = merge_editing_corpora([data])
        self.assertEqual(sum(len(item["examples"]) for item in result["projects"]), 0)
        self.assertEqual(result["excludedExampleIds"], ["p3line_break"])

    def test_loader_missing_corrupt_and_old_files_are_empty(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "corpus.json"
            self.assertEqual(load_editing_corpus(path)["projects"], [])
            for text in ["{bad", "[]", '{"entries":[{}]}']:
                path.write_text(text)
                self.assertEqual(load_editing_corpus(path)["projects"], [])

    def test_runtime_env_excludes_current_source_and_keeps_orientation_context(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            path = run / "corpus.json"
            path.write_text(json.dumps(corpus(project(), project("p2", "copy-source"))))
            (run / "editing_learning.json").write_text(json.dumps({"projectId": "current", "sourceId": "copy-source"}))
            (run / "orientation.json").write_text('{"orientation":"vertical"}')
            with patch.dict(os.environ, {"CATCUT_EDITING_LEARNING_PATH": str(path)}):
                examples = load_prompt_examples(run)
            self.assertEqual([item["projectId"] for item in examples], ["p1"])
            self.assertEqual(examples[0]["_currentContext"]["orientation"], "vertical")

    def test_holdout_has_no_source_leakage_including_copied_projects(self):
        data = corpus(project(), project("copy", "source1"), project("p2", "source2"), project("p3", "source3"))
        split = split_corpus_holdout(data)
        train = {item["sourceId"] for item in split["train"]["projects"]}
        held = {item["sourceId"] for item in split["holdout"]["projects"]}
        self.assertTrue(train and held)
        self.assertFalse(train & held)
        self.assertFalse(split["aiEvaluated"])
        self.assertEqual(split_corpus_holdout(corpus(project()))["reason"], "needs_at_least_two_sources")

    def test_fresh_run_same_media_with_new_stt_and_duration_is_excluded_before_baseline_exists(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original, copied = root / "old-name.mp4", root / "new-name.mp4"
            original.write_bytes(bytes(range(256)) * 800)
            copied.write_bytes(original.read_bytes())
            source_id = source_id_for_media(original)
            self.assertEqual(source_id, source_id_for_media(copied))
            self.assertIsNone(source_id_for_media(root / "missing"))
            (root / "step01_preprocess").mkdir()
            (root / "step01_preprocess" / "preprocess.json").write_text(json.dumps({"video_path": str(copied), "metadata": {"duration_ms": 999999}}))
            (root / "step02_stt").mkdir()
            (root / "step02_stt" / "stt_result.json").write_text('{"words":[{"text":"再解析で異なる本文","end_ms":987654}]}')
            path = root / "corpus.json"
            path.write_text(json.dumps(corpus(project("previous-project", source_id), project("unrelated", "another-source"))))
            with patch.dict(os.environ, {"CATCUT_EDITING_LEARNING_PATH": str(path)}):
                result = load_prompt_examples(root)
            self.assertEqual([item["projectId"] for item in result], ["unrelated"])

    def test_media_fingerprint_matches_actual_node_helpers_for_short_and_long_files(self):
        repo = Path(__file__).resolve().parents[2]
        script = ("const {mediaLearningIdentity}=require('./desktop/main/learningIntegration.cjs');"
                  "const {createHash}=require('node:crypto');"
                  "process.stdout.write(createHash('sha256').update(JSON.stringify({sourceIdentity:mediaLearningIdentity(process.argv[1])})).digest('hex'));")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "media.bin"
            for size in [0, 20, 65536, 180000]:
                path.write_bytes((b"synthetic" * ((size // 9) + 1))[:size])
                node = subprocess.check_output(["node", "-e", script, str(path)], cwd=repo, text=True)
                self.assertEqual(source_id_for_media(path), node)


class PromptTests(unittest.TestCase):
    def test_pure_line_move_is_kept_and_absolute_times_are_not_injected(self):
        examples = project()["examples"]
        section = build_editing_examples_section(examples, {"line_break"}, "青空の下で話します")
        self.assertIn('青空の\\n下で話します', section)
        self.assertNotIn("100000", section)
        self.assertNotIn("102000", section)

    def test_cut_examples_are_contextual_and_prompt_budget_is_bounded(self):
        examples = [project(str(index), kind="cut")["examples"][0] for index in range(20)]
        section = build_editing_examples_section(examples, {"cut"}, "青空の下で話します")
        self.assertLessEqual(len(section), 6000)
        self.assertIn('"keptDurationMs":2000', section)
        self.assertIn('"keptDurationMs":1800', section)
        self.assertIn("一律の削除規則ではありません", section)
        self.assertEqual(build_editing_examples_section(examples, {"cut"}, "XYZ"), "")

    def test_matching_orientation_and_kind_reserve_rank(self):
        preferred = project("preferred")["examples"][0]
        preferred["_currentContext"] = {"orientation": "vertical"}
        other = copy.deepcopy(preferred)
        other["exampleId"] = "other"
        other["context"]["orientation"] = "horizontal"
        chosen = select_editing_examples([other, preferred], {"line_break"}, "青空の下で話します", 1)
        self.assertEqual(chosen[0]["exampleId"], preferred["exampleId"])

    def test_new_examples_reach_all_relevant_prompt_builders(self):
        examples = [project(kind=kind)["examples"][0] for kind in ["cut", "proofreading", "line_break", "scene_boundary"]]
        p5 = step05_ai_retake.build_prompt([{"id": "s", "text": "青空の下で話します"}], editing_examples=examples)
        self.assertIn('"kind":"cut"', p5)
        self.assertNotIn('"kind":"line_break"', p5)
        p6b = step06b_ai_refine.build_prompt("青空の下で話します", [{"text": "青空の下で話します"}], 16, 2, editing_examples=examples)
        self.assertIn('"kind":"scene_boundary"', p6b)
        final = step06b_ai_refine.build_final_pass_prompt("青空の下で話します", [{"text": "青空の下で話します"}], editing_examples=examples)
        self.assertIn('"kind":"proofreading"', final)
        self.assertNotIn('"kind":"scene_boundary"', final)
        p6c = step06c_direction.build_slot_prompt([{"slot_id": "s", "text": "青空の下で話します"}], editing_examples=examples)
        self.assertIn('"kind":"line_break"', p6c)
        self.assertIn("merge_with_next:true", p6c)
        p6d = step06d_final_text_review.build_prompt([{"scene_id": "s", "text": "青空の下で話します"}], editing_examples=examples)
        self.assertIn('"kind":"proofreading"', p6d)
        self.assertNotIn('"kind":"cut"', p6d)

    def test_no_corpus_preserves_legacy_prompt_bytes(self):
        calls = [
            (step05_ai_retake.build_prompt, ([{"id": "s", "text": "本文"}],)),
            (step06b_ai_refine.build_prompt, ("本文", [], 16, 2)),
            (step06b_ai_refine.build_final_pass_prompt, ("本文", [])),
            (step06c_direction.build_slot_prompt, ([{"slot_id": "s", "text": "本文"}],)),
            (step06d_final_text_review.build_prompt, ([{"scene_id": "s", "text": "本文"}],)),
        ]
        for fn, args in calls:
            self.assertEqual(fn(*args), fn(*args, editing_examples=[]))


class ExportTests(unittest.TestCase):
    def export(self, machine, stamp, count, after="正表記"):
        return {"machine": machine, "exportedAt": stamp, "runs": [{"run": "r", "entries": [{"scene_id": "s", "before": "誤表記", "after": after, "ts": stamp}]}],
                "correctionHistory": {"pairs": [{"before": "誤表記", "after": "正表記", "count": count}]}}

    def test_cumulative_snapshots_do_not_double_count_and_order_does_not_revert(self):
        old = self.export("A", "2026-09-01", 2, "旧表記")
        new = self.export("A", "2026-09-02", 3)
        exports = [new, old, new]
        self.assertEqual(build_shared_correction_history(exports)["pairs"][0]["count"], 3)
        self.assertEqual(build_dataset(exports)[0]["after"], "正表記")
        self.assertEqual(latest_exports(exports), [new])

    def test_reexporting_aggregate_preserves_contributions_without_new_votes(self):
        exports = [self.export("A", "2026-09-01", 2), self.export("B", "2026-09-01", 3)]
        shared = build_shared_correction_history(exports)
        reexport = {"machine": "developer", "exportedAt": "2026-09-03", "correctionHistory": shared}
        self.assertEqual(build_shared_correction_history([*exports, reexport])["pairs"][0]["count"], 5)
        exports[0] = self.export("A", "2026-09-04", 4)
        self.assertEqual(build_shared_correction_history([reexport, *exports])["pairs"][0]["count"], 7)

    def test_latest_noop_retracts_old_scene_and_report_never_claims_ai_precision(self):
        exports = [self.export("A", "2026-09-01", 2), self.export("A", "2026-09-02", 2, "誤表記")]
        self.assertEqual(build_dataset(exports), [])
        empty = merge_editing_corpora([])
        report = build_report(exports, [], [], evaluate_dataset([], []), empty, split_corpus_holdout(empty))
        self.assertIn("AI精度ではありません", report)
        self.assertIn("2件未満", report)

    def test_cli_publishes_separate_provenance_corpus_without_overwriting_local_observations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            local = root / "user" / "correction_history.json"
            local.parent.mkdir()
            local.write_text('{"pairs":[{"before":"自分","after":"本人","count":1}]}')
            original = local.read_bytes()
            export = self.export("A", "2026-09-08", 2)
            export.update({"kind": "catcut-learning-export", "editingCorpus": corpus(project(), project("p2", "source2"))})
            export_path = root / "export.json"
            export_path.write_text(json.dumps(export))
            output = root / "output"
            with patch.object(sys, "argv", ["eval", str(export_path), "--output-dir", str(output), "--merge-history"]), \
                    patch.object(eval_edit_learning, "default_correction_history_path", return_value=local), \
                    patch.object(eval_edit_learning, "find_nextcloud_learning_dir", return_value=None), redirect_stdout(io.StringIO()):
                eval_edit_learning.main()
            self.assertEqual(local.read_bytes(), original)
            shared = json.loads((output / "shared_correction_history.json").read_text())
            self.assertEqual(shared["origin"], "aggregate")
            self.assertEqual(shared["contributions"][0]["machine"], "A")
            self.assertEqual(len(json.loads((output / "shared_editing_learning_corpus.json").read_text())["projects"]), 2)
            self.assertEqual(len(list(output.glob("editing_holdout_*.json"))), 1)

    def test_timestamp_order_uses_actual_time_across_timezones(self):
        old = self.export("A", "2026-09-08T18:00:00+09:00", 2)
        newer = self.export("A", "2026-09-08T10:00:00Z", 3)
        self.assertEqual(latest_exports([newer, old]), [newer])


class HeadlessTests(unittest.TestCase):
    def test_headless_invokes_contextual_cut_step_with_valid_cli_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run = root / "runs" / "test"
            (run / "step01_preprocess").mkdir(parents=True)
            (run / "step01_preprocess" / "preprocess.json").write_text('{"orientation":"horizontal"}')
            with patch.object(run_headless_pipeline, "ROOT", root), \
                    patch.object(run_headless_pipeline, "PYTHON", Path(sys.executable)), \
                    patch.object(run_headless_pipeline, "load_project_config", return_value={"telop": {"mode": "directed"}}), \
                    patch.object(run_headless_pipeline, "run_cmd") as cmd, redirect_stdout(io.StringIO()):
                run_headless_pipeline.run_pipeline(video_path=root / "video.mp4", run_dir=run,
                    stt_provider="local-whisper", whisper_model="tiny", stop_at="review", auto_export=False,
                    title="合成テスト", customer_id="test")
            commands = [call.args[0] for call in cmd.call_args_list]
            cut = next(command for command in commands if command[0] == "python/step05_ai_retake.py")
            self.assertIn("--fillers", cut)
            self.assertIn("--retakes-output", cut)
            self.assertLess(commands.index(cut), next(index for index, command in enumerate(commands) if command[0] == "python/step07_cut_proposal.py"))


class DisplayMergeTests(unittest.TestCase):
    def slots(self):
        return [{"slot_id": "s1", "cut_id": "c1", "source_start_ms": 1000, "source_end_ms": 2000,
                 "text": "青空の", "speaker": "speaker0"},
                {"slot_id": "s2", "cut_id": "c1", "source_start_ms": 2000, "source_end_ms": 3500,
                 "text": "下で話します", "speaker": "speaker0"}]

    def response(self):
        return [{"slots": [{"slot_id": "s1", "text": "青空の\n下で話します", "merge_with_next": True},
                           {"slot_id": "s2", "text": "下で話します"}], "op_picks": ["s2"]}]

    def test_merge_extends_known_time_preserves_all_text_and_reaches_output(self):
        slots = self.slots()
        original = copy.deepcopy(slots)
        directives, _, picks, _ = step06c_direction.apply_slot_responses(slots, self.response(), max_text_chars=20)
        self.assertEqual(slots, original)
        self.assertEqual(len(directives), 1)
        self.assertEqual(directives[0]["source_end_ms"], 3500)
        self.assertEqual(directives[0]["text"].replace("\n", ""), "青空の下で話します")
        self.assertEqual(picks[0]["slot_id"], "s1")
        segment = {"start_ms": 1000, "end_ms": 3500}
        mapped = select_slots_for_cut(directives, segment["start_ms"], segment["end_ms"])
        self.assertEqual((mapped[0]["start_ms"], mapped[0]["end_ms"]), (0, 2500))
        pages, telops = build_directed_cut_content("c1", mapped, [], 2500, 16)
        self.assertEqual(len(pages), 1)
        self.assertEqual((pages[0]["start_ms"], pages[0]["end_ms"]), (0, 2500))
        self.assertEqual("".join(pages[0]["lines"]), "青空の下で話します")
        self.assertEqual(segment, {"start_ms": 1000, "end_ms": 3500})

    def test_gap_other_cut_speaker_excess_length_or_missing_words_reject_merge(self):
        cases = [("source_start_ms", 2100), ("cut_id", "c2"), ("speaker", "speaker1")]
        for key, value in cases:
            slots = self.slots()
            slots[1][key] = value
            result = step06c_direction.apply_slot_responses(slots, self.response(), max_text_chars=20)[0]
            self.assertEqual([item["text"] for item in result], ["青空の", "下で話します"])
        self.assertEqual(len(step06c_direction.apply_slot_responses(self.slots(), self.response(), max_text_chars=3)[0]), 2)
        response = self.response()
        response[0]["slots"][0]["text"] = "青空だけ"
        response[0]["slots"][1] = {"slot_id": "s2", "drop": True}
        result = step06c_direction.apply_slot_responses(self.slots(), response, max_text_chars=20)[0]
        self.assertEqual([item["text"] for item in result], ["青空の", "下で話します"])


if __name__ == "__main__":
    unittest.main()
