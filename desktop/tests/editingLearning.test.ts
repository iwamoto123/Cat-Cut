import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { computeSceneKeptSubRanges, mergeSceneWithNext, setSceneTelopText, splitSceneAtMs, type Scene } from "../src/lib/scenes.ts";
import { cutSceneRangeMs } from "../src/lib/rangeCut.ts";
const require = createRequire(import.meta.url);
const learning = require("../main/editingLearning.cjs");
const legacy = require("../main/editLearning.cjs");
const range = (startMs: number, endMs: number) => ({ startMs, endMs });
function originalScenes(): Scene[] {
  return [
    { id: "first", sourceStartMs: 0, sourceEndMs: 2000, words: [{ id: "w1", text: "始まりです", startMs: 200, endMs: 1200, deleted: false }], telopText: "始まりです", telopEdited: false, cutMarks: [] },
    { id: "last", sourceStartMs: 2000, sourceEndMs: 4000, words: [{ id: "w2", text: "おわりです", startMs: 2600, endMs: 3500, deleted: false }], telopText: "終わりです", telopEdited: false, cutMarks: [] },
  ];
}
function fixture(t: any, scenes = originalScenes()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catcut-editing-learning-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runDir = path.join(dir, "runs", "run");
  const corpusPath = path.join(dir, "editing_learning_corpus.json");
  const transcript = { words: scenes.flatMap((scene) => scene.words), initialScenes: scenes,
    keepSegments: [range(0, 4000)], sentences: [], originalDurationMs: 4000, canvasWidth: 360, canvasHeight: 640, telopMode: "directed" };
  const rawWords = [{ id: "w1", text: "はじまりです", startMs: 200, endMs: 1200 }, { id: "w2", text: "おわりです", startMs: 2600, endMs: 3500 }];
  const state = learning.ensureBaseline({ runDir, transcript, rawWords, sourceIdentity: "fixture-source", provenance: "ai_original" });
  return { dir, runDir, corpusPath, transcript, scenes, rawWords, state };
}
function recordAndCapture(f: ReturnType<typeof fixture>, scenes: Scene[]) {
  learning.recordCurrent({ runDir: f.runDir, scenes, keepSegments: [range(0, 4000)] });
  return learning.captureForExport(f.runDir);
}

test("immutable baseline retains raw STT, original AI display and provenance across save/reopen", (t) => {
  const f = fixture(t);
  assert.equal(f.state.baseline.rawWords[0].text, "はじまりです");
  assert.equal(f.state.baseline.ai.scenes[0].text, "始まりです");
  assert.equal(f.state.baseline.provenance, "ai_original");
  const changed = setSceneTelopText(f.scenes, "first", "変更しました");
  recordAndCapture(f, changed);
  const loaded = learning.ensureBaseline({ runDir: f.runDir, transcript: { ...f.transcript, initialScenes: changed }, rawWords: [], provenance: "legacy_observed" });
  assert.deepEqual(loaded.baseline, f.state.baseline);
  assert.equal(loaded.projectId, f.state.projectId);
  assert.equal(loaded.current.scenes[0].text, "変更しました");
  assert.deepEqual(loaded.baseline.context, { orientation: "vertical", telopMode: "directed" });
});

test("legacy baseline stays labeled observed; missing initial UI baseline is not invented", (t) => {
  const f = fixture(t);
  const runDir = path.join(f.dir, "legacy");
  const transcript = { ...f.transcript, initialScenes: undefined };
  const state = learning.ensureBaseline({ runDir, transcript, rawWords: f.rawWords });
  assert.equal(state.baseline.provenance, "legacy_observed");
  assert.equal(state.baseline.ai.scenes, null);
  learning.recordCurrent({ runDir, scenes: f.scenes });
  const confirmed = learning.confirmExport({ runDir, corpusPath: f.corpusPath, captured: learning.captureForExport(runDir) });
  assert.deepEqual(confirmed.project.examples, []);
});

