// W16-6: powerMonitor はスリープ/画面ロック時にレンダラーへ再生停止を通知するために使う。
const { app, BrowserWindow, dialog, ipcMain, powerMonitor, shell } = require("electron");
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const yaml = require("js-yaml");
const { createApiKeysModule } = require("./apiKeys.cjs");
// W12-2: ライセンス基盤(userData/license.json・billing-server呼び出し)
const { createLicenseModule, registerLicenseIpc } = require("./license.cjs");
// フェーズW8(素材選択時の縦横選択): ffprobe結果のパース・orientation解決の純ロジック
const {
  parseProbeOutput,
  resolveRunOrientationValue,
  sanitizeOrientation,
} = require("./orientation.cjs");
// W13-1: 派生キャッシュ(segments/・preview_cut_sequence等)の統計・クリーンアップ
const { collectCacheStats, cleanCaches } = require("./cache.cjs");
// W14-2: 編集前→編集後の修正ペア学習(edit_history.json / correction_history.json)
const editLearning = require("./editLearning.cjs");
// W19-C2: 差分なしなら step08 を完全スキップするための入力合成ハッシュ
const {
  computeStep08InputHash,
  canSkipStep08,
  writeStep08InputHash,
} = require("./step08Hash.cjs");
// フェーズW23(改善1): 解析開始前のOP有無チェック → run正本op_config初期値の決定
const { resolveStartOpConfig } = require("./opStart.cjs");

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
  // W19-B1: 弱区間の再文字起こし(step05b)。キー無し・失敗はnon-fatalでスキップされる
  { id: "step05b_retranscribe", label: "弱区間の再文字起こし" },
  { id: "step07_cut_proposal", label: "カット提案" },
  { id: "step06c_direction", label: "演出決定" },
  { id: "step08_composition", label: "コンポジション" },
  { id: "extract_telop", label: "テロップ抽出" },
  { id: "review_telop", label: "書き出し前チェック" },
  { id: "step06b_ai_refine", label: "AI校正" },
  { id: "font_directives", label: "フォント反映" },
  // W19-B2: AI最終チェック(step06d)の自動実行。検品準備完了の直前に走る(non-fatal)
  { id: "step06d_final_check", label: "AI最終チェック" },
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

// --- フェーズT2.5-4: シーン種類(semantic type) → テロッププリセット マッピング ---
//
// 既定は templates/telop_type_mapping.yaml、ユーザー変更分は userData の
// telop_type_mapping.json に永続化する(apiKeys等と同じuserData永続化パターン)。
// python側(step06c/step08)へは --type-mapping でユーザーJSONのパスを渡し、
// load_type_mapping() が「フォールバック < 既定YAML < ユーザーJSON」で解決する。
// type一覧・既定マッピングは python/shared/telop_types.py / src/lib/telopTypes.ts と同期すること。

const TELOP_SEMANTIC_TYPES = [
  "default",
  "surprise",
  "harsh",
  "quote",
  "emphasis",
  "question",
  "reply",
  "punchline",
  "hype",
  "cta",
];

const TELOP_TYPE_FALLBACK_MAPPING = {
  default: "fact_yellow",
  surprise: "box_yellow",
  harsh: "serif_harsh",
  quote: "serif_quote",
  emphasis: "emotion_red",
  question: "question_blue",
  reply: "reply_cyan",
  punchline: "box_yellow",
  hype: "special_purple",
  cta: "cta_yellow",
};

// フェーズT3: マッピングエントリが指定できる登場アニメ・効果音ID
// (python/shared/telop_types.py / src/lib/telopAnimations.ts と同期)。
// フェーズW24 Phase B-1: 広告向け4種(blur_in/typewriter/wipe_up/drop_settle)を追加
const TELOP_ANIMATION_IN_TYPES = [
  "pop_big", "slide_left", "slide_up", "zoom", "stamp", "fade",
  "blur_in", "typewriter", "wipe_up", "drop_settle", "none",
];
// フェーズW2: teen(チーン。映像ギミックpinchの既定SFX)を追加
const TELOP_SFX_IDS = ["don", "shakin", "pon", "jan", "hyu", "teen"];

// フェーズW1: 話者カラーの既定(templates/telop_type_mapping.yaml の speaker_colors と同内容の保険)。
// python/shared/telop_types.py / src/lib/designExtras.ts と同期すること。
const SPEAKER_COLORS_FALLBACK = {
  enabled: true,
  apply_types: ["default", "reply"],
  styles: { speaker_1: "fact_cyan", speaker_2: "fact_green" },
};

// フェーズU7: シーンタイトル(chapter_title)の描画パターンID
// (remotion/src/lib/overlayStyles.ts CHAPTER_TITLE_PATTERNS / python shared/telop_types.py と同期)。
const OVERLAY_TITLE_PATTERNS = ["box_accent", "band_gradient", "tag_ribbon", "minimal_line", "neon_plate"];
// フェーズU8→V5: OPパターンID。V5で「なし/ハイライト予告」の2択へ一本化
// (src/lib/designExtras.ts と同期)。旧パターンは読み込み時に highlight_teaser へ移行する。
const OP_PATTERN_IDS = ["none", "highlight_teaser"];
const LEGACY_OP_PATTERN_IDS = ["title_card", "question_hook"];
// フェーズV5: OP装飾・テロップ登場アニメID(remotion/src/lib/opTimeline.ts と同期)。
const OP_DECORATION_IDS = ["flash_pop", "cinema_bars", "color_wipe", "neon_frame"];
const OP_TEXT_ANIMATION_IDS = ["slide_left", "slide_up", "stamp"];

/** フェーズU7: overlay_title 設定の正規化(欠落・不正は「有効・box_accent」=従来挙動)。 */
function sanitizeOverlayTitleConfig(raw) {
  const result = { enabled: true, style: "box_accent" };
  if (!raw || typeof raw !== "object") return result;
  if (raw.enabled === false) result.enabled = false;
  if (typeof raw.style === "string" && OVERLAY_TITLE_PATTERNS.includes(raw.style)) {
    result.style = raw.style;
  }
  return result;
}

/**
 * フェーズW1: speaker_colors 設定1ソース分の部分正規化
 * (python shared/telop_types.py の sanitize_speaker_colors と同じ規則)。
 * 存在する有効フィールドだけ返し、欠落は呼び出し側のマージで下位ソースの値が残る。
 */
function sanitizeSpeakerColorsPartial(raw) {
  const result = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return result;
  if (typeof raw.enabled === "boolean") result.enabled = raw.enabled;
  const applyTypes = Array.isArray(raw.apply_types) ? raw.apply_types : raw.applyTypes;
  if (Array.isArray(applyTypes)) {
    const valid = applyTypes.map(String).filter((type) => TELOP_SEMANTIC_TYPES.includes(type));
    if (valid.length) result.apply_types = valid;
  }
  const styles = raw.styles;
  if (styles && typeof styles === "object" && !Array.isArray(styles)) {
    const clean = {};
    for (const [key, value] of Object.entries(styles)) {
      const speaker = String(key || "").trim();
      if (speaker && typeof value === "string" && value.trim()) clean[speaker] = value.trim();
    }
    if (Object.keys(clean).length) result.styles = clean;
  }
  return result;
}

/** フェーズW1: 話者カラーの既定(フォールバック定数 < templates/telop_type_mapping.yaml)。常に完全形。 */
function loadDefaultSpeakerColors() {
  const result = {
    enabled: SPEAKER_COLORS_FALLBACK.enabled,
    apply_types: [...SPEAKER_COLORS_FALLBACK.apply_types],
    styles: { ...SPEAKER_COLORS_FALLBACK.styles },
  };
  try {
    const defaultPath = path.join(repoRoot(), "templates", "telop_type_mapping.yaml");
    if (fs.existsSync(defaultPath)) {
      const parsed = yaml.load(fs.readFileSync(defaultPath, "utf-8"));
      Object.assign(result, sanitizeSpeakerColorsPartial(parsed && parsed.speaker_colors));
    }
  } catch (error) {
    console.error("[speaker-colors] failed to load default yaml:", error);
  }
  return result;
}

/** フェーズW1: 部分設定を既定の上に重ねて完全形にする。 */
function resolveSpeakerColorsConfig(rawPartial) {
  return { ...loadDefaultSpeakerColors(), ...sanitizeSpeakerColorsPartial(rawPartial) };
}

/**
 * フェーズW2: シーン映像ギミック(video_effects)設定の正規化
 * (python shared/video_effects.py の sanitize_video_effects_enabled と同じ規則)。
 * - pinch / zoom: 欠落・不正はON(既定=W2からの後方互換)。明示的な false のみOFF。
 * - dim / face_zoom / slow_push(W24 Phase C): 欠落・不正はOFF(既定=既存テーマは
 *   従来動作)。明示的な true のみON。
 */
function sanitizeVideoEffectsConfig(raw) {
  const result = { pinch: true, zoom: true, dim: false, face_zoom: false, slow_push: false };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return result;
  if (raw.pinch === false) result.pinch = false;
  if (raw.zoom === false) result.zoom = false;
  if (raw.dim === true) result.dim = true;
  if (raw.face_zoom === true) result.face_zoom = true;
  if (raw.slow_push === true) result.slow_push = true;
  return result;
}

// W13-3: OPタイトル/キャッチコピーに実データとして混入しがちなプレースホルダ的文言。
// テーマ設定への試し入力が design_themes.json → 各runの op_config.json へ伝播して
// 動画に「タイトルテキスト」等が表示される事故があったため、読み込み時に空へ正規化する。
// desktop/src/lib/designExtras.ts / python shared/opening.py と同一リストを保つこと
const OP_PLACEHOLDER_TEXTS = ["タイトルテキスト", "タイトルテスト", "キャッチコピー", "サンプルテキスト"];

/** W13-3: プレースホルダ的文言は空文字へ正規化する(trim込み)。 */
function normalizeOpUserText(value) {
  const trimmed = String(value || "").trim();
  return OP_PLACEHOLDER_TEXTS.includes(trimmed) ? "" : trimmed;
}

/**
 * フェーズU8: op 設定の正規化(欠落・不正は pattern=none=OPなし)。
 * フェーズV5: 旧パターン(title_card等)は highlight_teaser へ無警告マイグレーション。
 * decoration / text_animation は未知値を既定(flash_pop / slide_left)へ落とす。
 */
function sanitizeOpConfig(raw) {
  const result = {
    pattern: "none",
    decoration: "flash_pop",
    text_animation: "slide_left",
    title: "",
    // W11-5: タイトルを表示するか。明示false のみ「表示しない」(省略=true=後方互換)
    title_enabled: true,
    catch_copy: "",
  };
  if (!raw || typeof raw !== "object") return result;
  if (typeof raw.pattern === "string") {
    if (OP_PATTERN_IDS.includes(raw.pattern)) {
      result.pattern = raw.pattern;
    } else if (LEGACY_OP_PATTERN_IDS.includes(raw.pattern)) {
      result.pattern = "highlight_teaser";
    }
  }
  if (typeof raw.decoration === "string" && OP_DECORATION_IDS.includes(raw.decoration)) {
    result.decoration = raw.decoration;
  }
  if (typeof raw.text_animation === "string" && OP_TEXT_ANIMATION_IDS.includes(raw.text_animation)) {
    result.text_animation = raw.text_animation;
  }
  // W13-3: プレースホルダ的文言(「タイトルテキスト」等)は空扱いに正規化する
  if (typeof raw.title === "string") result.title = normalizeOpUserText(raw.title);
  result.title_enabled = raw.title_enabled !== false;
  // UI側はcamelCase(catchCopy)、保存形式はsnake_case(catch_copy)の両方を受ける
  const catchCopy = raw.catch_copy !== undefined ? raw.catch_copy : raw.catchCopy;
  if (typeof catchCopy === "string") result.catch_copy = normalizeOpUserText(catchCopy);
  return result;
}

/**
 * フェーズV2: run単位op_config.jsonのクリップ配列の正規化。
 * python側 shared/opening.py の _normalize_op_clips と同一規則
 * (不正エントリは捨て、有効クリップ0件は null=AI自動選定)。
 * start_ms/end_ms は元動画の絶対ms(カット編集後もpython側が中点でカットへ再解決する)。
 */
function sanitizeOpClips(raw) {
  if (!Array.isArray(raw)) return null;
  const clips = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const startMs = Math.round(Number(entry.start_ms));
    const endMs = Math.round(Number(entry.end_ms));
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    // フェーズW: フックワード系メタ(display/hook_text/keyword/keyword_color)を保持する
    const hookText = typeof entry.hook_text === "string" ? entry.hook_text.trim() : "";
    const displayRaw = entry.display;
    const display =
      displayRaw === "hook" || displayRaw === "verbatim"
        ? displayRaw === "hook" && !hookText
          ? "verbatim"
          : displayRaw
        : hookText
          ? "hook"
          : "verbatim";
    clips.push({
      cut_id: typeof entry.cut_id === "string" ? entry.cut_id : "",
      start_ms: startMs,
      end_ms: endMs,
      text: typeof entry.text === "string" ? entry.text.trim() : "",
      style: typeof entry.style === "string" ? entry.style.trim() : "",
      display,
      hook_text: hookText,
      keyword: typeof entry.keyword === "string" ? entry.keyword.trim() : "",
      keyword_color:
        entry.keyword_color === "red" || entry.keyword_color === "white" ? entry.keyword_color : "yellow",
    });
  }
  return clips.length ? clips : null;
}

/** フェーズV2: run単位OP設定({pattern,title,catch_copy,clips})の正規化。 */
function sanitizeRunOpConfig(raw) {
  return {
    ...sanitizeOpConfig(raw),
    clips: raw && typeof raw === "object" ? sanitizeOpClips(raw.clips) : null,
  };
}

/** フェーズV2: run単位のOP設定ファイル(このrunのOPの正本)。 */
function runOpConfigPath(runDir) {
  return path.join(runDir, "op_config.json");
}

/** run単位OP設定を読む(ファイルなし・破損は null=未生成扱い)。 */
function readRunOpConfig(runDir) {
  try {
    const filePath = runOpConfigPath(runDir);
    if (!fs.existsSync(filePath)) return null;
    return sanitizeRunOpConfig(readJson(filePath));
  } catch (error) {
    console.error("[op-config] failed to read op_config.json:", error);
    return null;
  }
}

/** run単位OP設定を書き込み、正規化後の値を返す。 */
function writeRunOpConfig(runDir, config) {
  const sanitized = sanitizeRunOpConfig(config);
  writeJson(runOpConfigPath(runDir), sanitized);
  return sanitized;
}

/**
 * run単位OP設定を返す。無ければテーマ(orスタンダード)のOP設定から生成して保存する
 * (以降はこのrunの op_config.json が正本になり、テーマ変更の影響を受けない)。
 * clips: null = AI自動選定(select_highlight_clips)。
 */
function ensureRunOpConfig(runDir) {
  const existing = readRunOpConfig(runDir);
  if (existing) return existing;
  const initial = { ...resolveDesignExtras().op, clips: null };
  return writeRunOpConfig(runDir, initial);
}

function telopTypeMappingPath() {
  return userDataPath("telop_type_mapping.json");
}

/**
 * マッピング1エントリの正規化(フェーズT3: 新旧形式対応)。
 * 旧形式(文字列=styleのみ)は { style } へ包み、新形式は不正フィールドを落とす。
 * 有効なフィールドが1つも無ければ null。
 */
function normalizeTelopTypeEntry(value) {
  if (typeof value === "string") {
    return value.trim() ? { style: value.trim() } : null;
  }
  if (!value || typeof value !== "object") return null;
  const entry = {};
  if (typeof value.style === "string" && value.style.trim()) entry.style = value.style.trim();
  if (typeof value.animation_in === "string" && TELOP_ANIMATION_IN_TYPES.includes(value.animation_in)) {
    entry.animation_in = value.animation_in;
  }
  if (typeof value.sfx === "string" && (TELOP_SFX_IDS.includes(value.sfx) || value.sfx === "none")) {
    entry.sfx = value.sfx;
  }
  return Object.keys(entry).length ? entry : null;
}

/** type_stylesセクション(または直下)から有効なエントリ({style, animation_in?, sfx?})だけ拾う。 */
function extractTypeEntries(raw) {
  const source = raw && typeof raw === "object" ? (raw.type_styles ?? raw) : {};
  const result = {};
  if (!source || typeof source !== "object") return result;
  for (const type of TELOP_SEMANTIC_TYPES) {
    const entry = normalizeTelopTypeEntry(source[type]);
    if (entry) result[type] = entry;
  }
  return result;
}

/**
 * フェーズU6: カスタムスタイル定義(id → TelopStyle)を検証する。
 * python側 sanitize_custom_styles と同じ規則(辞書かつfillを持つエントリのみ残す)。
 */
