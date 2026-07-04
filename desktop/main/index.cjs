const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const yaml = require("js-yaml");
const { createApiKeysModule } = require("./apiKeys.cjs");

const DEV_SERVER_URL = "http://127.0.0.1:5174";
const DEFAULT_OLLAMA_MODEL = "qwen2.5:7b";
const ENABLE_GROUND_TRUTH_LEARNING = process.env.CATCUT_ENABLE_GROUND_TRUTH_LEARNING === "1";

let mainWindow = null;
let activeJob = null;
let previewServer = null;
let previewServerPort = null;
const previewFiles = new Map();

const steps = [
  { id: "step01_preprocess", label: "前処理" },
  { id: "step02_stt", label: "文字起こし" },
  { id: "step02b_transcript_correct", label: "STT補正" },
  { id: "step03_vad", label: "無音検出" },
  { id: "step04_filler_detect", label: "フィラー検出" },
  { id: "step05_ai_retake", label: "AI言い直し検出" },
  { id: "step07_cut_proposal", label: "カット提案" },
  { id: "step08_composition", label: "コンポジション" },
  { id: "extract_telop", label: "テロップ抽出" },
  { id: "review_telop", label: "書き出し前チェック" },
  { id: "step06b_ai_refine", label: "AI校正" },
  { id: "font_directives", label: "フォント反映" },
  { id: "apply_telop", label: "テロップ反映" },
  { id: "render", label: "書き出し" },
];

function repoRoot() {
  return path.resolve(__dirname, "..", "..");
}

function userDataPath(fileName) {
  return path.join(app.getPath("userData"), fileName);
}

/**
 * 改善8-B-1(プリセット駆動テーマへ全面切替): `templates/telop_presets.yaml` を
 * デスクトップUIの唯一のスタイル源として読み込む。yaml編集を即座に反映できるよう
 * キャッシュせず毎回読み直す(プリセット数十件程度でパースコストは無視できるため)。
 * 読み込み・パースに失敗した場合はUI側のフォールバックカタログに委ねるため空辞書を返す。
 */
function telopPresetsPath() {
  return path.join(repoRoot(), "templates", "telop_presets.yaml");
}

function loadTelopPresetCatalog() {
  try {
    const presetsPath = telopPresetsPath();
    if (!fs.existsSync(presetsPath)) return {};
    const raw = fs.readFileSync(presetsPath, "utf-8");
    const parsed = yaml.load(raw);
    const presets = parsed && typeof parsed === "object" ? parsed.presets : null;
    return presets && typeof presets === "object" ? presets : {};
  } catch (error) {
    console.error("[telop-presets] failed to load templates/telop_presets.yaml:", error);
    return {};
  }
}

function settingsPath() {
  return userDataPath("settings.json");
}

function fontProfilesPath() {
  return userDataPath("font_profiles.json");
}

function userDictionaryPath() {
  return userDataPath("user_dictionary.json");
}

function userRulesPath() {
  return userDataPath("user_rules.json");
}

function readSettingsRaw() {
  if (!fs.existsSync(settingsPath())) return {};
  try {
    return readJson(settingsPath());
  } catch {
    return {};
  }
}

const apiKeys = createApiKeysModule({
  userDataPath,
  repoRoot,
  readSettingsRaw,
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 980,
    minHeight: 660,
    title: "Cat-Cut",
    backgroundColor: "#f6f7f9",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  } else {
    mainWindow.loadURL(DEV_SERVER_URL);
  }
}

function sendJobEvent(event) {
  appendRunLog(event);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("job:event", event);
  }
}