test("saved explicit cut intervals remain authoritative in snapshot despite supplied hull keepSegments", (t) => {
  const f = fixture(t);
  const merged = mergeSceneWithNext(f.scenes, "first");
  const cut = cutSceneRangeMs(merged, merged[0].id, 1300, 2500, { keepSingleScene: true }).scenes;
  const captured = recordAndCapture(f, cut);
  assert.deepEqual(captured.current.keepSegments, [range(0, 1300), range(2500, 4000)]);
  assert.deepEqual(captured.current.scenes[0].keptRanges, computeSceneKeptSubRanges(cut[0]));
});

test("legacy deleted-word padding matches frontend while no pending cutMark is a training decision", (t) => {
  const f = fixture(t);
  const scenes = [{ ...f.scenes[0], words: [...f.scenes[0].words, { id: "deleted", text: "削除", startMs: 1400, endMs: 1500, deleted: true }], cutMarks: [1000] }];
  const captured = recordAndCapture(f, scenes);
  assert.deepEqual(captured.current.scenes[0].keptRanges, computeSceneKeptSubRanges(scenes[0]));
  const noMark = recordAndCapture(f, [{ ...scenes[0], cutMarks: [] }]);
  assert.equal(captured.current.revision, noMark.current.revision);
});

test("recording draft does not train; frozen export capture remains separate from later edits", (t) => {
  const f = fixture(t);
  const changed = setSceneTelopText(f.scenes, "first", "開始です");
  const captured = recordAndCapture(f, changed);
  assert.equal(fs.existsSync(f.corpusPath), false);
  assert.throws(() => { captured.current.scenes[0].text = "改変"; }, TypeError);
  recordAndCapture(f, setSceneTelopText(f.scenes, "first", "未書き出しの変更"));
  const confirmed = learning.confirmExport({ runDir: f.runDir, captured, corpusPath: f.corpusPath });
  assert.equal(confirmed.project.examples[0].after.text, "開始です");
  assert.equal(learning.loadState(f.runDir).current.scenes[0].text, "未書き出しの変更");
});

test("successful exports derive distinct proofreading, newline and split/merge boundary evidence", (t) => {
  const f = fixture(t);
  const changed = setSceneTelopText(f.scenes, "first", "始まり\nです");
  const captured = recordAndCapture(f, setSceneTelopText(changed, "last", "完了です"));
  const result = learning.confirmExport({ runDir: f.runDir, captured, corpusPath: f.corpusPath });
  assert.deepEqual(result.project.examples.map((item: any) => item.kind).sort(), ["line_break", "proofreading"]);
  assert.equal(result.project.examples.find((item: any) => item.kind === "line_break").after.text, "始まり\nです");
  const merged = mergeSceneWithNext(f.scenes, "first");
  const next = learning.confirmExport({ runDir: f.runDir, captured: recordAndCapture(f, merged), corpusPath: f.corpusPath });
  assert.deepEqual(next.project.examples.map((item: any) => item.kind), ["scene_boundary"]);
  assert.equal(next.project.examples[0].before.scenes.length, 2);
  assert.equal(next.project.examples[0].after.scenes.length, 1);
});

test("cut and merge examples contain precise source intervals without calling removed speech proofreading", (t) => {
  const f = fixture(t);
  let cut = cutSceneRangeMs(f.scenes, "first", 1000, 1800).scenes;
  cut = mergeSceneWithNext(cut, cut[0].id);
  const result = learning.confirmExport({ runDir: f.runDir, captured: recordAndCapture(f, cut), corpusPath: f.corpusPath });
  const example = result.project.examples.find((item: any) => item.kind === "cut");
  assert.deepEqual(example.before.keepSegments, [range(0, 3300)]);
  assert.deepEqual(example.after.keepSegments, [range(0, 1000), range(1800, 3300)]);
  assert.equal(example.context.sourceText, "はじまりですおわりです");
  assert.deepEqual(example.context.changedRange, range(1000, 1800));
  assert.ok(!result.project.examples.some((item: any) => item.kind === "proofreading"));
});