function sanitizeCustomStyles(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result = {};
  for (const [key, value] of Object.entries(raw)) {
    const styleId = String(key || "").trim();
    if (!styleId || !value || typeof value !== "object" || Array.isArray(value)) continue;
    if (!value.fill || typeof value.fill !== "object") continue;
    result[styleId] = value;
  }
  return result;
}

/** エントリをフィールド単位でマージする(python load_type_mapping_entries と同じ規則)。 */
function mergeTypeEntries(base, loaded) {
  for (const [type, entry] of Object.entries(loaded)) {
    base[type] = { ...(base[type] || {}), ...entry };
  }
  return base;
}

/** 既定マッピング(フォールバック定数 < templates/telop_type_mapping.yaml)。値はフルエントリ。 */
function loadDefaultTelopTypeMapping() {
  const mapping = {};
  for (const [type, style] of Object.entries(TELOP_TYPE_FALLBACK_MAPPING)) {
    mapping[type] = { style };
  }
  try {
    const defaultPath = path.join(repoRoot(), "templates", "telop_type_mapping.yaml");
    if (fs.existsSync(defaultPath)) {
      mergeTypeEntries(mapping, extractTypeEntries(yaml.load(fs.readFileSync(defaultPath, "utf-8"))));
    }
  } catch (error) {
    console.error("[telop-type-mapping] failed to load default yaml:", error);
  }
  return mapping;
}

/**
 * 解決済みのtype→エントリマッピング(既定 + ユーザー上書き)。常に全typeのエントリ(styleあり)を持つ。
 * フェーズT3: 値は { style, animation_in?, sfx? } の新形式(旧形式のuserDataも読める)。
 */
function loadTelopTypeMapping() {
  const mapping = loadDefaultTelopTypeMapping();
  try {
    const filePath = telopTypeMappingPath();
    if (fs.existsSync(filePath)) {
      mergeTypeEntries(mapping, extractTypeEntries(readJson(filePath)));
    }
  } catch (error) {
    console.error("[telop-type-mapping] failed to load user mapping:", error);
  }
  return mapping;
}