function appendRunLog(event) {
  const runDir = activeJob?.runDir;
  if (!runDir) return;
  try {
    let text = "";
    if (event.type === "log") {
      text = event.message || "";
    } else if (event.type === "step:start") {
      text = `\n[STEP START] ${event.stepId}\n`;
    } else if (event.type === "step:done") {
      text = `\n[STEP DONE] ${event.stepId}\n`;
    } else if (event.type === "step:error") {
      text = `\n[STEP ERROR] ${event.stepId}\n`;
    } else if (event.type === "job:error") {
      text = `\n[JOB ERROR]\n${event.error || ""}\n`;
    } else if (event.type === "job:done") {
      text = "\n[JOB DONE]\n";
    }
    if (text) {
      fs.appendFileSync(path.join(runDir, "pipeline.log"), text, "utf-8");
    }
  } catch {
    // Logging must never break the pipeline itself.
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function defaultUserRules() {
  return {
    version: "1.0.0",
    dictionary: [],
    boundary: [],
    filler: [],
    cut: [],
    reviewChecks: [],
    groundTruth: [],
    decisions: [],
  };
}

function readUserRules() {
  const filePath = userRulesPath();
  if (!fs.existsSync(filePath)) return defaultUserRules();
  try {
    const parsed = readJson(filePath);
    return {
      ...defaultUserRules(),
      ...parsed,
      dictionary: Array.isArray(parsed.dictionary) ? parsed.dictionary : [],
      boundary: Array.isArray(parsed.boundary) ? parsed.boundary : [],
      filler: Array.isArray(parsed.filler) ? parsed.filler : [],
      cut: Array.isArray(parsed.cut) ? parsed.cut : [],
      reviewChecks: Array.isArray(parsed.reviewChecks) ? parsed.reviewChecks : [],
      groundTruth: Array.isArray(parsed.groundTruth) ? parsed.groundTruth : [],
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
    };
  } catch {
    return defaultUserRules();
  }
}

function saveUserRules(input) {
  const current = readUserRules();
  const next = {
    ...current,
    ...input,
    dictionary: Array.isArray(input?.dictionary) ? input.dictionary : current.dictionary,
    boundary: Array.isArray(input?.boundary) ? input.boundary : current.boundary,
    filler: Array.isArray(input?.filler) ? input.filler : current.filler,
    cut: Array.isArray(input?.cut) ? input.cut : current.cut,
    reviewChecks: Array.isArray(input?.reviewChecks) ? input.reviewChecks : current.reviewChecks,
    groundTruth: Array.isArray(input?.groundTruth) ? input.groundTruth : current.groundTruth,
    decisions: Array.isArray(input?.decisions) ? input.decisions : current.decisions,
    updatedAt: new Date().toISOString(),
  };
  writeJson(userRulesPath(), next);
  return next;
}

function learnDictionaryRule(input) {
  const wrong = String(input?.wrong || "").trim();
  const correct = String(input?.correct || "").trim();
  const category = String(input?.category || "common_misrecognition");
  if (!wrong || !correct || wrong === correct) return readUserRules();

  const rules = readUserRules();
  const existing = rules.dictionary.find((rule) => rule.wrong === wrong && rule.correct === correct);
  if (existing) {
    existing.count = Number(existing.count || 0) + 1;
    existing.updatedAt = new Date().toISOString();
  } else {
    rules.dictionary.push({
      id: crypto.randomUUID(),
      category,
      wrong,
      correct,
      count: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  return saveUserRules(rules);
}

/** 改善10-B-2: step02b向けユーザー辞書(userData/user_dictionary.json)。 */
function defaultUserDictionary() {
  return { entries: [] };
}

function readUserDictionary() {
  const filePath = userDictionaryPath();
  if (!fs.existsSync(filePath)) return defaultUserDictionary();
  try {
    const parsed = readJson(filePath);
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    return {
      entries: entries
        .map((entry) => ({
          from: String(entry?.from || "").trim(),
          to: String(entry?.to || "").trim(),
        }))
        .filter((entry) => entry.from && entry.to && entry.from !== entry.to),
    };
  } catch {
    return defaultUserDictionary();
  }
}

function writeUserDictionary(data) {
  writeJson(userDictionaryPath(), data);
  return data;
}

function saveUserDictionaryEntry(input) {
  const from = String(input?.from || "").trim();
  const to = String(input?.to || "").trim();
  if (!from || !to || from === to) return readUserDictionary();
  const current = readUserDictionary();
  const withoutSameFrom = current.entries.filter((entry) => entry.from !== from);
  return writeUserDictionary({ entries: [...withoutSameFrom, { from, to }] });
}

function deleteUserDictionaryEntry(fromValue) {
  const from = String(fromValue || "").trim();
  if (!from) return readUserDictionary();
  const current = readUserDictionary();
  return writeUserDictionary({ entries: current.entries.filter((entry) => entry.from !== from) });
}

function recordLearningDecision(input) {
  const rules = readUserRules();
  const decisions = [
    {
      id: crypto.randomUUID(),
      kind: String(input?.kind || "telop"),
      action: String(input?.action || "unknown"),
      findingType: String(input?.findingType || ""),
      pageId: String(input?.pageId || ""),
      source: input?.source == null ? null : String(input.source),
      suggestion: input?.suggestion == null ? null : String(input.suggestion),
      message: input?.message == null ? null : String(input.message),
      createdAt: new Date().toISOString(),
    },
    ...rules.decisions,
  ].slice(0, 500);
  return saveUserRules({ ...rules, decisions });
}

function parseClockToMs(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!match) return null;
  const fraction = match[4] ? Number(match[4].padEnd(3, "0").slice(0, 3)) : 0;
  return (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000 + fraction;
}

function formatTelopTime(ms) {
  const safeMs = Math.max(0, Math.round(Number(ms) || 0));
  const totalSeconds = safeMs / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${seconds.toFixed(2).padStart(5, "0")}`;
}

function parseTelopClockToMs(value) {
  const match = String(value || "").trim().match(/^(\d+):(\d{2})\.(\d{2})$/);
  if (!match) return null;
  return (Number(match[1]) * 60 + Number(match[2])) * 1000 + Number(match[3]) * 10;
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function medianAbs(values) {
  return median(values.map((value) => Math.abs(value)));
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function normalizeTextForLearning(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[。、！？!?,.\s]/g, "")
    .toLowerCase();
}

function parseTelopTextWithTiming(text) {
  const pages = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    current.text = current.lines.filter((line) => line.trim()).join("\n");
    pages.push(current);
    current = null;
  };
  for (const raw of String(text || "").split(/\r?\n/)) {
    const header = raw.trim().match(/^#\s*(cut_\d+_p\d+)\s+\[(\d+:\d{2}\.\d{2})-(\d+:\d{2}\.\d{2})\]/);
    if (header) {
      flush();
      current = {
        id: header[1],
        startMs: parseTelopClockToMs(header[2]) ?? 0,
        endMs: parseTelopClockToMs(header[3]) ?? 0,
        lines: [],
        text: "",
      };
      continue;
    }
    if (!current || raw.trim().startsWith("#")) continue;
    current.lines.push(raw);
  }
  flush();
  return pages;
}

function cleanGroundTruthText(value) {
  return String(value || "")
    .replace(/\uFEFF/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseGroundTruthTextContent(content, filePath = "") {
  const rawEntries = [];
  const timePattern = "(\\d{1,2}:\\d{2}:\\d{2}(?:[.,]\\d{1,3})?)";
  for (const rawLine of String(content || "").split(/\r?\n/)) {
    const line = rawLine.replace(/^\uFEFF/, "").trimEnd();
    if (!line.trim()) continue;
    const match = line.match(new RegExp(`^\\s*${timePattern}(?:\\s+${timePattern})?\\s+(.+?)\\s*$`));
    if (!match) continue;
    const startMs = parseClockToMs(match[1]);
    const explicitEndMs = match[2] ? parseClockToMs(match[2]) : null;
    const text = cleanGroundTruthText(match[3]);
    if (startMs == null || !text) continue;
    rawEntries.push({ startMs, endMs: explicitEndMs, lines: [text] });
  }

  const grouped = [];
  for (const entry of rawEntries) {
    const previous = grouped[grouped.length - 1];
    if (previous && previous.startMs === entry.startMs) {
      previous.lines.push(...entry.lines);
      if (entry.endMs != null && entry.endMs > (previous.endMs || 0)) {
        previous.endMs = entry.endMs;
      }
      continue;
    }
    grouped.push({ ...entry });
  }

  const entries = grouped.map((entry, index) => {
    const nextStart = grouped[index + 1]?.startMs;
    const fallbackEnd = entry.startMs + Math.max(1200, Math.min(3500, entry.lines.join("").length * 120));
    const endMs =
      entry.endMs != null && entry.endMs > entry.startMs
        ? entry.endMs
        : nextStart != null && nextStart > entry.startMs
          ? nextStart
          : fallbackEnd;
    return {
      id: `truth_${String(index + 1).padStart(3, "0")}`,
      startMs: entry.startMs,
      endMs,
      lines: entry.lines,
      text: entry.lines.join("\n"),
    };
  });

  const durations = entries.map((entry) => entry.endMs - entry.startMs).filter((duration) => duration > 0);
  const stats = {
    entries: entries.length,
    firstStartMs: entries[0]?.startMs ?? 0,
    lastEndMs: entries[entries.length - 1]?.endMs ?? 0,
    avgDurationMs: durations.length
      ? Math.round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length)
      : 0,
    avgChars: entries.length
      ? Math.round(entries.reduce((sum, entry) => sum + entry.text.replace(/\s/g, "").length, 0) / entries.length)
      : 0,
  };

  return { path: filePath, entries, stats };
}

function parseGroundTruthTextFile(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  if (!fs.existsSync(resolved)) {
    throw new Error(`正解txtが見つかりません: ${resolved}`);
  }
  return parseGroundTruthTextContent(fs.readFileSync(resolved, "utf-8"), resolved);
}

function extractGroundTruthNotationRules(entries) {
  const text = entries.map((entry) => entry.text).join("\n");
  const knownPairs = [
    ["ライン", "LINE"],
    ["Line", "LINE"],
    ["line", "LINE"],
    ["youtube", "YouTube"],
    ["Youtube", "YouTube"],
    ["ユーチューブ", "YouTube"],
    ["url", "URL"],
    ["Url", "URL"],
    ["sns", "SNS"],
  ];
  const rules = [];
  for (const [wrong, correct] of knownPairs) {
    if (text.includes(correct)) {
      rules.push({ category: "notation", wrong, correct });
    }
  }
  return rules;
}

function upsertDictionaryRules(rules, additions) {
  for (const addition of additions) {
    if (!addition.wrong || !addition.correct || addition.wrong === addition.correct) continue;
    const existing = rules.dictionary.find(
      (rule) => rule.wrong === addition.wrong && rule.correct === addition.correct,
    );
    if (existing) {
      existing.count = Number(existing.count || 0) + 1;
      existing.updatedAt = new Date().toISOString();
    } else {
      rules.dictionary.push({
        id: crypto.randomUUID(),
        category: addition.category || "notation",
        wrong: addition.wrong,
        correct: addition.correct,
        count: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
  }
}

function writeGroundTruthDevelopmentLearning(runDir, parsed) {
  const filePath = path.join(repoRoot(), "templates", "ground_truth_learning.json");
  let current = { version: "1.0.0", examples: [] };
  if (fs.existsSync(filePath)) {
    try {
      current = readJson(filePath);
    } catch {
      current = { version: "1.0.0", examples: [] };
    }
  }
  const examples = Array.isArray(current.examples) ? current.examples : [];
  const nextExample = {
    id: crypto.randomUUID(),
    sourcePath: parsed.path,
    runDir,
    stats: parsed.stats,
    notationRules: extractGroundTruthNotationRules(parsed.entries),
    timingExamples: parsed.entries.slice(0, 80).map((entry) => ({
      startMs: entry.startMs,
      endMs: entry.endMs,
      chars: entry.text.replace(/\s/g, "").length,
      lineCount: entry.lines.length,
      text: entry.text,
    })),
    createdAt: new Date().toISOString(),
  };
  writeJson(filePath, {
    version: "1.0.0",
    updatedAt: new Date().toISOString(),
    examples: [nextExample, ...examples].slice(0, 200),
  });
}

function matchGeneratedToTruth(generatedPages, truthEntries) {
  return truthEntries.map((truth, index) => {
    let best = null;
    let bestScore = -Infinity;
    for (const generated of generatedPages) {
      const overlap = Math.max(0, Math.min(generated.endMs, truth.endMs) - Math.max(generated.startMs, truth.startMs));
      const distance = Math.abs(generated.startMs - truth.startMs);
      const score = overlap * 10 - distance;
      if (score > bestScore) {
        best = generated;
        bestScore = score;
      }
    }
    return { truth, generated: best || generatedPages[index] || null };
  });
}

function inferNotationRulesFromComparison(matches) {
  const rules = new Map();
  for (const { truth, generated } of matches) {
    const truthText = truth?.text || "";
    const generatedText = generated?.text || "";
    for (const rule of extractGroundTruthNotationRules([truth])) {
      if (generatedText.includes(rule.wrong) || truthText.includes(rule.correct)) {
        rules.set(`${rule.wrong}->${rule.correct}`, rule);
      }
    }
  }
  return Array.from(rules.values());
}

const BACKCHANNEL_TERMS = [
  "はいはい",
  "はい",
  "うんうん",
  "うん",
  "えー",
  "えっと",
  "あの",
  "まあ",
  "なんか",
  "そうですね",
];

const NUMBER_EXPRESSION_RE =
  /(?:\d[\d,]*(?:\.\d+)?|[〇零一二三四五六七八九十百千万億兆]+)(?:年|月|日|時|分|秒|時間|週間|ヶ月|か月|カ月|人|名|回|件|円|万円|億円|点|割|倍|%|パーセント|ページ|本|個|校|社|歳)?/g;
const PROPER_NOUN_LIKE_RE = /[A-Za-z][A-Za-z0-9+.#_-]{1,}|[ァ-ヴー]{3,}/g;

function compactLearningText(value) {
  return normalizeTextForLearning(value).replace(/ー/g, "");
}

function stripBackchannels(value) {
  let next = String(value || "");
  for (const term of BACKCHANNEL_TERMS) {
    next = next.split(term).join("");
  }
  return next;
}

function uniqueMatches(text, pattern) {
  const matches = new Set();
  for (const match of String(text || "").matchAll(pattern)) {
    const value = String(match[0] || "").trim();
    if (value) matches.add(value);
  }
  return Array.from(matches);
}

function hasKnownNotationDifference(generatedText, truthText) {
  const pairs = [
    ["ライン", "LINE"],
    ["Line", "LINE"],
    ["line", "LINE"],
    ["youtube", "YouTube"],
    ["Youtube", "YouTube"],
    ["ユーチューブ", "YouTube"],
    ["url", "URL"],
    ["sns", "SNS"],
  ];
  return pairs.some(([wrong, correct]) => generatedText.includes(wrong) && truthText.includes(correct));
}

function classifyGroundTruthDiff(generated, truth) {
  const generatedText = generated?.text || "";
  const truthText = truth?.text || "";
  const generatedCompact = compactLearningText(generatedText);
  const truthCompact = compactLearningText(truthText);
  const startOffsetMs = generated ? generated.startMs - truth.startMs : null;
  const endOffsetMs = generated ? generated.endMs - truth.endMs : null;
  const types = [];

  if (!generated) {
    types.push("missing_generated");
  } else {
    if (generatedCompact === truthCompact && generatedText !== truthText) {
      const generatedLines = generatedText.split(/\n/).filter(Boolean).length;
      const truthLines = truthText.split(/\n/).filter(Boolean).length;
      types.push(generatedLines === truthLines ? "notation" : "line_break");
    }
    if (generatedCompact !== truthCompact) {
      const withoutFillers = compactLearningText(stripBackchannels(generatedText));
      if (withoutFillers === truthCompact || BACKCHANNEL_TERMS.some((term) => generatedText.includes(term) && !truthText.includes(term))) {
        types.push("filler");
      }
      if (uniqueMatches(`${generatedText}\n${truthText}`, NUMBER_EXPRESSION_RE).length) {
        types.push("number");
      }
      if (uniqueMatches(`${generatedText}\n${truthText}`, PROPER_NOUN_LIKE_RE).length) {
        types.push("proper_noun");
      }
      if (hasKnownNotationDifference(generatedText, truthText)) {
        types.push("notation");
      }
      if (!types.length) {
        types.push("text_mismatch");
      }
    }
    if (Math.abs(startOffsetMs || 0) > 250 || Math.abs(endOffsetMs || 0) > 400) {
      types.push("page_boundary");
    }
  }

  const uniqueTypes = Array.from(new Set(types));
  const highRisk = uniqueTypes.some((type) => ["missing_generated", "number", "proper_noun", "filler"].includes(type));
  const severeTiming = Math.abs(startOffsetMs || 0) > 700 || Math.abs(endOffsetMs || 0) > 900;
  return {
    types: uniqueTypes,
    severity: highRisk || severeTiming ? "high" : uniqueTypes.length ? "medium" : "low",
    startOffsetMs,
    endOffsetMs,
  };
}

function readSttSentencesForRun(runDir) {
  const candidates = [
    path.join(runDir, "step02b_transcript_correct", "stt_corrected.json"),
    path.join(runDir, "step02_stt", "stt_result.json"),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const data = readJson(candidate);
      if (Array.isArray(data.sentences)) return data.sentences;
      if (Array.isArray(data.words)) {
        return data.words.map((word, index) => ({
          id: word.id || `word_${index}`,
          text: word.text || "",
          start_ms: word.start_ms,
          end_ms: word.end_ms,
        }));
      }
    } catch {
      // Ignore malformed optional STT files.
    }
  }
  return [];
}

function sttTextForRange(sentences, startMs, endMs) {
  const overlapping = sentences.filter((sentence) => {
    const sentenceStart = Number(sentence.start_ms ?? sentence.start ?? 0);
    const sentenceEnd = Number(sentence.end_ms ?? sentence.end ?? sentenceStart);
    return Math.max(sentenceStart, startMs) < Math.min(sentenceEnd, endMs);
  });
  return overlapping.map((sentence) => sentence.text || "").join("").trim();
}

function countTypes(rows) {
  const counts = {};
  for (const row of rows) {
    for (const type of row.types || []) {
      counts[type] = (counts[type] || 0) + 1;
    }
  }
  return counts;
}

function pushProposal(proposals, proposal) {
  if (proposals.some((item) => item.id === proposal.id)) return;
  proposals.push(proposal);
}

function buildGroundTruthRuleProposals(rows, parsed, generatedPages, matches) {
  const proposals = [];
  const typeCounts = countTypes(rows);
  const truthLineLengths = parsed.entries.flatMap((entry) => entry.lines.map((line) => line.replace(/\s/g, "").length));
  const truthLineMedian = median(truthLineLengths);
  const truthLinesMedian = median(parsed.entries.map((entry) => entry.lines.length));
  const generatedRatio = parsed.entries.length ? generatedPages.length / parsed.entries.length : 0;

  if (typeCounts.number) {
    pushProposal(proposals, {
      id: "review_number_expressions",
      kind: "review_check",
      type: "number",
      title: "数字表現は必ずユーザーチェックに出す",
      description: "漢数字/算用数字、日付、人数、回数、金額、点数などはSTT差分が小さく見えても意味が変わりやすいため、毎回レビュー候補に出します。",
      evidenceCount: typeCounts.number,
      payload: { checkType: "number_expression" },
    });
  }
  if (typeCounts.proper_noun) {
    pushProposal(proposals, {
      id: "review_proper_nouns",
      kind: "review_check",
      type: "proper_noun",
      title: "固有名詞・英字・カタカナ語は確認に出す",
      description: "人名、学校名、サービス名、英字表記、長いカタカナ語は誤認識しても自然な文章に見えるため、毎回レビュー候補に出します。",
      evidenceCount: typeCounts.proper_noun,
      payload: { checkType: "proper_noun_like" },
    });
  }
  if (typeCounts.filler) {
    pushProposal(proposals, {
      id: "review_backchannels",
      kind: "filler",
      type: "filler",
      title: "相槌・フィラーは境界条件つきでチェックする",
      description: "「はい」「うん」「えー」などが正解txtで落ちている場合、削除候補にします。ただし意味のある返答の可能性があるため自動削除せず、候補として出します。",
      evidenceCount: typeCounts.filler,
      payload: { terms: BACKCHANNEL_TERMS, action: "review_or_remove" },
    });
  }
  if (typeCounts.page_boundary || typeCounts.line_break) {
    pushProposal(proposals, {
      id: "review_boundaries_and_linebreaks",
      kind: "boundary",
      type: "page_boundary",
      title: "ページ境界・改行の違和感を強めにチェックする",
      description: "正解txtと生成テロップで開始/終了時刻や改行単位がズレているため、助詞終わり・名詞句分断・前後ページ連結候補をレビューに出します。",
      evidenceCount: (typeCounts.page_boundary || 0) + (typeCounts.line_break || 0),
      payload: { checkType: "boundary_and_linebreak" },
    });
  }
  if (truthLineMedian || truthLinesMedian || Math.abs(generatedRatio - 1) > 0.25) {
    pushProposal(proposals, {
      id: "telop_density_profile",
      kind: "telop_density",
      type: "density",
      title: "この正解データのテロップ密度を設計メモとして保存する",
      description: `正解txtの中央値は1行約${truthLineMedian || "-"}字、1ページ約${truthLinesMedian || "-"}行。生成/正解ページ比は${generatedRatio ? generatedRatio.toFixed(2) : "-"}です。自動適用ではなく、次の手動ルール設計の材料として保存します。`,
      evidenceCount: parsed.entries.length,
      payload: {
        maxCharsPerLineMedian: truthLineMedian,
        maxLinesPerPageMedian: truthLinesMedian,
        generatedToTruthPageRatio: generatedRatio,
      },
    });
  }

  for (const rule of inferNotationRulesFromComparison(matches).slice(0, 20)) {
    pushProposal(proposals, {
      id: `dictionary_${rule.wrong}_${rule.correct}`,
      kind: "dictionary",
      type: "notation",
      title: `${rule.wrong} → ${rule.correct} を表記ルールに追加`,
      description: "正解txt側で使われている表記に寄せるため、次回からレビュー候補に出します。",
      evidenceCount: rows.filter((row) => row.generatedText.includes(rule.wrong) || row.truthText.includes(rule.correct)).length || 1,
      payload: rule,
    });
  }

  return proposals;
}

function analyzeGroundTruthRules(input) {
  const runDir = path.resolve(String(input?.runDir || ""));
  const truthPath = String(input?.path || "");
  if (!runDir || !fs.existsSync(runDir)) {
    throw new Error(`runDir が見つかりません: ${runDir}`);
  }
  const parsed = parseGroundTruthTextFile(truthPath);
  const outputs = buildOutputs(runDir);
  const generatedPages = fs.existsSync(outputs.telop)
    ? parseTelopTextWithTiming(fs.readFileSync(outputs.telop, "utf-8"))
    : [];
  const matches = matchGeneratedToTruth(generatedPages, parsed.entries);
  const sttSentences = readSttSentencesForRun(runDir);
  const rows = matches.map(({ truth, generated }, index) => {
    const classification = classifyGroundTruthDiff(generated, truth);
    const startMs = Math.min(truth.startMs, generated?.startMs ?? truth.startMs);
    const endMs = Math.max(truth.endMs, generated?.endMs ?? truth.endMs);
    return {
      id: `diff_${String(index + 1).padStart(3, "0")}`,
      truthId: truth.id,
      pageId: generated?.id || "",
      startMs: truth.startMs,
      endMs: truth.endMs,
      generatedStartMs: generated?.startMs ?? null,
      generatedEndMs: generated?.endMs ?? null,
      startOffsetMs: classification.startOffsetMs,
      endOffsetMs: classification.endOffsetMs,
      sttText: sttTextForRange(sttSentences, startMs, endMs),
      generatedText: generated?.text || "",
      truthText: truth.text,
      types: classification.types,
      severity: classification.severity,
    };
  });
  const typeCounts = countTypes(rows);
  const exactMatches = rows.filter(
    (row) => compactLearningText(row.generatedText) === compactLearningText(row.truthText),
  ).length;
  const report = {
    version: "1.0.0",
    sourceVideoRunDir: runDir,
    sourceTruthPath: parsed.path,
    createdAt: new Date().toISOString(),
    summary: {
      truthPages: parsed.entries.length,
      generatedPages: generatedPages.length,
      matchedPages: rows.filter((row) => row.pageId).length,
      exactMatches,
      mismatchPages: Math.max(0, rows.length - exactMatches),
      typeCounts,
    },
    rows,
    proposals: buildGroundTruthRuleProposals(rows, parsed, generatedPages, matches),
  };
  writeJson(path.join(runDir, "ground_truth_rule_review.json"), report);
  return report;
}

function addOrUpdateReviewCheck(rules, proposal) {
  const checkType = String(proposal?.payload?.checkType || proposal?.type || "").trim();
  if (!checkType) return;
  const existing = rules.reviewChecks.find((rule) => rule.checkType === checkType);
  if (existing) {
    existing.count = Number(existing.count || 0) + 1;
    existing.updatedAt = new Date().toISOString();
    return;
  }
  rules.reviewChecks.push({
    id: crypto.randomUUID(),
    checkType,
    title: String(proposal.title || checkType),
    description: String(proposal.description || ""),
    count: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

function addOrUpdateStructuredRule(rules, bucket, proposal) {
  const list = Array.isArray(rules[bucket]) ? rules[bucket] : [];
  const existing = list.find((rule) => rule.proposalId === proposal.id);
  if (existing) {
    existing.count = Number(existing.count || 0) + 1;
    existing.updatedAt = new Date().toISOString();
  } else {
    list.push({
      id: crypto.randomUUID(),
      proposalId: proposal.id,
      type: proposal.type,
      title: proposal.title,
      description: proposal.description,
      payload: proposal.payload || {},
      count: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  rules[bucket] = list;
}

function applyGroundTruthRuleProposal(input) {
  const proposal = input?.proposal || {};
  const action = String(input?.action || "review");
  const rules = readUserRules();
  const decision = {
    id: crypto.randomUUID(),
    kind: "ground_truth_rule",
    action,
    proposalId: String(proposal.id || ""),
    proposalKind: String(proposal.kind || ""),
    proposalType: String(proposal.type || ""),
    title: String(proposal.title || ""),
    createdAt: new Date().toISOString(),
  };

  if (action === "ignore_forever") {
    rules.decisions = [decision, ...rules.decisions].slice(0, 500);
    return saveUserRules(rules);
  }

  if (proposal.kind === "dictionary") {
    upsertDictionaryRules(rules, [proposal.payload || {}]);
  } else if (proposal.kind === "review_check") {
    addOrUpdateReviewCheck(rules, proposal);
  } else if (proposal.kind === "filler") {
    addOrUpdateStructuredRule(rules, "filler", proposal);
    addOrUpdateReviewCheck(rules, { ...proposal, payload: { checkType: "filler_backchannel" } });
  } else if (proposal.kind === "boundary" || proposal.kind === "telop_density") {
    addOrUpdateStructuredRule(rules, "boundary", proposal);
    if (proposal.kind === "boundary") {
      addOrUpdateReviewCheck(rules, { ...proposal, payload: { checkType: "boundary_and_linebreak" } });
    }
  }

  rules.decisions = [decision, ...rules.decisions].slice(0, 500);
  return saveUserRules(rules);
}

function writeFormalLearnedRules(report) {
  const rulesPath = path.join(repoRoot(), "templates", "learned_rules.json");
  const corrections = {};
  for (const rule of report.appliedRules.textRules) {
    corrections[rule.wrong] = rule.correct;
  }
  const formalRules = {
    version: "1.0.0",
    active: true,
    source: "ground_truth_learning",
    updatedAt: new Date().toISOString(),
    text_rules: {
      corrections,
    },
    telop: {
      max_chars_per_line: report.appliedRules.telop.maxCharsPerLine,
      max_lines_per_page: report.appliedRules.telop.maxLinesPerPage,
    },
    edit: {
      max_gap_ms: report.appliedRules.edit.maxGapMs,
      segment_padding_ms: report.appliedRules.edit.segmentPaddingMs,
    },
    timing: {
      telop_start_offset_ms: report.appliedRules.timing.telopStartOffsetMs,
      vad_start_bias_ms: report.appliedRules.timing.vadStartBiasMs,
      vad_end_bias_ms: report.appliedRules.timing.vadEndBiasMs,
      word_vad_clamp_strength: report.appliedRules.timing.wordVadClampStrength,
    },
    learning_summary: report.summary,
  };
  writeJson(rulesPath, formalRules);
  return rulesPath;
}

function evaluateAndLearnGroundTruth(runDir, truthPath) {
  const parsed = parseGroundTruthTextFile(truthPath);
  if (!parsed.entries.length) {
    throw new Error("正解txtから時刻付きテロップを読み取れませんでした");
  }
  const outputs = buildOutputs(runDir);
  const generatedPages = fs.existsSync(outputs.telop)
    ? parseTelopTextWithTiming(fs.readFileSync(outputs.telop, "utf-8"))
    : [];
  const proposalPath = path.join(runDir, "step07_cut_proposal", "cut_proposal.json");
  const proposal = fs.existsSync(proposalPath) ? readJson(proposalPath) : {};
  const currentEditConfig = proposal?.stats?.config || {};
  const matches = matchGeneratedToTruth(generatedPages, parsed.entries);
  const comparable = matches.filter((item) => item.generated);
  const startOffsets = comparable.map((item) => item.generated.startMs - item.truth.startMs);
  const boundaryOffsets = comparable.map((item) => item.generated.endMs - item.truth.endMs);
  const recommendedStartOffsetMs = clampNumber(median(startOffsets.map((value) => -value)), -500, 500);
  const truthGaps = parsed.entries
    .slice(1)
    .map((entry, index) => entry.startMs - parsed.entries[index].endMs)
    .filter((gap) => gap > 120);
  const currentMaxGapMs = Number(currentEditConfig.max_gap_ms || 400);
  const currentSegmentPaddingMs = Number(currentEditConfig.segment_padding_ms || 50);
  const maxGapMs = clampNumber(Math.round((median(truthGaps) || currentMaxGapMs) * 0.85), 80, 1000);
  const segmentPaddingMs = clampNumber(
    Math.round(currentSegmentPaddingMs * 0.65 + medianAbs(startOffsets) * 0.25),
    0,
    160,
  );
  const vadStartBiasMs = clampNumber(Math.round(-median(startOffsets) * 0.2), -160, 160);
  const vadEndBiasMs = clampNumber(Math.round(-median(boundaryOffsets) * 0.2), -160, 160);
  const wordVadClampStrength = Math.round(
    clampNumber(1 - Math.min(0.35, medianAbs([...startOffsets, ...boundaryOffsets]) / 1200), 0.65, 1) * 100,
  ) / 100;
  const truthLineLengths = parsed.entries.flatMap((entry) => entry.lines.map((line) => line.replace(/\s/g, "").length));
  const maxCharsPerLine = clampNumber(Math.round(median(truthLineLengths) || parsed.stats.avgChars || 12), 8, 24);
  const maxLinesPerPage = clampNumber(
    Math.max(1, Math.min(3, Math.round(median(parsed.entries.map((entry) => entry.lines.length)) || 2))),
    1,
    3,
  );
  const textMatched = comparable.filter(
    (item) => normalizeTextForLearning(item.generated.text) === normalizeTextForLearning(item.truth.text),
  ).length;
  const textRules = inferNotationRulesFromComparison(matches);
  const summary = {
    truthPages: parsed.entries.length,
    generatedPages: generatedPages.length,
    comparablePages: comparable.length,
    textExactMatches: textMatched,
    textMismatchPages: Math.max(0, comparable.length - textMatched),
    avgStartOffsetMs: startOffsets.length
      ? Math.round(startOffsets.reduce((sum, value) => sum + value, 0) / startOffsets.length)
      : 0,
    medianStartOffsetMs: median(startOffsets),
    avgBoundaryOffsetMs: boundaryOffsets.length
      ? Math.round(boundaryOffsets.reduce((sum, value) => sum + value, 0) / boundaryOffsets.length)
      : 0,
    medianBoundaryOffsetMs: median(boundaryOffsets),
  };
  const report = {
    version: "1.0.0",
    sourceVideoRunDir: runDir,
    sourceTruthPath: parsed.path,
    createdAt: new Date().toISOString(),
    summary,
    appliedRules: {
      timing: {
        telopStartOffsetMs: recommendedStartOffsetMs,
        vadStartBiasMs,
        vadEndBiasMs,
        wordVadClampStrength,
        reason: `正解開始時刻との差分中央値 ${summary.medianStartOffsetMs}ms を打ち消す補正`,
      },
      edit: {
        maxGapMs,
        segmentPaddingMs,
        reason: "正解txtの無音ギャップと開始ズレから、カット分割閾値と前後paddingを更新",
      },
      telop: {
        maxCharsPerLine,
        maxLinesPerPage,
        reason: "正解txtの1行文字数とページ行数の中央値から更新",
      },
      textRules,
    },
    samples: comparable.slice(0, 30).map((item) => ({
      pageId: item.generated.id,
      generatedStartMs: item.generated.startMs,
      truthStartMs: item.truth.startMs,
      startOffsetMs: item.generated.startMs - item.truth.startMs,
      generatedText: item.generated.text,
      truthText: item.truth.text,
    })),
  };
  const learnedRulesPath = writeFormalLearnedRules(report);
  writeJson(path.join(runDir, "ground_truth_learning.json"), {
    ...report,
    learnedRulesPath,
    truthStats: parsed.stats,
  });
  writeGroundTruthDevelopmentLearning(runDir, parsed);
  return { ...report, learnedRulesPath };
}

function learnFromGroundTruth(runDir, parsed) {
  const rules = readUserRules();
  const durations = parsed.entries.map((entry) => entry.endMs - entry.startMs).filter((duration) => duration > 0);
  const profile = {
    id: crypto.randomUUID(),
    kind: "vrew_ground_truth",
    runDir,
    sourcePath: parsed.path,
    sampleCount: parsed.entries.length,
    avgDurationMs: parsed.stats.avgDurationMs,
    avgChars: parsed.stats.avgChars,
    minDurationMs: durations.length ? Math.min(...durations) : 0,
    maxDurationMs: durations.length ? Math.max(...durations) : 0,
    examples: parsed.entries.slice(0, 8).map((entry) => ({
      startMs: entry.startMs,
      endMs: entry.endMs,
      text: entry.text,
    })),
    createdAt: new Date().toISOString(),
  };
  rules.groundTruth = [profile, ...rules.groundTruth].slice(0, 30);
  rules.boundary = [
    {
      id: "vrew_timing_profile",
      kind: "timing_profile",
      source: "vrew_ground_truth",
      updatedAt: new Date().toISOString(),
      sampleCount: parsed.entries.length,
      avgDurationMs: parsed.stats.avgDurationMs,
      avgChars: parsed.stats.avgChars,
      note: "正解txtから学習したテロップ開始時刻・境界の傾向",
    },
    ...rules.boundary.filter((item) => item?.id !== "vrew_timing_profile"),
  ].slice(0, 50);
  upsertDictionaryRules(rules, extractGroundTruthNotationRules(parsed.entries));
  writeGroundTruthDevelopmentLearning(runDir, parsed);
  return saveUserRules(rules);
}

function findCutForGroundTruthEntry(cuts, entry) {
  return (
    cuts.find((cut) => {
      const start = Number(cut?.timeline?.start_ms || 0);
      const end = Number(cut?.timeline?.end_ms || 0);
      return entry.startMs >= start && entry.startMs < end;
    }) ||
    cuts.find((cut) => entry.startMs < Number(cut?.timeline?.end_ms || 0)) ||
    cuts[cuts.length - 1]
  );
}

function styleForGroundTruthEntry(composition, cut, entry, pageIndex) {
  const voiceCut = (composition?.voice_data?.cuts || []).find((item) => item.id === cut.cut_id);
  const telops = voiceCut?.telops || [];
  const cutStartMs = Number(cut?.timeline?.start_ms || 0);
  const relativeStartSec = Math.max(0, (entry.startMs - cutStartMs) / 1000);
  const overlapping = telops.find((telop) => {
    if (typeof telop.start !== "number" || typeof telop.end !== "number") return false;
    return relativeStartSec >= telop.start && relativeStartSec < telop.end;
  });
  const indexed = telops[pageIndex];
  return overlapping?.style || indexed?.style || "";
}

function buildTelopTextFromGroundTruth(composition, parsed) {
  const cuts = composition?.timeline?.cuts || [];
  if (!cuts.length) throw new Error("composition.jsonにカット情報がありません");

  const pageCounters = new Map();
  const pagesByCut = new Map(cuts.map((cut) => [cut.cut_id, []]));

  for (const entry of parsed.entries) {
    const cut = findCutForGroundTruthEntry(cuts, entry);
    if (!cut) continue;
    const cutStartMs = Number(cut?.timeline?.start_ms || 0);
    const cutEndMs = Number(cut?.timeline?.end_ms || entry.endMs);
    const startMs = Math.max(cutStartMs, entry.startMs);
    const endMs = Math.max(startMs + 100, Math.min(entry.endMs, cutEndMs));
    const pageIndex = pageCounters.get(cut.cut_id) || 0;
    pageCounters.set(cut.cut_id, pageIndex + 1);
    const id = `${cut.cut_id}_p${String(pageIndex).padStart(2, "0")}`;
    const style = styleForGroundTruthEntry(composition, cut, entry, pageIndex);
    const marker = style ? ` @style=${style}` : "";
    pagesByCut.get(cut.cut_id).push({
      id,
      startMs,
      endMs,
      lines: entry.lines,
      marker,
    });
  }

  const lines = [
    "# Cat-Cut 正解データ反映済みテロップ",
    "# Vrewなどで作った正解txtをもとに、開始時刻と区切りを反映しています。",
    "# テキストを直したら「テロップを確定」でプレビューと書き出しに反映されます。",
    "#",
    `# source: ${parsed.path}`,
    "",
  ];

  for (const cut of cuts) {
    const pages = pagesByCut.get(cut.cut_id) || [];
    for (const page of pages) {
      lines.push(`# ${page.id} [${formatTelopTime(page.startMs)}-${formatTelopTime(page.endMs)}]${page.marker}`);
      lines.push(...page.lines);
      lines.push("");
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

async function applyGroundTruthToRun(input) {
  const resolved = resolveRunDir(input?.runDir);
  const parsed = parseGroundTruthTextFile(input?.path);
  if (!parsed.entries.length) {
    throw new Error("正解txtから時刻付きテロップを読み取れませんでした");
  }

  const outputs = buildOutputs(resolved);
  if (!fs.existsSync(outputs.composition)) {
    throw new Error("composition.jsonが見つかりません");
  }

  const composition = readJson(outputs.composition);
  const telopText = buildTelopTextFromGroundTruth(composition, parsed);
  fs.writeFileSync(outputs.telop, telopText, "utf-8");
  writeJson(path.join(resolved, "ground_truth_learning.json"), {
    source: parsed.path,
    stats: parsed.stats,
    entries: parsed.entries,
    updatedAt: new Date().toISOString(),
  });
  const userRules = learnFromGroundTruth(resolved, parsed);

  const root = repoRoot();
  const python = path.join(root, ".venv", "bin", "python");
  if (fs.existsSync(python)) {
    await spawnUtility({
      command: python,
      args: ["python/tools/apply_telop.py", path.relative(root, resolved)],
      cwd: root,
      env: apiKeys.buildPipelineEnv(),
    });
  }

  return {
    groundTruth: parsed,
    userRules,
    state: loadTelopReviewState(resolved),
  };
}

function parseTelopPagesForAi(text) {
  const pages = [];
  let current = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const match = raw.trim().match(/^#\s*(cut_\d+_p\d+)\b/);
    if (match) {
      if (current) pages.push(current);
      current = { id: match[1], header: raw, lines: [] };
      continue;
    }
    if (!current || raw.trim().startsWith("#")) continue;
    current.lines.push(raw);
  }
  if (current) pages.push(current);
  return pages.map((page) => ({
    id: page.id,
    header: page.header,
    text: page.lines.filter((line) => line.trim()).join("\n"),
  }));
}

function safeJsonArrayFromText(text) {
  const raw = String(text || "").trim();
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.findings)) return parsed.findings;
  } catch {
    // Fall through to fenced/embedded JSON extraction.
  }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return safeJsonArrayFromText(fenced[1]);
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeForAiComparison(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/ライン/g, "LINE")
    .toLowerCase()
    .replace(/[。、！？!?,.・\s]/g, "");
}

function sourceExistsInTelop(pageText, source) {
  const raw = String(source || "");
  if (!raw) return false;
  if (pageText.includes(raw)) return true;
  return normalizeForAiComparison(pageText).includes(normalizeForAiComparison(raw));
}

function isSafeAiSuggestion(type, source, suggestion) {
  if (!source || !suggestion) return false;
  const before = normalizeForAiComparison(source);
  const after = normalizeForAiComparison(suggestion);
  if (!before || !after) return false;
  if (before === after) return true;
  if (type === "page_boundary") return true;
  if (type === "dictionary") {
    return before.replace(/line/g, "line") === after.replace(/line/g, "line");
  }
  return false;
}

function normalizeAiFindings(items, telopText = "") {
  const allowedTypes = new Set(["dictionary", "line_break", "line_prefix", "page_boundary", "duplicate_line", "filler_only", "ai_review"]);
  const pageTextById = new Map(parseTelopPagesForAi(telopText).map((page) => [page.id, page.text]));
  return items
    .map((item, index) => {
      const pageId = String(item.page_id || item.pageId || "").trim();
      const before = item.before == null ? null : String(item.before);
      const after = item.after == null ? null : String(item.after);
      const source = item.source == null ? before : String(item.source);
      const suggestion = item.suggestion == null ? after : String(item.suggestion);
      const type = allowedTypes.has(item.type) ? item.type : "ai_review";
      if (!pageId || (!source && !before)) return null;
      const pageText = pageTextById.get(pageId) || "";
      if (!sourceExistsInTelop(pageText, source || before)) return null;
      const exactSource = pageText.includes(source || before) ? (source || before) : pageText;
      if (type !== "filler_only" && !isSafeAiSuggestion(type, source || before, suggestion || after)) return null;
      return {
        id: `ollama_${pageId}_${index}`,
        type,
        severity: ["high", "medium", "low"].includes(item.severity) ? item.severity : "medium",
        page_id: pageId,
        line_index: Number.isFinite(Number(item.line_index)) ? Number(item.line_index) : null,
        message: String(item.message || item.reason || "ローカルAIレビュー候補"),
        source: exactSource,
        suggestion,
        before: exactSource,
        after,
      };
    })
    .filter(Boolean);
}

function ollamaRequest(pathname, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload || {});
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: 11434,
        path: pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (response) => {
        let data = "";
        response.setEncoding("utf-8");
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(data || `Ollama HTTP ${response.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ response: data });
          }
        });
      },
    );
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function ollamaGet(pathname) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: 11434,
        path: pathname,
        method: "GET",
      },
      (response) => {
        let data = "";
        response.setEncoding("utf-8");
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(data || `Ollama HTTP ${response.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({});
          }
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function ollamaVersion() {
  const result = spawnSync("ollama", ["--version"], { encoding: "utf-8" });
  if (result.error) {
    return { installed: false, version: "", error: result.error.message };
  }
  if (result.status !== 0) {
    return { installed: false, version: "", error: (result.stderr || result.stdout || "").trim() };
  }
  return { installed: true, version: (result.stdout || result.stderr || "").trim() };
}

async function getOllamaStatus(model = DEFAULT_OLLAMA_MODEL) {
  const version = ollamaVersion();
  if (!version.installed) {
    return {
      installed: false,
      running: false,
      modelInstalled: false,
      model,
      error: version.error || "Ollamaが見つかりません",
    };
  }
  try {
    const list = await ollamaGet("/api/tags");
    const models = Array.isArray(list.models) ? list.models.map((item) => item.name).filter(Boolean) : [];
    return {
      installed: true,
      running: true,
      modelInstalled: models.includes(model),
      model,
      version: version.version,
      models,
    };
  } catch (error) {
    return {
      installed: true,
      running: false,
      modelInstalled: false,
      model,
      version: version.version,
      error: error.message || String(error),
    };
  }
}

function buildTelopReviewPrompt(telopText) {
  const pages = parseTelopPagesForAi(telopText);
  return [
    "あなたは日本語動画テロップの校正者です。",
    "目的は、誤字・不自然な改行・ページ境界の違和感を候補として出すことです。",
    "重要: 音声にない言葉を足さない。音声にある言葉を消さない。文末や語尾を言い換えない。",
    "許可する変更は、改行位置の変更、ページ境界の変更、明らかな表記統一(LINE/YouTube/中黒など)だけです。",
    "禁止例: 「なんと」を消す、「ちゃんと」を消す、「届いて」を「届きます」に変える、文章を短く要約する。",
    "返答はJSON配列だけにしてください。説明文やMarkdownは禁止です。",
    "",
    "各要素の形式:",
    '{"page_id":"cut_001_p00","type":"line_break","severity":"medium","source":"修正前","suggestion":"修正後","before":"修正前","after":"修正後","message":"理由"}',
    "",
    "typeは dictionary, line_break, line_prefix, page_boundary, duplicate_line, filler_only, ai_review のいずれか。",
    "source/before はページ内に実在する文字列を改行込みで完全コピーしてください。採用時に置換します。",
    "line_break/line_prefix/ai_review の suggestion/after は、source/before と文字を増減させず、改行だけを変えてください。",
    "page_boundary は前後ページをまたぐ移動候補です。source/before は対象ページ内の完全一致文字列、suggestion/after はそのページで置き換えたい文字列にしてください。",
    "候補がなければ [] を返してください。",
    "",
    "チェック対象:",
    JSON.stringify(pages, null, 2),
  ].join("\n");
}

function defaultFontDirectivesText() {
  const templatePath = path.join(repoRoot(), "templates", "font_directives_template.md");
  if (fs.existsSync(templatePath)) {
    return fs.readFileSync(templatePath, "utf-8");
  }
  return [
    "# フォント指示",
    "",
    "使うフォントパターンは1つ。",
    "全テロップを、太めで読みやすいゴシックにする。",
    "",
  ].join("\n");
}

function defaultTelopStyleDirectivesText() {
  return [
    "グラデーションで2重の枠。白い内枠と濃い外枠で、読みやすく派手すぎない。",
    "通常は青、強調は黄オレンジ、落ち着いた場面は淡い水色、注意は赤、質問は緑。",
    "数字・結論・重要語は強調、問いかけは質問、否定や注意は注意、補足はシンプルにする。",
  ].join("\n");
}

function ensureFontDirectives(runDir) {
  const outputs = buildOutputs(runDir);
  if (!fs.existsSync(outputs.fontDirectives)) {
    fs.writeFileSync(outputs.fontDirectives, defaultFontDirectivesText(), "utf-8");
  }
  return outputs.fontDirectives;
}

function ensureTelopStyleDirectives(runDir) {
  const outputs = buildOutputs(runDir);
  if (!fs.existsSync(outputs.telopStyleDirectives)) {
    fs.writeFileSync(outputs.telopStyleDirectives, defaultTelopStyleDirectivesText(), "utf-8");
  }
  return outputs.telopStyleDirectives;
}

function readFontPlan(outputs) {
  if (!fs.existsSync(outputs.fontPlan)) return null;
  return readJson(outputs.fontPlan);
}

function readTelopStylePlan(outputs) {
  if (!fs.existsSync(outputs.telopStylePlan)) return null;
  return readJson(outputs.telopStylePlan);
}

function readTelopStyleState(outputs) {
  const composition = fs.existsSync(outputs.composition) ? readJson(outputs.composition) : {};
  const timeline = composition.timeline || {};
  const plan = readTelopStylePlan(outputs);
  return {
    telopStyles: timeline.telop_styles || plan?.styles || {},
    defaultTelopStyle: timeline.default_telop_style || plan?.default_style || "default",
    telopStylePlan: plan,
    telopStyleDirectivesText: fs.existsSync(outputs.telopStyleDirectives)
      ? fs.readFileSync(outputs.telopStyleDirectives, "utf-8")
      : defaultTelopStyleDirectivesText(),
  };
}

function ensurePreviewServer() {
  if (previewServerPort) return Promise.resolve(previewServerPort);

  return new Promise((resolve, reject) => {
    previewServer = http.createServer((request, response) => {
      try {
        servePreviewVideo(request, response);
      } catch (error) {
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(error.message || String(error));
      }
    });

    previewServer.on("error", reject);
    previewServer.listen(0, "127.0.0.1", () => {
      previewServerPort = previewServer.address().port;
      resolve(previewServerPort);
    });
  });
}

function servePreviewVideo(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  const match = url.pathname.match(/^\/video\/([A-Fa-f0-9]+)\.mp4$/);
  if (!match) {
    response.writeHead(404);
    response.end("not found");
    return;
  }

  const filePath = previewFiles.get(match[1]);
  if (!filePath || !fs.existsSync(filePath)) {
    response.writeHead(404);
    response.end("video not found");
    return;
  }

  const stat = fs.statSync(filePath);
  const range = request.headers.range;
  const commonHeaders = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };

  if (range) {
    const parsed = range.match(/bytes=(\d*)-(\d*)/);
    const start = parsed && parsed[1] ? Number(parsed[1]) : 0;
    const end = parsed && parsed[2] ? Number(parsed[2]) : stat.size - 1;
    if (start >= stat.size || end >= stat.size || start > end) {
      response.writeHead(416, {
        ...commonHeaders,
        "Content-Range": `bytes */${stat.size}`,
      });
      response.end();
      return;
    }
    response.writeHead(206, {
      ...commonHeaders,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Content-Length": end - start + 1,
    });
    fs.createReadStream(filePath, { start, end }).pipe(response);
    return;
  }

  response.writeHead(200, {
    ...commonHeaders,
    "Content-Length": stat.size,
  });
  fs.createReadStream(filePath).pipe(response);
}

function registerPreviewVideo(filePath) {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath) || !previewServerPort) return null;
  const id = crypto.createHash("sha1").update(absPath).digest("hex").slice(0, 20);
  previewFiles.set(id, absPath);
  return `http://127.0.0.1:${previewServerPort}/video/${id}.mp4`;
}

function quoteConcatPath(filePath) {
  return `'${filePath.replace(/'/g, "'\\''")}'`;
}

function ensureCutPreviewVideo(outputs, cuts) {
  const segmentPaths = cuts
    .map((cut) => {
      const rawVideoPath = cut?.video?.file_path;
      if (!rawVideoPath) return "";
      return path.isAbsolute(rawVideoPath)
        ? rawVideoPath
        : path.resolve(path.dirname(outputs.composition), rawVideoPath);
    })
    .filter(Boolean);

  if (!segmentPaths.length || segmentPaths.some((segmentPath) => !fs.existsSync(segmentPath))) {
    return "";
  }
  if (segmentPaths.length === 1) return segmentPaths[0];

  const previewPath = path.join(path.dirname(outputs.composition), "preview_cut_sequence.mp4");
  const previewExists = fs.existsSync(previewPath);
  const previewMtime = previewExists ? fs.statSync(previewPath).mtimeMs : 0;
  const sourceMtime = Math.max(...segmentPaths.map((segmentPath) => fs.statSync(segmentPath).mtimeMs));
  if (previewExists && previewMtime >= sourceMtime) return previewPath;

  const listPath = path.join(path.dirname(outputs.composition), "preview_cut_sequence.txt");
  fs.writeFileSync(
    listPath,
    `${segmentPaths.map((segmentPath) => `file ${quoteConcatPath(segmentPath)}`).join("\n")}\n`,
    "utf-8",
  );

  fs.mkdirSync(path.dirname(previewPath), { recursive: true });
  let result = spawnSync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", previewPath], {
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    result = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        previewPath,
      ],
      { encoding: "utf-8" },
    );
  }

  return result.status === 0 && fs.existsSync(previewPath) ? previewPath : "";
}

