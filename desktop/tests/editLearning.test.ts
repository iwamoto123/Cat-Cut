// W14-2: 編集学習の正本管理(main/editLearning.cjs)のテスト。
// edit_history.json(シーン単位・初期テキスト保持)と correction_history.json
// (語レベルペア・頻度カウント・上限500 LRU)の読み書きを一時ディレクトリで検証する。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const editLearning = require("../main/editLearning.cjs");

function tempFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catcut-edit-learning-"));
  return path.join(dir, name);
}

// --- correction_history.json ---

test("Nextcloud共有 combineCorrectionHistories: 同一ペアはcount合算・updatedAtは新しい方・二重計上しない", () => {
  const local = {
    version: "1.0.0",
    pairs: [
      { before: "平谷塾", after: "白谷塾", count: 2, updatedAt: "2026-08-01T00:00:00.000Z" },
      { before: "協定", after: "共テ", count: 1, updatedAt: "2026-08-02T00:00:00.000Z" },
    ],
  };
  const shared = {
    version: "1.0.0",
    pairs: [
      { before: "平谷塾", after: "白谷塾", count: 5, updatedAt: "2026-08-10T00:00:00.000Z" },
      { before: "宮廷", after: "旧帝", count: 3, updatedAt: "2026-08-05T00:00:00.000Z" },
    ],
  };
  const combined = editLearning.combineCorrectionHistories(local, shared);
  assert.equal(combined.pairs.length, 3);
  const merged = combined.pairs.find((p: { before: string }) => p.before === "平谷塾");
  assert.equal(merged.count, 7);
  assert.equal(merged.updatedAt, "2026-08-10T00:00:00.000Z");
  // 導出関数なので繰り返し合成しても結果は同じ(累積しない)
  const again = editLearning.combineCorrectionHistories(local, shared);
  assert.deepEqual(again, combined);
});

test("Nextcloud共有 combineCorrectionHistories: 空・不正エントリは無視し上限500でLRU", () => {
  const manyPairs = Array.from({ length: 501 }, (_, i) => ({
    before: `誤${i}`,
    after: `正${i}`,
    count: 1,
    updatedAt: `2026-08-01T00:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z`,
  }));
  const combined = editLearning.combineCorrectionHistories(
    { version: "1.0.0", pairs: manyPairs },
    { version: "1.0.0", pairs: [{ before: "", after: "x" }, { before: "same", after: "same" }] },
  );
  assert.equal(combined.pairs.length, 500);
  const empty = editLearning.combineCorrectionHistories(null, undefined);
  assert.deepEqual(empty, { version: "1.0.0", pairs: [] });
});

test("W14-2 loadCorrectionHistory: ファイルが無い・壊れている場合は空履歴(後方互換)", () => {
  const filePath = tempFile("correction_history.json");
  assert.deepEqual(editLearning.loadCorrectionHistory(filePath), { version: "1.0.0", pairs: [] });
  fs.writeFileSync(filePath, "{broken json", "utf-8");
  assert.deepEqual(editLearning.loadCorrectionHistory(filePath), { version: "1.0.0", pairs: [] });
});

test("W14-2 recordCorrectionPairs: 新規ペアはcount=1で追加・同一ペアはcount加算", () => {
  const filePath = tempFile("correction_history.json");
  let history = editLearning.recordCorrectionPairs(
    filePath,
    [{ before: "平谷塾", after: "白谷塾" }],
    "2026-07-14T00:00:00.000Z",
  );
  assert.equal(history.pairs.length, 1);
  assert.equal(history.pairs[0].count, 1);

  history = editLearning.recordCorrectionPairs(
    filePath,
    [
      { before: "平谷塾", after: "白谷塾" },
      { before: "協定", after: "共テ" },
    ],
    "2026-07-14T01:00:00.000Z",
  );
  assert.equal(history.pairs.length, 2);
  const shirataniPair = history.pairs.find((pair: { before: string }) => pair.before === "平谷塾");
  assert.equal(shirataniPair.count, 2);
  assert.equal(shirataniPair.updatedAt, "2026-07-14T01:00:00.000Z");

  // 保存済みファイルからも同じ内容が読める
  assert.deepEqual(editLearning.loadCorrectionHistory(filePath).pairs.length, 2);
});