/** userData/telop_type_mapping.json の生JSON(スタンダードのU7/U8設定の読み出しに使う)。 */
function readUserTelopMappingRaw() {
  try {
    const filePath = telopTypeMappingPath();
    if (!fs.existsSync(filePath)) return {};
    const parsed = readJson(filePath);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * ユーザーマッピングをuserDataへ保存し(常に新形式)、解決済みマッピングを返す。
 * フェーズU7/U8: スタンダード(テーマ未選択)のシーンタイトル・OP設定も同じファイルに持つ。
 * extras 未指定(undefined)の保存では既存の設定を維持する(マッピングだけの保存で消さない)。
 */
function saveTelopTypeMapping(input, extras) {
  const sanitized = extractTypeEntries(input);
  const existing = readUserTelopMappingRaw();
  const overlayTitle =
    extras && extras.overlayTitle !== undefined
      ? sanitizeOverlayTitleConfig(extras.overlayTitle)
      : sanitizeOverlayTitleConfig(existing.overlay_title);
  const opConfig =
    extras && extras.op !== undefined ? sanitizeOpConfig(extras.op) : sanitizeOpConfig(existing.op);
  // フェーズW1: 話者カラー設定。未指定の保存では既存を維持する(overlayTitleと同じ規則)。
  const speakerColors =
    extras && extras.speakerColors !== undefined
      ? resolveSpeakerColorsConfig(extras.speakerColors)
      : resolveSpeakerColorsConfig(existing.speaker_colors);
  // フェーズW2: シーン映像ギミック設定。未指定の保存では既存を維持する(同上)。
  const videoEffects =
    extras && extras.videoEffects !== undefined
      ? sanitizeVideoEffectsConfig(extras.videoEffects)
      : sanitizeVideoEffectsConfig(existing.video_effects);
  const filePath = telopTypeMappingPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeJson(filePath, {
    version: "2.0",
    updated_at: new Date().toISOString(),
    type_styles: sanitized,
    overlay_title: overlayTitle,
    op: opConfig,
    speaker_colors: speakerColors,
    video_effects: videoEffects,
  });
  return loadEffectiveTelopTypeMapping();
}

// --- フェーズU2: 使用シーンバンドル(templates/design_scenes.yaml) と保存済みデザインテーマ ---
//
// デザインテーマ = ユーザーが名前をつけて保存した type→preset マッピング一式
// (userData/design_themes.json)。settings.activeDesignThemeId が指すテーマがあれば、
// 従来の telop_type_mapping 経路(プレビュー用のIPC・step08への --type-mapping)より
// テーマの type_styles を優先する。未選択(空文字)は「スタンダード」=従来動作のまま。

function designScenesPath() {
  return path.join(repoRoot(), "templates", "design_scenes.yaml");
}

function designThemesPath() {
  return userDataPath("design_themes.json");
}

/** step08へ渡す実行時マッピングの書き出し先(テーマ選択時のみ生成)。 */
function effectiveTypeMappingRuntimePath() {
  return userDataPath("telop_type_mapping.effective.json");
}

/**
 * templates/design_scenes.yaml を読み込み、有効なシーンだけ返す。
 * type_styles は extractTypeEntries でバリデーション(未知type・不正エントリは捨てる)。
 */
function loadDesignScenes() {
  try {
    const filePath = designScenesPath();
    if (!fs.existsSync(filePath)) return [];
    const parsed = yaml.load(fs.readFileSync(filePath, "utf-8"));
    const scenes = parsed && typeof parsed === "object" && Array.isArray(parsed.scenes) ? parsed.scenes : [];
    return scenes
      .filter((scene) => scene && typeof scene === "object" && typeof scene.id === "string" && scene.id.trim() && typeof scene.label === "string" && scene.label.trim())
      .map((scene) => ({
        id: scene.id.trim(),
        label: scene.label.trim(),
        description: typeof scene.description === "string" ? scene.description.trim() : "",
        type_styles: extractTypeEntries(scene.type_styles),
        // フェーズU7: ジャンルごとのシーンタイトル既定(新規テーマ作成の初期値)
        overlay_title: sanitizeOverlayTitleConfig(scene.overlay_title),
        // フェーズV2: ジャンルごとのOP既定パターン(新規テーマ作成の初期値)
        op: sanitizeOpConfig(scene.op),
      }));
  } catch (error) {
    console.error("[design-scenes] failed to load templates/design_scenes.yaml:", error);
    return [];
  }
}

/** userData/design_themes.json のテーマ配列(壊れたエントリは捨てる)。 */
function loadDesignThemes() {
  try {
    const filePath = designThemesPath();
    if (!fs.existsSync(filePath)) return [];
    const parsed = readJson(filePath);
    const themes = parsed && typeof parsed === "object" && Array.isArray(parsed.themes) ? parsed.themes : [];
    return themes
      .filter((theme) => theme && typeof theme === "object" && typeof theme.id === "string" && theme.id.trim() && typeof theme.name === "string" && theme.name.trim())
      .map((theme) => ({
        id: theme.id.trim(),
        name: theme.name.trim(),
        base_scene: typeof theme.base_scene === "string" ? theme.base_scene : "",
        type_styles: extractTypeEntries(theme.type_styles),
        // フェーズU6: テーマ専属のカスタムプリセット定義(type_stylesから参照される)
        custom_styles: sanitizeCustomStyles(theme.custom_styles),
        // フェーズU7/U8: シーンタイトル(chapter_title)とOPのテーマ設定
        overlay_title: sanitizeOverlayTitleConfig(theme.overlay_title),
        op: sanitizeOpConfig(theme.op),
        // フェーズW1: 話者カラーのテーマ設定(旧テーマは既定=有効で補完)
        speaker_colors: resolveSpeakerColorsConfig(theme.speaker_colors),
        // フェーズW2: シーン映像ギミックのテーマ設定(旧テーマは既定=両方ONで補完)
        video_effects: sanitizeVideoEffectsConfig(theme.video_effects),
        created_at: typeof theme.created_at === "string" ? theme.created_at : "",
        updated_at: typeof theme.updated_at === "string" ? theme.updated_at : "",
      }));
  } catch (error) {
    console.error("[design-themes] failed to load design_themes.json:", error);
    return [];
  }
}

function writeDesignThemes(themes) {
  const filePath = designThemesPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeJson(filePath, { version: 1, themes });
}

/**
 * テーマの新規作成(id無し)または上書き(id一致)。
 * 保存した type_styles は「既定マッピング+入力」の完全形にする
 * (欠落typeがあると実行時に既定YAMLへフォールバックし、テーマの意図とズレるため)。
 */
function saveDesignTheme(input) {
  const themes = loadDesignThemes();
  const now = new Date().toISOString();
  const typeStyles = mergeTypeEntries(loadDefaultTelopTypeMapping(), extractTypeEntries(input.typeStyles ?? input.type_styles));
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new Error("テーマ名が空です");
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : `theme_${crypto.randomUUID()}`;
  const existingIndex = themes.findIndex((theme) => theme.id === id);
  // フェーズU6: customStyles未指定の上書き保存では既存のカスタム定義を維持する
  // (type_stylesだけの更新でカスタムプリセットが消えると参照切れになるため)。
  const customStylesInput = input.customStyles ?? input.custom_styles;
  const customStyles =
    customStylesInput !== undefined
      ? sanitizeCustomStyles(customStylesInput)
      : existingIndex >= 0
        ? themes[existingIndex].custom_styles || {}
        : {};
  // フェーズU7/U8: 未指定の上書き保存では既存のシーンタイトル・OP設定を維持する
  // (customStylesと同じ規則。type_stylesだけの更新で設定が消えないように)。
  const overlayTitleInput = input.overlayTitle ?? input.overlay_title;
  const overlayTitle =
    overlayTitleInput !== undefined
      ? sanitizeOverlayTitleConfig(overlayTitleInput)
      : sanitizeOverlayTitleConfig(existingIndex >= 0 ? themes[existingIndex].overlay_title : null);
  const opInput = input.op;
  const opConfig =
    opInput !== undefined
      ? sanitizeOpConfig(opInput)
      : sanitizeOpConfig(existingIndex >= 0 ? themes[existingIndex].op : null);
  // フェーズW1: 話者カラー。未指定の上書き保存では既存を維持する(overlayTitleと同じ規則)。
  const speakerColorsInput = input.speakerColors ?? input.speaker_colors;
  const speakerColors =
    speakerColorsInput !== undefined
      ? resolveSpeakerColorsConfig(speakerColorsInput)
      : resolveSpeakerColorsConfig(existingIndex >= 0 ? themes[existingIndex].speaker_colors : null);
  // フェーズW2: シーン映像ギミック。未指定の上書き保存では既存を維持する(同上)。
  const videoEffectsInput = input.videoEffects ?? input.video_effects;
  const videoEffects =
    videoEffectsInput !== undefined
      ? sanitizeVideoEffectsConfig(videoEffectsInput)
      : sanitizeVideoEffectsConfig(existingIndex >= 0 ? themes[existingIndex].video_effects : null);
  const theme = {
    id,
    name,
    base_scene:
      typeof input.baseScene === "string"
        ? input.baseScene
        : typeof input.base_scene === "string"
          ? input.base_scene
          : existingIndex >= 0
            ? themes[existingIndex].base_scene
            : "",
    type_styles: typeStyles,
    custom_styles: customStyles,
    overlay_title: overlayTitle,
    op: opConfig,
    speaker_colors: speakerColors,
    video_effects: videoEffects,
    created_at: existingIndex >= 0 ? themes[existingIndex].created_at || now : now,
    updated_at: now,
  };
  if (existingIndex >= 0) {
    themes[existingIndex] = theme;
  } else {
    themes.push(theme);
  }
  writeDesignThemes(themes);
  return { themes: loadDesignThemes(), theme };
}

function deleteDesignTheme(themeId) {
  const themes = loadDesignThemes().filter((theme) => theme.id !== themeId);
  writeDesignThemes(themes);
  return themes;
}

/** settings.activeDesignThemeId が指す実在テーマ(無い・削除済みなら null=スタンダード)。 */
function resolveActiveDesignTheme() {
  const raw = readSettingsRaw();
  const activeId = typeof raw.activeDesignThemeId === "string" ? raw.activeDesignThemeId : "";
  if (!activeId) return null;
  return loadDesignThemes().find((theme) => theme.id === activeId) || null;
}

/**
 * プレビュー・UIに使う解決済みマッピング。
 * アクティブなデザインテーマがあればその type_styles を優先し、
 * 無ければ従来どおり「既定YAML+userDataのユーザー上書き」を返す。
 */
function loadEffectiveTelopTypeMapping() {
  const theme = resolveActiveDesignTheme();
  if (theme) {
    return mergeTypeEntries(loadDefaultTelopTypeMapping(), theme.type_styles);
  }
  return loadTelopTypeMapping();
}

/**
 * step08(書き出し・再実行)へ渡す --type-mapping 引数。
 * テーマ選択時はテーマの type_styles を実行時ファイルへ書き出して渡す
 * (python側は「既定YAML < このファイル」の順で解決するため、テーマが正になる)。
 * スタンダード時は従来のユーザーマッピングファイルをそのまま渡す(完全後方互換)。
 */
function effectiveTypeMappingArgs() {
  const theme = resolveActiveDesignTheme();
  if (theme) {
    const runtimePath = effectiveTypeMappingRuntimePath();
    fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
    writeJson(runtimePath, {
      version: "2.0",
      source: `design_theme:${theme.id}`,
      updated_at: new Date().toISOString(),
      type_styles: theme.type_styles,
      // フェーズU6: テーマ専属カスタム定義。step08が composition の telop_styles へ注入する
      custom_styles: theme.custom_styles || {},
      // フェーズU7: シーンタイトル設定。step08が chapter_title の生成有無・styleに使う
      overlay_title: sanitizeOverlayTitleConfig(theme.overlay_title),
      // フェーズW1: 話者カラー設定。step08の load_speaker_colors が読む
      speaker_colors: resolveSpeakerColorsConfig(theme.speaker_colors),
      // フェーズW2: シーン映像ギミック設定。step08の load_video_effects_config が読む
      video_effects: sanitizeVideoEffectsConfig(theme.video_effects),
    });
    return ["--type-mapping", runtimePath];
  }
  // スタンダード時はユーザーマッピングファイルをそのまま渡す(overlay_titleも同ファイル内)
  return fs.existsSync(telopTypeMappingPath()) ? ["--type-mapping", telopTypeMappingPath()] : [];
}

/**
 * フェーズU7/U8: 現在の選択(テーマ or スタンダード)のシーンタイトル・OP設定。
 * UIの初期値表示(design-extras:get)と --op-config の組み立てに使う。
 */
function resolveDesignExtras() {
  const theme = resolveActiveDesignTheme();
  if (theme) {
    return {
      overlayTitle: sanitizeOverlayTitleConfig(theme.overlay_title),
      op: sanitizeOpConfig(theme.op),
      // フェーズW1: 話者カラー設定(UI初期値・プレビュー解決に使う)
      speakerColors: resolveSpeakerColorsConfig(theme.speaker_colors),
      // フェーズW2: シーン映像ギミック設定(UI初期値に使う)
      videoEffects: sanitizeVideoEffectsConfig(theme.video_effects),
    };
  }
  const raw = readUserTelopMappingRaw();
  return {
    overlayTitle: sanitizeOverlayTitleConfig(raw.overlay_title),
    op: sanitizeOpConfig(raw.op),
    speakerColors: resolveSpeakerColorsConfig(raw.speaker_colors),
    videoEffects: sanitizeVideoEffectsConfig(raw.video_effects),
  };
}

/**
 * フェーズU8: step08へ渡す --op-config 引数。pattern=none(既定)は引数なし=完全に従来通り。
 * タイトル未入力の既定(動画ファイル名)はpython側(shared/opening.py)が補完する。
 * フェーズV2: runDir 指定時は runs/<run>/op_config.json を正本として優先する
 * (無ければテーマ設定から生成)。未指定は従来のテーマ設定のみ(後方互換)。
 */
function opConfigArgs(runDir) {
  const op = runDir ? ensureRunOpConfig(runDir) : resolveDesignExtras().op;
  if (!op || op.pattern === "none") return [];
  return ["--op-config", JSON.stringify(op)];
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

/** W14-2: 全run横断の修正ペア履歴(userData/correction_history.json)。 */
function correctionHistoryPath() {
  return userDataPath("correction_history.json");
}

/**
 * 学習データ共有用のNextcloudフォルダ(<Nextcloud>/CatCut-learning)。
 * Nextcloud同期フォルダが見つからないPCでは null(完全従来動作)。
 * 同期フォルダの場所が特殊な場合は環境変数 CATCUT_NEXTCLOUD_DIR で上書きできる。
 */
function nextcloudLearningDir() {
  const home = require("os").homedir();
  const candidates = process.env.CATCUT_NEXTCLOUD_DIR
    ? [process.env.CATCUT_NEXTCLOUD_DIR]
    : [
        path.join(home, "Desktop", "NextCloud"),
        path.join(home, "Nextcloud"),
        path.join(home, "NextCloud"),
      ];
  for (const base of candidates) {
    if (fs.existsSync(base)) return path.join(base, "CatCut-learning");
  }
  return null;
}

/**
 * AI校正へ注入する修正ペア履歴のパスを返す。
 * Nextcloudに開発機が公開した統合学習(shared_correction_history.json)があれば
 * ローカル学習と合成した correction_history.effective.json を生成して返し、
 * 無ければ従来どおりローカルの correction_history.json を返す。
 * 書き手の分離: 共有ファイルを書くのは開発機の eval_edit_learning.py だけ。
 * 各PCはここで読むだけなのでNextcloudのコンフリクトは発生しない。
 */
function effectiveCorrectionHistoryPath() {
  const localPath = correctionHistoryPath();
  const learningDir = nextcloudLearningDir();
  const sharedPath = learningDir ? path.join(learningDir, "shared_correction_history.json") : null;
  if (!sharedPath || !fs.existsSync(sharedPath)) return localPath;
  try {
    const combined = editLearning.combineCorrectionHistories(
      editLearning.loadCorrectionHistory(localPath),
      editLearning.loadCorrectionHistory(sharedPath),
    );
    const effectivePath = userDataPath("correction_history.effective.json");
    fs.writeFileSync(effectivePath, `${JSON.stringify(combined, null, 2)}\n`, "utf-8");
    return effectivePath;
  } catch {
    return localPath;
  }
}

/** W17: 全run横断の完全編集例(source→AI表示→編集者確定)。 */
function editExamplesPath() {
  return userDataPath("telop_edit_examples.json");
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

/** W19-C5: 適用(step08セグメント抽出)中の進捗をrendererへ中継する。 */
function sendApplyProgress(percent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("apply:progress", { percent });
  }
}

/**
 * W19-C4: 書き出し・適用系の子プロセスのOS優先度を下げる(nice相当)。
 * 書き出し中もUI(プレビュー・編集操作)の応答性を優先する趣旨。
 * 解析パイプライン(初回STT等)は対象外。失敗してもnon-fatal(優先度はそのまま)。
 */
function lowerChildPriority(child) {
  try {
    if (child?.pid) os.setPriority(child.pid, 10);
  } catch {
    // non-fatal: サポート外プラットフォーム・権限不足は無視
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

/** W10-9: run正本へのシーン編集ドラフト(scene_edits_draft.json)のパス。 */
function sceneEditsDraftPath(runDir) {
  return path.join(resolveRunDir(runDir), "scene_edits_draft.json");
}

/** W14-2: run正本のシーン編集履歴(edit_history.json)のパス。 */
function editHistoryPath(runDir) {
  return path.join(resolveRunDir(runDir), "edit_history.json");
}

/**
 * W14-2: テロップ編集確定(blur)の記録。run正本 edit_history.json(シーン単位・初期テキスト保持)と
 * userData/correction_history.json(全run横断の語レベルペア・頻度カウント・LRU上限)を同時に更新する。
 * ペアの抽出(語レベルdiff・ノイズ除外)はrenderer側(correctionPairs.ts)で済んでいる。
 */
function recordTelopEditLearning(input) {
  const runDir = String(input?.runDir || "");
  const editHistory = runDir
    ? editLearning.recordSceneEdit(editHistoryPath(runDir), {
        sceneId: String(input?.sceneId || ""),
        source: String(input?.source ?? ""),
        before: String(input?.before ?? ""),
        after: String(input?.after ?? ""),
      })
    : null;
  const pairs = Array.isArray(input?.pairs) ? input.pairs : [];
  const correctionHistory = pairs.length
    ? editLearning.recordCorrectionPairs(correctionHistoryPath(), pairs)
    : editLearning.loadCorrectionHistory(correctionHistoryPath());
  if (runDir) {
    editLearning.recordEditExample(editExamplesPath(), {
      run: path.basename(runDir),
      sceneId: String(input?.sceneId || ""),
      source: String(input?.source ?? ""),
      before: String(input?.before ?? ""),
      after: String(input?.after ?? ""),
    });
  }
  return { editHistory, correctionHistory };
}

/** W11-2: ドラフトのオブジェクト辞書フィールド(overlayEdits/customStyles)の正規化。 */
function sanitizeDraftRecord(raw) {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

/**
 * W10-9: ドラフト保存用に scenes + keepSegments + updatedAt を残す。
 * W11-2(適用ボタン廃止): applySceneEdits の送信内容のうち scenes から導出できない
 * overlayEdits(オーバーレイ文言の未保存編集) / customStyles(シーン個別カスタムスタイル定義)も
 * ドラフトへ含める(version 1.1.0)。
 */
function sanitizeSceneEditsDraft(input) {
  return {
    version: "1.1.0",
    updatedAt: new Date().toISOString(),
    scenes: Array.isArray(input?.scenes) ? input.scenes : [],
    keepSegments: Array.isArray(input?.keepSegments) ? input.keepSegments : [],
    overlayEdits: sanitizeDraftRecord(input?.overlayEdits),
    customStyles: sanitizeDraftRecord(input?.customStyles),
  };
}

function loadSceneEditsDraft(runDir) {
  const filePath = sceneEditsDraftPath(runDir);
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = readJson(filePath);
    return {
      version: String(parsed.version || "1.0.0"),
      updatedAt: String(parsed.updatedAt || ""),
      scenes: Array.isArray(parsed.scenes) ? parsed.scenes : [],
      keepSegments: Array.isArray(parsed.keepSegments) ? parsed.keepSegments : [],
      // W11-2: 旧ドラフト(1.0.0)にはフィールドが無いため空辞書へフォールバック(後方互換)
      overlayEdits: sanitizeDraftRecord(parsed.overlayEdits),
      customStyles: sanitizeDraftRecord(parsed.customStyles),
    };
  } catch {
    return null;
  }
}

/**
 * W19-A6: ドラフト保存の非同期化・compact化。
 * - fs.promises.writeFile(メインプロセスのイベントループを塞がない)
 * - JSON.stringify(インデントなし。数百シーンのpretty printはCPU/サイズとも重い)
 * - tmp→rename のアトミック書き込み(書き込み途中のクラッシュで正本を壊さない)
 * 読み込み(loadSceneEditsDraft)はJSON.parseなのでpretty/compact両形式を透過的に受ける。
 */
async function saveSceneEditsDraft(runDir, input) {
  const resolved = resolveRunDir(runDir);
  const draft = sanitizeSceneEditsDraft(input);
  const filePath = sceneEditsDraftPath(resolved);
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.promises.writeFile(tmpPath, `${JSON.stringify(draft)}\n`, "utf-8");
    await fs.promises.rename(tmpPath, filePath);
  } catch (error) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
  return draft;
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

/** フェーズU9: プレビュー配信のContent-Type(拡張子ベース)。BGM音源とサムネイル画像を追加。 */
const PREVIEW_CONTENT_TYPES = {
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  // V4(画像挿入トラック): 挿入画像のプレビュー配信で使う追加形式
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function servePreviewVideo(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  // U1-6(効果音): /audio/<id>.wav はプレビュー効果音(assets/sfx/*.wav)の配信。
  // U9: /audio/<id>.(mp3|m4a|aac) はBGM音源、/image/<id>.jpg はフィルムストリップのサムネイル。
  // いずれも動画と同じ previewFiles レジストリを使う(登録は registerPreviewFile)。
  const match = url.pathname.match(/^\/(video|audio|image)\/([A-Fa-f0-9]+)\.(mp4|wav|mp3|m4a|aac|jpg|jpeg|png|webp|gif)$/);
  if (!match) {
    response.writeHead(404);
    response.end("not found");
    return;
  }

  const filePath = previewFiles.get(match[2]);
  if (!filePath || !fs.existsSync(filePath)) {
    response.writeHead(404);
    response.end("video not found");
    return;
  }

  const stat = fs.statSync(filePath);
  const range = request.headers.range;
  const commonHeaders = {
    "Content-Type": PREVIEW_CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
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

/**
 * フェーズU9: 任意のローカルファイルをプレビューサーバー配信へ登録する共通処理。
 * kind(URLの種別セグメント)と実ファイルの拡張子からURLを組み立てる。
 */
function registerPreviewFile(filePath, kind, urlExt) {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath) || !previewServerPort) return null;
  const id = crypto.createHash("sha1").update(absPath).digest("hex").slice(0, 20);
  previewFiles.set(id, absPath);
  return `http://127.0.0.1:${previewServerPort}/${kind}/${id}${urlExt}`;
}

function registerPreviewVideo(filePath) {
  return registerPreviewFile(filePath, "video", ".mp4");
}

/** U1-6(効果音): assets/sfx/*.wav をプレビューサーバー経由でレンダラーへ配信するURLを返す。 */
function registerPreviewAudio(filePath) {
  return registerPreviewFile(filePath, "audio", ".wav");
}

/** U9(BGM): 音源(mp3/wav/m4a/aac)を実拡張子つきURLで配信登録する。 */
function registerPreviewBgmAudio(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return registerPreviewFile(filePath, "audio", PREVIEW_CONTENT_TYPES[ext] ? ext : ".mp3");
}

/** U9(フィルムストリップ): サムネイルjpgを配信登録する。 */
function registerPreviewImage(filePath) {
  return registerPreviewFile(filePath, "image", ".jpg");
}

/** V4(画像挿入トラック): 挿入画像(png/jpg/jpeg/webp/gif)を実拡張子つきURLで配信登録する。 */
function registerPreviewOverlayImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return registerPreviewFile(filePath, "image", PREVIEW_CONTENT_TYPES[ext] ? ext : ".png");
}

/** U1-6: 同梱効果音ID一覧(remotion/src/lib/telopSfx.ts の SFX_IDS と同期)。
 * フェーズW2: teen(映像ギミックpinchのSFX。プレビューのpinch開始で鳴らす)を追加。 */
const PREVIEW_SFX_IDS = ["don", "shakin", "pon", "jan", "hyu", "teen"];

/** U1-6: 効果音ID→プレビュー配信URLの辞書を組み立てる(存在するwavのみ)。 */
function buildPreviewSfxUrls() {
  const urls = {};
  for (const sfxId of PREVIEW_SFX_IDS) {
    const url = registerPreviewAudio(path.join(repoRoot(), "assets", "sfx", `${sfxId}.wav`));
    if (url) urls[sfxId] = url;
  }
  return urls;
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
  const listPath = path.join(path.dirname(outputs.composition), "preview_cut_sequence.txt");
  const listContent = `${segmentPaths.map((segmentPath) => `file ${quoteConcatPath(segmentPath)}`).join("\n")}\n`;
  const previewExists = fs.existsSync(previewPath);
  const previewMtime = previewExists ? fs.statSync(previewPath).mtimeMs : 0;
  const sourceMtime = Math.max(...segmentPaths.map((segmentPath) => fs.statSync(segmentPath).mtimeMs));
  // W11-1a(差分キャッシュ追従): セグメントは編集後もmtimeが古いまま再利用されるため、
  // mtime比較だけでは編集(セグメント構成の変化)を検出できない。前回の結合リストと
  // パス列が同一であることも合わせて確認する
  const previousList = fs.existsSync(listPath) ? fs.readFileSync(listPath, "utf-8") : "";
  if (previewExists && previewMtime >= sourceMtime && previousList === listContent) return previewPath;

  fs.writeFileSync(listPath, listContent, "utf-8");

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

function loadProjectTelopMode(projectRelativePath) {
  try {
    const projectPath = path.join(repoRoot(), projectRelativePath);
    const parsed = yaml.load(fs.readFileSync(projectPath, "utf-8"));
    return parsed?.telop?.mode === "directed" ? "directed" : "full";
  } catch {
    return "full";
  }
}

/** フェーズT2: テロップ演出モード。UI設定 > 環境変数 > project.yaml の順で解決する。 */
function resolveTelopMode(options, projectRelativePath) {
  if (options?.telopMode === "directed" || options?.telopMode === "full") {
    return options.telopMode;
  }
  const envMode = String(process.env.CATCUT_TELOP_MODE || "").trim();
  if (envMode === "directed" || envMode === "full") return envMode;
  return loadProjectTelopMode(projectRelativePath);
}

function normalizeTelopModeSetting(rawMode) {
  if (rawMode === "directed" || rawMode === "full") return rawMode;
  return process.env.CATCUT_TELOP_MODE === "directed" ? "directed" : "full";
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
      telopMode: normalizeTelopModeSetting(),
      activeDesignThemeId: "",
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
    telopMode: normalizeTelopModeSetting(raw.telopMode),
    // フェーズU2: 選択中のデザインテーマ(空文字=スタンダード)。どのrunでどのテーマを
    // 使ったかの記録も兼ねる(開始時点の値がそのまま実行時マッピングに使われる)
    activeDesignThemeId: typeof raw.activeDesignThemeId === "string" ? raw.activeDesignThemeId : "",
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
    telopMode:
      input.telopMode === "directed" || input.telopMode === "full"
        ? input.telopMode
        : existing.telopMode === "directed" || existing.telopMode === "full"
          ? existing.telopMode
          : normalizeTelopModeSetting(),
    // フェーズU2: 空文字=スタンダードも有効値のため undefined 判定で既存値と区別する
    activeDesignThemeId:
      input.activeDesignThemeId !== undefined
        ? String(input.activeDesignThemeId || "")
        : typeof existing.activeDesignThemeId === "string"
          ? existing.activeDesignThemeId
          : "",
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

function spawnCommand({ command, args, cwd, env, stepId, lowPriority }) {
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
    // W19-C4: 書き出し経路(呼び出し側が指定)のみ優先度を下げる
    if (lowPriority) lowerChildPriority(child);
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

function spawnUtility({ command, args, cwd, env, lowPriority, onOutput }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // W19-C4: 書き出し・適用経路(呼び出し側が指定)のみ優先度を下げる
    if (lowPriority) lowerChildPriority(child);

    let output = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      if (onOutput) onOutput(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      if (onOutput) onOutput(text);
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
    // フェーズW7(書き出し完了ダイアログ): レンダリング済みMP4が実在するか。
    // job:doneは「適用のみ(renderFinal=false)」でも飛ぶため、Finder表示の判定に使う。
    finalVideoExists: fs.existsSync(finalVideo),
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

/** W25: macOSの既定ファイルシステムは大文字小文字を区別しないため、パスを小文字化して同一判定する。 */
function isSameFileCaseInsensitive(a, b) {
  return path.resolve(String(a || "")).toLowerCase() === path.resolve(String(b || "")).toLowerCase();
}

/**
 * W25: 元動画の上書き防止。書き出し先が元動画と同一ファイルを指す場合
 * (例: 元動画「〜.MP4」と同じフォルダへ同名「〜.mp4」で書き出す)、
 * 「<名前>-edited.mp4」へ自動退避する。
 */
function avoidSourceOverwrite(outputPath, sourceVideoPath) {
  if (!sourceVideoPath || !isSameFileCaseInsensitive(outputPath, sourceVideoPath)) {
    return outputPath;
  }
  const dir = path.dirname(outputPath);
  const base = path.basename(outputPath, path.extname(outputPath));
  let candidate = path.join(dir, `${base}-edited.mp4`);
  let index = 2;
  while (isSameFileCaseInsensitive(candidate, sourceVideoPath)) {
    candidate = path.join(dir, `${base}-edited-${index}.mp4`);
    index += 1;
  }
  sendJobEvent({
    type: "log",
    message: `[export] 書き出し先が元動画と同じため上書きを避けて保存します: ${candidate}\n`,
  });
  return candidate;
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
    runDir,
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
      ...([1.25, 1.5, 2].includes(Number(segment.speed)) ? { speed: Number(segment.speed) } : {}),
    }))
    .filter((segment) => segment.end_ms > segment.start_ms)
    .sort((a, b) => a.start_ms - b.start_ms);
  const merged = [];
  for (const segment of normalized) {
    const last = merged[merged.length - 1];
    if (last && segment.start_ms <= last.end_ms && (last.speed || 1) === (segment.speed || 1)) {
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

/**
 * フェーズW8: run直下 orientation.json(ユーザーの縦横選択の正本)。無い・読めない場合は null。
 * 旧run(ファイルなし)は従来どおり preprocess の自動判定が使われる(完全後方互換)。
 */
function readRunOrientationJson(runDir) {
  const orientationPath = path.join(runDir, "orientation.json");
  if (!fs.existsSync(orientationPath)) return null;
  try {
    const data = readJson(orientationPath);
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

/** フェーズW8: orientation.json があれば step08 へ渡す --orientation 引数(無ければ空=従来動作)。 */
function orientationArgsForRun(runDir) {
  const orientation = sanitizeOrientation(readRunOrientationJson(runDir)?.orientation);
  return orientation ? ["--orientation", orientation] : [];
}

function projectPathForRun(runDir) {
  const runProjectPath = path.join(runDir, "project.yaml");
  if (fs.existsSync(runProjectPath)) {
    return path.relative(repoRoot(), runProjectPath);
  }
  const preprocessPath = path.join(runDir, "step01_preprocess", "preprocess.json");
  const preprocess = fs.existsSync(preprocessPath) ? readJson(preprocessPath) : {};
  // フェーズW8: ユーザーの縦横選択(orientation.json)を最優先し、無ければ従来どおり自動判定
  const orientation = resolveRunOrientationValue(readRunOrientationJson(runDir), preprocess.orientation);
  return path.join("templates", `${orientation}.yaml`);
}

function editOverridesForSilenceTightness(tightness) {
  if (tightness === "tight") {
    return {
      max_gap_ms: 180,
      lead_padding_ms: 70,
      tail_padding_ms: 50,
      min_internal_silence_ms: 280,
    };
  }
  if (tightness === "loose") {
    return {
      max_gap_ms: 1000,
      lead_padding_ms: 280,
      tail_padding_ms: 200,
      min_internal_silence_ms: 800,
    };
  }
  return null;
}

/**
 * 開始画面で標準以外が選ばれた場合だけ、向き別テンプレートをrun内へ複製してeditを上書きする。
 * テンプレート本体は変更せず、以後の再適用でもrun固有project.yamlを使う。
 */
function projectPathForSilenceTightness(root, runDir, templateProjectPath, tightness) {
  const editOverrides = editOverridesForSilenceTightness(tightness);
  if (!editOverrides) return templateProjectPath;

  const templateAbsolutePath = path.join(root, templateProjectPath);
  const parsed = yaml.load(fs.readFileSync(templateAbsolutePath, "utf-8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`プロジェクト設定を読み込めません: ${templateProjectPath}`);
  }

  const project = {
    ...parsed,
    edit: {
      ...(parsed.edit && typeof parsed.edit === "object" && !Array.isArray(parsed.edit) ? parsed.edit : {}),
      ...editOverrides,
    },
  };
  const runProjectPath = path.join(runDir, "project.yaml");
  fs.writeFileSync(runProjectPath, yaml.dump(project, { noRefs: true, lineWidth: -1 }), "utf-8");
  return path.relative(root, runProjectPath);
}

async function rerunCompositionAndTelop(runDir, options = {}) {
  const root = repoRoot();
  const python = path.join(root, ".venv", "bin", "python");
  if (!fs.existsSync(python)) throw new Error(`Python venv not found: ${python}`);
  const relRunDir = path.relative(root, runDir);
  const source = loadTranscriptSource(runDir);
  const sttPath = path.relative(root, source.sttPath);
  const preprocess = source.preprocess || {};
  const reviewPath = path.join(relRunDir, "step06_review", "review.json");
  const project = projectPathForRun(runDir);
  // フェーズT2.5-4: ユーザーのtype→presetマッピング(userData)があればstep08へ渡す。
  // directedモードのスロットは実行のたびに最新マッピングでスタイルが再解決される。
  // フェーズU2: アクティブなデザインテーマがあればテーマの type_styles を優先する。
  const typeMappingArgs = effectiveTypeMappingArgs();
  const sourceVideoPath = preprocess.video_path || source.composition?.meta?.source_video || "";
  const step08Args = [
    "python/step08_composition.py",
    "--proposal",
    path.join(relRunDir, "step07_cut_proposal", "cut_proposal.json"),
    "--stt",
    sttPath,
    "--video",
    sourceVideoPath,
    "--output",
    path.join(relRunDir, "step08_composition"),
    "--project",
    project,
    "--review",
    reviewPath,
    ...typeMappingArgs,
    // フェーズV2: run単位 op_config.json を正本に使う(無ければテーマ設定から生成)
    ...opConfigArgs(runDir),
    // フェーズW8: ユーザーの縦横選択(orientation.json)をキャンバスへ反映する
    ...orientationArgsForRun(runDir),
  ];

  // W19-C2: step08の入力を決めるものの合成ハッシュ。前回成功時と一致し、
  // composition.jsonと全セグメントファイルが実在すればstep08・extract_telop・
  // review_telopを丸ごとスキップする(編集差分ゼロの書き出しを数秒にする)。
  // 旧run(ハッシュファイル無し)・不一致・欠損は従来どおり実行=完全後方互換。
  const typeMappingIndex = typeMappingArgs.indexOf("--type-mapping");
  const inputHash = computeStep08InputHash({
    runDir,
    keepSegments: Array.isArray(source.proposal?.keep_segments) ? source.proposal.keep_segments : [],
    step08Args,
    sourceVideoPath,
    sttPath: source.sttPath,
    reviewPath: path.join(runDir, "step06_review", "review.json"),
    typeMappingPath: typeMappingIndex >= 0 ? typeMappingArgs[typeMappingIndex + 1] : "",
    // 非directedモードのシーン本文上書き。skip時はtelop.txtが再生成されないため、
    // 「上書き→autoへ戻す」変更を確実に再実行へ倒す(step08Hash.cjsのコメント参照)
    telopOverrides: options.telopOverrides,
  });
  if (canSkipStep08(runDir, inputHash.hash)) {
    console.log(`step08 skipped (no changes): ${runDir}`);
    sendJobEvent({ type: "log", message: "step08 skipped (no changes)\n" });
    return;
  }

  await spawnUtility({
    command: python,
    args: step08Args,
    cwd: root,
    env: apiKeys.buildPipelineEnv(),
    // W19-C4: 適用中もUI応答性を優先する(優先度を下げる)
    lowPriority: true,
    // W19-C5: step08のセグメント抽出進捗(Progress: <n>%)を適用中UIへ中継する。
    // Remotionレンダリングの Progress: パース(handleProcessOutput)とは経路が別で衝突しない。
    onOutput: (text) => {
      const matches = [...text.matchAll(/Progress:\s*(\d+)%/g)];
      if (matches.length) sendApplyProgress(Number(matches[matches.length - 1][1]));
    },
  });
  await spawnUtility({
    command: python,
    args: ["python/tools/extract_telop.py", relRunDir],
    cwd: root,
    env: apiKeys.buildPipelineEnv(),
    lowPriority: true,
  });
  await spawnUtility({
    command: python,
    args: ["python/tools/review_telop.py", relRunDir, "--dictionary", "templates/domain_dictionary.yaml"],
    cwd: root,
    env: apiKeys.buildPipelineEnv(),
    lowPriority: true,
  });

  // 成功時のみ保存する(途中失敗した実行を「変更なし」と誤判定しないため)
  writeStep08InputHash(runDir, inputHash);
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
  // フェーズT2(directedモード): telopはスロット単位の明示start/end(カット相対秒)を持つため、
  // word_indicesの逆算ではなく明示タイミングをそのままページ境界に使う(1シーン=1スロット)。
  // fullモードは従来のword_indices逆算のまま(既存runのシーン初期化を変えない)。
  const directed = isDirectedTelopMode(source);
  const boundaries = [];
  cuts.forEach((cut, index) => {
    const segment = keepSegments[index];
    if (!segment) return;
    const segStartMs = Number(segment.start_ms || 0);
    const segmentSpeed = [1.25, 1.5, 2].includes(Number(segment.speed)) ? Number(segment.speed) : 1;
    const words = Array.isArray(cut?.voice?.words) ? cut.voice.words : [];
    const telops = Array.isArray(cut?.telops) ? cut.telops : [];
    const timelineCut = timelineCuts[index];
    const timelinePages = Array.isArray(timelineCut?.telop?.pages) ? timelineCut.telop.pages : [];
    for (let pageIndex = 0; pageIndex < telops.length; pageIndex += 1) {
      const telop = telops[pageIndex];
      let startMs = null;
      let endMs = null;
      if (directed && typeof telop?.start === "number" && typeof telop?.end === "number") {
        startMs = segStartMs + Math.round(Number(telop.start) * 1000 * segmentSpeed);
        endMs = segStartMs + Math.round(Number(telop.end) * 1000 * segmentSpeed);
      } else {
        const indices = Array.isArray(telop?.word_indices) ? telop.word_indices : [];
        if (!indices.length) continue;
        const minIndex = Math.min(...indices);
        const maxIndex = Math.max(...indices);
        const firstWord = words[minIndex];
        const lastWord = words[maxIndex];
        if (!firstWord || !lastWord) continue;
        startMs = segStartMs + Math.round(Number(firstWord.start || 0) * 1000 * segmentSpeed);
        endMs = segStartMs + Math.round(Number(lastWord.end || 0) * 1000 * segmentSpeed);
      }
      if (endMs <= startMs) continue;
      const timelinePage = timelinePages[pageIndex];
      const timelineText = Array.isArray(timelinePage?.lines) ? timelinePage.lines.join("") : "";
      const text = String(telop?.text || timelineText || "").trim();
      const styleId = directed && telop?.style ? String(telop.style) : "";
      // フェーズT2.5-4: semantic type と個別上書きフラグ(スタイルバッジのtype表示・
      // マッピング再解決の判定に使う)。旧run(type無し)は空のまま。
      const typeId =
        directed && typeof telop?.type === "string" && TELOP_SEMANTIC_TYPES.includes(telop.type)
          ? telop.type
          : "";
      const styleOverridden = Boolean(directed && telop?.style_overridden);
      // フェーズT3: UIピッカー由来のアニメ上書き(animation_overridden)のみシーンへ復元する。
      // マッピング・プリセット既定由来の解決結果は復元しない(シーンは「上書きなし」のまま
      // 最新のマッピングに追従させるため)。
      const animationIn =
        directed &&
        telop?.animation_overridden &&
        typeof telop?.animation_in === "string" &&
        TELOP_ANIMATION_IN_TYPES.includes(telop.animation_in)
          ? telop.animation_in
          : "";
      // シーン検品で明示指定した映像演出だけを復元する。自動選定結果は
      // timeline.video_effects 側にしか無く、シーンの上書き状態にはしない。
      const videoEffectOverride =
        directed &&
        telop?.video_effect_overridden &&
        typeof telop?.video_effect === "string" &&
        ["none", "pinch", "zoom", "dim", "face_zoom", "slow_push"].includes(telop.video_effect)
          ? telop.video_effect
          : "";
      const highlightWords = Array.isArray(telop?.highlight_words)
        ? telop.highlight_words.map(String).filter(Boolean)
        : [];
      // フェーズW1: スロットの話者ID(composition telops[].speaker 由来。旧runはなし)
      const speaker = directed && typeof telop?.speaker === "string" && telop.speaker ? telop.speaker : "";
      boundaries.push({
        startMs,
        endMs,
        ...(text ? { text } : {}),
        ...(styleId ? { styleId } : {}),
        ...(typeId ? { typeId } : {}),
        ...(styleOverridden ? { styleOverridden: true } : {}),
        ...(animationIn ? { animationIn } : {}),
        ...(videoEffectOverride ? { videoEffectOverride } : {}),
        ...(styleId && highlightWords.length ? { highlightWords } : {}),
        ...(speaker ? { speaker } : {}),
      });
    }
  });
  boundaries.sort((a, b) => a.startMs - b.startMs);
  return boundaries;
}

/**
 * U1-5(オーバーレイのプレビュー写像): timeline.cuts[i](書き出し後タイムラインms)と
 * proposal.keep_segments[i](元動画の絶対ms)の対応表を組み立てる。
 * step08_composition.py が keep_segments と同じ順序(startMs昇順)で cut_001, cut_002, ... を
 * 割り当てる前提(buildTelopPageBoundariesと同じ)を利用する。
 * レンダラー側は lib/previewTimeline.ts の sourceMsToTimelineMs でオーバーレイ表示判定に使う。
 */
function buildTimelineCutRanges(source) {
  const keepSegments = Array.isArray(source.proposal?.keep_segments) ? source.proposal.keep_segments : [];
  const timelineCuts = Array.isArray(source.composition?.timeline?.cuts) ? source.composition.timeline.cuts : [];
  const ranges = [];
  timelineCuts.forEach((cut, index) => {
    const segment = keepSegments[index];
    if (!segment) return;
    const sourceStartMs = Number(segment.start_ms || 0);
    const sourceEndMs = Number(segment.end_ms || 0);
    const timelineStartMs = Number(cut?.timeline?.start_ms);
    const timelineEndMs = Number(cut?.timeline?.end_ms);
    if (!Number.isFinite(timelineStartMs) || !Number.isFinite(timelineEndMs)) return;
    if (sourceEndMs <= sourceStartMs || timelineEndMs <= timelineStartMs) return;
    const entry = { sourceStartMs, sourceEndMs, timelineStartMs, timelineEndMs };
    const speed = Number(cut?.video?.speed ?? segment.speed);
    if ([1.25, 1.5, 2].includes(speed)) entry.speed = speed;
    // フェーズW24 Phase A-2: cut単位のテロップ縦位置(縦型の顔回避配置)をプレビューへ転写する。
    // 無い既存run(横型・旧縦型)はキー自体を付けない=グローバルtelop_yのまま(後方互換)。
    const cutTelopY = Number(cut?.telop_y);
    if (Number.isFinite(cutTelopY) && cutTelopY >= 0 && cutTelopY <= 1) entry.telopY = cutTelopY;
    // フェーズW26: cut単位のパンチイン(交互ズーム)をプレビューへ転写する。
    // 無い既存run・横型はキー自体を付けない=変形なし(後方互換)。
    const punchScale = Number(cut?.punch_scale);
    if (Number.isFinite(punchScale) && punchScale > 1) {
      entry.punchScale = punchScale;
      const originX = Number(cut?.punch_origin?.x);
      const originY = Number(cut?.punch_origin?.y);
      if (Number.isFinite(originX)) entry.punchOriginX = originX;
      if (Number.isFinite(originY)) entry.punchOriginY = originY;
    }
    ranges.push(entry);
  });
  return ranges;
}

/** フェーズT2: このrunがdirectedモード(演出ディレクティブ駆動)かどうか。 */
function isDirectedTelopMode(source) {
  if (source.composition?.meta?.telop_mode === "directed") return true;
  // 旧compositionにフラグが無い場合はディレクティブファイルの存在で判定する
  const runDir = source.runDir || "";
  return Boolean(runDir) && fs.existsSync(path.join(runDir, "telop_directives.json"));
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
        ...([1.25, 1.5, 2].includes(Number(segment.speed)) ? { speed: Number(segment.speed) } : {}),
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
      // フェーズW1: diarize時の話者ID(speaker無しの旧runはフィールドなし=後方互換)
      ...(typeof word.speaker === "string" && word.speaker ? { speaker: word.speaker } : {}),
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

  // W19-B1: 弱区間の再文字起こし(step05b)の差分候補。旧run(ファイル無し)は空=完全従来動作。
  const retranscribePath = path.join(resolved, "step05b_retranscribe", "retranscribe.json");
  const retranscribeRaw = fs.existsSync(retranscribePath) ? readJson(retranscribePath) : null;
  const retranscribe = {
    enabled: Boolean(retranscribeRaw?.enabled),
    items: Array.isArray(retranscribeRaw?.items) ? retranscribeRaw.items : [],
  };

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
    // W5-2: step05のAI疑義ワード(文脈上あやしい語)。旧runのai_review.jsonには無い=空配列。
    suspectWords: Array.isArray(aiReviewRaw?.suspect_words) ? aiReviewRaw.suspect_words : [],
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
    // 改善21-B: error_kind / provider / error_detail(旧runのJSONには無い→空文字でUI側がother扱い)。
    transcriptErrorKind: transcriptRefineFailed ? String(aiReviewRaw?.error_kind || "") : "",
    telopErrorKind: telopRefineFailed ? String(refineRaw?.error_kind || "") : "",
    transcriptErrorDetail: transcriptRefineFailed ? String(aiReviewRaw?.error_detail || aiReviewRaw?.reason || "") : "",
    telopErrorDetail: telopRefineFailed ? String(refineRaw?.error_detail || refineRaw?.reason || "") : "",
    transcriptProvider: String(aiReviewRaw?.provider || ""),
    telopProvider: String(refineRaw?.provider || ""),
    transcriptUsage: aiReviewRaw?.usage || null,
    telopUsage: refineRaw?.usage || null,
  };

  const wordSplitFlags = Array.isArray(source.proposal?.word_split_flags)
    ? source.proposal.word_split_flags.map((flag) => ({
        prev_end_ms: Number(flag.prev_end_ms || 0),
        next_start_ms: Number(flag.next_start_ms || 0),
        tail_text: String(flag.tail_text || ""),
        head_text: String(flag.head_text || ""),
        gap_ms: Number(flag.gap_ms || 0),
      }))
    : undefined;

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
    // 改善20-B: 1行の文字数バジェット。超過行のプレビュー折返し(wrapTelopLine)に使う。
    // 旧run(フィールドなし)は縦横に応じたテンプレート既定値(横16/縦12)にフォールバック。
    telopMaxCharsPerLine: Number(
      source.composition?.timeline?.telop_max_chars_per_line ||
        (source.composition?.meta?.orientation === "horizontal" ? 16 : 12),
    ),
    // 改善8-B-3(シーン初期化=テロップページ): BudouXテロップページ境界(絶対ms)。
    // composition.jsonにvoice_data/telopsが無い(旧run等)場合は空配列(UI側はヒューリスティックへフォールバック)。
    telopPageBoundaries: buildTelopPageBoundaries(source),
    // フェーズT2: directedモード(演出ディレクティブ駆動)かどうか。UIのスタイルバッジ表示に使う。
    telopMode: isDirectedTelopMode(source) ? "directed" : "full",
    aiReview,
    // W19-B1: 再文字起こしの差分候補(要確認パネルの種別 retranscribe に出す)。
    retranscribe,
    wordSplitFlags,
    // --- フェーズU1(プレビュー忠実化): 書き出しと同じ見た目に必要なcomposition情報 ---
    // U1-3: 縦位置(0〜1の中心基準)とコンポジション高さ(クランプ計算用)。
    telopY: Number(source.composition?.timeline?.telop_y ?? 0.5),
    telopBaseHeight: Number(source.composition?.meta?.display_height || 720),
    // フェーズW8(キャンバス基準プレビュー): コンポジションのキャンバス寸法。
    // telopBase* と違い既定値を持たず、composition未生成時は0(プレビューは
    // video intrinsic基準へフォールバックする)。
    canvasWidth: Number(source.composition?.meta?.display_width || 0),
    canvasHeight: Number(source.composition?.meta?.display_height || 0),
    // フェーズW9(映像フレーミング): ソース動画の表示解像度(rotation適用後)。
    // composition meta.source_*(W8で追加)優先、無い旧runは preprocess の display_* へ
    // フォールバック(どちらも無ければ0=プレビューはキャンバス寸法とみなす)。
    sourceWidth: Number(
      source.composition?.meta?.source_width || source.preprocess?.display_width || 0,
    ),
    sourceHeight: Number(
      source.composition?.meta?.source_height || source.preprocess?.display_height || 0,
    ),
    // フェーズW9: run正本 video_framing.json の正規化済みフレーミング(無ければidentity)。
    videoFraming: loadVideoFramingForRun(resolved),
    // U1-6: アニメ長さ換算(frames→ms)用fpsと、timeline既定の登場アニメ(旧popIn等互換)。
    timelineFps: Number(source.composition?.timeline?.fps || 30),
    timelineAnimationIn: String(source.composition?.timeline?.animation_in || "none"),
    // U1-6: 効果音の音量(composition準拠)と同梱wavのプレビュー配信URL。
    sfxVolume: Number(source.composition?.timeline?.sfx_volume ?? 0.25),
    sfxUrls: buildPreviewSfxUrls(),
    // U1-1: 書き出し時に実際に使われるスタイル辞書(directedプリセット解決の第一候補)。
    telopStyles:
      source.composition?.timeline?.telop_styles && typeof source.composition.timeline.telop_styles === "object"
        ? source.composition.timeline.telop_styles
        : {},
    defaultTelopStyle: String(source.composition?.timeline?.default_telop_style || "default"),
    // U1-5: オーバーレイ(タイムラインms基準)と、元動画ms⇔タイムラインmsの対応表。
    overlays: Array.isArray(source.composition?.timeline?.overlays)
      ? source.composition.timeline.overlays
      : [],
    timelineCutRanges: buildTimelineCutRanges(source),
    // U9(BGMトラック): タイムライン総尺(OP含む)。BGMクリップUIの横軸スケールに使う。
    timelineDurationMs: Math.max(0, Math.round(Number(source.composition?.timeline?.total_duration_ms) || 0)),
    // V1(タイムラインView): timeline.op(U8)。映像トラック先頭のOPグループブロック表示用
    // (正規化はレンダラー側 lib/timelineLayout.ts の normalizeTimelineOp が行う)。
    timelineOp: source.composition?.timeline?.op ?? null,
    // フェーズW2: シーン映像ギミック(pinch/zoom。タイムラインms基準)。
    // 正規化はレンダラー側 lib/videoEffects.ts の normalizeVideoEffects が行う。
    // video_effects の無い既存compositionは空配列=効果なし。
    videoEffects: Array.isArray(source.composition?.timeline?.video_effects)
      ? source.composition.timeline.video_effects
      : [],
  };
}

/**
 * フェーズT2(directedモード): UIのシーン編集(deriveDirectedSlots)を telop_directives.json の
 * slots へ書き戻す。step08 はスロットを絶対msアンカーで現在のkeep_segmentsへ選び直すため、
 * ここでは編集後のスロット(文言・スタイル・強調語・絶対ms範囲)で丸ごと差し替えればよい。
 * 既存スロットと中点が一致するものは slot_id / source_text(フォールバック検証の元発話)を引き継ぐ。
 * 戻り値は実際に書き換えを行ったかどうか。
 */
function applyDirectedSlotEditsToDirectives(runDir, directedSlots) {
  if (!Array.isArray(directedSlots) || !directedSlots.length) return false;
  const directivesPath = path.join(runDir, "telop_directives.json");
  if (!fs.existsSync(directivesPath)) return false;
  const directives = readJson(directivesPath);
  const existingSlots = Array.isArray(directives.slots) ? directives.slots : [];

  const findExisting = (startMs, endMs) => {
    const midpoint = (startMs + endMs) / 2;
    return existingSlots.find(
      (slot) =>
        Number(slot?.source_start_ms) <= midpoint && midpoint < Number(slot?.source_end_ms),
    );
  };

  const nextSlots = [];
  directedSlots.forEach((edit, index) => {
    const startMs = Math.round(Number(edit?.startMs ?? 0));
    const endMs = Math.round(Number(edit?.endMs ?? 0));
    const text = String(edit?.text || "").trim();
    if (endMs <= startMs) return;
    const existing = findExisting(startMs, endMs);
    // テロップ空欄のシーン(相槌の自動空欄=W10-7・ユーザーの文言削除)は「テロップなし」の
    // 明示マーカーとして残す(step06cのdrop:trueと同形)。スロットごと落とすと、step08が
    // 「スロットの無いカット」としてSTTテキストからテロップを自動再生成してしまい、
    // 消したはずの文言が書き出しに復活する(実機FB「一番最後のテキストが削除しても残り続ける」)。
    if (!text) {
      nextSlots.push({
        slot_id: existing?.slot_id || `ui_s${String(index + 1).padStart(3, "0")}`,
        cut_id: existing?.cut_id || "",
        source_start_ms: startMs,
        source_end_ms: endMs,
        source_text: existing?.source_text ?? "",
        text: "",
        style: typeof edit?.styleId === "string" && edit.styleId ? edit.styleId : "fact_yellow",
        ...(typeof existing?.speaker === "string" && existing.speaker ? { speaker: existing.speaker } : {}),
        highlight_words: [],
        fallback: false,
        dropped: true,
      });
      return;
    }
    const highlightWords = Array.isArray(edit?.highlightWords)
      ? edit.highlightWords.map(String).filter((word) => word && text.includes(word))
      : [];
    // フェーズT2.5-4: typeを保存し、個別上書きでないスロットはstep08実行時に
    // type×最新マッピングで再解決される(styleはtypeを読めない旧経路向けのスナップショット)。
    const typeId =
      typeof edit?.typeId === "string" && TELOP_SEMANTIC_TYPES.includes(edit.typeId) ? edit.typeId : "";
    // フェーズT3: アニメーションピッカーの個別上書き。slots[].animation_in の存在=上書きであり、
    // 未指定(null)のスロットは書かない(step08がtype×マッピング→プリセット既定で解決する)。
    const animationIn =
      typeof edit?.animationIn === "string" && TELOP_ANIMATION_IN_TYPES.includes(edit.animationIn)
        ? edit.animationIn
        : "";
    const videoEffectOverride =
      typeof edit?.videoEffectOverride === "string" &&
      ["none", "pinch", "zoom"].includes(edit.videoEffectOverride)
        ? edit.videoEffectOverride
        : "";
    nextSlots.push({
      slot_id: existing?.slot_id || `ui_s${String(index + 1).padStart(3, "0")}`,
      cut_id: existing?.cut_id || "",
      source_start_ms: startMs,
      source_end_ms: endMs,
      source_text: existing?.source_text ?? text,
      text,
      style: typeof edit?.styleId === "string" && edit.styleId ? edit.styleId : "fact_yellow",
      // フェーズW1: 話者IDはUIで編集しないため既存スロットから引き継ぐ(無ければ書かない)
      ...(typeof existing?.speaker === "string" && existing.speaker ? { speaker: existing.speaker } : {}),
      ...(typeId ? { type: typeId } : {}),
      ...(edit?.styleOverridden ? { style_overridden: true } : {}),
      ...(animationIn ? { animation_in: animationIn } : {}),
      ...(videoEffectOverride ? { video_effect: videoEffectOverride } : {}),
      highlight_words: highlightWords,
      fallback: false,
    });
  });
  if (!nextSlots.length) return false;

  directives.slots = nextSlots;
  directives.edited_by_ui = true;
  directives.updated_at = new Date().toISOString();
  writeJson(directivesPath, directives);
  return true;
}

/**
 * フェーズU6(詳細エディタ): シーン個別カスタムスタイルの定義を telop_directives.json の
 * custom_styles へマージ保存する。step08 が composition の telop_styles へ注入し、
 * スロットの style=custom_scene_* が directed の sanitize で許可される。
 * 上書きのみ行い削除はしない(過去シーンが参照している定義を消さないため)。
 */
function applyCustomStylesToDirectives(runDir, customStyles) {
  const sanitized = sanitizeCustomStyles(customStyles);
  if (!Object.keys(sanitized).length) return false;
  const directivesPath = path.join(runDir, "telop_directives.json");
  if (!fs.existsSync(directivesPath)) return false;
  const directives = readJson(directivesPath);
  directives.custom_styles = { ...(directives.custom_styles || {}), ...sanitized };
  directives.edited_by_ui = true;
  directives.updated_at = new Date().toISOString();
  writeJson(directivesPath, directives);
  return true;
}

/**
 * U1-5(オーバーレイの文言編集): プレビューでクリック編集したオーバーレイ文言を
 * telop_directives.json へ書き戻す(スロット編集と同じ「directives書き戻し→step08再実行」経路)。
 * - chapter_title(id=chapter_XX)は directives.chapters[].title を書き換える
 * - それ以外(profile_card等)は directives.overlays[] の text / subtitle を書き換える
 *   (lines を持つ list_stack / cta_banner は text の改行split で lines も更新する)
 * 戻り値は実際に書き換えを行ったかどうか。
 */
function applyOverlayEditsToDirectives(runDir, overlayEdits) {
  if (!Array.isArray(overlayEdits) || !overlayEdits.length) return false;
  const directivesPath = path.join(runDir, "telop_directives.json");
  if (!fs.existsSync(directivesPath)) return false;
  const directives = readJson(directivesPath);
  const chapters = Array.isArray(directives.chapters) ? directives.chapters : [];
  const overlays = Array.isArray(directives.overlays) ? directives.overlays : [];
  let changed = false;

  for (const edit of overlayEdits) {
    const overlayId = String(edit?.id || "");
    if (!overlayId) continue;
    const chapter = chapters.find((entry) => String(entry?.id || "") === overlayId);
    if (chapter) {
      const title = typeof edit.text === "string" ? edit.text.trim() : "";
      if (title && title !== String(chapter.title || "")) {
        chapter.title = title;
        changed = true;
      }
      continue;
    }
    const overlay = overlays.find((entry) => String(entry?.id || "") === overlayId);
    if (!overlay) continue;
    if (typeof edit.text === "string") {
      const text = edit.text.trim();
      if (text && text !== String(overlay.text || "")) {
        overlay.text = text;
        if (Array.isArray(overlay.lines) && overlay.lines.length) {
          overlay.lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
        }
        changed = true;
      }
    }
    if (typeof edit.subtitle === "string" && edit.subtitle.trim() !== String(overlay.subtitle || "")) {
      overlay.subtitle = edit.subtitle.trim();
      changed = true;
    }
  }

  if (!changed) return false;
  directives.edited_by_ui = true;
  directives.updated_at = new Date().toISOString();
  writeJson(directivesPath, directives);
  return true;
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
  // フェーズT2(directedモード): step08はtelop_directives.jsonを読むため、再実行前に
  // UIのスロット編集(文言・スタイル・強調語)をディレクティブへ書き戻しておく。
  // フェーズU6: シーン個別カスタムスタイル定義を先に保存する(スロットのstyle=custom_scene_*
  // が定義とセットでstep08に届くようにするため)。
  applyCustomStylesToDirectives(resolved, input?.customStyles);
  const directedApplied = applyDirectedSlotEditsToDirectives(resolved, input?.directedSlots);
  // U1-5: オーバーレイのクリック文言編集も同じタイミングでディレクティブへ書き戻す。
  applyOverlayEditsToDirectives(resolved, input?.overlayEdits);
  await rerunCompositionAndTelop(resolved, { telopOverrides: input?.telopOverrides });

  // directedモードではスロット由来のtelopsが正であり、telop.txt経由の上書き
  // (apply_telop.pyのword再マッピング)を通すと明示タイミング・スタイルが崩れるため通さない。
  if (directedApplied) {
    return {
      transcript: loadTranscriptEditorState(resolved),
      review: loadTelopReviewState(resolved),
    };
  }

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

// --- フェーズW7: プロジェクト一覧(検品段階からの再編集) ---
// runs/<run>/ を「プロジェクト」として扱う。検品UIを開くのに必要なファイルが
// 揃っている(=パイプラインがstep08まで到達した)runだけを一覧に出す。

const PROJECT_META_FILE = "project_meta.json";

function projectMetaPath(runDir) {
  return path.join(runDir, PROJECT_META_FILE);
}

function readProjectMeta(runDir) {
  const metaPath = projectMetaPath(runDir);
  if (!fs.existsSync(metaPath)) return null;
  try {
    return readJson(metaPath);
  } catch {
    return null;
  }
}

/** runフォルダ名の先頭タイムスタンプ(YYYYMMDD_HHMMSS)から作成日時msを復元する */
function runCreatedAtMs(runName, runDir) {
  const match = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(runName);
  if (match) {
    const date = new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    );
    if (!Number.isNaN(date.getTime())) return date.getTime();
  }
  try {
    const stat = fs.statSync(runDir);
    return stat.birthtimeMs || stat.mtimeMs || 0;
  } catch {
    return 0;
  }
}

/** filmstripキャッシュの先頭フレームをサムネイルとして返す(無ければ空文字) */
function projectThumbnailDataUrl(runDir) {
  try {
    const dir = path.join(runDir, "ui_cache", "filmstrip");
    if (!fs.existsSync(dir)) return "";
    const first = fs
      .readdirSync(dir)
      .filter((name) => /\.(jpe?g|png|webp)$/i.test(name))
      .sort()[0];
    if (!first) return "";
    const buffer = fs.readFileSync(path.join(dir, first));
    if (buffer.length > 512 * 1024) return "";
    const ext = path.extname(first).toLowerCase();
    const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    return `data:${mime};base64,${buffer.toString("base64")}`;
  } catch {
    return "";
  }
}

function projectSummaryForRun(runDir) {
  const runName = path.basename(runDir);
  const required = [
    path.join(runDir, "step01_preprocess", "preprocess.json"),
    path.join(runDir, "step07_cut_proposal", "cut_proposal.json"),
    path.join(runDir, "step08_composition", "composition.json"),
  ];
  if (!required.every((file) => fs.existsSync(file))) return null;

  let preprocess;
  try {
    preprocess = readJson(required[0]);
  } catch {
    return null;
  }
  const meta = readProjectMeta(runDir);
  const sourceVideoPath = String(preprocess.video_path || "");
  const finalVideo = readRenderOutputPath(runDir) || defaultRenderOutputPath(runDir);
  const createdAtMs = runCreatedAtMs(runName, runDir);
  let updatedAtMs = createdAtMs;
  try {
    updatedAtMs = Math.max(createdAtMs, fs.statSync(required[1]).mtimeMs || 0);
  } catch {
    // cut_proposal.jsonのstatに失敗しても作成日時で代用できる
  }

  return {
    runDir,
    runName,
    title: String(meta?.title || extractRunTitle(runDir) || runName),
    createdAtMs,
    updatedAtMs,
    durationMs: Math.round(Number(preprocess.metadata?.duration_ms || 0)),
    sourceVideoPath,
    sourceVideoExists: Boolean(sourceVideoPath && fs.existsSync(sourceVideoPath)),
    exportedVideoPath: fs.existsSync(finalVideo) ? finalVideo : "",
    saved: Boolean(meta?.saved),
    thumbnailDataUrl: projectThumbnailDataUrl(runDir),
  };
}

function listProjects() {
  const runsRoot = path.join(repoRoot(), "runs");
  if (!fs.existsSync(runsRoot)) return { projects: [] };
  const projects = [];
  for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const summary = projectSummaryForRun(path.join(runsRoot, entry.name));
    if (summary) projects.push(summary);
  }
  projects.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  return { projects };
}

function saveProjectMeta(input) {
  const runDir = resolveRunDir(input?.runDir);
  const existing = readProjectMeta(runDir) || {};
  const next = {
    version: 1,
    saved: true,
    title: String(input?.title ?? existing.title ?? extractRunTitle(runDir) ?? ""),
    savedAt: new Date().toISOString(),
  };
  writeJson(projectMetaPath(runDir), next);
  return next;
}

function deleteProject(input) {
  const runDir = resolveRunDir(input?.runDir);
  if (activeJob && activeJob.runDir === runDir) {
    throw new Error("このプロジェクトはジョブ実行中のため削除できません");
  }
  fs.rmSync(runDir, { recursive: true, force: true });
  return { ok: true };
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

// --- フェーズU9: フィルムストリップ(サムネイル帯) ---

// 全体ナビ幅に敷き詰める枚数と高さ。48枚あればホバー追従でも「動いて見える」粒度になり、
// 生成時間(1枚あたりffmpeg高速シーク1回)とのバランスも良い。
const FILMSTRIP_FRAME_COUNT = 48;
const FILMSTRIP_FRAME_HEIGHT = 54;
const FILMSTRIP_CACHE_VERSION = 1;

function filmstripCacheDir(runDir) {
  // waveform(ui_cache/waveform.json)と同じUIキャッシュ置き場に集約する
  return path.join(runDir, "ui_cache", "filmstrip");
}

/** 元動画のパス(preprocess.json優先、無ければcomposition metaへフォールバック)。 */
function resolveRunSourceVideoPath(runDir) {
  const preprocessPath = path.join(runDir, "step01_preprocess", "preprocess.json");
  if (fs.existsSync(preprocessPath)) {
    try {
      const preprocess = readJson(preprocessPath);
      if (preprocess?.video_path && fs.existsSync(preprocess.video_path)) return preprocess.video_path;
    } catch {
      // 壊れたpreprocess.jsonはcompositionへフォールバック
    }
  }
  const compositionPath = path.join(runDir, "step08_composition", "composition.json");
  if (fs.existsSync(compositionPath)) {
    try {
      const composition = readJson(compositionPath);
      const source = composition?.meta?.source_video;
      if (source && fs.existsSync(source)) return source;
    } catch {
      // 読めない場合はnull
    }
  }
  return null;
}

/** ffprobeでメディアの長さ(ms)を取得する。失敗時はnull。 */
function probeMediaDurationMs(filePath) {
  return new Promise((resolve) => {
    const child = spawn(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      const seconds = parseFloat(stdout.trim());
      resolve(code === 0 && Number.isFinite(seconds) ? Math.round(seconds * 1000) : null);
    });
  });
}

/** ffmpeg高速シーク(-ss を -i より前)で1フレームだけサムネイルを抽出する。 */
function extractFilmstripFrame(videoPath, timeMs, outPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-y",
        "-ss", String(timeMs / 1000),
        "-i", videoPath,
        "-frames:v", "1",
        "-vf", `scale=-2:${FILMSTRIP_FRAME_HEIGHT}`,
        "-q:v", "4",
        "-loglevel", "error",
        outPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0 && fs.existsSync(outPath)) resolve();
      else reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

/**
 * 指定runのフィルムストリップ(等間隔サムネイル一式)を生成する(またはキャッシュから返す)。
 * waveformキャッシュと同方式: runDir/ui_cache/filmstrip/ にjpg+manifestを保存し、
 * 元動画の更新日時・サイズ・設定が一致する限り再利用する(2回目以降は即時返却)。
 * 全編を1回デコードするのではなく枚数分の高速シーク抽出(60分素材でも数秒〜十数秒)。
 */
async function generateFilmstripForRun(runDir) {
  const resolved = resolveRunDir(runDir);
  const videoPath = resolveRunSourceVideoPath(resolved);
  if (!videoPath) throw new Error("元動画が見つかりません(step01_preprocess/preprocess.json)");
  const videoStat = fs.statSync(videoPath);
  const cacheDir = filmstripCacheDir(resolved);
  const manifestPath = path.join(cacheDir, "filmstrip.json");

  const toResponse = (manifest, cached) => ({
    count: manifest.frames.length,
    height: manifest.height,
    durationMs: manifest.durationMs,
    frames: manifest.frames
      .map((frame) => ({
        ms: frame.ms,
        url: registerPreviewImage(path.join(cacheDir, frame.file)),
      }))
      .filter((frame) => Boolean(frame.url)),
    cached,
  });

  if (fs.existsSync(manifestPath)) {
    try {
      const cachedManifest = readJson(manifestPath);
      if (
        cachedManifest &&
        cachedManifest.version === FILMSTRIP_CACHE_VERSION &&
        cachedManifest.videoMtimeMs === videoStat.mtimeMs &&
        cachedManifest.videoSize === videoStat.size &&
        Array.isArray(cachedManifest.frames) &&
        cachedManifest.frames.every((frame) => fs.existsSync(path.join(cacheDir, frame.file)))
      ) {
        return toResponse(cachedManifest, true);
      }
    } catch {
      // キャッシュが壊れている場合は再生成する。
    }
  }

  const durationMs = await probeMediaDurationMs(videoPath);
  if (!durationMs || durationMs <= 0) throw new Error("元動画の長さを取得できませんでした");

  fs.mkdirSync(cacheDir, { recursive: true });
  const frames = [];
  for (let i = 0; i < FILMSTRIP_FRAME_COUNT; i += 1) {
    // ビン中央の時刻を代表フレームにする(先頭/末尾の黒フレームを避けやすい)
    const timeMs = Math.min(durationMs - 1, Math.round(((i + 0.5) / FILMSTRIP_FRAME_COUNT) * durationMs));
    const fileName = `frame_${String(i).padStart(3, "0")}.jpg`;
    await extractFilmstripFrame(videoPath, timeMs, path.join(cacheDir, fileName));
    frames.push({ ms: timeMs, file: fileName });
  }

  const manifest = {
    version: FILMSTRIP_CACHE_VERSION,
    height: FILMSTRIP_FRAME_HEIGHT,
    durationMs,
    videoMtimeMs: videoStat.mtimeMs,
    videoSize: videoStat.size,
    frames,
  };
  writeJson(manifestPath, manifest);
  return toResponse(manifest, false);
}

// --- フェーズU9: BGMトラック(runs/<run>/bgm/bgm.json) ---

// 100%を既定とし、ユーザーがタイムラインで下げて微調整する運用(実機FB 2026-09-03)
const BGM_DEFAULT_VOLUME = 1;
const BGM_DEFAULT_FADE_MS = 1500;
const BGM_AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "aac"];

function bgmDir(runDir) {
  return path.join(runDir, "bgm");
}

function bgmJsonPath(runDir) {
  return path.join(bgmDir(runDir), "bgm.json");
}

/** composition.json のタイムライン総尺(ms)。無ければ0(UI側は音源長のみでクリップを作る)。 */
function timelineDurationMsForRun(runDir) {
  const compositionPath = path.join(runDir, "step08_composition", "composition.json");
  if (!fs.existsSync(compositionPath)) return 0;
  try {
    const composition = readJson(compositionPath);
    return Math.max(0, Math.round(Number(composition?.timeline?.total_duration_ms) || 0));
  } catch {
    return 0;
  }
}

/**
 * bgm.json のクリップ配列をmain側で検証・整形する(python shared/bgm.py と同じ規則)。
 * レンダラーからの未検証入力(bgm:save)にも使うため、数値クランプ・実在チェックを行う。
 */
function sanitizeBgmClipsForRun(runDir, rawClips) {
  if (!Array.isArray(rawClips)) return [];
  const dir = bgmDir(runDir);
  const clips = [];
  for (let index = 0; index < rawClips.length; index += 1) {
    const entry = rawClips[index];
    if (!entry || typeof entry !== "object") continue;
    const fileName = typeof entry.file === "string" ? entry.file : "";
    if (!fileName) continue;
    // パス走査を防ぐためファイル名成分のみ受け付ける(bgm.json正本はbgm/内のファイル名)
    const baseName = path.basename(fileName);
    if (!fs.existsSync(path.join(dir, baseName))) continue;
    const startMs = Math.max(0, Math.round(Number(entry.start_ms)));
    const endMs = Math.round(Number(entry.end_ms));
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    const durationMs = endMs - startMs;
    const volumeRaw = Number(entry.volume);
    clips.push({
      id: typeof entry.id === "string" && entry.id ? entry.id : `bgm_${Date.now()}_${index}`,
      file: baseName,
      start_ms: startMs,
      end_ms: endMs,
      volume: Number.isFinite(volumeRaw) ? Math.max(0, Math.min(1, volumeRaw)) : BGM_DEFAULT_VOLUME,
      fade_in_ms: Math.max(0, Math.min(durationMs, Math.round(Number(entry.fade_in_ms) || 0))),
      fade_out_ms: Math.max(0, Math.min(durationMs, Math.round(Number(entry.fade_out_ms) || 0))),
    });
  }
  // V6-5: 配列順=UIのレーン順の正本のため、start_msでのソートはしない(入力順を保つ)
  return clips;
}

/** bgm.json を読み、UI表示用の付加情報(配信URL・音源長・表示名)つきで返す。 */
async function loadBgmStateForRun(runDir) {
  const resolved = resolveRunDir(runDir);
  const jsonPath = bgmJsonPath(resolved);
  let raw = [];
  if (fs.existsSync(jsonPath)) {
    try {
      raw = readJson(jsonPath);
    } catch {
      raw = [];
    }
  }
  const clips = sanitizeBgmClipsForRun(resolved, raw);
  const enriched = [];
  for (const clip of clips) {
    const filePath = path.join(bgmDir(resolved), clip.file);
    enriched.push({
      ...clip,
      url: registerPreviewBgmAudio(filePath) || "",
      audioDurationMs: (await probeMediaDurationMs(filePath)) || 0,
    });
  }
  return {
    clips: enriched,
    timelineDurationMs: timelineDurationMsForRun(resolved),
  };
}

/** bgm.json へ保存(bgm:save)。保存後の状態(UI付加情報つき)を返す。 */
async function saveBgmClipsForRun(runDir, rawClips) {
  const resolved = resolveRunDir(runDir);
  const clips = sanitizeBgmClipsForRun(resolved, rawClips);
  fs.mkdirSync(bgmDir(resolved), { recursive: true });
  writeJson(bgmJsonPath(resolved), clips);
  return loadBgmStateForRun(resolved);
}

/** コピー先で同名ファイルがあれば連番を付けて衝突を避ける(既存クリップの素材を上書きしない)。 */
function uniqueDestFileName(destDir, sourcePath) {
  const parsed = path.parse(path.basename(sourcePath));
  let destName = `${parsed.name}${parsed.ext}`;
  let suffix = 2;
  while (fs.existsSync(path.join(destDir, destName))) {
    destName = `${parsed.name}-${suffix}${parsed.ext}`;
    suffix += 1;
  }
  return destName;
}

/**
 * V6-4: パス指定のBGM追加(bgm:add-file。ダイアログなし版。D&Dと bgm:add の共通コア)。
 * 指定startMsから音源長ぶん配置する(音源長不明時は60秒。総尺内に余地があればクランプ)。
 */
async function addBgmFileToRun(runDir, sourcePath, startMsRaw) {
  const resolved = resolveRunDir(runDir);
  if (typeof sourcePath !== "string" || !fs.existsSync(sourcePath)) return null;
  // レンダラーは拡張子で振り分け済みだが、未検証入力なのでmain側でも防御する
  const ext = path.extname(sourcePath).slice(1).toLowerCase();
  if (!BGM_AUDIO_EXTENSIONS.includes(ext)) {
    throw new Error(`非対応の音声形式です（対応: ${BGM_AUDIO_EXTENSIONS.join("/")}）`);
  }

  fs.mkdirSync(bgmDir(resolved), { recursive: true });
  const destName = uniqueDestFileName(bgmDir(resolved), sourcePath);
  fs.copyFileSync(sourcePath, path.join(bgmDir(resolved), destName));

  const audioDurationMs = (await probeMediaDurationMs(path.join(bgmDir(resolved), destName))) || 0;
  const timelineDurationMs = timelineDurationMsForRun(resolved);
  const startMs = Math.max(0, Math.round(Number(startMsRaw) || 0));
  // 音源長もタイムライン総尺も不明な場合の最低尺(伸縮ですぐ調整できる)
  let endMs = startMs + Math.max(1000, audioDurationMs || 60000);
  // 総尺クランプは1秒以上の余地がある場合のみ(末尾追記=総尺ちょうどからの追加で区間ゼロにしない)
  if (timelineDurationMs > startMs + 1000) endMs = Math.min(endMs, timelineDurationMs);

  const durationMs = endMs - startMs;
  const existing = fs.existsSync(bgmJsonPath(resolved)) ? readJson(bgmJsonPath(resolved)) : [];
  const nextClips = [
    ...(Array.isArray(existing) ? existing : []),
    {
      id: `bgm_${Date.now()}`,
      file: destName,
      start_ms: startMs,
      end_ms: endMs,
      volume: BGM_DEFAULT_VOLUME,
      fade_in_ms: Math.min(BGM_DEFAULT_FADE_MS, durationMs),
      fade_out_ms: Math.min(BGM_DEFAULT_FADE_MS, durationMs),
    },
  ];
  return saveBgmClipsForRun(resolved, nextClips);
}

/**
 * BGM追加(bgm:add): ファイル選択ダイアログ → runs/<run>/bgm/ へコピー → 既定値でクリップ追加。
 * V6-5: 開始位置はレンダラー指定(既存クリップ最後尾の終端。1本目は0)。
 */
async function addBgmToRun(runDir, startMsRaw) {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "BGMファイルを選択",
    properties: ["openFile"],
    filters: [{ name: "音声ファイル", extensions: BGM_AUDIO_EXTENSIONS }],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return addBgmFileToRun(runDir, result.filePaths[0], startMsRaw);
}

// --- フェーズV4: 画像挿入トラック(runs/<run>/images/images.json) ---
// U9のBGM経路と同型: images.json 正本 → step08(shared/images.py)が timeline.images へ転写。

const IMAGE_DEFAULT_X = 0.5;
const IMAGE_DEFAULT_Y = 0.35;
const IMAGE_DEFAULT_SCALE = 0.55;
const IMAGE_DEFAULT_OPACITY = 1;
/** 追加時の既定表示尺(ms)。再生ヘッド位置から4秒間。 */
const IMAGE_DEFAULT_DURATION_MS = 4000;
const IMAGE_MIN_CLIP_MS = 500;
const IMAGE_FILE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"];

function imagesDir(runDir) {
  return path.join(runDir, "images");
}

function imagesJsonPath(runDir) {
  return path.join(imagesDir(runDir), "images.json");
}

/**
 * images.json のクリップ配列をmain側で検証・整形する(python shared/images.py と同じ規則)。
 * レンダラーからの未検証入力(images:save)にも使うため、数値クランプ・実在チェックを行う。
 */
function sanitizeImageClipsForRun(runDir, rawClips) {
  if (!Array.isArray(rawClips)) return [];
  const dir = imagesDir(runDir);
  const clips = [];
  for (let index = 0; index < rawClips.length; index += 1) {
    const entry = rawClips[index];
    if (!entry || typeof entry !== "object") continue;
    const fileName = typeof entry.file === "string" ? entry.file : "";
    if (!fileName) continue;
    // パス走査を防ぐためファイル名成分のみ受け付ける(images.json正本はimages/内のファイル名)
    const baseName = path.basename(fileName);
    if (!fs.existsSync(path.join(dir, baseName))) continue;
    const startMs = Math.max(0, Math.round(Number(entry.start_ms)));
    const endMs = Math.round(Number(entry.end_ms));
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    const xRaw = Number(entry.x);
    const yRaw = Number(entry.y);
    const scaleRaw = Number(entry.scale);
    const opacityRaw = Number(entry.opacity);
    clips.push({
      id: typeof entry.id === "string" && entry.id ? entry.id : `image_${Date.now()}_${index}`,
      file: baseName,
      start_ms: startMs,
      end_ms: endMs,
      x: Number.isFinite(xRaw) ? Math.max(0, Math.min(1, xRaw)) : IMAGE_DEFAULT_X,
      y: Number.isFinite(yRaw) ? Math.max(0, Math.min(1, yRaw)) : IMAGE_DEFAULT_Y,
      scale: Number.isFinite(scaleRaw) ? Math.max(0.1, Math.min(1, scaleRaw)) : IMAGE_DEFAULT_SCALE,
      opacity: Number.isFinite(opacityRaw) ? Math.max(0, Math.min(1, opacityRaw)) : IMAGE_DEFAULT_OPACITY,
    });
  }
  // V6-5: 配列順=前後関係(UIのレーン順・RemotionのzIndex順)の正本のため、ソートしない
  return clips;
}

/** images.json を読み、UI表示用の付加情報(配信URL)つきで返す。 */
function loadImagesStateForRun(runDir) {
  const resolved = resolveRunDir(runDir);
  const jsonPath = imagesJsonPath(resolved);
  let raw = [];
  if (fs.existsSync(jsonPath)) {
    try {
      raw = readJson(jsonPath);
    } catch {
      raw = [];
    }
  }
  const clips = sanitizeImageClipsForRun(resolved, raw).map((clip) => ({
    ...clip,
    url: registerPreviewOverlayImage(path.join(imagesDir(resolved), clip.file)) || "",
  }));
  return {
    clips,
    timelineDurationMs: timelineDurationMsForRun(resolved),
  };
}

/** images.json へ保存(images:save)。保存後の状態(UI付加情報つき)を返す。 */
function saveImageClipsForRun(runDir, rawClips) {
  const resolved = resolveRunDir(runDir);
  const clips = sanitizeImageClipsForRun(resolved, rawClips);
  fs.mkdirSync(imagesDir(resolved), { recursive: true });
  writeJson(imagesJsonPath(resolved), clips);
  return loadImagesStateForRun(resolved);
}

// =============================================================================
// フェーズW9: 映像フレーミング(変形・クロップ)。run正本は runs/<run>/video_framing.json
// (images.json と同パターン: 保存はjsonのみでstep08再実行はしない。書き出し・適用時に
// step08 が読んで timeline.video_framing へ転写する)。
// =============================================================================

const FRAMING_CROP_MAX = 0.45;
const FRAMING_SCALE_MIN = 0.2;
const FRAMING_SCALE_MAX = 4.0;
const FRAMING_OFFSET_MAX = 1.0;

function videoFramingJsonPath(runDir) {
  return path.join(runDir, "video_framing.json");
}

function framingClampedNumber(container, key, low, high, fallback) {
  const value = Number(container && typeof container === "object" ? container[key] : undefined);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(low, Math.min(high, value));
}

/**
 * video_framing の未検証入力をクランプ・不正キー除去して完全形にする
 * (python shared/video_framing.py / remotion videoFraming.ts と同じ正規化規則)。
 */
function sanitizeVideoFraming(raw) {
  const entry = raw && typeof raw === "object" ? raw : {};
  const transform = entry.transform;
  const crop = entry.crop;
  return {
    transform: {
      scale: framingClampedNumber(transform, "scale", FRAMING_SCALE_MIN, FRAMING_SCALE_MAX, 1),
      x: framingClampedNumber(transform, "x", -FRAMING_OFFSET_MAX, FRAMING_OFFSET_MAX, 0),
      y: framingClampedNumber(transform, "y", -FRAMING_OFFSET_MAX, FRAMING_OFFSET_MAX, 0),
    },
    crop: {
      left: framingClampedNumber(crop, "left", 0, FRAMING_CROP_MAX, 0),
      top: framingClampedNumber(crop, "top", 0, FRAMING_CROP_MAX, 0),
      right: framingClampedNumber(crop, "right", 0, FRAMING_CROP_MAX, 0),
      bottom: framingClampedNumber(crop, "bottom", 0, FRAMING_CROP_MAX, 0),
    },
  };
}

/** video_framing.json を読み、正規化済みフレーミングを返す(ファイルなし・壊れたJSONはidentity)。 */
function loadVideoFramingForRun(runDir) {
  const resolved = resolveRunDir(runDir);
  const jsonPath = videoFramingJsonPath(resolved);
  let raw = null;
  if (fs.existsSync(jsonPath)) {
    try {
      raw = readJson(jsonPath);
    } catch {
      raw = null;
    }
  }
  return sanitizeVideoFraming(raw);
}

/** video_framing.json へ保存(video-framing:save)。保存後の正規化済みフレーミングを返す。 */
function saveVideoFramingForRun(runDir, rawFraming) {
  const resolved = resolveRunDir(runDir);
  const framing = sanitizeVideoFraming(rawFraming);
  writeJson(videoFramingJsonPath(resolved), { version: 1, ...framing });
  return framing;
}

/**
 * V6-4: パス指定の画像追加(images:add-file。ダイアログなし版。D&Dと images:add の共通コア)。
 * 既定: start=指定msから4秒間(総尺クランプ)、中央上寄り(x=0.5,y=0.35)、scale=0.55、opacity=1。
 */
function addImageFileToRun(runDir, sourcePath, startMsRaw) {
  const resolved = resolveRunDir(runDir);
  if (typeof sourcePath !== "string" || !fs.existsSync(sourcePath)) return null;
  // レンダラーは拡張子で振り分け済みだが、未検証入力なのでmain側でも防御する
  const ext = path.extname(sourcePath).slice(1).toLowerCase();
  if (!IMAGE_FILE_EXTENSIONS.includes(ext)) {
    throw new Error(`非対応の画像形式です（対応: ${IMAGE_FILE_EXTENSIONS.join("/")}）`);
  }

  fs.mkdirSync(imagesDir(resolved), { recursive: true });
  const destName = uniqueDestFileName(imagesDir(resolved), sourcePath);
  fs.copyFileSync(sourcePath, path.join(imagesDir(resolved), destName));

  const timelineDurationMs = timelineDurationMsForRun(resolved);
  let startMs = Math.max(0, Math.round(Number(startMsRaw) || 0));
  let endMs = startMs + IMAGE_DEFAULT_DURATION_MS;
  if (timelineDurationMs > 0) {
    // 総尺クランプ。末尾付近の追加でも最小尺は確保する(その分startを手前へ寄せる)
    endMs = Math.min(endMs, timelineDurationMs);
    startMs = Math.min(startMs, Math.max(0, endMs - IMAGE_MIN_CLIP_MS));
    if (endMs <= startMs) endMs = startMs + IMAGE_DEFAULT_DURATION_MS;
  }

  const existing = fs.existsSync(imagesJsonPath(resolved)) ? readJson(imagesJsonPath(resolved)) : [];
  const nextClips = [
    ...(Array.isArray(existing) ? existing : []),
    {
      id: `image_${Date.now()}`,
      file: destName,
      start_ms: startMs,
      end_ms: endMs,
      x: IMAGE_DEFAULT_X,
      y: IMAGE_DEFAULT_Y,
      scale: IMAGE_DEFAULT_SCALE,
      opacity: IMAGE_DEFAULT_OPACITY,
    },
  ];
  return saveImageClipsForRun(resolved, nextClips);
}

/** 画像追加(images:add): ファイル選択ダイアログ → パス指定版(addImageFileToRun)へ委譲。 */
async function addImageToRun(runDir, startMsRaw) {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "挿入する画像を選択",
    properties: ["openFile"],
    filters: [{ name: "画像ファイル", extensions: IMAGE_FILE_EXTENSIONS }],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return addImageFileToRun(runDir, result.filePaths[0], startMsRaw);
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
    // W19-C4: 書き出し中もUI応答性を優先する(優先度を下げる)
    lowPriority: true,
  });

  await applyFontDirectivesForRun(runDir, { useJobEvents: true });

  if (renderFinal) {
    const preprocess = readJson(path.join(runDir, "step01_preprocess", "preprocess.json"));
    let outputPath = resolveRenderOutputPath(runDir, options);
    // W25: 書き出し先が元動画と同じファイルを指す場合(macOSは大文字小文字を区別しないため
    // 「.MP4」の元動画に「.mp4」で書き出すと衝突する)、元動画の上書きを防いで別名へ退避する。
    outputPath = avoidSourceOverwrite(outputPath, preprocess?.video_path);
    // フェーズW7(書き出し設定モーダル): 解像度は「短辺の上限」で指定する
    // (横動画1080p=1920x1080 / 縦動画1080p=1080x1920 のどちらも同じ指定で済むため)。
    // フェーズW8: 縦横選択でキャンバスがソースと異なり得るため、composition の
    // meta.display_*(キャンバス寸法)を最優先し、無い旧runは従来どおり preprocess 由来。
    let width = Number(preprocess.display_width || 1280);
    let height = Number(preprocess.display_height || 720);
    const compositionPath = path.join(runDir, "step08_composition", "composition.json");
    if (fs.existsSync(compositionPath)) {
      try {
        const compositionMeta = readJson(compositionPath)?.meta || {};
        if (Number(compositionMeta.display_width) > 0 && Number(compositionMeta.display_height) > 0) {
          width = Number(compositionMeta.display_width);
          height = Number(compositionMeta.display_height);
        }
      } catch {
        // composition が読めない場合は preprocess 由来のまま(従来動作)
      }
    }
    const targetShortSide = Number(options.targetShortSide) || 0;
    const shortSide = Math.min(width, height);
    if (targetShortSide > 0 && targetShortSide < shortSide) {
      const scale = targetShortSide / shortSide;
      width = Math.max(2, Math.round((width * scale) / 2) * 2);
      height = Math.max(2, Math.round((height * scale) / 2) * 2);
    }
    const renderArgs = [
      "run",
      "render:cli",
      "--",
      "--composition",
      path.join("..", relRunDir, "step08_composition", "composition.json"),
      "--output",
      outputPath,
      "--width",
      String(width),
      "--height",
      String(height),
      "--concurrency",
      String(Math.max(1, Number(options.renderConcurrency) || 4)),
    ];
    // W11-1b: ハードウェアエンコード(VideoToolbox)。HW時は crf を渡してはいけない
    // (Remotionの制約)ため、videoBitrate と crf は排他で配線する
    const hardwareAcceleration = options.hardwareAcceleration === "if-possible" ? "if-possible" : "";
    const videoBitrate = String(options.videoBitrate || "").trim();
    if (hardwareAcceleration) {
      renderArgs.push("--hardware-acceleration", hardwareAcceleration);
    }
    if (videoBitrate) {
      renderArgs.push("--video-bitrate", videoBitrate);
    }
    const crf = Number(options.crf) || 0;
    if (!hardwareAcceleration && !videoBitrate && crf >= 1 && crf <= 51) {
      renderArgs.push("--crf", String(crf));
    }
    await spawnCommand({
      command: "npm",
      args: renderArgs,
      cwd: path.join(root, "remotion"),
      env: nodeEnv,
      stepId: "render",
      // W19-C4: レンダリング(最重量プロセス)中もUI応答性を優先する(優先度を下げる)
      lowPriority: true,
    });
    // W25: 書き出し先の記録はレンダリング成功後に行う。以前はレンダリング前に書いていたため、
    // 失敗しても render_output.json にパスが残り、そのパスに既存ファイル(元動画等)があると
    // UIが「書き出し済み」と誤表示する事故があった(2026-08-21 実害あり)。
    writeRenderOutputPath(runDir, outputPath);
  } else {
    sendJobEvent({ type: "step:done", stepId: "render" });
  }

  const outputs = buildOutputs(runDir);
  sendJobEvent({ type: "job:done", outputs });
  return outputs;
}

/**
 * W19-B2: AI最終チェック(step06d)自動実行用の入力シーン列を組み立てる。
 * レンダラーのシーンIDはセッション依存の採番で main からは分からないため、
 * composition のテロップページ本文(=レンダラーの初期シーン本文と同一)を auto_0001.. の
 * 仮IDで送り、レンダラーがロード時に本文一致で現在のシーンIDへ再マップする
 * (src/lib/finalCheck.ts remapFinalCheckIssues)。
 */
function buildAutoFinalCheckScenes(runDir) {
  const source = loadTranscriptSource(runDir);
  const scenes = [];
  for (const page of buildTelopPageBoundaries(source)) {
    const text = String(page.text || "").trim();
    if (!text) continue;
    scenes.push({ scene_id: `auto_${String(scenes.length + 1).padStart(4, "0")}`, text });
  }
  return scenes;
}

/**
 * W19-B2: 解析パイプライン最終段(検品準備完了の直前)のAI最終チェック。
 * キー無しはPython側がenabled:falseで正常終了し、プロセス失敗もnon-fatal
 * (ログを出して続行=検品画面は従来どおり開く)。
 */
async function runAutoFinalCheck({ runDir, python, env, root }) {
  const stepId = "step06d_final_check";
  try {
    const scenes = buildAutoFinalCheckScenes(runDir);
    if (!scenes.length) {
      sendJobEvent({ type: "step:done", stepId });
      return;
    }
    const outDir = path.join(runDir, "step06d_final_check");
    fs.mkdirSync(outDir, { recursive: true });
    const inputPath = path.join(outDir, "scenes_input.json");
    const outputPath = path.join(outDir, "issues.json");
    fs.writeFileSync(inputPath, `${JSON.stringify({ scenes }, null, 2)}\n`, "utf-8");
    const args = [
      "python/step06d_final_text_review.py",
      "--input",
      path.relative(root, inputPath),
      "--output",
      path.relative(root, outputPath),
    ];
    const historyPath = effectiveCorrectionHistoryPath();
    if (fs.existsSync(historyPath)) {
      args.push("--correction-history", historyPath);
    }
    await spawnCommand({ command: python, args, cwd: root, env, stepId });
  } catch (error) {
    if (!activeJob || activeJob.cancelled) throw error;
    sendJobEvent({
      type: "log",
      message: `\n[FINAL CHECK]\nAI最終チェックをスキップしました (${error.message || error})\n`,
    });
  }
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

  // フェーズW8: 素材選択時のユーザー縦横選択。run正本として orientation.json へ永続化し、
  // テンプレート選択・step08の--orientation・再実行(rerunCompositionAndTelop)・
  // プロジェクト再オープン(projectPathForRun)まで一貫してこの値を最優先する。
  // options.orientation なし(旧UI・自動)の場合はファイルを書かず完全従来動作。
  const userOrientation = sanitizeOrientation(options.orientation);
  if (userOrientation) {
    writeJson(path.join(runDir, "orientation.json"), {
      version: 1,
      orientation: userOrientation,
      source: "user",
    });
  }

  // フェーズW23(改善1): UIのOP有無チェックが指定されていれば、step08実行前に
  // run正本 op_config.json を明示生成する(writeRunOpConfig が sanitizeRunOpConfig で正規化)。
  // opEnabled 未指定(旧UI・後方互換)は何も書かず、従来どおり step08 時の
  // ensureRunOpConfig(テーマ設定から生成)に任せる。
  const startOpConfig = resolveStartOpConfig(resolveDesignExtras().op, options.opEnabled);
  if (startOpConfig) {
    writeRunOpConfig(runDir, startOpConfig);
  }

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
  // フェーズW8: ユーザー選択(orientation.json)があれば自動判定より優先する
  const orientation =
    userOrientation || (preprocess.orientation === "vertical" ? "vertical" : "horizontal");
  const templateProject = path.join("templates", `${orientation}.yaml`);
  const project = projectPathForSilenceTightness(
    root,
    runDir,
    templateProject,
    options.silenceTightness,
  );

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
      // W14-2: ユーザーが過去に確定した修正例(誤→正)をプロンプトへ注入する(無ければ従来動作)
      "--correction-history",
      effectiveCorrectionHistoryPath(),
    ],
    cwd: root,
    env,
    stepId: "step05_ai_retake",
  });

  // W19-B1: 弱い区間の再文字起こし(step05b)。ai_review.json の needs_review /
  // suggestion無しsuspect_wordsを再STT+LLM裁定し、置換候補を retranscribe.json へ出す。
  // キー無し・0件はPython側がenabled:falseで正常終了する。プロセス失敗もnon-fatal
  // (ステップはエラー表示になるがパイプラインは続行する)。
  try {
    await spawnCommand({
      command: python,
      args: [
        "python/step05b_retranscribe.py",
        relRunDir,
        "--review",
        path.join(relRunDir, "step05_ai_retake", "ai_review.json"),
        "--stt",
        correctedStt,
        "--audio",
        path.join(relRunDir, "step01_preprocess", "audio.wav"),
        "--output",
        path.join(relRunDir, "step05b_retranscribe", "retranscribe.json"),
        "--stt-provider",
        provider,
        ...(provider === "local-whisper" ? ["--whisper-model", options.whisperModel || "small"] : []),
      ],
      cwd: root,
      env,
      stepId: "step05b_retranscribe",
    });
  } catch (error) {
    if (!activeJob || activeJob.cancelled) throw error;
    sendJobEvent({
      type: "log",
      message: `\n[RETRANSCRIBE]\n再文字起こしをスキップしました (${error.message || error})\n`,
    });
  }

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

  const directedMode = resolveTelopMode(options, project) === "directed";
  sendJobEvent({
    type: "log",
    message: directedMode
      ? "\n[DIRECTED]\n演出モード: step06c でテロップ演出を決定します\n"
      : "\n[FULL]\n通常テロップモード\n",
  });

  if (directedMode) {
    await spawnCommand({
      command: python,
      args: [
        "python/step06c_direction.py",
        relRunDir,
        "--proposal",
        path.join(relRunDir, "step07_cut_proposal", "cut_proposal.json"),
        "--stt",
        correctedStt,
        "--title",
        extractRunTitle(runDir),
        "--project",
        project,
        "--edit-examples",
        editExamplesPath(),
      ],
      cwd: root,
      env,
      stepId: "step06c_direction",
    });
  } else {
    sendJobEvent({ type: "step:done", stepId: "step06c_direction" });
  }

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
      // フェーズT2.5-4: ユーザーのtype→presetマッピング(directedモードのrunでのみ効く)
      // フェーズU2: アクティブなデザインテーマがあればテーマの type_styles を優先する
      ...effectiveTypeMappingArgs(),
      // フェーズV2: run開始時にテーマ設定からrun単位 op_config.json を生成し正本にする
      ...opConfigArgs(runDir),
      // フェーズW8: ユーザーの縦横選択(orientation.json)をキャンバスへ反映する
      ...orientationArgsForRun(runDir),
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

  // 改善11: AI校正(step06b)。ANTHROPIC_API_KEY未設定時はPython側が安全にスキップする。
  // フェーズT2(directed): step06bのページ再分割はスロット単位のタイミング・スタイルを
  // 破壊するため、演出モードではスキップする(文言整形はstep06cが担う)。
  if (!directedMode) {
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
        // W14-2: ユーザーが過去に確定した修正例(誤→正)をプロンプトへ注入する(無ければ従来動作)
        "--correction-history",
        effectiveCorrectionHistoryPath(),
      ],
      cwd: root,
      env,
      stepId: "step06b_ai_refine",
    });
  } else {
    sendJobEvent({
      type: "log",
      message: "\n[DIRECTED]\nAI校正(step06b)をスキップします\n",
    });
    sendJobEvent({ type: "step:done", stepId: "step06b_ai_refine" });
  }

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
    // W19-B2: 検品準備完了の直前にAI最終チェック(step06d)を自動実行する(non-fatal)。
    // 結果(issues.json)は review:ready 後のtranscriptロード時にレンダラーが読み込む。
    await runAutoFinalCheck({ runDir, python, env, root });
    sendJobEvent({
      type: "review:ready",
      runDir,
      renderFinal,
      ...loadTelopReviewState(runDir),
    });
    return buildOutputs(runDir);
  }

  // 検品なしの直接書き出しではAI最終チェックを行わない(人が確認する画面が無いため)
  sendJobEvent({ type: "step:done", stepId: "step06d_final_check" });
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
// W12-2: ライセンスIPC(license:get/activate/deactivate/refresh/checkout)。
// FEATURES.billing(App.tsx)がOFFの間はUIから呼ばれないが、常時登録しておく。
registerLicenseIpc(ipcMain, createLicenseModule({ userDataPath }));
ipcMain.handle("shell:openExternal", (_event, url) => {
  const target = String(url || "").trim();
  if (!target) return;
  return shell.openExternal(target);
});
ipcMain.handle("font-profiles:list", () => readFontProfiles());
ipcMain.handle("telop-presets:list", () => loadTelopPresetCatalog());
// フェーズT2.5-4: シーン種類→プリセットのユーザーマッピング(userData永続化)
// フェーズU2: アクティブなデザインテーマがあればテーマ優先の解決結果を返す
ipcMain.handle("telop-type-mapping:get", () => loadEffectiveTelopTypeMapping());
ipcMain.handle("telop-type-mapping:save", (_event, input, extras) => saveTelopTypeMapping(input || {}, extras));
// フェーズU7/U8: 現在の選択(テーマ or スタンダード)のシーンタイトル・OP設定
ipcMain.handle("design-extras:get", () => resolveDesignExtras());
// フェーズV2: run単位のOP設定(runs/<run>/op_config.json)。get時に無ければテーマ設定から生成する
ipcMain.handle("op-config:get", (_event, runDir) => ensureRunOpConfig(String(runDir || "")));
ipcMain.handle("op-config:save", (_event, input) =>
  writeRunOpConfig(String(input?.runDir || ""), input?.config),
);
// フェーズU2: 使用シーンバンドル(テンプレート)と保存済みデザインテーマ
ipcMain.handle("design-scenes:list", () => loadDesignScenes());
ipcMain.handle("design-themes:list", () => loadDesignThemes());
ipcMain.handle("design-themes:save", (_event, input) => saveDesignTheme(input || {}));
ipcMain.handle("design-themes:delete", (_event, themeId) => deleteDesignTheme(String(themeId || "")));
ipcMain.handle("font-profiles:save", (_event, input) => saveFontProfile(input || {}));
ipcMain.handle("font-profiles:delete", (_event, profileId) => deleteFontProfile(profileId));
ipcMain.handle("user-rules:get", () => readUserRules());
ipcMain.handle("user-rules:save", (_event, input) => saveUserRules(input || {}));
ipcMain.handle("user-rules:learnDictionary", (_event, input) => learnDictionaryRule(input || {}));
ipcMain.handle("user-rules:recordDecision", (_event, input) => recordLearningDecision(input || {}));
ipcMain.handle("user-dictionary:get", () => readUserDictionary());
ipcMain.handle("user-dictionary:save", (_event, input) => saveUserDictionaryEntry(input || {}));
ipcMain.handle("user-dictionary:delete", (_event, from) => deleteUserDictionaryEntry(from));
// W14-2: 編集前→編集後の修正ペア学習(蓄積は自動・無操作。削除は学習済み修正モーダルから)
ipcMain.handle("edit-learning:record", (_event, input) => recordTelopEditLearning(input || {}));
ipcMain.handle("edit-history:load", (_event, runDir) =>
  editLearning.loadEditHistory(editHistoryPath(String(runDir || ""))),
);
ipcMain.handle("correction-history:get", () =>
  editLearning.loadCorrectionHistory(correctionHistoryPath()),
);
ipcMain.handle("correction-history:delete", (_event, input) =>
  editLearning.deleteCorrectionPair(correctionHistoryPath(), input || {}),
);
// W15: 学習データ(全runのedit_history + correction_history)を1ファイルへ書き出す。
// Nextcloud同期フォルダがあれば <Nextcloud>/CatCut-learning/exports/ へ保存し
// 同期で自動的に開発機へ届く(送付不要)。ファイル名にPC名+日時を含めるため
// 複数PCが同時に書き出しても衝突しない。Nextcloudが無いPCは従来どおりデスクトップへ。
ipcMain.handle("edit-learning:export", () => {
  const exportData = editLearning.buildLearningExport({
    runsRoot: path.join(repoRoot(), "runs"),
    correctionHistoryPath: correctionHistoryPath(),
    machineLabel: require("os").hostname(),
  });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13).replace("T", "-");
  const host = require("os").hostname().replace(/\.local$/i, "").replace(/[^A-Za-z0-9_-]+/g, "-");
  const learningDir = nextcloudLearningDir();
  let outputPath;
  let shared = false;
  if (learningDir) {
    try {
      const exportsDir = path.join(learningDir, "exports");
      fs.mkdirSync(exportsDir, { recursive: true });
      outputPath = path.join(exportsDir, `catcut-learning-${host}-${stamp}.json`);
      shared = true;
    } catch {
      outputPath = null;
    }
  }
  if (!outputPath) {
    outputPath = path.join(app.getPath("desktop"), `catcut-learning-${stamp}.json`);
    shared = false;
  }
  fs.writeFileSync(outputPath, `${JSON.stringify(exportData, null, 2)}\n`, "utf-8");
  shell.showItemInFolder(outputPath);
  return { path: outputPath, stats: exportData.stats, shared };
});