function loadSettings() {
  const elevenConfigured = apiKeys.isElevenConfigured();
  if (!fs.existsSync(settingsPath())) {
    return {
      sttProvider: "elevenlabs",
      whisperModel: "small",
      renderFinal: true,
      reviewBeforeExport: true,
      fontProfileMode: "new",
      selectedFontProfileId: "",
      outputDirectory: "",
      outputFileName: "",
      elevenApiKeySet: elevenConfigured,
      telopTheme: "simple",
    };
  }

  const raw = readJson(settingsPath());
  return {
    sttProvider: raw.sttProvider || "elevenlabs",
    whisperModel: raw.whisperModel || "small",
    renderFinal: raw.renderFinal !== false,
    reviewBeforeExport: raw.reviewBeforeExport !== false,
    fontProfileMode: raw.fontProfileMode === "saved" ? "saved" : "new",
    selectedFontProfileId: raw.selectedFontProfileId || "",
    outputDirectory: raw.outputDirectory || "",
    outputFileName: raw.outputFileName || "",
    elevenApiKeySet: elevenConfigured,
    // 改善7-4(プリセットギャラリー約100種)・7-3("saved"テーマ)により、telopThemeは
    // 生成マトリクスのテーマIDや"saved"を含む動的な文字列を取り得るため、非空文字列であれば
    // そのまま受け入れる(有効なテーマIDかどうかはレンダラー側でTHEME_IDS/SAVED_THEME_IDと突合する)。
    telopTheme: typeof raw.telopTheme === "string" && raw.telopTheme ? raw.telopTheme : "simple",
  };
}