test("W14-2 recordCorrectionPairs: 無効なペア(空・同一・過長)は捨てる", () => {
  const filePath = tempFile("correction_history.json");
  const history = editLearning.recordCorrectionPairs(filePath, [
    { before: "", after: "白谷塾" },
    { before: "同じ", after: "同じ" },
    { before: "あ".repeat(41), after: "正" },
    { before: "有効", after: "ペア" },
  ]);
  assert.equal(history.pairs.length, 1);
  assert.equal(history.pairs[0].before, "有効");
});

test("W14-2 mergeCorrectionPairs: 上限500件を超えたら更新が古いペアからLRUで削除する", () => {
  let history = { version: "1.0.0", pairs: [] };
  const baseMs = Date.UTC(2026, 6, 14, 0, 0, 0);
  for (let index = 0; index < 505; index += 1) {
    history = editLearning.mergeCorrectionPairs(
      history,
      [{ before: `誤り${index}`, after: `正解${index}` }],
      new Date(baseMs + index * 1000).toISOString(),
    );
  }
  assert.equal(history.pairs.length, editLearning.CORRECTION_HISTORY_MAX_PAIRS);
  const befores = new Set(history.pairs.map((pair: { before: string }) => pair.before));
  // 最初に登録した(最も古い)5件が削除されている
  for (const dropped of ["誤り0", "誤り1", "誤り2", "誤り3", "誤り4"]) {
    assert.equal(befores.has(dropped), false);
  }
  assert.equal(befores.has("誤り504"), true);
});

test("W14-2 deleteCorrectionPair: 指定ペアだけ削除する(誤learningの解除)", () => {
  const filePath = tempFile("correction_history.json");
  editLearning.recordCorrectionPairs(filePath, [
    { before: "平谷塾", after: "白谷塾" },
    { before: "協定", after: "共テ" },
  ]);
  const history = editLearning.deleteCorrectionPair(filePath, { before: "平谷塾", after: "白谷塾" });
  assert.equal(history.pairs.length, 1);
  assert.equal(history.pairs[0].before, "協定");
});

// --- edit_history.json ---

test("W14-2 loadEditHistory: ファイルが無ければ空履歴(後方互換)", () => {
  const filePath = tempFile("edit_history.json");
  assert.deepEqual(editLearning.loadEditHistory(filePath), { version: "1.0.0", entries: [] });
});

test("W14-2 recordSceneEdit: 同一scene_idはbefore(初期テキスト)を保ったままafterのみ更新する", () => {
  const filePath = tempFile("edit_history.json");
  editLearning.recordSceneEdit(
    filePath,
    { sceneId: "scene_1", before: "初期テキスト", after: "1回目の編集" },
    "2026-07-14T00:00:00.000Z",
  );
  const history = editLearning.recordSceneEdit(
    filePath,
    { sceneId: "scene_1", before: "1回目の編集", after: "2回目の編集" },
    "2026-07-14T01:00:00.000Z",
  );
  assert.equal(history.entries.length, 1);
  assert.equal(history.entries[0].scene_id, "scene_1");
  // beforeは中間状態(1回目の編集)ではなく初期テキストのまま
  assert.equal(history.entries[0].before, "初期テキスト");
  assert.equal(history.entries[0].after, "2回目の編集");
  assert.equal(history.entries[0].ts, "2026-07-14T01:00:00.000Z");
});

test("W14-2 recordSceneEdit: 別シーンは別エントリとして追加する", () => {
  const filePath = tempFile("edit_history.json");
  editLearning.recordSceneEdit(filePath, { sceneId: "scene_1", before: "a", after: "b" });
  const history = editLearning.recordSceneEdit(filePath, {
    sceneId: "scene_2",
    before: "c",
    after: "d",
  });
  assert.equal(history.entries.length, 2);
  assert.deepEqual(
    history.entries.map((entry: { scene_id: string }) => entry.scene_id),
    ["scene_1", "scene_2"],
  );
});

