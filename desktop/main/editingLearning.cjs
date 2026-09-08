// Successful-export learning snapshots. Pure Node; never calls a model or modifies source media.
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const VERSION = "1.0.0";
const STATE_FILE = "editing_learning.json";
const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const now = () => new Date().toISOString();
const statePath = (runDir) => path.join(runDir, STATE_FILE);

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  // A damaged archive is an error, never permission to erase accumulated examples.
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
function writeAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, "utf8");
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
function deepFreeze(value) {
  if (!value || typeof value !== "object") return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}
function ranges(value, start = 0, end = Infinity) {
  const sorted = (Array.isArray(value) ? value : []).flatMap((item) => {
    const a = item?.startMs ?? item?.start_ms;
    const b = item?.endMs ?? item?.end_ms;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return [];
    const startMs = Math.max(start, a), endMs = Math.min(end, b);
    return endMs > startMs ? [{ startMs, endMs }] : [];
  }).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const result = [];
  for (const item of sorted) {
    const last = result[result.length - 1];
    if (last && item.startMs <= last.endMs) last.endMs = Math.max(last.endMs, item.endMs);
    else result.push({ ...item });
  }
  return result;
}
function subtract(kept, removed) {
  const result = [];
  let index = 0;
  for (const range of kept) {
    let cursor = range.startMs;
    while (index < removed.length && removed[index].endMs <= cursor) index++;
    for (let i = index; i < removed.length && removed[i].startMs < range.endMs; i++) {
      if (removed[i].startMs > cursor) result.push({ startMs: cursor, endMs: Math.min(range.endMs, removed[i].startMs) });
      cursor = Math.max(cursor, removed[i].endMs);
      if (cursor >= range.endMs) break;
    }
    if (cursor < range.endMs) result.push({ startMs: cursor, endMs: range.endMs });
  }
  return result;
}
function normalizeWords(value) {
  return (Array.isArray(value) ? value : []).flatMap((word, index) => {
    const startMs = word?.startMs ?? word?.start_ms;
    const endMs = word?.endMs ?? word?.end_ms;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
    return [{ id: String(word.id ?? `word_${index}`), text: String(word.text ?? ""), startMs, endMs,
      ...(word.speaker ? { speaker: String(word.speaker) } : {}) }];
  });
}
function sceneRanges(scene, startMs, endMs) {
  // Exact waveform cuts override transcript deletion/autoTrimmed status.
  if (Array.isArray(scene.sourceKeepRanges)) return ranges(scene.sourceKeepRanges, startMs, endMs);
  if (Array.isArray(scene.keptRanges)) return ranges(scene.keptRanges, startMs, endMs);
  const words = Array.isArray(scene.words) ? scene.words : [];
  const removed = [];
  let runStart = -1;
  for (let i = 0; i <= words.length; i++) {
    if (i < words.length && words[i].deleted) { if (runStart === -1) runStart = i; continue; }
    if (runStart !== -1) {
      removed.push({ startMs: runStart === 0 ? startMs : words[runStart].startMs,
        endMs: i === words.length ? endMs : words[i - 1].endMs });
      runStart = -1;
    }
  }
  return subtract([{ startMs, endMs }], ranges(removed, startMs, endMs));
}
function normalizeScenes(value) {
  return (Array.isArray(value) ? value : []).flatMap((scene, index) => {
    const startMs = scene?.sourceStartMs ?? scene?.startMs;
    const endMs = scene?.sourceEndMs ?? scene?.endMs;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
    const words = Array.isArray(scene.words) ? scene.words : [];
    return [{ sceneId: String(scene.id ?? scene.sceneId ?? `scene_${index}`), startMs, endMs,
      sourceWordIds: Array.isArray(scene.sourceWordIds) ? scene.sourceWordIds.map(String) : words.filter((word) => !word.silence).map((word) => String(word.id)),
      text: String(scene.telopText ?? scene.text ?? ""), keptRanges: sceneRanges(scene, startMs, endMs),
      speed: Number.isFinite(scene.speed) && scene.speed > 0 ? scene.speed : 1 }];
  }).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}