// W16-7: AI最終チェック。現在の表示テキスト全シーンをpython(step06d)でLLM再チェックする。
// 入出力は runs/<run>/step06d_final_check/ に残す(検品可能にする)。失敗はrenderer側でnon-fatal扱い。
ipcMain.handle("final-check:run", async (_event, input) => {
  const runDir = resolveRunDir(String(input?.runDir || ""));
  const scenes = Array.isArray(input?.scenes) ? input.scenes : [];
  const root = repoRoot();
  const python = path.join(root, ".venv", "bin", "python");
  if (!fs.existsSync(python)) throw new Error(`Python venv not found: ${python}`);

  const outDir = path.join(runDir, "step06d_final_check");
  fs.mkdirSync(outDir, { recursive: true });
  const inputPath = path.join(outDir, "scenes_input.json");
  const outputPath = path.join(outDir, "issues.json");
  fs.writeFileSync(
    inputPath,
    `${JSON.stringify({ scenes: scenes.map((scene) => ({ scene_id: String(scene?.sceneId || ""), text: String(scene?.text || "") })) }, null, 2)}\n`,
    "utf-8",
  );

  const args = [
    "python/step06d_final_text_review.py",
    "--input",
    path.relative(root, inputPath),
    "--output",
    path.relative(root, outputPath),
  ];
  const historyPath = effectiveCorrectionHistoryPath();
  if (fs.existsSync(historyPath)) {
    args.push("--correction-history", historyPath);
  }
  await spawnUtility({
    command: python,
    args,
    cwd: root,
    env: apiKeys.buildPipelineEnv(),
  });
  return readJson(outputPath);
});