test("Undo before first export yields no examples; later Undo replaces prior corpus contribution with empty", (t) => {
  const f = fixture(t);
  recordAndCapture(f, setSceneTelopText(f.scenes, "first", "開始です"));
  const unchanged = learning.confirmExport({ runDir: f.runDir, captured: recordAndCapture(f, f.scenes), corpusPath: f.corpusPath });
  assert.deepEqual(unchanged.project.examples, []);
  learning.confirmExport({ runDir: f.runDir, captured: recordAndCapture(f, setSceneTelopText(f.scenes, "first", "開始です")), corpusPath: f.corpusPath });
  const undone = learning.confirmExport({ runDir: f.runDir, captured: recordAndCapture(f, f.scenes), corpusPath: f.corpusPath });
  assert.equal(undone.corpus.projects.length, 1);
  assert.deepEqual(undone.corpus.projects[0].examples, []);
  assert.equal(undone.state.confirmedRevisions.length, 2, "過去の確定版は検証用アーカイブに残す");
});

test("repeat export is idempotent and scene IDs do not amplify or manufacture unchanged examples", (t) => {
  const f = fixture(t);
  const changed = setSceneTelopText(f.scenes, "first", "開始です");
  const captured = recordAndCapture(f, changed);
  const first = learning.confirmExport({ runDir: f.runDir, captured, corpusPath: f.corpusPath });
  const second = learning.confirmExport({ runDir: f.runDir, captured, corpusPath: f.corpusPath });
  assert.equal(second.changed, false);
  assert.deepEqual(second.corpus, first.corpus);
  assert.equal(second.state.confirmedRevisions.length, 1);
  const renamed = recordAndCapture(f, changed.map((scene) => ({ ...scene, id: `${scene.id}_new` })));
  assert.equal(renamed.current.revision, captured.current.revision);
});

test("split then merge back to original is not a boundary example despite changed IDs", (t) => {
  const f = fixture(t);
  const split = splitSceneAtMs(f.scenes, "first", 800, { allowEmptySpeechSide: true });
  const merged = mergeSceneWithNext(split, split[0].id);
  const result = learning.confirmExport({ runDir: f.runDir, captured: recordAndCapture(f, merged), corpusPath: f.corpusPath });
  assert.deepEqual(result.project.examples, []);
});

test("excluded examples stay excluded after re-export and unrelated new revision", (t) => {
  const f = fixture(t);
  const changed = setSceneTelopText(f.scenes, "first", "開始です");
  const first = learning.confirmExport({ runDir: f.runDir, captured: recordAndCapture(f, changed), corpusPath: f.corpusPath });
  const exampleId = first.project.examples[0].exampleId;
  const excluded = learning.excludeExample({ corpusPath: f.corpusPath, exampleId });
  assert.deepEqual(excluded.projects[0].examples, []);
  assert.deepEqual(excluded.excludedExampleIds, [exampleId]);
  const next = learning.confirmExport({ runDir: f.runDir, captured: recordAndCapture(f, setSceneTelopText(changed, "last", "完了です")), corpusPath: f.corpusPath });
  assert.equal(next.project.examples.length, 1);
  assert.equal(next.project.examples[0].after.text, "完了です");
  assert.ok(next.state.confirmedRevisions[0].examples.some((item: any) => item.exampleId === exampleId), "検証用アーカイブは削除しない");
});

test("missing captures and mismatched projects never promote unrelated edits", (t) => {
  const f = fixture(t);
  assert.equal(learning.captureForExport(f.runDir), null);
  assert.equal(learning.confirmExport({ runDir: f.runDir, corpusPath: f.corpusPath, captured: null }), null);
  const captured = recordAndCapture(f, f.scenes);
  assert.throws(() => learning.confirmExport({ runDir: f.runDir, corpusPath: f.corpusPath, captured: { ...captured, projectId: "other" } }), /一致しません/);
  assert.equal(fs.existsSync(f.corpusPath), false);
});