function saveSettings(input) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  const existing = fs.existsSync(settingsPath()) ? readJson(settingsPath()) : {};
  const next = {
    ...existing,
    sttProvider: input.sttProvider || existing.sttProvider || "elevenlabs",
    whisperModel: input.whisperModel || existing.whisperModel || "small",
    renderFinal: input.renderFinal !== undefined ? Boolean(input.renderFinal) : existing.renderFinal !== false,
    reviewBeforeExport:
      input.reviewBeforeExport !== undefined
        ? Boolean(input.reviewBeforeExport)
        : existing.reviewBeforeExport !== false,
    fontProfileMode:
      input.fontProfileMode === "saved" || input.fontProfileMode === "new"
        ? input.fontProfileMode
        : existing.fontProfileMode === "saved"
          ? "saved"
          : "new",
    selectedFontProfileId:
      input.selectedFontProfileId !== undefined ? String(input.selectedFontProfileId || "") : existing.selectedFontProfileId || "",
    outputDirectory:
      input.outputDirectory !== undefined ? String(input.outputDirectory || "") : existing.outputDirectory || "",
    outputFileName:
      input.outputFileName !== undefined ? ensureMp4FileName(String(input.outputFileName || "")) : existing.outputFileName || "",
    telopTheme:
      typeof input.telopTheme === "string" && input.telopTheme
        ? input.telopTheme
        : typeof existing.telopTheme === "string" && existing.telopTheme
          ? existing.telopTheme
          : "simple",
  };

  if (input.elevenApiKey !== undefined && input.elevenApiKey !== "") {
    apiKeys.saveApiKey("elevenlabs", input.elevenApiKey);
  }

  fs.writeFileSync(settingsPath(), `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return loadSettings();
}

function ensureMp4FileName(fileName) {
  const trimmed = String(fileName || "").trim();
  if (!trimmed) return "";
  const ext = path.extname(trimmed);
  if (!ext) return `${trimmed}.mp4`;
  if (ext.toLowerCase() === ".mp4") return trimmed;
  return `${trimmed.slice(0, -ext.length)}.mp4`;
}

function ensureMp4OutputPath(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  const ext = path.extname(resolved);
  if (!ext) return `${resolved}.mp4`;
  if (ext.toLowerCase() === ".mp4") return resolved;
  return `${resolved.slice(0, -ext.length)}.mp4`;
}

function readFontProfiles() {
  if (!fs.existsSync(fontProfilesPath())) return [];
  const raw = readJson(fontProfilesPath());
  return Array.isArray(raw?.profiles) ? raw.profiles : [];
}

function saveFontProfiles(profiles) {
  fs.mkdirSync(path.dirname(fontProfilesPath()), { recursive: true });
  fs.writeFileSync(fontProfilesPath(), `${JSON.stringify({ profiles }, null, 2)}\n`, "utf-8");
}

function saveFontProfile(input) {
  const profiles = readFontProfiles();
  const now = new Date().toISOString();
  const id = input?.id || crypto.randomUUID();
  const next = {
    id,
    name: String(input?.name || "フォント設定"),
    patternCount: Math.max(1, Math.min(6, Number(input?.patternCount || 1))),
    scenes: input?.scenes && typeof input.scenes === "object" ? input.scenes : {},
    directivesText: String(input?.directivesText || ""),
    createdAt: input?.createdAt || now,
    updatedAt: now,
  };
  const index = profiles.findIndex((profile) => profile.id === id);
  if (index >= 0) {
    profiles[index] = { ...profiles[index], ...next, createdAt: profiles[index].createdAt || next.createdAt };
  } else {
    profiles.unshift(next);
  }
  saveFontProfiles(profiles);
  return profiles;
}

function deleteFontProfile(profileId) {
  const id = String(profileId || "").trim();
  if (!id) return readFontProfiles();
  const profiles = readFontProfiles().filter((profile) => profile.id !== id);
  saveFontProfiles(profiles);
  return profiles;
}

function resolveSavedFontDirectives(options) {
  if (options?.fontDirectivesText) return String(options.fontDirectivesText);
  if (!options?.savedFontProfileId) return "";
  const profile = readFontProfiles().find((item) => item.id === options.savedFontProfileId);
  return profile?.directivesText || "";
}

function resolveSavedFontProfile(options) {
  if (!options?.savedFontProfileId) return null;
  return readFontProfiles().find((item) => item.id === options.savedFontProfileId) || null;
}

function styleFromSavedScene(base, scene) {
  const fillMode = scene.fillMode === "solid" ? "solid" : "gradient";
  const strokeEnabled = scene.strokeEnabled !== false;
  return {
    ...base,
    font_size: Number(scene.size || base.font_size || 72),
    font_weight: Number(scene.weight || base.font_weight || 900),
    letter_spacing:
      scene.letterSpacing !== undefined ? `${Number(scene.letterSpacing).toFixed(2)}em` : base.letter_spacing || "0.02em",
    line_height: Number(scene.lineHeight || base.line_height || 1.35),
    fill:
      fillMode === "solid"
        ? { type: "solid", color: scene.fillColor || "#FFFFFF" }
        : {
            type: "gradient",
            gradient_from: scene.gradientFrom || "#FFFFFF",
            gradient_to: scene.gradientTo || "#1E5DA8",
            gradient_direction: "vertical",
          },
    inner_stroke: strokeEnabled
      ? { color: scene.innerStrokeColor || "#FFFFFF", width: Number(scene.innerStrokeWidth || 10) }
      : null,
    outer_stroke: strokeEnabled
      ? { color: scene.outerStrokeColor || "#1E3A5F", width: Number(scene.outerStrokeWidth || 18) }
      : null,
    drop_shadow: strokeEnabled ? base.drop_shadow : "drop-shadow(0px 3px 5px rgba(0,0,0,0.35))",
  };
}

function applySavedFontProfileStyles(runDir, profile) {
  if (!profile?.scenes) return;
  const outputs = buildOutputs(runDir);
  if (!fs.existsSync(outputs.composition)) return;
  const composition = readJson(outputs.composition);
  const timeline = composition.timeline || {};
  const styles = { ...(timeline.telop_styles || {}) };
  const order = ["default", "highlight", "warning", "question", "calm", "simple"];
  for (const sceneName of order) {
    const scene = profile.scenes[sceneName];
    if (!scene) continue;
    styles[sceneName] = styleFromSavedScene(styles[sceneName] || styles.default || {}, scene);
  }
  const plan = {
    version: "1.0.0",
    source: "saved_font_profile",
    updated_at: new Date().toISOString(),
    default_style: timeline.default_telop_style || "default",
    styles,
  };
  writeJson(outputs.telopStylePlan, plan);
  applyTelopStylePlanToComposition(outputs, plan);
}

function formatDatePart(value) {
  return String(value).padStart(2, "0");
}

function createRunName(videoPath) {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    formatDatePart(now.getMonth() + 1),
    formatDatePart(now.getDate()),
    "_",
    formatDatePart(now.getHours()),
    formatDatePart(now.getMinutes()),
    formatDatePart(now.getSeconds()),
  ].join("");
  const base = path.basename(videoPath, path.extname(videoPath))
    .replace(/[^\p{Letter}\p{Number}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36);
  return `${stamp}_${base || "video"}`;
}

function spawnCommand({ command, args, cwd, env, stepId }) {
  return new Promise((resolve, reject) => {
    if (!activeJob || activeJob.cancelled) {
      reject(new Error("Job cancelled"));
      return;
    }

    sendJobEvent({ type: "step:start", stepId });
    sendJobEvent({ type: "log", message: `$ ${command} ${args.map(shellQuote).join(" ")}\n` });

    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeJob.child = child;

    let recentOutput = "";
    const rememberOutput = (chunk) => {
      const text = chunk.toString();
      recentOutput = `${recentOutput}${text}`.slice(-16000);
      handleProcessOutput(text, stepId);
    };

    child.stdout.on("data", rememberOutput);
    child.stderr.on("data", rememberOutput);

    child.on("error", (error) => {
      sendJobEvent({ type: "step:error", stepId });
      reject(new Error(commandFailureMessage(command, args, null, recentOutput, error.message || String(error))));
    });
    child.on("close", (code) => {
      if (activeJob) activeJob.child = null;
      if (!activeJob || activeJob.cancelled) {
        reject(new Error("Job cancelled"));
        return;
      }
      if (code === 0) {
        sendJobEvent({ type: "step:done", stepId });
        resolve();
      } else {
        sendJobEvent({ type: "step:error", stepId });
        reject(new Error(commandFailureMessage(command, args, code, recentOutput)));
      }
    });
  });
}

function commandFailureMessage(command, args, code, output, cause) {
  const header =
    code === null
      ? `${command} failed to start`
      : `${command} exited with code ${code}`;
  const commandLine = `$ ${command} ${args.map(shellQuote).join(" ")}`;
  const cleanedOutput = cleanProcessTail(output);
  const parts = [header, commandLine];
  if (cause) parts.push(`Cause: ${cause}`);
  if (cleanedOutput) {
    parts.push("---- last process output ----");
    parts.push(cleanedOutput);
  }
  return parts.join("\n");
}

function cleanProcessTail(output) {
  if (!output) return "";
  const normalized = output
    .replace(/\rProgress:/g, "\nProgress:")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, index, lines) => line.trim() || index === lines.length - 1)
    .join("\n")
    .trim();
  if (normalized.length <= 8000) return normalized;
  return normalized.slice(-8000);
}

function spawnUtility({ command, args, cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(output || `${command} exited with code ${code}`));
      }
    });
  });
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function handleProcessOutput(chunk, stepId) {
  const text = chunk.toString();
  sendJobEvent({ type: "log", message: text });

  if (stepId === "render") {
    const matches = [...text.matchAll(/Progress:\s*(\d+)%/g)];
    if (matches.length) {
      const percent = Number(matches[matches.length - 1][1]);
      sendJobEvent({ type: "export:progress", percent });
    }
  }
}

function buildOutputs(runDir) {
  const finalVideo = readRenderOutputPath(runDir) || defaultRenderOutputPath(runDir);
  return {
    runDir,
    telop: path.join(runDir, "telop.txt"),
    telopReview: path.join(runDir, "telop_review.json"),
    fontDirectives: path.join(runDir, "font_directives.md"),
    fontPlan: path.join(runDir, "font_plan.json"),
    telopStyleDirectives: path.join(runDir, "telop_style_directives.md"),
    telopStylePlan: path.join(runDir, "telop_style_plan.json"),
    composition: path.join(runDir, "step08_composition", "composition.json"),
    finalVideo,
    transcriptPatch: path.join(runDir, "step02b_transcript_correct", "transcript_patch.json"),
  };
}

function defaultRenderOutputPath(runDir) {
  return path.join(runDir, "output", "final.mp4");
}

function renderOutputInfoPath(runDir) {
  return path.join(runDir, "output", "render_output.json");
}

function readRenderOutputPath(runDir) {
  const infoPath = renderOutputInfoPath(runDir);
  if (!fs.existsSync(infoPath)) return "";
  try {
    const raw = readJson(infoPath);
    return raw?.finalVideo || raw?.outputPath || "";
  } catch {
    return "";
  }
}

function writeRenderOutputPath(runDir, outputPath) {
  const infoPath = renderOutputInfoPath(runDir);
  writeJson(infoPath, {
    finalVideo: outputPath,
    updated_at: new Date().toISOString(),
  });
}

function resolveRenderOutputPath(runDir, options) {
  if (options?.outputPath) {
    return ensureMp4OutputPath(options.outputPath);
  }
  return defaultRenderOutputPath(runDir);
}

function buildPreviewPages(outputs) {
  if (!fs.existsSync(outputs.composition)) return [];

  const composition = readJson(outputs.composition);
  const cuts = composition?.timeline?.cuts || [];
  const voiceCuts = new Map((composition?.voice_data?.cuts || []).map((cut) => [cut.id, cut]));
  const displayWidth = Number(composition?.meta?.display_width || 1280);
  const displayHeight = Number(composition?.meta?.display_height || 720);
  const result = [];
  const cutPreviewVideo = ensureCutPreviewVideo(outputs, cuts);
  const cutPreviewUrl = cutPreviewVideo ? registerPreviewVideo(cutPreviewVideo) : "";
  let sequenceStartMs = 0;

  for (const cut of cuts) {
    const pages = cut?.telop?.pages || [];
    if (!pages.length) continue;

    const rawVideoPath = cut?.video?.file_path;
    if (!rawVideoPath) continue;

    const videoPath = path.isAbsolute(rawVideoPath)
      ? rawVideoPath
      : path.resolve(path.dirname(outputs.composition), rawVideoPath);
    const videoUrl = cutPreviewUrl || registerPreviewVideo(videoPath);
    if (!videoUrl) continue;

    const cutDurationMs =
      Number(cut?.video?.end_ms || 0) - Number(cut?.video?.start_ms || 0) ||
      Number(cut?.timeline?.end_ms || 0) - Number(cut?.timeline?.start_ms || 0);
    const sourceStartMs = cutPreviewUrl ? sequenceStartMs : Number(cut?.video?.start_ms || 0);
    const voiceCut = voiceCuts.get(cut.cut_id);
    const voiceWords = voiceCut?.voice?.words || [];
    const voiceTelops = voiceCut?.telops || [];

    const telopRange = (index) => {
      const telop = voiceTelops[index];
      if (typeof telop?.start === "number" && typeof telop?.end === "number" && telop.end > telop.start) {
        return {
          pageStartMs: Math.max(0, Math.floor(telop.start * 1000)),
          pageEndMs: Math.max(0, Math.floor(telop.end * 1000)),
        };
      }
      const indices = telop?.word_indices || [];
      if (!indices.length || !voiceWords.length) {
        const pageStartMs = Math.max(0, Math.floor((cutDurationMs * index) / pages.length));
        const pageEndMs = Math.max(0, Math.floor((cutDurationMs * (index + 1)) / pages.length));
        return { pageStartMs, pageEndMs };
      }
      const firstWord = voiceWords[Math.min(...indices)];
      const lastWord = voiceWords[Math.max(...indices)];
      const nextIndices = voiceTelops[index + 1]?.word_indices || [];
      const nextWord = nextIndices.length ? voiceWords[Math.min(...nextIndices)] : null;
      const pageStartMs = Math.max(0, Math.floor(Number(firstWord?.start || 0) * 1000));
      const pageEndMs = Math.max(
        pageStartMs + 100,
        Math.floor(Number((nextWord || lastWord)?.[nextWord ? "start" : "end"] || 0) * 1000),
      );
      return { pageStartMs, pageEndMs };
    };

    pages.forEach((page, index) => {
      const { pageStartMs, pageEndMs } = telopRange(index);
      result.push({
        pageId: page.id,
        cutId: cut.cut_id,
        videoUrl,
        startMs: sourceStartMs + pageStartMs,
        endMs: sourceStartMs + pageEndMs,
        displayWidth,
        displayHeight,
      });
    });
    sequenceStartMs += cutDurationMs;
  }

  return result;
}

function loadTelopReviewState(runDir) {
  const outputs = buildOutputs(runDir);
  ensureFontDirectives(runDir);
  ensureTelopStyleDirectives(runDir);
  return {
    outputs,
    telopText: fs.existsSync(outputs.telop) ? fs.readFileSync(outputs.telop, "utf-8") : "",
    review: fs.existsSync(outputs.telopReview) ? readJson(outputs.telopReview) : null,
    fontDirectivesText: fs.existsSync(outputs.fontDirectives)
      ? fs.readFileSync(outputs.fontDirectives, "utf-8")
      : defaultFontDirectivesText(),
    fontPlan: readFontPlan(outputs),
    ...readTelopStyleState(outputs),
    previewPages: buildPreviewPages(outputs),
  };
}

function sttCandidates(runDir) {
  return [
    path.join(runDir, "step02b_transcript_correct", "stt_corrected.json"),
    path.join(runDir, "step02_stt", "stt_result.json"),
  ];
}

function loadTranscriptSource(runDir) {
  const sttPath = sttCandidates(runDir).find((candidate) => fs.existsSync(candidate));
  if (!sttPath) throw new Error("stt_result.json / stt_corrected.json が見つかりません");
  const proposalPath = path.join(runDir, "step07_cut_proposal", "cut_proposal.json");
  if (!fs.existsSync(proposalPath)) throw new Error("cut_proposal.json が見つかりません");
  const fillerPath = path.join(runDir, "step04_filler_detect", "fillers.json");
  const preprocessPath = path.join(runDir, "step01_preprocess", "preprocess.json");
  const compositionPath = path.join(runDir, "step08_composition", "composition.json");
  const stt = readJson(sttPath);
  const proposal = readJson(proposalPath);
  const fillers = fs.existsSync(fillerPath) ? readJson(fillerPath) : { fillers: [] };
  const preprocess = fs.existsSync(preprocessPath) ? readJson(preprocessPath) : {};
  const composition = fs.existsSync(compositionPath) ? readJson(compositionPath) : {};
  const words = Array.isArray(stt.words) ? stt.words : [];
  const sentences = Array.isArray(stt.sentences) ? stt.sentences : [];
  const sentenceByWordId = new Map();
  for (const sentence of sentences) {
    for (const wordId of sentence.word_ids || []) {
      sentenceByWordId.set(wordId, sentence.id || "");
    }
  }
  return {
    sttPath,
    proposalPath,
    fillerPath,
    preprocessPath,
    compositionPath,
    stt,
    proposal,
    fillers,
    preprocess,
    composition,
    words,
    sentenceByWordId,
    sentences,
  };
}

function normalizeSegmentsForProposal(segments, durationMs) {
  const safeDuration = Math.max(0, Math.round(durationMs || 0));
  const normalized = (Array.isArray(segments) ? segments : [])
    .map((segment) => ({
      start_ms: Math.max(0, Math.min(safeDuration, Math.round(Number(segment.start_ms ?? segment.startMs ?? 0)))),
      end_ms: Math.max(0, Math.min(safeDuration, Math.round(Number(segment.end_ms ?? segment.endMs ?? 0)))),
      text: typeof segment.text === "string" ? segment.text : "",
      scene_id: segment.scene_id ?? segment.sceneId ?? null,
    }))
    .filter((segment) => segment.end_ms > segment.start_ms)
    .sort((a, b) => a.start_ms - b.start_ms);
  const merged = [];
  for (const segment of normalized) {
    const last = merged[merged.length - 1];
    if (last && segment.start_ms <= last.end_ms) {
      last.end_ms = Math.max(last.end_ms, segment.end_ms);
      if (segment.text) last.text = `${last.text || ""}${segment.text}`;
      continue;
    }
    merged.push({ ...segment });
  }
  return merged;
}

function buildRemoveRangesFromKeepSegments(keepSegments, durationMs) {
  const safeDuration = Math.max(0, Math.round(durationMs || 0));
  const ranges = [];
  let cursor = 0;
  for (const segment of keepSegments) {
    if (segment.start_ms > cursor) {
      ranges.push({
        start_ms: cursor,
        end_ms: segment.start_ms,
        duration_ms: segment.start_ms - cursor,
        reason: "gap",
      });
    }
    cursor = segment.end_ms;
  }
  if (cursor < safeDuration) {
    ranges.push({
      start_ms: cursor,
      end_ms: safeDuration,
      duration_ms: safeDuration - cursor,
      reason: "trailing_silence",
    });
  }
  return ranges;
}

function proposalDurationMs(source) {
  return (
    Number(source.proposal?.stats?.original_duration_ms || 0) ||
    Number(source.preprocess?.metadata?.duration_ms || 0) ||
    Math.max(...source.words.map((word) => Number(word.end_ms || 0)), 0) + 500
  );
}

function buildSegmentTextFromWords(words, startMs, endMs) {
  return words
    .filter((word) => Number(word.start_ms) < endMs && Number(word.end_ms) > startMs)
    .sort((a, b) => Number(a.start_ms) - Number(b.start_ms))
    .map((word) => String(word.text || ""))
    .join("");
}

function applyWordCorrections(runDir, corrections) {
  const list = Array.isArray(corrections)
    ? corrections.filter((item) => item && typeof item.wordId === "string" && typeof item.text === "string")
    : [];
  if (!list.length) return [];

  const sttPath = sttCandidates(runDir).find((candidate) => fs.existsSync(candidate));
  if (!sttPath) return [];

  const stt = readJson(sttPath);
  const words = Array.isArray(stt.words) ? stt.words : [];
  const wordById = new Map(words.map((word) => [String(word.id), word]));
  const applied = [];

  for (const correction of list) {
    const word = wordById.get(String(correction.wordId));
    if (!word) continue;
    const original = String(word.text || "");
    const nextText = correction.text.trim();
    if (!nextText || nextText === original) continue;
    word.text = nextText;
    applied.push({ wrong: original, correct: nextText });
  }

  if (applied.length) {
    writeJson(sttPath, stt);
    for (const pair of applied) {
      if (pair.wrong) learnDictionaryRule({ wrong: pair.wrong, correct: pair.correct, category: "common_misrecognition" });
    }
  }
  return applied;
}

function updateCutProposalKeepSegments(runDir, keepSegmentsInput) {
  const source = loadTranscriptSource(runDir);
  const durationMs = proposalDurationMs(source);
  const keepSegments = normalizeSegmentsForProposal(keepSegmentsInput, durationMs).map((segment) => ({
    ...segment,
    text: buildSegmentTextFromWords(source.words, segment.start_ms, segment.end_ms),
  }));
  const removeRanges = buildRemoveRangesFromKeepSegments(keepSegments, durationMs);
  const keptMs = keepSegments.reduce((sum, segment) => sum + (segment.end_ms - segment.start_ms), 0);
  const removedMs = Math.max(0, durationMs - keptMs);
  const proposal = {
    ...source.proposal,
    keep_segments: keepSegments,
    remove_ranges: removeRanges,
    stats: {
      ...(source.proposal.stats || {}),
      total_keep_segments: keepSegments.length,
      total_remove_ranges: removeRanges.length,
      kept_duration_ms: keptMs,
      removed_duration_ms: removedMs,
      original_duration_ms: durationMs,
      reduction_ratio: Number((removedMs / Math.max(durationMs, 1)).toFixed(3)),
    },
  };
  writeJson(source.proposalPath, proposal);
  return proposal;
}

function projectPathForRun(runDir) {
  const preprocessPath = path.join(runDir, "step01_preprocess", "preprocess.json");
  const preprocess = fs.existsSync(preprocessPath) ? readJson(preprocessPath) : {};
  const orientation = preprocess.orientation === "vertical" ? "vertical" : "horizontal";
  return path.join("templates", `${orientation}.yaml`);
}

async function rerunCompositionAndTelop(runDir) {
  const root = repoRoot();
  const python = path.join(root, ".venv", "bin", "python");
  if (!fs.existsSync(python)) throw new Error(`Python venv not found: ${python}`);
  const relRunDir = path.relative(root, runDir);
  const source = loadTranscriptSource(runDir);
  const sttPath = path.relative(root, source.sttPath);
  const preprocess = source.preprocess || {};
  const reviewPath = path.join(relRunDir, "step06_review", "review.json");
  const project = projectPathForRun(runDir);
  await spawnUtility({
    command: python,
    args: [
      "python/step08_composition.py",
      "--proposal",
      path.join(relRunDir, "step07_cut_proposal", "cut_proposal.json"),
      "--stt",
      sttPath,
      "--video",
      preprocess.video_path || source.composition?.meta?.source_video || "",
      "--output",
      path.join(relRunDir, "step08_composition"),
      "--project",
      project,
      "--review",
      reviewPath,
    ],
    cwd: root,
    env: apiKeys.buildPipelineEnv(),
  });
  await spawnUtility({
    command: python,
    args: ["python/tools/extract_telop.py", relRunDir],
    cwd: root,
    env: apiKeys.buildPipelineEnv(),
  });
  await spawnUtility({
    command: python,
    args: ["python/tools/review_telop.py", relRunDir, "--dictionary", "templates/domain_dictionary.yaml"],
    cwd: root,
    env: apiKeys.buildPipelineEnv(),
  });
}

async function rerunCutProposalWithGap(runDir, maxGapMs) {
  const root = repoRoot();
  const python = path.join(root, ".venv", "bin", "python");
  const relRunDir = path.relative(root, runDir);
  const source = loadTranscriptSource(runDir);
  const config = {
    ...(source.proposal?.stats?.config || {}),
    max_gap_ms: Math.max(40, Math.min(1600, Math.round(maxGapMs))),
  };
  const script = [
    "import json, os, sys",
    "sys.path.insert(0, os.path.join(os.getcwd(), 'python'))",
    "from step07_cut_proposal import run_step",
    "stt, fillers, retakes, scenes, out_dir, vad, config_json = sys.argv[1:8]",
    "run_step(stt, fillers, retakes, scenes, out_dir, config=json.loads(config_json), vad_result_path=vad or None)",
  ].join(";");
  await spawnUtility({
    command: python,
    args: [
      "-c",
      script,
      path.relative(root, source.sttPath),
      path.join(relRunDir, "step04_filler_detect", "fillers.json"),
      path.join(relRunDir, "step05_retake_detect", "retakes.json"),
      path.join(relRunDir, "step06_scene_structure", "scenes.json"),
      path.join(relRunDir, "step07_cut_proposal"),
      path.join(relRunDir, "step03_vad", "vad_result.json"),
      JSON.stringify(config),
    ],
    cwd: root,
    env: apiKeys.buildPipelineEnv(),
  });
  await rerunCompositionAndTelop(runDir);
}

/**
 * 改善8-B-3(シーン初期化=テロップページ): composition.json の voice_data.cuts[].telops[]
 * (BudouXでページ分割済みのテロップ)から、各ページの元動画上の絶対ms範囲を抽出する。
 *
 * voice_data.cuts[i] は step08_composition.py が keep_segments と同じ順序(startMs昇順)で
 * cut_001, cut_002, ... を割り当てているため、proposal.keep_segments[i] がそのカットの
 * 絶対開始msを与える(telopThemes.ts側のコメントにある既存の前提と同じ)。
 * 各telopページの word_indices (cut内のvoice.words配列のindex集合)の最小/最大から、
 * ページの開始/終了(カット相対秒)を求め、カットの絶対開始msを足して絶対ms範囲にする。
 */
function buildTelopPageBoundaries(source) {
  const keepSegments = Array.isArray(source.proposal?.keep_segments) ? source.proposal.keep_segments : [];
  const cuts = Array.isArray(source.composition?.voice_data?.cuts) ? source.composition.voice_data.cuts : [];
  const timelineCuts = Array.isArray(source.composition?.timeline?.cuts) ? source.composition.timeline.cuts : [];
  const boundaries = [];
  cuts.forEach((cut, index) => {
    const segment = keepSegments[index];
    if (!segment) return;
    const segStartMs = Number(segment.start_ms || 0);
    const words = Array.isArray(cut?.voice?.words) ? cut.voice.words : [];
    const telops = Array.isArray(cut?.telops) ? cut.telops : [];
    const timelineCut = timelineCuts[index];
    const timelinePages = Array.isArray(timelineCut?.telop?.pages) ? timelineCut.telop.pages : [];
    for (let pageIndex = 0; pageIndex < telops.length; pageIndex += 1) {
      const telop = telops[pageIndex];
      const indices = Array.isArray(telop?.word_indices) ? telop.word_indices : [];
      if (!indices.length) continue;
      const minIndex = Math.min(...indices);
      const maxIndex = Math.max(...indices);
      const firstWord = words[minIndex];
      const lastWord = words[maxIndex];
      if (!firstWord || !lastWord) continue;
      const startMs = segStartMs + Math.round(Number(firstWord.start || 0) * 1000);
      const endMs = segStartMs + Math.round(Number(lastWord.end || 0) * 1000);
      if (endMs <= startMs) continue;
      const timelinePage = timelinePages[pageIndex];
      const timelineText = Array.isArray(timelinePage?.lines) ? timelinePage.lines.join("") : "";
      const text = String(telop?.text || timelineText || "").trim();
      boundaries.push({ startMs, endMs, ...(text ? { text } : {}) });
    }
  });
  boundaries.sort((a, b) => a.startMs - b.startMs);
  return boundaries;
}

function isAiRefineFailure(raw) {
  if (!raw || raw.enabled !== false) return false;
  const reason = String(raw.reason || "");
  return reason !== "no AI provider key set";
}

function extractRunTitle(runDir) {
  const name = path.basename(runDir);
  const parts = name.split("_");
  if (parts.length >= 3) {
    return parts.slice(2).join(" ");
  }
  return "";
}

function loadTranscriptEditorState(runDir) {
  const resolved = resolveRunDir(runDir);
  const source = loadTranscriptSource(resolved);
  const keepSegments = Array.isArray(source.proposal?.keep_segments)
    ? source.proposal.keep_segments.map((segment) => ({
        startMs: Number(segment.start_ms || 0),
        endMs: Number(segment.end_ms || 0),
      }))
    : [];
  // 改善10: step07が既に除去したフィラー(removed_word_ids)は「カットされずに残っています」
  // 警告の対象から外す。時間範囲はkeep_segmentと重なるため、IDベースでしか判別できない。
  const removedWordIdSet = new Set(
    Array.isArray(source.proposal?.removed_word_ids)
      ? source.proposal.removed_word_ids.map(String)
      : [],
  );
  const fillerWordIds = Array.isArray(source.fillers?.fillers)
    ? source.fillers.fillers
        .filter((filler) => {
          const ids = Array.isArray(filler.word_ids) && filler.word_ids.length
            ? filler.word_ids.map(String)
            : [String(filler.word_id || "")];
          return !ids.some((id) => removedWordIdSet.has(id));
        })
        .map((filler) => String(filler.word_id || ""))
        .filter(Boolean)
    : [];
  const sentenceFromId = new Map(source.sentences.map((sentence) => [sentence.id, sentence]));
  const words = source.words.map((word, index) => {
    const sentenceId = source.sentenceByWordId.get(word.id) || "";
    return {
      id: String(word.id || `w-${index}`),
      text: String(word.text || ""),
      startMs: Number(word.start_ms || 0),
      endMs: Number(word.end_ms || word.start_ms || 0),
      sentenceId,
      confidence: word.confidence == null ? 1 : Number(word.confidence),
    };
  });
  const sentences = source.sentences.map((sentence, index) => ({
    id: String(sentence.id || `s-${index}`),
    text: String(sentence.text || ""),
    wordIds: Array.isArray(sentence.word_ids) ? sentence.word_ids : [],
    startMs: Number(sentence.start_ms || 0),
    endMs: Number(sentence.end_ms || sentence.start_ms || 0),
  }));
  const fallbackSentences =
    sentences.length > 0
      ? sentences
      : [
          {
            id: "s-000",
            text: words.map((word) => word.text).join(""),
            wordIds: words.map((word) => word.id),
            startMs: words[0]?.startMs || 0,
            endMs: words[words.length - 1]?.endMs || 0,
          },
        ];
  const sourceVideoPath = String(source.preprocess?.video_path || source.composition?.meta?.source_video || "");
  const sourceVideoUrl = sourceVideoPath && previewServerPort ? registerPreviewVideo(sourceVideoPath) || "" : "";

  const aiReviewPath = path.join(resolved, "step05_ai_retake", "ai_review.json");
  const refinePath = path.join(resolved, "step06b_ai_refine", "refine.json");
  const aiReviewRaw = fs.existsSync(aiReviewPath) ? readJson(aiReviewPath) : null;
  const refineRaw = fs.existsSync(refinePath) ? readJson(refinePath) : null;
  const transcriptRefineFailed = isAiRefineFailure(aiReviewRaw);
  const telopRefineFailed = isAiRefineFailure(refineRaw);
  const aiReviewEnabled = Boolean(aiReviewRaw?.enabled || refineRaw?.enabled);
  const aiReview = {
    enabled: aiReviewEnabled,
    transcriptNeedsReview: Array.isArray(aiReviewRaw?.needs_review) ? aiReviewRaw.needs_review : [],
    telopNeedsReview: Array.isArray(refineRaw?.needs_review) ? refineRaw.needs_review : [],
    dismissedFindingIds: Array.isArray(refineRaw?.dismissed_finding_ids)
      ? refineRaw.dismissed_finding_ids.map(String)
      : [],
    transcriptRefineFailed,
    telopRefineFailed,
    transcriptRefineFailureReason: transcriptRefineFailed ? String(aiReviewRaw?.reason || "") : "",
    telopRefineFailureReason: telopRefineFailed ? String(refineRaw?.reason || "") : "",
    transcriptFailedChunks: Number(aiReviewRaw?.failed_chunks || 0),
    telopFailedChunks: Number(refineRaw?.failed_chunks || 0),
  };

  return {
    runDir: resolved,
    sourceVideoPath,
    sourceVideoUrl,
    words,
    sentences: fallbackSentences.map((sentence) => ({
      ...sentence,
      text:
        sentence.text ||
        sentence.wordIds
          .map((wordId) => words.find((word) => word.id === wordId)?.text || "")
          .join(""),
    })),
    keepSegments,
    fillerWordIds,
    maxGapMs: Number(source.proposal?.stats?.config?.max_gap_ms || 600),
    segmentPaddingMs: Number(source.proposal?.stats?.config?.segment_padding_ms || 50),
    originalDurationMs: proposalDurationMs(source),
    telopFontSize: Number(source.composition?.timeline?.telop_font_size || 52),
    // 改善7-2(プレビューテロップの適正サイズ): telopFontSizeが算出された基準解像度幅。
    // プレビュー側で「video要素の実表示幅 × (telopFontSize / telopBaseWidth)」の相対比率計算に使う
    // (Remotion書き出し時と同じ比率になるようにするため)。
    telopBaseWidth: Number(source.composition?.meta?.display_width || 1280),
    // 改善8-B-3(シーン初期化=テロップページ): BudouXテロップページ境界(絶対ms)。
    // composition.jsonにvoice_data/telopsが無い(旧run等)場合は空配列(UI側はヒューリスティックへフォールバック)。
    telopPageBoundaries: buildTelopPageBoundaries(source),
    aiReview,
  };
}

// --- 検品UI v2(シーン行UI, Phase 1): scenesのtelopText編集をtelop.txt/composition.jsonへ反映する ---
//
// レンダラー側(src/lib/scenes.ts の deriveKeepSegments/deriveTelopOverrides)は、scenesから
// 導出したkeep_segmentsと同じ並び順(startMs昇順 = step08_composition.pyがcut_id
// (cut_001, cut_002, ...)を割り当てる順序と同一)でテロップ上書き配列を渡してくる。
// 既存の「テロップレビュー保存経路」(telop.txt -> python/tools/apply_telop.py -> composition.json)
// をそのまま再利用し、telop.txtの該当cutブロックだけを上書きテキストで置き換えてから
// apply_telop.pyを実行する、というのが最小の接続点。

const TELOP_PAGE_HEADER_RE = /^#\s*(cut_(\d+)_p\d+)\b/;

/**
 * telop.txt(extract_telop.pyが直後に再生成した「自動テロップ」)を読み、
 * telopOverrides[i]("cut_{i+1}"のcut_idに対応)が文字列であれば、そのcutの全ページを
 * 1ページ(先頭ページのヘッダ=時間範囲・スタイルはそのまま)に差し替える。
 * null/未指定のcutは自動生成のまま変更しない。戻り値は実際に書き換えを行ったかどうか。
 */
function applyTelopOverridesToFile(runDir, telopOverrides) {
  if (!Array.isArray(telopOverrides) || !telopOverrides.some((text) => typeof text === "string")) return false;
  const telopPath = path.join(runDir, "telop.txt");
  if (!fs.existsSync(telopPath)) return false;

  const lines = fs.readFileSync(telopPath, "utf-8").split("\n");
  const output = [];
  let changed = false;
  let i = 0;
  while (i < lines.length) {
    const header = TELOP_PAGE_HEADER_RE.exec((lines[i] || "").trim());
    if (!header) {
      output.push(lines[i]);
      i += 1;
      continue;
    }
    const cutNumber = Number(header[2]);
    const cutBlocks = [];
    while (i < lines.length) {
      const blockHeader = TELOP_PAGE_HEADER_RE.exec((lines[i] || "").trim());
      if (!blockHeader || Number(blockHeader[2]) !== cutNumber) break;
      const headerLine = lines[i];
      i += 1;
      const bodyLines = [];
      while (i < lines.length && lines[i] !== "") {
        bodyLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length && lines[i] === "") i += 1;
      cutBlocks.push({ headerLine, bodyLines });
    }
    const override = telopOverrides[cutNumber - 1];
    if (typeof override === "string" && override.length > 0 && cutBlocks.length > 0) {
      changed = true;
      output.push(cutBlocks[0].headerLine);
      for (const bodyLine of override.split("\n")) output.push(bodyLine);
      output.push("");
    } else {
      for (const block of cutBlocks) {
        output.push(block.headerLine);
        for (const bodyLine of block.bodyLines) output.push(bodyLine);
        output.push("");
      }
    }
  }

  if (!changed) return false;
  fs.writeFileSync(telopPath, output.join("\n"), "utf-8");
  return true;
}

// --- T-5(テーマ×感情の自動スタイリング・書き出し反映) ---
//
// 調査の結果、apply_telop.py には既に「ページ単位のスタイル指定」の受け皿があった:
//   1. telop.txt の各ページヘッダ行(# cut_XXX_pYY [...])の末尾に `@style=<プリセット名>` を
//      付けると、apply_to_composition() がそのページの composition.json 上の style を
//      更新する(STYLE_DIRECTIVE_RE)。
//   2. telop_style_plan.json (styles辞書+default_style) を置くと、load_style_plan()/
//      apply_style_plan() が composition.timeline.telop_styles / default_telop_style に反映する。
// この2つを組み合わせれば、UI側で計算した「テーマ×感情のスタイル辞書」と「シーン(cut)ごとの
// 適用スタイル名」を、pythonコードを一切変更せずにcomposition.json → Remotionまで届けられる。
// そのため実装は「telop.txtへの@styleディレクティブ注入」+「telop_style_plan.json書き込み」の
// 2点のみで完結する(python側は完全に既存のまま)。

const TELOP_STYLE_TOKEN_RE = /\s*@style=[\w-]+\s*$/;

/**
 * telop.txtの各ページヘッダ行に `@style=<id>` ディレクティブを注入/更新する。
 * styleIdsByCut は keepSegments/telopOverrides と同じ順序(cut_001→index0, ...)。
 * 1つのcutに複数ページがあっても(build_telop_pagesが自動で複数ページに分けた場合)、
 * そのcutに属する全ページへ同じスタイルIDを適用する(シーン=cut単位でスタイルを揃えるため)。
 * 戻り値は実際に書き換えを行ったかどうか。
 */
function applyTelopStyleDirectivesToFile(runDir, styleIdsByCut) {
  if (!Array.isArray(styleIdsByCut) || !styleIdsByCut.length) return false;
  const telopPath = path.join(runDir, "telop.txt");
  if (!fs.existsSync(telopPath)) return false;

  const lines = fs.readFileSync(telopPath, "utf-8").split("\n");
  let changed = false;
  const output = lines.map((line) => {
    const header = TELOP_PAGE_HEADER_RE.exec(line.trim());
    if (!header) return line;
    const cutNumber = Number(header[2]);
    const styleId = styleIdsByCut[cutNumber - 1];
    if (typeof styleId !== "string" || !styleId) return line;
    const withoutStyle = line.replace(TELOP_STYLE_TOKEN_RE, "");
    const nextLine = `${withoutStyle} @style=${styleId}`;
    if (nextLine !== line) changed = true;
    return nextLine;
  });

  if (!changed) return false;
  fs.writeFileSync(telopPath, output.join("\n"), "utf-8");
  return true;
}

/** telop.txtの変更をcomposition.jsonへ反映する(既存のテロップ確定経路と同じ呼び出し方)。 */
async function applyTelopFileToComposition(runDir) {
  const root = repoRoot();
  const python = path.join(root, ".venv", "bin", "python");
  const relRunDir = path.relative(root, runDir);
  await spawnUtility({
    command: python,
    args: ["python/tools/apply_telop.py", relRunDir],
    cwd: root,
    env: apiKeys.buildPipelineEnv(),
  });
}

async function applyTranscriptKeepSegments(input) {
  const resolved = resolveRunDir(input?.runDir);
  applyWordCorrections(resolved, input?.corrections || []);
  updateCutProposalKeepSegments(resolved, input?.keepSegments || []);
  await rerunCompositionAndTelop(resolved);

  const textChanged = applyTelopOverridesToFile(resolved, input?.telopOverrides);

  // T-5: テーマ×感情のスタイル辞書をtelop_style_plan.jsonへ書き込み、composition.jsonへも
  // 即時反映する(apply_telop.py実行時にも同じplanが再適用されるため二重適用だが冪等)。
  if (input?.telopStylePlan && typeof input.telopStylePlan === "object") {
    const outputs = buildOutputs(resolved);
    const plan = {
      version: "1.0.0",
      source: "scene_theme_selector",
      updated_at: new Date().toISOString(),
      default_style: input.telopStylePlan.defaultStyle || "default",
      styles: input.telopStylePlan.styles || {},
    };
    writeJson(outputs.telopStylePlan, plan);
    applyTelopStylePlanToComposition(outputs, plan);
  }
  const styleChanged = applyTelopStyleDirectivesToFile(resolved, input?.telopStyleIdsByCut);

  if (textChanged || styleChanged) {
    await applyTelopFileToComposition(resolved);
  }
  return {
    transcript: loadTranscriptEditorState(resolved),
    review: loadTelopReviewState(resolved),
  };
}

async function runTranscriptCommand(input) {
  const resolved = resolveRunDir(input?.runDir);
  const command = String(input?.command || "");
  if (command === "silence_stronger" || command === "silence_weaker") {
    const source = loadTranscriptSource(resolved);
    const currentGap = Number(source.proposal?.stats?.config?.max_gap_ms || 600);
    const nextGap = command === "silence_stronger" ? currentGap - 120 : currentGap + 120;
    await rerunCutProposalWithGap(resolved, nextGap);
  } else if (command === "telop_font_bigger" || command === "telop_font_smaller") {
    const compositionPath = path.join(resolved, "step08_composition", "composition.json");
    const composition = readJson(compositionPath);
    const current = Number(composition?.timeline?.telop_font_size || 52);
    const delta = command === "telop_font_bigger" ? 4 : -4;
    composition.timeline = composition.timeline || {};
    composition.timeline.telop_font_size = Math.max(24, Math.min(120, current + delta));
    writeJson(compositionPath, composition);
  }
  return {
    transcript: loadTranscriptEditorState(resolved),
    review: loadTelopReviewState(resolved),
  };
}

function resolveRunDir(inputRunDir) {
  const root = repoRoot();
  const resolved = path.resolve(inputRunDir || "");
  const runsRoot = path.join(root, "runs");
  if (!resolved.startsWith(runsRoot + path.sep)) {
    throw new Error("runs 配下の作業フォルダを指定してください");
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`作業フォルダが見つかりません: ${resolved}`);
  }
  return resolved;
}

// --- Phase C (C-1): 波形データ生成 ---

const WAVEFORM_SAMPLE_RATE = 8000;
const WAVEFORM_DEFAULT_BIN_MS = 20;

function waveformCacheDir(runDir) {
  return path.join(runDir, "ui_cache");
}

function waveformCachePath(runDir) {
  return path.join(waveformCacheDir(runDir), "waveform.json");
}

function resolveRunAudioPath(runDir) {
  const candidate = path.join(runDir, "step01_preprocess", "audio.wav");
  return fs.existsSync(candidate) ? candidate : null;
}

/** ffmpegでPCM(16bit signed LE, mono)を抽出し、標準出力からBufferとして受け取る。 */
function runFfmpegPcm(audioPath, sampleRate) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      ["-y", "-i", audioPath, "-ac", "1", "-ar", String(sampleRate), "-f", "s16le", "-loglevel", "error", "pipe:1"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

/**
 * PCM(16bit signed LE, mono)バッファから binMs ごとの正規化済み(0-1)ピーク配列を計算する。
 * ビン計算アルゴリズムは src/lib/waveform.ts の computePeaksFromPcm16 と同一。
 * main(CJS)とsrc/lib(ESM/TS。レンダラーへViteでバンドルされ、テストはNodeで直接実行される)は
 * 実行時のモジュール形式が異なり直接共有できないため、ロジックを複製している。
 * アルゴリズムを変更する場合は両方を同期すること。
 */
function computeWaveformPeaks(pcmBuffer, sampleRate, binMs) {
  const totalSamples = Math.floor(pcmBuffer.length / 2);
  if (totalSamples === 0) return [];
  const samplesPerBin = Math.max(1, Math.round((sampleRate * binMs) / 1000));
  const binCount = Math.max(1, Math.ceil(totalSamples / samplesPerBin));
  const peaks = new Array(binCount).fill(0);
  for (let bin = 0; bin < binCount; bin += 1) {
    const start = bin * samplesPerBin;
    const end = Math.min(totalSamples, start + samplesPerBin);
    let peak = 0;
    for (let i = start; i < end; i += 1) {
      const sample = Math.abs(pcmBuffer.readInt16LE(i * 2));
      if (sample > peak) peak = sample;
    }
    peaks[bin] = peak;
  }
  return peaks.map((value) => Math.round((value / 32768) * 1000) / 1000);
}

/**
 * 指定runの波形ピーク配列を生成する(またはキャッシュから返す)。
 * キャッシュは runDir/ui_cache/waveform.json に保存し、音声ファイルの更新日時・サイズが
 * 一致する限り再利用する(2回目以降は即時返却)。
 */
async function generateWaveformForRun(runDir, options = {}) {
  const resolved = resolveRunDir(runDir);
  const binMs = Math.max(5, Math.round(options.binMs || WAVEFORM_DEFAULT_BIN_MS));
  const audioPath = resolveRunAudioPath(resolved);
  if (!audioPath) throw new Error("音声ファイル(step01_preprocess/audio.wav)が見つかりません");
  const audioStat = fs.statSync(audioPath);
  const cachePath = waveformCachePath(resolved);

  if (fs.existsSync(cachePath)) {
    try {
      const cached = readJson(cachePath);
      if (
        cached &&
        cached.binMs === binMs &&
        cached.audioMtimeMs === audioStat.mtimeMs &&
        cached.audioSize === audioStat.size &&
        Array.isArray(cached.peaks)
      ) {
        return {
          binMs: cached.binMs,
          sampleRate: cached.sampleRate,
          durationMs: cached.durationMs,
          peaks: cached.peaks,
          cached: true,
        };
      }
    } catch {
      // キャッシュが壊れている場合は再生成する。
    }
  }

  const pcm = await runFfmpegPcm(audioPath, WAVEFORM_SAMPLE_RATE);
  const peaks = computeWaveformPeaks(pcm, WAVEFORM_SAMPLE_RATE, binMs);
  const durationMs = Math.round((pcm.length / 2 / WAVEFORM_SAMPLE_RATE) * 1000);
  const payload = {
    version: 1,
    binMs,
    sampleRate: WAVEFORM_SAMPLE_RATE,
    durationMs,
    audioMtimeMs: audioStat.mtimeMs,
    audioSize: audioStat.size,
    peaks,
  };
  fs.mkdirSync(waveformCacheDir(resolved), { recursive: true });
  // ピーク配列が大きくなる(60分素材で約18万要素)ため、writeJsonの整形出力(pretty print)は使わずコンパクトに書き出す。
  fs.writeFileSync(cachePath, JSON.stringify(payload), "utf-8");
  return { binMs, sampleRate: WAVEFORM_SAMPLE_RATE, durationMs, peaks, cached: false };
}

async function applyFontDirectivesForRun(runDir, { useJobEvents = false } = {}) {
  const root = repoRoot();
  const python = path.join(root, ".venv", "bin", "python");
  const resolved = resolveRunDir(runDir);
  const relRunDir = path.relative(root, resolved);
  const env = apiKeys.buildPipelineEnv();

  ensureFontDirectives(resolved);

  const args = [
    "python/tools/apply_font_directives.py",
    relRunDir,
    "--apply-composition",
  ];

  if (useJobEvents) {
    await spawnCommand({
      command: python,
      args,
      cwd: root,
      env,
      stepId: "font_directives",
    });
  } else {
    await spawnUtility({
      command: python,
      args,
      cwd: root,
      env,
    });
  }
}

function applyTelopStylePlanToComposition(outputs, plan) {
  if (!fs.existsSync(outputs.composition)) return;
  const composition = readJson(outputs.composition);
  composition.timeline = composition.timeline || {};
  composition.timeline.telop_styles = plan.styles || {};
  composition.timeline.default_telop_style = plan.default_style || "default";
  composition.timeline.telop_style_plan = {
    version: plan.version || "1.0.0",
    source: "telop_style_plan.json",
    updated_at: plan.updated_at,
  };
  writeJson(outputs.composition, composition);
}

async function applyTelopAndExport(options) {
  const root = repoRoot();
  const python = path.join(root, ".venv", "bin", "python");
  const runDir = resolveRunDir(options.runDir);
  const relRunDir = path.relative(root, runDir);
  const renderFinal = options.renderFinal !== false;
  const env = apiKeys.buildPipelineEnv();
  const nodeEnv = apiKeys.buildPipelineEnv();

  if (!fs.existsSync(python)) {
    throw new Error(`Python venv not found: ${python}`);
  }

  sendJobEvent({ type: "export:start", runDir });

  await spawnCommand({
    command: python,
    args: ["python/tools/apply_telop.py", relRunDir],
    cwd: root,
    env,
    stepId: "apply_telop",
  });

  await applyFontDirectivesForRun(runDir, { useJobEvents: true });

  if (renderFinal) {
    const preprocess = readJson(path.join(runDir, "step01_preprocess", "preprocess.json"));
    const outputPath = resolveRenderOutputPath(runDir, options);
    writeRenderOutputPath(runDir, outputPath);
    await spawnCommand({
      command: "npm",
      args: [
        "run",
        "render:cli",
        "--",
        "--composition",
        path.join("..", relRunDir, "step08_composition", "composition.json"),
        "--output",
        outputPath,
        "--width",
        String(preprocess.display_width || 1280),
        "--height",
        String(preprocess.display_height || 720),
        "--concurrency",
        "4",
      ],
      cwd: path.join(root, "remotion"),
      env: nodeEnv,
      stepId: "render",
    });
  } else {
    sendJobEvent({ type: "step:done", stepId: "render" });
  }

  const outputs = buildOutputs(runDir);
  sendJobEvent({ type: "job:done", outputs });
  return outputs;
}

async function runPipeline(options) {
  const root = repoRoot();
  const python = path.join(root, ".venv", "bin", "python");
  const env = apiKeys.buildPipelineEnv();

  if (!fs.existsSync(python)) {
    throw new Error(`Python venv not found: ${python}`);
  }

  const videoPath = options.videoPath;
  if (!videoPath || !fs.existsSync(videoPath)) {
    throw new Error("動画ファイルが見つかりません");
  }

  const provider = options.sttProvider || "elevenlabs";
  if (provider === "elevenlabs" && !env.ELEVEN_API_KEY) {
    throw new Error("ElevenLabs APIキーが未設定です");
  }

  const runName = createRunName(videoPath);
  const runDir = path.join(root, "runs", runName);
  const relRunDir = path.relative(root, runDir);
  const renderFinal = options.renderFinal !== false;

  fs.mkdirSync(runDir, { recursive: true });
  activeJob.runDir = runDir;

  sendJobEvent({
    type: "job:start",
    runName,
    runDir,
    steps,
  });

  await spawnCommand({
    command: python,
    args: [
      "python/step01_preprocess.py",
      "--video",
      videoPath,
      "--output",
      path.join(relRunDir, "step01_preprocess"),
    ],
    cwd: root,
    env,
    stepId: "step01_preprocess",
  });

  const preprocess = readJson(path.join(runDir, "step01_preprocess", "preprocess.json"));
  const orientation = preprocess.orientation === "vertical" ? "vertical" : "horizontal";
  const project = path.join("templates", `${orientation}.yaml`);

  const sttArgs = [
    "python/step02_stt.py",
    "--provider",
    provider,
    "--language",
    "ja",
    "--audio",
    path.join(relRunDir, "step01_preprocess", "audio.wav"),
    "--output",
    path.join(relRunDir, "step02_stt"),
  ];
  if (provider === "local-whisper") {
    sttArgs.push("--whisper-model", options.whisperModel || "small");
  }

  await spawnCommand({
    command: python,
    args: sttArgs,
    cwd: root,
    env,
    stepId: "step02_stt",
  });

  await spawnCommand({
    command: python,
    args: [
      "python/step02b_transcript_correct.py",
      "--stt",
      path.join(relRunDir, "step02_stt", "stt_result.json"),
      "--dictionary",
      "templates/domain_dictionary.yaml",
      "--project",
      project,
      "--output",
      path.join(relRunDir, "step02b_transcript_correct"),
    ],
    cwd: root,
    env,
    stepId: "step02b_transcript_correct",
  });

  const correctedStt = path.join(relRunDir, "step02b_transcript_correct", "stt_corrected.json");

  await spawnCommand({
    command: python,
    args: [
      "python/step03_vad.py",
      "--audio",
      path.join(relRunDir, "step01_preprocess", "audio.wav"),
      "--stt",
      correctedStt,
      "--output",
      path.join(relRunDir, "step03_vad"),
    ],
    cwd: root,
    env,
    stepId: "step03_vad",
  });

  await spawnCommand({
    command: python,
    args: [
      "python/step04_filler_detect.py",
      "--stt",
      correctedStt,
      "--vad",
      path.join(relRunDir, "step03_vad", "vad_result.json"),
      "--output",
      path.join(relRunDir, "step04_filler_detect"),
    ],
    cwd: root,
    env,
    stepId: "step04_filler_detect",
  });

  writeJson(path.join(runDir, "step06_scene_structure", "scenes.json"), { scenes: [] });
  writeJson(path.join(runDir, "step06_review", "review.json"), {
    corrections: {},
    quality_notes: ["desktop local run"],
  });

  await spawnCommand({
    command: python,
    args: [
      "python/step05_ai_retake.py",
      relRunDir,
      "--stt",
      correctedStt,
      "--fillers",
      path.join(relRunDir, "step04_filler_detect", "fillers.json"),
      "--retakes-output",
      path.join(relRunDir, "step05_retake_detect", "retakes.json"),
      "--review-output",
      path.join(relRunDir, "step05_ai_retake", "ai_review.json"),
    ],
    cwd: root,
    env,
    stepId: "step05_ai_retake",
  });

  await spawnCommand({
    command: python,
    args: [
      "python/step07_cut_proposal.py",
      "--stt",
      correctedStt,
      "--fillers",
      path.join(relRunDir, "step04_filler_detect", "fillers.json"),
      "--retakes",
      path.join(relRunDir, "step05_retake_detect", "retakes.json"),
      "--scenes",
      path.join(relRunDir, "step06_scene_structure", "scenes.json"),
      "--vad",
      path.join(relRunDir, "step03_vad", "vad_result.json"),
      "--project",
      project,
      "--output",
      path.join(relRunDir, "step07_cut_proposal"),
    ],
    cwd: root,
    env,
    stepId: "step07_cut_proposal",
  });

  await spawnCommand({
    command: python,
    args: [
      "python/step08_composition.py",
      "--proposal",
      path.join(relRunDir, "step07_cut_proposal", "cut_proposal.json"),
      "--stt",
      correctedStt,
      "--video",
      videoPath,
      "--output",
      path.join(relRunDir, "step08_composition"),
      "--project",
      project,
      "--review",
      path.join(relRunDir, "step06_review", "review.json"),
    ],
    cwd: root,
    env,
    stepId: "step08_composition",
  });

  await spawnCommand({
    command: python,
    args: ["python/tools/extract_telop.py", relRunDir],
    cwd: root,
    env,
    stepId: "extract_telop",
  });

  await spawnCommand({
    command: python,
    args: [
      "python/tools/review_telop.py",
      relRunDir,
      "--dictionary",
      "templates/domain_dictionary.yaml",
    ],
    cwd: root,
    env,
    stepId: "review_telop",
  });

  // 改善11: AI校正(step06b)。ANTHROPIC_API_KEY未設定時はPython側が安全にスキップする
  await spawnCommand({
    command: python,
    args: [
      "python/step06b_ai_refine.py",
      relRunDir,
      "--stt",
      correctedStt,
      "--project",
      project,
      "--output",
      path.join(relRunDir, "step06b_ai_refine", "refine.json"),
      "--review",
      path.join(relRunDir, "telop_review.json"),
      "--dictionary",
      "templates/domain_dictionary.yaml",
      "--title",
      extractRunTitle(runDir),
    ],
    cwd: root,
    env,
    stepId: "step06b_ai_refine",
  });

  if (options.groundTruthPath && ENABLE_GROUND_TRUTH_LEARNING) {
    const report = evaluateAndLearnGroundTruth(runDir, options.groundTruthPath);
    sendJobEvent({
      type: "learning:done",
      report,
    });
    sendJobEvent({
      type: "log",
      message:
        `\n[LEARNING]\n` +
        `truth pages: ${report.summary.truthPages}, generated pages: ${report.summary.generatedPages}\n` +
        `telop_start_offset_ms: ${report.appliedRules.timing.telopStartOffsetMs}\n` +
        `vad_start_bias_ms: ${report.appliedRules.timing.vadStartBiasMs}, ` +
        `vad_end_bias_ms: ${report.appliedRules.timing.vadEndBiasMs}, ` +
        `word_vad_clamp_strength: ${report.appliedRules.timing.wordVadClampStrength}\n` +
        `max_gap_ms: ${report.appliedRules.edit.maxGapMs}, segment_padding_ms: ${report.appliedRules.edit.segmentPaddingMs}\n` +
        `max_chars_per_line: ${report.appliedRules.telop.maxCharsPerLine}, max_lines_per_page: ${report.appliedRules.telop.maxLinesPerPage}\n` +
        `rules: ${report.learnedRulesPath}\n`,
    });
  } else if (options.groundTruthPath) {
    sendJobEvent({
      type: "log",
      message: "\n[LEARNING]\n正解データ学習は現在オフです。正式ルールへの反映は行いません。\n",
    });
  }

  if (options.fontProfileMode === "saved") {
    const savedDirectives = resolveSavedFontDirectives(options);
    if (savedDirectives) {
      const outputs = buildOutputs(runDir);
      fs.writeFileSync(outputs.fontDirectives, savedDirectives, "utf-8");
    }
    applySavedFontProfileStyles(runDir, resolveSavedFontProfile(options));
  }

  await applyFontDirectivesForRun(runDir, { useJobEvents: true });

  if (options.reviewBeforeExport !== false) {
    sendJobEvent({
      type: "review:ready",
      runDir,
      renderFinal,
      ...loadTelopReviewState(runDir),
    });
    return buildOutputs(runDir);
  }

  return applyTelopAndExport({ runDir, renderFinal, outputPath: options.outputPath });
}

ipcMain.handle("settings:get", () => loadSettings());
ipcMain.handle("settings:save", (_event, input) => saveSettings(input || {}));
ipcMain.handle("api-keys:status", () => apiKeys.getApiKeysStatus());
ipcMain.handle("api-keys:set", (_event, input) => {
  const provider = input?.provider;
  if (!["elevenlabs", "anthropic", "openai", "gemini"].includes(provider)) {
    throw new Error("不明なAPIキー種別です");
  }
  return apiKeys.saveApiKey(provider, input?.apiKey);
});
ipcMain.handle("api-keys:delete", (_event, input) => {
  const provider = input?.provider;
  if (!["elevenlabs", "anthropic", "openai", "gemini"].includes(provider)) {
    throw new Error("不明なAPIキー種別です");
  }
  return apiKeys.deleteApiKey(provider);
});
ipcMain.handle("api-keys:test", async (_event, input) => {
  const provider = input?.provider;
  if (!["elevenlabs", "anthropic", "openai", "gemini"].includes(provider)) {
    throw new Error("不明なAPIキー種別です");
  }
  return apiKeys.testApiKeyConnection(provider, input?.apiKey);
});
ipcMain.handle("shell:openExternal", (_event, url) => {
  const target = String(url || "").trim();
  if (!target) return;
  return shell.openExternal(target);
});
ipcMain.handle("font-profiles:list", () => readFontProfiles());
ipcMain.handle("telop-presets:list", () => loadTelopPresetCatalog());
ipcMain.handle("font-profiles:save", (_event, input) => saveFontProfile(input || {}));
ipcMain.handle("font-profiles:delete", (_event, profileId) => deleteFontProfile(profileId));
ipcMain.handle("user-rules:get", () => readUserRules());
ipcMain.handle("user-rules:save", (_event, input) => saveUserRules(input || {}));
ipcMain.handle("user-rules:learnDictionary", (_event, input) => learnDictionaryRule(input || {}));
ipcMain.handle("user-rules:recordDecision", (_event, input) => recordLearningDecision(input || {}));
ipcMain.handle("user-dictionary:get", () => readUserDictionary());
ipcMain.handle("user-dictionary:save", (_event, input) => saveUserDictionaryEntry(input || {}));
ipcMain.handle("user-dictionary:delete", (_event, from) => deleteUserDictionaryEntry(from));

ipcMain.handle("dialog:chooseVideo", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "動画を選択",
    properties: ["openFile"],
    filters: [
      { name: "Video", extensions: ["mp4", "mov", "m4v", "avi", "mkv"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (result.canceled) return null;
  return result.filePaths[0] || null;
});

ipcMain.handle("ground-truth:choose", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "正解テロップtxtを選択",
    properties: ["openFile"],
    filters: [
      { name: "Text", extensions: ["txt"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return parseGroundTruthTextFile(result.filePaths[0]);
});

ipcMain.handle("ground-truth:analyze", async (_event, input) => analyzeGroundTruthRules(input || {}));
ipcMain.handle("ground-truth:apply-rule-proposal", async (_event, input) => applyGroundTruthRuleProposal(input || {}));

ipcMain.handle("ground-truth:apply", async (_event, input) => {
  if (!ENABLE_GROUND_TRUTH_LEARNING) {
    throw new Error("正解データ学習は現在オフです。正式ルールへの反映は行いません。");
  }
  return applyGroundTruthToRun(input || {});
});

ipcMain.handle("dialog:chooseOutputDirectory", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "動画の保存場所を選択",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled) return null;
  return result.filePaths[0] || null;
});

ipcMain.handle("dialog:saveOutputFile", async (_event, input) => {
  const defaultPath =
    input?.defaultPath ||
    path.join(app.getPath("downloads"), ensureMp4FileName(input?.defaultFileName || "catcut-output.mp4"));
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "名前を付けて保存",
    defaultPath,
    filters: [{ name: "MP4 video", extensions: ["mp4"] }],
  });
  if (result.canceled || !result.filePath) return null;
  return ensureMp4OutputPath(result.filePath);
});

ipcMain.handle("path:reveal", (_event, targetPath) => {
  if (!targetPath) return;
  shell.showItemInFolder(targetPath);
});

ipcMain.handle("path:open", (_event, targetPath) => {
  if (!targetPath) return;
  shell.openPath(targetPath);
});

ipcMain.handle("ollama:openInstallGuide", () => {
  shell.openExternal("https://ollama.com/download");
});

ipcMain.handle("ollama:status", async () => getOllamaStatus());

ipcMain.handle("ollama:pull", async (_event, input) => {
  const model = input?.model || DEFAULT_OLLAMA_MODEL;
  const version = ollamaVersion();
  if (!version.installed) {
    return { ok: false, error: "Ollamaがインストールされていません" };
  }

  return new Promise((resolve) => {
    const child = spawn("ollama", ["pull", model], { cwd: repoRoot(), env: process.env });
    let lastMessage = "";
    const onData = (chunk) => {
      const message = chunk.toString();
      lastMessage = message;
      sendJobEvent({ type: "ollama:pull:progress", message });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (error) => resolve({ ok: false, error: error.message || String(error) }));
    child.on("close", async (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: lastMessage || `ollama pull exited with code ${code}` });
        return;
      }
      resolve({ ok: true, status: await getOllamaStatus(model) });
    });
  });
});

ipcMain.handle("ollama:review-telop", async (_event, input) => {
  const model = input?.model || DEFAULT_OLLAMA_MODEL;
  const status = await getOllamaStatus(model);
  if (!status.installed) throw new Error("Ollamaがインストールされていません");
  if (!status.running) throw new Error("Ollamaが起動していません。Ollamaアプリを起動してから再チェックしてください");
  if (!status.modelInstalled) throw new Error(`モデル ${model} が未ダウンロードです`);

  const result = await ollamaRequest("/api/generate", {
    model,
    prompt: buildTelopReviewPrompt(input?.text || ""),
    stream: false,
    options: {
      temperature: 0.1,
      num_ctx: 8192,
    },
  });
  const raw = result.response || "";
  return { findings: normalizeAiFindings(safeJsonArrayFromText(raw), input?.text || ""), raw };
});

ipcMain.handle("telop:load", (_event, runDir) => {
  const resolved = resolveRunDir(runDir);
  return loadTelopReviewState(resolved);
});

ipcMain.handle("transcript:load", (_event, runDir) => loadTranscriptEditorState(runDir));
ipcMain.handle("transcript:apply", async (_event, input) => applyTranscriptKeepSegments(input || {}));
ipcMain.handle("transcript:run-command", async (_event, input) => runTranscriptCommand(input || {}));
ipcMain.handle("transcript:waveform", async (_event, input) =>
  generateWaveformForRun(input?.runDir, { binMs: input?.binMs }),
);

ipcMain.handle("telop:save", (_event, input) => {
  const resolved = resolveRunDir(input?.runDir);
  const outputs = buildOutputs(resolved);
  fs.writeFileSync(outputs.telop, String(input?.text || ""), "utf-8");
  return loadTelopReviewState(resolved);
});

ipcMain.handle("font:apply", async (_event, input) => {
  const resolved = resolveRunDir(input?.runDir);
  const outputs = buildOutputs(resolved);
  fs.writeFileSync(outputs.fontDirectives, String(input?.text || ""), "utf-8");
  await applyFontDirectivesForRun(resolved);
  return loadTelopReviewState(resolved);
});

ipcMain.handle("telop-style:apply", async (_event, input) => {
  const resolved = resolveRunDir(input?.runDir);
  const outputs = buildOutputs(resolved);
  const styles = input?.styles && typeof input.styles === "object" ? input.styles : {};
  const root = repoRoot();
  const python = path.join(root, ".venv", "bin", "python");
  const relRunDir = path.relative(root, resolved);
  const plan = {
    version: "1.0.0",
    source: "desktop_style_editor",
    updated_at: new Date().toISOString(),
    default_style: input?.defaultStyleName || "default",
    styles,
  };

  fs.writeFileSync(outputs.telop, String(input?.text || ""), "utf-8");
  fs.writeFileSync(outputs.telopStyleDirectives, String(input?.directivesText || ""), "utf-8");
  writeJson(outputs.telopStylePlan, plan);
  applyTelopStylePlanToComposition(outputs, plan);
  if (fs.existsSync(python) && fs.existsSync(outputs.telop)) {
    await spawnUtility({
      command: python,
      args: ["python/tools/apply_telop.py", relRunDir],
      cwd: root,
      env: apiKeys.buildPipelineEnv(),
    });
  }
  return loadTelopReviewState(resolved);
});

ipcMain.handle("job:start", async (_event, options) => {
  if (activeJob) {
    return { ok: false, error: "別のジョブが実行中です" };
  }

  activeJob = { cancelled: false, child: null, runDir: null };

  runPipeline(options || {})
    .catch((error) => {
      const message = error.message || String(error);
      sendJobEvent({ type: "log", message: `\n[ERROR]\n${message}\n` });
      sendJobEvent({ type: "job:error", error: message });
    })
    .finally(() => {
      activeJob = null;
    });

  return { ok: true };
});

ipcMain.handle("export:start", async (_event, options) => {
  if (activeJob) {
    return { ok: false, error: "別のジョブが実行中です" };
  }

  try {
    const runDir = resolveRunDir(options?.runDir);
    activeJob = { cancelled: false, child: null, runDir };

    applyTelopAndExport({
      runDir,
      renderFinal: options?.renderFinal !== false,
      outputPath: options?.outputPath || "",
    })
      .catch((error) => {
        const message = error.message || String(error);
        sendJobEvent({ type: "log", message: `\n[ERROR]\n${message}\n` });
        sendJobEvent({ type: "job:error", error: message });
      })
      .finally(() => {
        activeJob = null;
      });

    return { ok: true };
  } catch (error) {
    activeJob = null;
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle("job:cancel", () => {
  if (!activeJob) return { ok: true };
  activeJob.cancelled = true;
  if (activeJob.child) {
    activeJob.child.kill("SIGTERM");
  }
  sendJobEvent({ type: "job:cancelled" });
  activeJob = null;
  return { ok: true };
});

app.whenReady().then(async () => {
  await ensurePreviewServer();
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// テスト・検証スクリプトから直接呼び出せるようにする(Electronアプリの起動には影響しない)。
module.exports = {
  generateWaveformForRun,
  computeWaveformPeaks,
  resolveRunAudioPath,
  waveformCachePath,
};
