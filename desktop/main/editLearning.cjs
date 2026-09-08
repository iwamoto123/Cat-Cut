// W14-2: 編集前→編集後の修正ペア学習の正本管理。
//
// - runs/<run>/edit_history.json … シーン単位の編集履歴(run正本)。
//   同一scene_idは最新のみ保持し、beforeは「そのシーンの初期テキスト」(最初に記録した
//   編集前テキスト)を保ち続ける(中間状態は残さない)。
// - userData/correction_history.json … 全run横断の語レベル修正ペア(誤→正)。
//   頻度カウント付き・上限500ペアでLRU(最終更新が古いものから削除)。
//   ペアの抽出(語レベルdiff・助詞/空白ノイズ除外)はrenderer側 correctionPairs.ts が担い、
//   ここでは形の検証と集約のみを行う。
//
// どちらのファイルも無ければ空として扱う=完全従来動作(後方互換)。
// electron に依存しない純Node実装(desktop/tests/editLearning.test.ts から直接テストする)。
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("node:crypto");
const editingLearning = require("./editingLearning.cjs");

/** correction_history.json に保持する修正ペアの上限(超過分はLRUで削除)。 */
const CORRECTION_HISTORY_MAX_PAIRS = 500;

/** 1ペアの片側フラグメントとして受け付ける最大文字数(壊れた入力の防波堤)。 */
const MAX_FRAGMENT_CHARS = 40;
/** W17: 演出AIへ渡すシーン単位の編集確定例の上限。 */
const EDIT_EXAMPLES_MAX_ENTRIES = 300;