test("malformed existing learning files are preserved and atomic writes leave no temporary files", (t) => {
  const f = fixture(t);
  const filePath = path.join(f.runDir, learning.STATE_FILE);
  fs.writeFileSync(filePath, "broken");
  assert.throws(() => learning.ensureBaseline({ runDir: f.runDir, transcript: f.transcript }));
  assert.equal(fs.readFileSync(filePath, "utf8"), "broken");
  assert.deepEqual(fs.readdirSync(f.runDir), [learning.STATE_FILE]);
});

test("learning JSON includes run state without legacy edit_history and human TXT shows exact newlines and cuts", (t) => {
  const f = fixture(t);
  learning.confirmExport({ runDir: f.runDir, captured: recordAndCapture(f, setSceneTelopText(f.scenes, "first", "始まり\nです")), corpusPath: f.corpusPath });
  const exportData = legacy.buildLearningExport({ runsRoot: path.join(f.dir, "runs"), correctionHistoryPath: path.join(f.dir, "missing"), machineLabel: "fixture", editingCorpusPath: f.corpusPath });
  assert.equal(exportData.runs.length, 1);
  assert.deepEqual(exportData.runs[0].entries, []);
  assert.equal(exportData.runs[0].editingLearning.projectId, f.state.projectId);
  assert.equal(exportData.editingCorpus.projects[0].examples[0].kind, "line_break");
  assert.equal(exportData.stats.editingExamples, 1);
  assert.equal(exportData.stats.confirmedProjects, 1);
  const text = legacy.formatLearningExportText(exportData);
  assert.match(text, /始まり\nです/);
  assert.match(text, /元の文字起こし/);
  assert.match(text, /保持区間: 0\.000–2\.000秒/);
  const oldContract = legacy.buildLearningExport({ runsRoot: path.join(f.dir, "runs"), machineLabel: "fixture" });
  assert.equal(oldContract.editingCorpus, undefined);
  assert.deepEqual(oldContract.runs, []);
  assert.equal(oldContract.stats.editingExamples, undefined);
  assert.equal(oldContract.stats.confirmedProjects, undefined);
});

test("contribution-aware shared corrections replace this machine's count and pure merges do not mutate inputs", () => {
  const pair = (count: number) => ({ before: "誤字", after: "正字", count, updatedAt: "2026-09-08T00:00:00Z" });
  const local = { pairs: [pair(3)] };
  const shared = { origin: "aggregate", pairs: [pair(6)], contributions: [{ machine: "local", pairs: [pair(2)] }, { machine: "other", pairs: [pair(4)] }] };
  const before = structuredClone({ local, shared });
  assert.equal(legacy.combineCorrectionHistories(local, shared, { machineLabel: "local" }).pairs[0].count, 7);
  legacy.mergeCorrectionPairs(local, [{ before: "誤字", after: "正字" }], "later");
  assert.deepEqual({ local, shared }, before);
});

test("source identity groups the same video despite changed recognition and word IDs", (t) => {
  const f = fixture(t);
  const same = learning.ensureBaseline({ runDir: path.join(f.dir, "same-video"), transcript: { ...f.transcript, words: [], originalDurationMs: 4123 }, rawWords: [{ id: "changed", text: "別の認識", startMs: 100, endMs: 200 }], sourceIdentity: "fixture-source" });
  const other = learning.ensureBaseline({ runDir: path.join(f.dir, "other-video"), transcript: f.transcript, rawWords: f.rawWords, sourceIdentity: "different-source" });
  assert.equal(same.sourceId, f.state.sourceId);
  assert.notEqual(same.projectId, f.state.projectId);
  assert.notEqual(other.sourceId, f.state.sourceId);
});