// W19-B2: 保存済みのAI最終チェック結果(issues.json)のロード。review:ready後の
// transcriptロード・プロジェクト再オープン時にレンダラーが呼ぶ。issues.json が無い
// 旧runは exists: false(完全従来動作)。inputScenes は自動実行(auto_XXXX仮ID)の指摘を
// 現在のシーンIDへ本文一致で再マップするために返す(remapFinalCheckIssues)。
ipcMain.handle("final-check:load", (_event, runDir) => {
  const resolved = resolveRunDir(String(runDir || ""));
  const outDir = path.join(resolved, "step06d_final_check");
  const issuesPath = path.join(outDir, "issues.json");
  if (!fs.existsSync(issuesPath)) {
    return { exists: false, enabled: false, issues: [], inputScenes: [] };
  }
  let issuesRaw = null;
  let inputRaw = null;
  try {
    issuesRaw = readJson(issuesPath);
    const inputPath = path.join(outDir, "scenes_input.json");
    inputRaw = fs.existsSync(inputPath) ? readJson(inputPath) : null;
  } catch {
    return { exists: false, enabled: false, issues: [], inputScenes: [] };
  }
  const inputScenes = Array.isArray(inputRaw?.scenes)
    ? inputRaw.scenes
        .map((scene) => ({
          sceneId: String(scene?.scene_id || ""),
          text: String(scene?.text || ""),
        }))
        .filter((scene) => scene.sceneId && scene.text)
    : [];
  return {
    exists: true,
    enabled: Boolean(issuesRaw?.enabled),
    issues: Array.isArray(issuesRaw?.issues) ? issuesRaw.issues : [],
    inputScenes,
  };
});

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