function readJsonSafe(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

// ---------------------------------------------------------------------------
// correction_history.json (userData / 全run横断)
// ---------------------------------------------------------------------------

function sanitizePair(raw) {
  const before = String(raw?.before || "").trim();
  const after = String(raw?.after || "").trim();
  if (!before || !after || before === after) return null;
  if (before.length > MAX_FRAGMENT_CHARS || after.length > MAX_FRAGMENT_CHARS) return null;
  return { before, after };
}

function sanitizeCorrectionHistory(raw) {
  const pairs = [];
  for (const entry of Array.isArray(raw?.pairs) ? raw.pairs : []) {
    const pair = sanitizePair(entry);
    if (!pair) continue;
    pairs.push({
      ...pair,
      count: Math.max(1, Math.round(Number(entry?.count) || 1)),
      updatedAt: String(entry?.updatedAt || ""),
    });
  }
  const contributions = Array.isArray(raw?.contributions) ? raw.contributions
    .filter((entry) => entry && typeof entry.machine === "string" && entry.machine)
    .map((entry) => ({ machine: entry.machine, pairs: sanitizeCorrectionHistory({ pairs: entry.pairs }).pairs })) : undefined;
  return { version: contributions ? "1.1.0" : "1.0.0", pairs,
    ...(raw?.origin === "aggregate" ? { origin: "aggregate" } : {}),
    ...(raw?.kind === "catcut-shared-correction-history" ? { kind: raw.kind } : {}),
    ...(contributions ? { contributions } : {}) };
}

/** correction_history.json を読む(無い・壊れている場合は空履歴)。 */
function loadCorrectionHistory(filePath) {
  return sanitizeCorrectionHistory(readJsonSafe(filePath));
}

/**
 * 修正ペア群を履歴へ集約する(純関数)。同一の before→after は count を加算、
 * 新規は count=1 で追加し、上限超過時は updatedAt が古いペアから削除する(LRU)。
 */
function mergeCorrectionPairs(history, rawPairs, nowIso) {
  const pairs = (history?.pairs || []).map((pair) => ({ ...pair }));
  for (const raw of Array.isArray(rawPairs) ? rawPairs : []) {
    const pair = sanitizePair(raw);
    if (!pair) continue;
    const existing = pairs.find((item) => item.before === pair.before && item.after === pair.after);
    if (existing) {
      existing.count += 1;
      existing.updatedAt = nowIso;
    } else {
      pairs.push({ ...pair, count: 1, updatedAt: nowIso });
    }
  }
  if (pairs.length > CORRECTION_HISTORY_MAX_PAIRS) {
    pairs.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
    pairs.splice(0, pairs.length - CORRECTION_HISTORY_MAX_PAIRS);
  }
  return { version: "1.0.0", pairs };
}

/** 修正ペア群を correction_history.json へ集約保存する。 */
function recordCorrectionPairs(filePath, rawPairs, nowIso = new Date().toISOString()) {
  const next = mergeCorrectionPairs(loadCorrectionHistory(filePath), rawPairs, nowIso);
  writeJson(filePath, next);
  return next;
}

/**
 * ローカル履歴と共有履歴(Nextcloudの shared_correction_history.json)を合成する(純関数)。
 * 同一の before→after は count を合算し updatedAt は新しい方を残す。
 * 上限超過時は既存と同じく updatedAt が古いペアから削除する。
 * 合成結果は毎回2つの正本から導出する(累積させない)ため、繰り返し呼んでも二重計上しない。
 */
function combineCorrectionHistories(localHistory, sharedHistory, options = {}) {
  // A shared snapshot carries each machine's observations. Replace our old shared contribution
  // with current local observations instead of adding the same edits a second time.
  const sources = options.machineLabel && Array.isArray(sharedHistory?.contributions)
    ? [localHistory, ...sharedHistory.contributions.filter((entry) => entry && entry.machine !== options.machineLabel)]
    : [localHistory, sharedHistory];
  const combined = new Map();
  for (const source of sources) {
    for (const entry of source?.pairs || []) {
      const pair = sanitizePair(entry);
      if (!pair) continue;
      const key = `${pair.before}\u0000${pair.after}`;
      const count = Math.max(1, Math.round(Number(entry?.count) || 1));
      const updatedAt = String(entry?.updatedAt || "");
      const existing = combined.get(key);
      if (existing) {
        existing.count += count;
        if (updatedAt.localeCompare(existing.updatedAt) > 0) existing.updatedAt = updatedAt;
      } else {
        combined.set(key, { ...pair, count, updatedAt });
      }
    }
  }
  const pairs = [...combined.values()];
  if (pairs.length > CORRECTION_HISTORY_MAX_PAIRS) {
    pairs.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
    pairs.splice(0, pairs.length - CORRECTION_HISTORY_MAX_PAIRS);
  }
  return { version: "1.0.0", pairs };
}

/** 誤learningの解除: 指定の before→after ペアを削除して保存する。 */
function deleteCorrectionPair(filePath, input) {
  const before = String(input?.before || "");
  const after = String(input?.after || "");
  const history = loadCorrectionHistory(filePath);
  const next = {
    version: "1.0.0",
    pairs: history.pairs.filter((pair) => !(pair.before === before && pair.after === after)),
  };
  writeJson(filePath, next);
  return next;
}

// ---------------------------------------------------------------------------
// edit_history.json (run正本 / シーン単位)
// ---------------------------------------------------------------------------

function sanitizeEditHistory(raw) {
  const entries = [];
  for (const entry of Array.isArray(raw?.entries) ? raw.entries : []) {
    const sceneId = String(entry?.scene_id || "");
    if (!sceneId) continue;
    entries.push({
      scene_id: sceneId,
      // W15: 元テキスト(STT生テキスト)。W14時代のエントリには無い(空文字)
      source: String(entry?.source ?? ""),
      before: String(entry?.before ?? ""),
      after: String(entry?.after ?? ""),
      ts: String(entry?.ts || ""),
    });
  }
  return { version: "1.0.0", entries };
}

/** edit_history.json を読む(無い・壊れている場合は空履歴)。 */
function loadEditHistory(filePath) {
  return sanitizeEditHistory(readJsonSafe(filePath));
}

/**
 * シーン編集を履歴へ反映する(純関数)。既存entryがあれば before(初期テキスト)を保ったまま
 * after のみ最新へ更新する。無ければ before=今回の編集前テキストで新規追加する。
 */
function mergeSceneEdit(history, input, nowIso) {
  const sceneId = String(input?.sceneId || "");
  if (!sceneId) return sanitizeEditHistory(history);
  const entries = (history?.entries || []).map((entry) => ({ ...entry }));
  const existing = entries.find((entry) => entry.scene_id === sceneId);
  if (existing) {
    existing.after = String(input?.after ?? "");
    existing.ts = nowIso;
    // W15: W14時代の既存エントリにはsourceが無いので、あれば後追いで埋める
    if (!existing.source && input?.source) existing.source = String(input.source);
  } else {
    entries.push({
      scene_id: sceneId,
      source: String(input?.source ?? ""),
      before: String(input?.before ?? ""),
      after: String(input?.after ?? ""),
      ts: nowIso,
    });
  }
  return { version: "1.0.0", entries };
}

/** シーン編集を edit_history.json へ反映保存する。 */
function recordSceneEdit(filePath, input, nowIso = new Date().toISOString()) {
  const next = mergeSceneEdit(loadEditHistory(filePath), input, nowIso);
  writeJson(filePath, next);
  return next;
}

// ---------------------------------------------------------------------------
// W17: 全run横断の完全編集例(source→AI表示→編集者確定)
// ---------------------------------------------------------------------------

function loadEditExamples(filePath) {
  const raw = readJsonSafe(filePath);
  const entries = [];
  for (const entry of Array.isArray(raw?.entries) ? raw.entries : []) {
    const run = String(entry?.run || "");
    const sceneId = String(entry?.scene_id || "");
    const before = String(entry?.before ?? "");
    const after = String(entry?.after ?? "");
    if (!run || !sceneId || before === after) continue;
    entries.push({
      run,
      scene_id: sceneId,
      source: String(entry?.source ?? ""),
      before,
      after,
      ts: String(entry?.ts || ""),
    });
  }
  return { version: "1.0.0", entries };
}

/** 同じrun+sceneは初期beforeを保ち、最新afterへ更新する。古い例から上限超過分を落とす。 */
function recordEditExample(filePath, input, nowIso = new Date().toISOString()) {
  const history = loadEditExamples(filePath);
  const run = String(input?.run || "");
  const sceneId = String(input?.sceneId || "");
  if (!run || !sceneId) return history;
  const entries = [...history.entries];
  const existing = entries.find((entry) => entry.run === run && entry.scene_id === sceneId);
  if (existing) {
    if (!existing.source && input?.source) existing.source = String(input.source);
    existing.after = String(input?.after ?? "");
    existing.ts = nowIso;
  } else {
    entries.push({
      run,
      scene_id: sceneId,
      source: String(input?.source ?? ""),
      before: String(input?.before ?? ""),
      after: String(input?.after ?? ""),
      ts: nowIso,
    });
  }
  const valid = entries
    .filter((entry) => entry.before !== entry.after)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
    .slice(-EDIT_EXAMPLES_MAX_ENTRIES);
  const next = { version: "1.0.0", entries: valid };
  writeJson(filePath, next);
  return next;
}

// ---------------------------------------------------------------------------
// W15: 学習データの書き出し(他PC→開発機への収集用)
// ---------------------------------------------------------------------------

/**
 * 全runの edit_history.json と correction_history.json を1つのJSONへ集約する(純関数寄り)。
 * 開発機の python/tools/eval_edit_learning.py がこの形式を取り込む。
 * runsRoot が無い・edit_historyを持つrunが無い場合も空配列で正常に返す。
 */
function buildLearningExport({ runsRoot, correctionHistoryPath, machineLabel, editingCorpusPath }) {
  const runs = [];
  let entryCount = 0;
  const runNames =
    runsRoot && fs.existsSync(runsRoot)
      ? fs
          .readdirSync(runsRoot, { withFileTypes: true })
          .filter((item) => item.isDirectory())
          .map((item) => item.name)
          .sort()
      : [];
  for (const runName of runNames) {
    const historyPath = path.join(runsRoot, runName, "edit_history.json");
    const history = loadEditHistory(historyPath);
    const editingState = editingCorpusPath !== undefined ? editingLearning.loadState(path.join(runsRoot, runName)) : null;
    if (history.entries.length === 0 && !editingState) continue;
    entryCount += history.entries.length;
    runs.push({ run: runName, entries: history.entries, ...(editingState ? { editingLearning: editingState } : {}) });
  }
  const correctionHistory = loadCorrectionHistory(correctionHistoryPath);
  const editingCorpus = editingCorpusPath !== undefined ? editingLearning.loadCorpus(editingCorpusPath) : null;
  return {
    version: "1.0.0",
    kind: "catcut-learning-export",
    machine: String(machineLabel || ""),
    exportedAt: new Date().toISOString(),
    stats: {
      runs: runs.length,
      editEntries: entryCount,
      correctionPairs: correctionHistory.pairs.length,
      ...(editingCorpus ? {
        editingExamples: editingCorpus.projects.reduce((count, project) => count + project.examples.length, 0),
        confirmedProjects: editingCorpus.projects.length,
      } : {}),
    },
    runs,
    correctionHistory,
    ...(editingCorpus ? { editingCorpus } : {}),
  };
}

/** Human review companion. JSON remains the complete machine-readable source. */
function formatLearningExportText(data) {
  const lines = ["Cat-Cut 編集学習データ", `書き出し: ${data.exportedAt || ""}`, `PC: ${data.machine || ""}`, ""];
  const label = { cut: "カット / 復元", proofreading: "文章校正", scene_boundary: "シーンの区切り", line_break: "改行" };
  const formatRanges = (ranges) => (ranges || []).map((range) => `${(range.startMs / 1000).toFixed(3)}–${(range.endMs / 1000).toFixed(3)}秒`).join(", ") || "なし";
  const formatSide = (name, value) => {
    if (typeof value === "string") { lines.push(`${name}:`, value); return; }
    lines.push(`${name}:`, String(value?.text ?? ""), `保持区間: ${formatRanges(value?.keepSegments)}`);
    for (const [index, scene] of (value?.scenes || []).entries()) {
      lines.push(`  シーン${index + 1} [${(scene.startMs / 1000).toFixed(3)}–${(scene.endMs / 1000).toFixed(3)}秒]`, String(scene.text));
    }
  };
  for (const project of data.editingCorpus?.projects || []) {
    lines.push(`プロジェクト: ${project.projectId}`, `確定版: ${project.revision}`, `書き出し成功: ${project.confirmedAt}`);
    if (!project.examples.length) lines.push("基準からの有効な変更例はありません。");
    for (const example of project.examples || []) {
      lines.push("", `${label[example.kind] || example.kind} / ${example.exampleId}`, `基準の由来: ${example.context?.baselineProvenance || "不明"}`, "元の文字起こし:", String(example.context?.sourceText || ""));
      formatSide("AI提案 / 観測した基準", example.before);
      formatSide("編集者の確定結果", example.after);
    }
    lines.push("");
  }
  for (const run of data.runs || []) {
    if (!run.entries?.length) continue;
    lines.push(`互換用の旧編集記録: ${run.run}（書き出し確定の保証なし）`);
    for (const entry of run.entries) lines.push(`シーン: ${entry.scene_id}`, "元:", entry.source || "", "変更前:", entry.before || "", "変更後:", entry.after || "", "");
  }
  if (!(data.editingCorpus?.projects?.length || data.runs?.some((run) => run.entries?.length))) lines.push("蓄積された編集例はありません。");
  return `${lines.join("\n")}\n`;
}

module.exports = {
  CORRECTION_HISTORY_MAX_PAIRS,
  loadCorrectionHistory,
  mergeCorrectionPairs,
  combineCorrectionHistories,
  recordCorrectionPairs,
  deleteCorrectionPair,
  loadEditHistory,
  mergeSceneEdit,
  recordSceneEdit,
  loadEditExamples,
  recordEditExample,
  buildLearningExport,
  formatLearningExportText,
};