test("late-video cuts use local context and exact removed/restored windows", (t) => {
  const f = fixture(t);
  const runDir = path.join(f.dir, "long-video");
  const words = [{ id: "early", text: "冒頭だけ", startMs: 100, endMs: 500, deleted: false }, { id: "late", text: "後半の言い直し", startMs: 92000, endMs: 93000, deleted: false }];
  const scenes = [{ id: "long", sourceStartMs: 0, sourceEndMs: 100000, words, telopText: "冒頭だけ後半の言い直し", telopEdited: false, cutMarks: [] }];
  learning.ensureBaseline({ runDir, transcript: { words, initialScenes: scenes, keepSegments: [range(0, 100000)], originalDurationMs: 100000 }, rawWords: words, sourceIdentity: "long", provenance: "ai_original" });
  learning.recordCurrent({ runDir, scenes: [{ ...scenes[0], sourceKeepRanges: [range(0, 92000), range(93000, 100000)] }] });
  const result = learning.confirmExport({ runDir, captured: learning.captureForExport(runDir), corpusPath: f.corpusPath });
  const cut = result.project.examples.find((item: any) => item.kind === "cut");
  assert.equal(cut.context.sourceText, "後半の言い直し");
  assert.equal(cut.context.sourceStartMs, 90500);
  assert.equal(cut.context.sourceEndMs, 94500);
  assert.equal(cut.before.text, "後半の言い直し");
  assert.equal(cut.after.text, "");
  assert.deepEqual(cut.after.keepSegments, [range(90500, 92000), range(93000, 94500)]);
  assert.equal(cut.context.action, "removed");
});

test("whole scene deletion is a cut example, restoration of AI-cut source is recorded separately", (t) => {
  const f = fixture(t);
  const deleted = learning.confirmExport({ runDir: f.runDir, captured: recordAndCapture(f, [{ ...f.scenes[0], sourceKeepRanges: [] }, f.scenes[1]]), corpusPath: f.corpusPath });
  assert.equal(deleted.project.examples.filter((item: any) => item.kind === "cut").length, 1);
  assert.ok(!deleted.project.examples.some((item: any) => item.kind === "proofreading"));
  const runDir = path.join(f.dir, "ai-cut");
  const scenes = [{ ...f.scenes[1], sourceStartMs: 2500 }];
  learning.ensureBaseline({ runDir, transcript: { ...f.transcript, keepSegments: [range(2500, 4000)], initialScenes: scenes }, rawWords: f.rawWords });
  learning.recordCurrent({ runDir, scenes: [{ ...scenes[0], sourceStartMs: 2000, sourceKeepRanges: [range(2000, 4000)] }] });
  const restored = learning.confirmExport({ runDir, captured: learning.captureForExport(runDir), corpusPath: f.corpusPath });
  const cut = restored.project.examples.find((item: any) => item.kind === "cut");
  assert.equal(cut.context.action, "restored");
  assert.deepEqual(cut.context.changedRange, range(2000, 2500));
});

test("spacing alone does not create an invented line-break correction", (t) => {
  const f = fixture(t);
  const result = learning.confirmExport({ runDir: f.runDir, captured: recordAndCapture(f, setSceneTelopText(f.scenes, "first", "始まり です")), corpusPath: f.corpusPath });
  assert.deepEqual(result.project.examples, []);
});

test("loading shared corrections preserves contribution provenance for runtime deduplication", (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, "shared_correction_history.json");
  const pair = { before: "誤字", after: "正字", count: 3, updatedAt: "now" };
  fs.writeFileSync(file, JSON.stringify({ origin: "aggregate", pairs: [pair], contributions: [{ machine: "me", pairs: [pair] }, null] }));
  const shared = legacy.loadCorrectionHistory(file);
  assert.equal(shared.origin, "aggregate");
  assert.equal(shared.contributions.length, 1);
  assert.equal(legacy.combineCorrectionHistories({ pairs: [pair] }, shared, { machineLabel: "me" }).pairs[0].count, 3);
});