/**
 * フェーズW8: 素材選択直後の縦横自動判定(ffprobe)。
 * rotation ±90/270 の表示寸法入替を含む判定規則は python 側
 * (shared/ffmpeg_tools.get_video_metadata)と同一(orientation.cjs parseProbeOutput)。
 * 失敗時は { ok: false } を返し、UIは横型を既定にする。
 */
function probeVideoOrientation(videoPath) {
  return new Promise((resolve) => {
    if (!videoPath || !fs.existsSync(videoPath)) {
      resolve({ ok: false });
      return;
    }
    const child = spawn(
      "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", videoPath],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolve({ ok: false }));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve({ ok: false });
        return;
      }
      resolve(parseProbeOutput(stdout));
    });
  });
}

ipcMain.handle("video:probe", (_event, videoPath) => probeVideoOrientation(String(videoPath || "")));

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

// フェーズW7: プロジェクト一覧(runs/を「プロジェクト」として一覧・保存・削除)
ipcMain.handle("projects:list", () => listProjects());
ipcMain.handle("projects:save-meta", (_event, input) => saveProjectMeta(input || {}));
ipcMain.handle("projects:delete", (_event, input) => deleteProject(input || {}));

// --- W13-1: キャッシュ管理(派生キャッシュの統計・削除。runフォルダ自体は消さない) ---