test("W14-2 recordSceneEdit: sceneId無しは無視される(履歴を壊さない)", () => {
  const filePath = tempFile("edit_history.json");
  const history = editLearning.recordSceneEdit(filePath, { sceneId: "", before: "a", after: "b" });
  assert.equal(history.entries.length, 0);
});

// --- W15: source(元テキスト)と学習データ書き出し ---

test("W15 recordSceneEdit: source(元テキスト)を記録し、旧エントリには後追いで埋める", () => {
  const filePath = tempFile("edit_history.json");
  // W14時代のエントリ(source無し)を模擬
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      version: "1.0.0",
      entries: [{ scene_id: "scene_1", before: "表示A", after: "編集A", ts: "2026-07-14T00:00:00.000Z" }],
    }),
    "utf-8",
  );
  // 読み込み時はsource=""で後方互換
  assert.equal(editLearning.loadEditHistory(filePath).entries[0].source, "");
  // 再編集でsourceが後追いで埋まる(beforeは初期テキストのまま)
  const history = editLearning.recordSceneEdit(
    filePath,
    { sceneId: "scene_1", source: "元テキストA", before: "編集A", after: "編集A2" },
    "2026-07-14T01:00:00.000Z",
  );
  assert.equal(history.entries[0].source, "元テキストA");
  assert.equal(history.entries[0].before, "表示A");
  assert.equal(history.entries[0].after, "編集A2");
});

test("W15 buildLearningExport: 全runのedit_historyとcorrection_historyを1つへ集約する", () => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "catcut-export-runs-"));
  fs.mkdirSync(path.join(runsRoot, "run_a"));
  fs.writeFileSync(
    path.join(runsRoot, "run_a", "edit_history.json"),
    JSON.stringify({
      version: "1.0.0",
      entries: [{ scene_id: "s1", source: "元", before: "表示", after: "編集後", ts: "t" }],
    }),
    "utf-8",
  );
  // edit_historyが無いrun・空runは含まれない
  fs.mkdirSync(path.join(runsRoot, "run_b"));
  const correctionPath = tempFile("correction_history.json");
  fs.writeFileSync(
    correctionPath,
    JSON.stringify({ version: "1.0.0", pairs: [{ before: "誤", after: "正", count: 3, updatedAt: "t" }] }),
    "utf-8",
  );

  const exportData = editLearning.buildLearningExport({
    runsRoot,
    correctionHistoryPath: correctionPath,
    machineLabel: "test-mac",
  });
  assert.equal(exportData.kind, "catcut-learning-export");
  assert.equal(exportData.machine, "test-mac");
  assert.deepEqual(exportData.stats, { runs: 1, editEntries: 1, correctionPairs: 1 });
  assert.equal(exportData.runs[0].run, "run_a");
  assert.equal(exportData.runs[0].entries[0].source, "元");
  assert.equal(exportData.correctionHistory.pairs[0].before, "誤");
});

test("W15 buildLearningExport: runsRootが無い場合も空で正常に返す", () => {
  const exportData = editLearning.buildLearningExport({
    runsRoot: path.join(os.tmpdir(), "catcut-not-exist-runs"),
    correctionHistoryPath: tempFile("correction_history.json"),
    machineLabel: "test-mac",
  });
  assert.deepEqual(exportData.stats, { runs: 0, editEntries: 0, correctionPairs: 0 });
});

test("W17 recordEditExample: 同じrun+sceneは初期表示を保ち最新確定文へ更新する", () => {
  const filePath = tempFile("telop_edit_examples.json");
  editLearning.recordEditExample(
    filePath,
    { run: "run_a", sceneId: "s1", source: "元発話", before: "短い", after: "内容を戻した" },
    "2026-07-17T00:00:00.000Z",
  );
  const history = editLearning.recordEditExample(
    filePath,
    { run: "run_a", sceneId: "s1", source: "元発話", before: "中間", after: "内容を完全に戻した" },
    "2026-07-17T01:00:00.000Z",
  );
  assert.equal(history.entries.length, 1);
  assert.equal(history.entries[0].before, "短い");
  assert.equal(history.entries[0].after, "内容を完全に戻した");
  assert.equal(history.entries[0].source, "元発話");
});