function snapshot(scenes, keepSegments) {
  const normalized = normalizeScenes(scenes);
  const kept = Array.isArray(scenes) ? ranges(normalized.flatMap((scene) => scene.keptRanges)) : ranges(keepSegments);
  const semanticScenes = normalized.map(({ startMs, endMs, text, keptRanges, speed }) => ({ startMs, endMs, text, keptRanges, speed }));
  return { revision: hash({ scenes: semanticScenes, keepSegments: kept }), scenes: normalized, keepSegments: kept };
}
function contextFromTranscript(transcript) {
  const width = Number(transcript.canvasWidth ?? transcript.width ?? 0);
  const height = Number(transcript.canvasHeight ?? transcript.height ?? 0);
  const orientation = ["horizontal", "vertical"].includes(transcript.orientation) ? transcript.orientation
    : width > 0 && height > 0 ? (height > width ? "vertical" : "horizontal") : "unknown";
  return { orientation, telopMode: String(transcript.telopMode ?? "unknown") };
}
function loadState(runDir) {
  const state = readJson(statePath(runDir));
  if (state && (state.kind !== "catcut-editing-learning" || !state.projectId || !state.sourceId || !state.baseline)) {
    throw new Error("編集学習の基準ファイルが不正です。");
  }
  return state;
}
function ensureBaseline({ runDir, transcript = {}, rawWords = [], sourceIdentity, provenance = "legacy_observed" }) {
  const existing = loadState(runDir);
  if (existing) return existing;
  const originalWords = normalizeWords(rawWords);
  const aiWords = normalizeWords(transcript.words);
  // Initial UI scenes are passed before draft hydration. Missing older baselines stay explicitly
  // unavailable instead of guessing text/page boundaries from a later export's composition.
  const initialScenes = Array.isArray(transcript.initialScenes) ? normalizeScenes(transcript.initialScenes) : null;
  const timestamp = now();
  const baseline = {
    capturedAt: timestamp,
    provenance: provenance === "ai_original" ? "ai_original" : "legacy_observed",
    rawWords: originalWords,
    originalDurationMs: Number(transcript.originalDurationMs) || 0,
    ai: { words: aiWords, sentences: clone(transcript.sentences ?? []), keepSegments: ranges(transcript.keepSegments),
      scenes: initialScenes, telopPageBoundaries: clone(transcript.telopPageBoundaries ?? []) },
    context: contextFromTranscript(transcript),
  };
  const state = { version: VERSION, kind: "catcut-editing-learning", projectId: randomUUID(),
    sourceId: hash(sourceIdentity ? { sourceIdentity }
      : { words: originalWords.length ? originalWords : aiWords, durationMs: baseline.originalDurationMs }),
    createdAt: timestamp, baseline, current: null, confirmedRevisions: [] };
  writeAtomic(statePath(runDir), state);
  return clone(state);
}
function recordCurrent({ runDir, scenes, keepSegments }) {
  const state = loadState(runDir);
  if (!state) throw new Error("編集学習の基準がまだ保存されていません。");
  const current = snapshot(scenes, keepSegments);
  if (state.current?.revision === current.revision) return state;
  const next = { ...state, current: { ...current, savedAt: now() } };
  writeAtomic(statePath(runDir), next);
  return clone(next);
}
function captureForExport(runDir) {
  const state = loadState(runDir);
  if (!state?.current) return null;
  return deepFreeze(clone({ version: VERSION, projectId: state.projectId, sourceId: state.sourceId, baseline: state.baseline, current: state.current }));
}
function emptyCorpus() { return { version: VERSION, kind: "catcut-editing-corpus", projects: [], excludedExampleIds: [] }; }
function loadCorpus(corpusPath) {
  const raw = corpusPath ? readJson(corpusPath) : null;
  if (!raw) return emptyCorpus();
  if (raw.kind !== "catcut-editing-corpus" || !Array.isArray(raw.projects)) throw new Error("編集学習コーパスの形式が不正です。");
  const excludedExampleIds = [...new Set((raw.excludedExampleIds ?? []).filter((id) => typeof id === "string"))];
  const excluded = new Set(excludedExampleIds);
  return { ...raw, excludedExampleIds, projects: raw.projects.map((project) => ({ ...project,
    examples: (project.examples ?? []).filter((example) => !excluded.has(example.exampleId)) })) };
}
function representation(scenes, kept) {
  const visible = scenes.filter((scene) => scene.keptRanges.length);
  return { text: visible.map((scene) => scene.text).join(""),
    scenes: visible.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })), keepSegments: kept };
}
function connectedComponents(before, after) {
  const entries = [...before.map((scene) => ({ scene, side: "before" })), ...after.map((scene) => ({ scene, side: "after" }))]
    .filter(({ scene }) => scene.keptRanges.length).sort((a, b) => a.scene.startMs - b.scene.startMs || a.scene.endMs - b.scene.endMs);
  const result = [];
  for (const entry of entries) {
    let group = result[result.length - 1];
    // Touching rows stay separate. A merged row overlaps its former rows and connects them.
    if (!group || entry.scene.startMs >= group.endMs) {
      group = { startMs: entry.scene.startMs, endMs: entry.scene.endMs, before: [], after: [] };
      result.push(group);
    }
    group.endMs = Math.max(group.endMs, entry.scene.endMs);
    group[entry.side].push(entry.scene);
  }
  return result;
}
const stripWhitespace = (text) => text.replace(/\s+/gu, "");
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function deriveExamples(captured, confirmedAt) {
  const { baseline, current, projectId, sourceId } = captured;
  const context = { ...baseline.context, baselineProvenance: baseline.provenance };
  const beforeScenes = baseline.ai.scenes;
  const examples = [];
  const sourceWords = baseline.rawWords.length ? baseline.rawWords : baseline.ai.words;
  function add(kind, before, after, startMs, endMs, extraContext = {}) {
    const sourceText = sourceWords.filter((word) => word.startMs < endMs && word.endMs > startMs).map((word) => word.text).join("");
    const identity = { projectId, kind, before, after, startMs, endMs, extraContext };
    examples.push({ exampleId: hash(identity), projectId, sourceId, revision: current.revision, kind, before, after,
      context: { ...context, sourceStartMs: startMs, sourceEndMs: endMs, sourceText, ...extraContext }, confirmedAt });
  }
  // Keep cut examples local even when a merged caption spans the entire video. Text here is
  // explicitly source transcript context; arbitrary edited caption text has no word alignment.
  const changedRanges = [
    ...subtract(baseline.ai.keepSegments, current.keepSegments).map((range) => ({ range, action: "removed" })),
    ...subtract(current.keepSegments, baseline.ai.keepSegments).map((range) => ({ range, action: "restored" })),
  ];
  const sourceEndMs = baseline.originalDurationMs || Math.max(0, ...baseline.ai.keepSegments.map((range) => range.endMs), ...current.keepSegments.map((range) => range.endMs));
  for (const change of changedRanges) {
    const startMs = Math.max(0, change.range.startMs - 1500);
    const endMs = Math.min(sourceEndMs, change.range.endMs + 1500);
    const cutSide = (kept) => {
      const localKept = ranges(kept, startMs, endMs);
      const text = sourceWords.filter((word) => word.startMs < endMs && word.endMs > startMs && localKept.some((range) => range.startMs < word.endMs && range.endMs > word.startMs)).map((word) => word.text).join("");
      return { text, scenes: [], keepSegments: localKept };
    };
    add("cut", cutSide(baseline.ai.keepSegments), cutSide(current.keepSegments), startMs, endMs,
      { action: change.action, changedRange: change.range,
        changedText: sourceWords.filter((word) => word.startMs < change.range.endMs && word.endMs > change.range.startMs).map((word) => word.text).join(""),
        textBasis: "source_transcript" });
  }
  if (!beforeScenes) return examples;
  for (const group of connectedComponents(beforeScenes, current.scenes)) {
    const beforeKept = ranges(group.before.flatMap((scene) => scene.keptRanges));
    const afterKept = ranges(group.after.flatMap((scene) => scene.keptRanges));
    const before = representation(group.before, beforeKept), after = representation(group.after, afterKept);
    const timingChanged = !same(beforeKept, afterKept);
    // Removing speech changes its caption too. Do not train that as a spelling correction.
    // Joint cut+text changes remain available in the structured cut example and full archive.
    if (!timingChanged && stripWhitespace(before.text) !== stripWhitespace(after.text)) {
      add("proofreading", before, after, group.startMs, group.endMs);
    }
    if (before.scenes.length && after.scenes.length &&
        !same(before.scenes.map(({ startMs, endMs }) => [startMs, endMs]), after.scenes.map(({ startMs, endMs }) => [startMs, endMs]))) {
      add("scene_boundary", before, after, group.startMs, group.endMs);
    }
    // Newline-only evidence stays separate from typo pairs. Compare text after removing all
    // whitespace first so incidental wraps during a rewrite are not labeled layout corrections.
    if ((before.text.includes("\n") || after.text.includes("\n")) && stripWhitespace(before.text) === stripWhitespace(after.text) && before.text !== after.text) {
      add("line_break", before, after, group.startMs, group.endMs);
    }
  }
  return examples;
}
function confirmExport({ runDir, captured, corpusPath }) {
  if (!captured) return null;
  const state = loadState(runDir);
  if (!state || state.projectId !== captured.projectId || state.sourceId !== captured.sourceId) throw new Error("書き出し時の編集学習プロジェクトが一致しません。");
  const corpus = loadCorpus(corpusPath);
  const existing = corpus.projects.find((project) => project.projectId === captured.projectId);
  const confirmedAt = existing?.revision === captured.current.revision ? existing.confirmedAt : now();
  const archived = (state.confirmedRevisions ?? []).find((revision) => revision.revision === captured.current.revision);
  const examples = archived?.examples ?? deriveExamples(captured, confirmedAt);
  const excluded = new Set(corpus.excludedExampleIds);
  const project = { projectId: captured.projectId, sourceId: captured.sourceId, revision: captured.current.revision, confirmedAt,
    context: { ...captured.baseline.context, baselineProvenance: captured.baseline.provenance },
    examples: examples.filter((example) => !excluded.has(example.exampleId)).map((example) => ({ ...example, confirmedAt })) };
  const nextCorpus = { ...corpus, projects: [...corpus.projects.filter((item) => item.projectId !== project.projectId), project]
    .sort((a, b) => a.projectId.localeCompare(b.projectId)) };
  const nextState = { ...state, confirmed: { revision: project.revision, confirmedAt },
    confirmedRevisions: archived ? state.confirmedRevisions : [...(state.confirmedRevisions ?? []), { revision: project.revision, confirmedAt, examples }] };
  const changed = !same(corpus, nextCorpus);
  if (changed) writeAtomic(corpusPath, nextCorpus);
  if (!same(state, nextState)) writeAtomic(statePath(runDir), nextState);
  return { state: clone(nextState), corpus: clone(nextCorpus), project: clone(project), changed };
}
function excludeExample({ corpusPath, exampleId }) {
  const corpus = loadCorpus(corpusPath);
  if (typeof exampleId !== "string" || !exampleId || corpus.excludedExampleIds.includes(exampleId)) return corpus;
  const next = { ...corpus, excludedExampleIds: [...corpus.excludedExampleIds, exampleId].sort(),
    projects: corpus.projects.map((project) => ({ ...project, examples: project.examples.filter((example) => example.exampleId !== exampleId) })) };
  writeAtomic(corpusPath, next);
  return clone(next);
}
module.exports = { STATE_FILE, ensureBaseline, recordCurrent, captureForExport, confirmExport, loadState, loadCorpus, excludeExample, deriveExamples };