ipcMain.handle("cache:stats", () => collectCacheStats(path.join(repoRoot(), "runs")));
ipcMain.handle("cache:clean", (_event, input) =>
  cleanCaches(path.join(repoRoot(), "runs"), {
    mode: input?.mode === "all" ? "all" : "old",
    // 実行中ジョブのrunは常にスキップする(書き出し中のsegments等を消さない)
    activeRunDir: activeJob?.runDir || null,
  }),
);

/**
 * W13-1: 起動時の自動キャッシュクリーン。最終利用が7日超のrunの派生キャッシュを削除する。
 * 起動をブロックしないよう、ウィンドウ生成後に遅延してから実行する(削除はサイズ次第で
 * 数秒かかり得るため)。実行中ジョブのrunはスキップ。失敗しても起動には影響させない。
 */
function scheduleStartupCacheClean() {
  setTimeout(() => {
    try {
      const result = cleanCaches(path.join(repoRoot(), "runs"), {
        mode: "old",
        activeRunDir: activeJob?.runDir || null,
      });
      if (result.cleanedRuns > 0) {
        console.log(
          `[cache] startup clean: ${result.cleanedRuns} runs, ${Math.round(result.freedBytes / 1024 / 1024)}MB freed`,
        );
      }
    } catch (error) {
      console.error("[cache] startup clean failed:", error);
    }
  }, 5000);
}

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
ipcMain.handle("scene-edits:save-draft", async (_event, input) => {
  const runDir = String(input?.runDir || "");
  if (!runDir) throw new Error("runDir is required");
  return saveSceneEditsDraft(runDir, input);
});
ipcMain.handle("scene-edits:load-draft", (_event, runDir) => loadSceneEditsDraft(String(runDir || "")));
ipcMain.handle("transcript:apply", async (_event, input) => applyTranscriptKeepSegments(input || {}));
ipcMain.handle("transcript:run-command", async (_event, input) => runTranscriptCommand(input || {}));
ipcMain.handle("transcript:waveform", async (_event, input) =>
  generateWaveformForRun(input?.runDir, { binMs: input?.binMs }),
);

// フェーズU9: フィルムストリップ(サムネイル帯)とBGMトラック
ipcMain.handle("transcript:filmstrip", async (_event, input) => generateFilmstripForRun(input?.runDir));
ipcMain.handle("bgm:list", async (_event, input) => loadBgmStateForRun(input?.runDir));
ipcMain.handle("bgm:add", async (_event, input) => addBgmToRun(input?.runDir, input?.startMs));
// V6-4: ダイアログなし版(D&D)。OSからドラッグしたファイルのパス+開始msを直接受ける
ipcMain.handle("bgm:add-file", async (_event, input) =>
  addBgmFileToRun(input?.runDir, input?.filePath, input?.startMs),
);
ipcMain.handle("bgm:save", async (_event, input) => saveBgmClipsForRun(input?.runDir, input?.clips));
// フェーズV4: 画像挿入トラック
ipcMain.handle("images:list", async (_event, input) => loadImagesStateForRun(input?.runDir));
ipcMain.handle("images:add", async (_event, input) => addImageToRun(input?.runDir, input?.startMs));
// V6-4: ダイアログなし版(D&D)。OSからドラッグしたファイルのパス+開始msを直接受ける
ipcMain.handle("images:add-file", async (_event, input) =>
  addImageFileToRun(input?.runDir, input?.filePath, input?.startMs),
);
ipcMain.handle("images:save", async (_event, input) => saveImageClipsForRun(input?.runDir, input?.clips));
// フェーズW9: 映像フレーミング(変形・クロップ)。保存はrun正本jsonのみ(step08再実行なし=imagesと同方針)
ipcMain.handle("video-framing:get", async (_event, input) => loadVideoFramingForRun(input?.runDir));
ipcMain.handle("video-framing:save", async (_event, input) =>
  saveVideoFramingForRun(input?.runDir, input?.framing),
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
      targetShortSide: options?.targetShortSide || 0,
      crf: options?.crf || 0,
      renderConcurrency: options?.renderConcurrency || 0,
      // W11-1b: HWエンコード(VideoToolbox)と画質→ビットレートのマッピング値
      hardwareAcceleration: options?.hardwareAcceleration || "",
      videoBitrate: options?.videoBitrate || "",
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
  // W13-1: 古い派生キャッシュの自動クリーン(非ブロック・遅延実行)
  scheduleStartupCacheClean();
  // W16-6(スリープ中のCPU消費対策): スリープ・画面ロックでレンダラーへ通知し、
  // プレビュー再生(rAF/仮想再生ループの駆動源)を止めさせる。
  const notifyPowerSuspend = () => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("power:suspend");
    }
  };
  powerMonitor.on("suspend", notifyPowerSuspend);
  powerMonitor.on("lock-screen", notifyPowerSuspend);
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
  // フェーズU9: BGM・フィルムストリップ(検証スクリプト・テスト用)
  sanitizeBgmClipsForRun,
  generateFilmstripForRun,
  // フェーズV4: 画像挿入トラック(検証スクリプト・テスト用)
  sanitizeImageClipsForRun,
};
