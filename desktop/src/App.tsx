import { type CSSProperties, type SyntheticEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Circle,
  Copy,
  Download,
  FileText,
  FolderOpen,
  Loader2,
  Palette,
  Play,
  Save,
  Scissors,
  SlidersHorizontal,
  Square,
  Type,
  Wand2,
  X,
  Video,
} from "lucide-react";
import { ApiKeyWizard } from "./components/ApiKeyWizard";
import { AiSuggestionPanel } from "./components/AiSuggestionPanel";
import { CommandPalette, type DeterministicCommand } from "./components/CommandPalette";
import { CutCardsPanel, type SelectedBoundary } from "./components/CutCardsPanel";
import { PreviewPlayer, type PreviewPlayerHandle } from "./components/PreviewPlayer";
import { SceneNavBar, type NavFlagMarker } from "./components/SceneNavBar";
import { SceneRowList, type ChipSelectionState, type SceneEdgeVisual } from "./components/SceneRowList";
import { SuspicionQueuePanel } from "./components/SuspicionQueuePanel";
import { TelopReplaceModal, occurrenceKey } from "./components/TelopReplaceModal";
import { UserDictionaryModal } from "./components/UserDictionaryModal";
import { TranscriptEditor } from "./components/TranscriptEditor";
import { nudgeKeepSegmentBoundary, setKeepSegmentBoundaryMs } from "./lib/boundaryNudge";
import { computeBoundaryOverrunHighlights, findBoundaryHighlightByWordId } from "./lib/cutCards";
import { isWordInKeepSegments } from "./lib/keepSegments";
import {
  attachSuspicionsToScenes,
  deriveTelopStyleIds,
  findSceneIndexAtMs,
  findTelopOccurrencesInOtherScenes,
  initializeScenes,
  type Scene,
} from "./lib/scenes";
import { deriveDirectedSlots } from "./lib/directedTelop";
import { DEFAULT_TYPE_MAPPING, sanitizeTypeMapping, type TelopTypeMapping } from "./lib/telopTypes";
import { TelopTypeMappingModal } from "./components/TelopTypeMappingModal";
import {
  applyEdgeTrim,
  formatEdgeTrimDelta,
  isEdgeLinked,
  MIN_SCENE_DURATION_MS,
  type EdgeTrimEdge,
} from "./lib/edgeTrim";
import {
  cyclePlaybackRate,
  findAdjacentGroupBoundaryMs,
  findAdjacentSceneId,
  isCaretAtLineStart,
  isGroupCursorAtLineStart,
  resolveCaretDeleteLeftTarget,
  resolveCaretSplitTarget,
  resolveGroupDeleteLeftTarget,
  resolveGroupDeleteRightTarget,
  resolveGroupSplitTarget,
  resolveMatchingCutMark,
  resolveScissorsChipSplitTarget,
  SCENE_PLAYBACK_RATES,
} from "./lib/playhead";
import { buildInspectionCopyText } from "./lib/inspectionCopyText";
import { detectTelopWordReplacement } from "./lib/telopReplace";
import { computePeakMax } from "./lib/waveform";
import {
  buildTelopStylePlan,
  clearRuntimeTheme,
  DEFAULT_THEME_ID,
  describeThemeCard,
  hasRuntimeTheme,
  registerPresetCatalog,
  resolveEffectiveStyle,
  SAVED_THEME_ID,
  setRuntimeTheme,
  THEME_IDS,
  type TelopThemeId,
} from "./lib/telopThemes";
import { mapFontProfileToEmotionStyles, pickPrimaryFontProfile, type FontProfile } from "./lib/fontProfileTheme";
import { buildSuspicionQueue, type SuspicionItem } from "./lib/suspicionQueue";
import { buildAiReviewBanner } from "./lib/aiReviewBanner";
import { formatAiUsageSummary } from "./lib/aiUsage";
import { TelopStyleSample } from "./components/TelopStyleSample";
import { TelopThemeGalleryModal } from "./components/TelopThemeGalleryModal";
import { buildWordGroups, wordIdsForGroupRange } from "./lib/wordGroups";
import {
  computeReadThroughProgressPercent,
  DEFAULT_FOLLOW_ALONG_RATE,
  DEFAULT_NORMAL_RATE,
  findAdjacentWordIndex,
  findPreviousReadWordIndex,
  findWordIndexAtOrBefore,
  PLAYBACK_RATES,
  type PlaybackRate,
} from "./lib/followAlong";
import { useKeepSegments } from "./hooks/useKeepSegments";
import { useScenes } from "./hooks/useScenes";

/**
 * Phase A: 検品ファーストUXへの方針転換に伴う機能フラグ。
 * 削除ではなくフラグオフとし、将来の再有効化を可能にする。
 * false のものは描画だけでなく関連IPC呼び出し・データロードもスキップする。
 */
const FEATURES = {
  commandPalette: false,
  ollama: false,
  groundTruth: false,
  fontDirectivesUi: false,
  telopStyleUi: false,
  telopStage: false,
  /**
   * 検品UI v2(シーン行UI)への全面置き換えに伴うフラグ。falseで旧検品UI
   * (TranscriptEditorの文ブロック・SuspicionQueuePanel・CutCardsPanel・追い読みモード)を
   * 非表示・非ロードにする。削除はせず、いつでもtrueに戻せば旧UIへ復帰できる。
   */
  legacyReviewUi: false,
} as const;

type StepStatus = "pending" | "running" | "done" | "error";

type Step = {
  id: string;
  label: string;
  status: StepStatus;
};

const LOCAL_AI_MODEL = "qwen2.5:7b";
const ENABLE_RULE_LAB = window.location.protocol === "http:";

type Settings = Awaited<ReturnType<typeof window.catcut.getSettings>>;
type OllamaStatus = Awaited<ReturnType<typeof window.catcut.getOllamaStatus>>;
type UserRules = Awaited<ReturnType<typeof window.catcut.getUserRules>>;
type DictionaryRule = UserRules["dictionary"][number];
type GroundTruthResult = NonNullable<Awaited<ReturnType<typeof window.catcut.chooseGroundTruthText>>>;
type LearningReport = Extract<Parameters<Parameters<typeof window.catcut.onJobEvent>[0]>[0], { type: "learning:done" }>["report"];
type GroundTruthRuleReport = Awaited<ReturnType<typeof window.catcut.analyzeGroundTruthRules>>;
type GroundTruthRuleProposal = GroundTruthRuleReport["proposals"][number];
type TranscriptState = Awaited<ReturnType<typeof window.catcut.loadTranscriptEditor>>;
type WaveformResult = Awaited<ReturnType<typeof window.catcut.generateWaveform>>;
type CatCutOutputs = {
  runDir: string;
  telop: string;
  telopReview: string;
  fontDirectives: string;
  fontPlan: string;
  telopStyleDirectives: string;
  telopStylePlan: string;
  composition: string;
  finalVideo: string;
  transcriptPatch: string;
};

type TelopFinding = {
  id: string;
  type: string;
  severity: "high" | "medium" | "low";
  page_id: string;
  line_index: number | null;
  message: string;
  source: string | null;
  suggestion: string | null;
  before: string | null;
  after: string | null;
};

type TelopReview = {
  stats?: {
    findings?: number;
    remaining_findings?: number;
    applied?: number;
  };
  findings?: TelopFinding[];
  remaining_findings?: TelopFinding[];
};

type FontPattern = {
  id: string;
  label: string;
  preset: string;
  profile: string;
  profile_label: string;
  font_family: string;
  font_source?: string;
  google_font?: string;
  font_weight?: number;
  font_size?: number;
  letter_spacing?: string;
  line_height?: number;
  intent: string;
};

type FontPlan = {
  version: string;
  source: string;
  pattern_count: number;
  patterns: FontPattern[];
  notes?: string[];
};

type TelopFill = {
  type: "solid" | "gradient";
  color?: string;
  gradient_from?: string;
  gradient_to?: string;
  gradient_direction?: "vertical" | "horizontal" | "diagonal";
};

type TelopStyle = {
  description?: string;
  font_family?: string;
  font_size?: number;
  font_weight?: number;
  letter_spacing?: string;
  line_height?: number;
  fill: TelopFill;
  inner_stroke?: { color: string; width: number } | null;
  outer_stroke?: { color: string; width: number } | null;
  drop_shadow?: string | null;
  y_position_offset?: number;
};

type TelopStylePlan = {
  version: string;
  source: string;
  updated_at?: string;
  default_style: string;
  styles: Record<string, TelopStyle>;
};

type ReviewState = {
  outputs: CatCutOutputs;
  review: TelopReview | null;
  renderFinal: boolean;
  fontPlan: FontPlan | null;
  telopStyleDirectivesText: string;
  telopStylePlan: TelopStylePlan | null;
  telopStyles: Record<string, TelopStyle>;
  defaultTelopStyle: string;
  previewPages: PreviewPage[];
};

type TelopPage = {
  id: string;
  header: string;
  body: string[];
};

/** 改善10-B-1(一括変更ポップアップ): テロップ編集確定時に検出した単語置換の候補。 */
type TelopReplaceCandidate = {
  sceneId: string;
  from: string;
  to: string;
  occurrences: ReturnType<typeof findTelopOccurrencesInOtherScenes>;
};

type PreviewPage = {
  pageId: string;
  cutId: string;
  videoUrl: string;
  startMs: number;
  endMs: number;
  displayWidth?: number;
  displayHeight?: number;
};

type FontMode = "natural" | "select";
type TelopStyleMode = "natural" | "params";
type FontProfileMode = "saved" | "new";
type FontSceneKey = "default" | "highlight" | "calm" | "warning" | "question" | "simple";
type FontMood = "readable" | "soft" | "serious" | "pop" | "impact" | "handwritten";
type FontFillMode = "solid" | "gradient";
type FontStrokeMode = "withStroke" | "withoutStroke";

type FontSceneSetting = {
  font: string;
  weight: number;
  size: number;
  letterSpacing: number;
  lineHeight: number;
  fillMode: FontFillMode;
  fillColor: string;
  gradientFrom: string;
  gradientTo: string;
  strokeEnabled: boolean;
  innerStrokeColor: string;
  outerStrokeColor: string;
  innerStrokeWidth: number;
  outerStrokeWidth: number;
};

type SavedFontProfile = {
  id: string;
  name: string;
  patternCount: number;
  scenes: Record<string, FontSceneSetting>;
  directivesText: string;
  createdAt?: string;
  updatedAt?: string;
};

type FontQaState = {
  mood: FontMood;
  fillMode: FontFillMode;
  strokeMode: FontStrokeMode;
};

const localFontProfilesKey = "catcut.fontProfiles.v1";

type GoogleFontOption = {
  value: string;
  label: string;
  family: string;
  weights: number[];
  defaultWeight: number;
  description: string;
  aliases?: string[];
};

const initialSteps: Step[] = [
  { id: "step01_preprocess", label: "前処理", status: "pending" },
  { id: "step02_stt", label: "文字起こし", status: "pending" },
  { id: "step02b_transcript_correct", label: "STT補正", status: "pending" },
  { id: "step03_vad", label: "無音検出", status: "pending" },
  { id: "step04_filler_detect", label: "フィラー検出", status: "pending" },
  { id: "step07_cut_proposal", label: "カット提案", status: "pending" },
  { id: "step08_composition", label: "コンポジション", status: "pending" },
  { id: "extract_telop", label: "テロップ抽出", status: "pending" },
  { id: "review_telop", label: "書き出し前チェック", status: "pending" },
  { id: "font_directives", label: "フォント反映", status: "pending" },
  { id: "apply_telop", label: "テロップ反映", status: "pending" },
  { id: "render", label: "書き出し", status: "pending" },
];

const googleFontOptions: GoogleFontOption[] = [
  {
    value: "Zen Kaku Gothic Antique",
    label: "Zen Kaku Gothic Antique",
    family: '"Zen Kaku Gothic Antique", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Meiryo", sans-serif',
    weights: [400, 700, 900],
    defaultWeight: 900,
    description: "太く読みやすい標準ゴシック",
  },
  {
    value: "Noto Sans JP",
    label: "Noto Sans JP",
    family: '"Noto Sans JP", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Meiryo", sans-serif',
    weights: [400, 700, 900],
    defaultWeight: 900,
    description: "くっきりした万能ゴシック",
  },
  {
    value: "Zen Maru Gothic",
    label: "Zen Maru Gothic",
    family: '"Zen Maru Gothic", "Hiragino Maru Gothic ProN", "Hiragino Sans", "Meiryo", sans-serif',
    weights: [400, 700, 900],
    defaultWeight: 900,
    description: "丸みのある強調向け",
  },
  {
    value: "M PLUS Rounded 1c",
    label: "M PLUS Rounded 1c",
    family: '"M PLUS Rounded Onec", "M PLUS Rounded 1c", "Zen Maru Gothic", "Hiragino Maru Gothic ProN", "Meiryo", sans-serif',
    weights: [400, 700, 800, 900],
    defaultWeight: 900,
    description: "丸く太いポップなゴシック",
    aliases: ["丸ゴ", "丸ゴシック", "エムプラス"],
  },
  {
    value: "Mochiy Pop One",
    label: "Mochiy Pop One",
    family: '"Mochiy Pop One", "M PLUS Rounded Onec", "M PLUS Rounded 1c", "Meiryo", sans-serif',
    weights: [400],
    defaultWeight: 400,
    description: "可愛いポップ体",
    aliases: ["かわいい", "可愛い", "ポップ", "もち"],
  },
  {
    value: "RocknRoll One",
    label: "RocknRoll One",
    family: '"RocknRoll One", "Mochiy Pop One", "M PLUS Rounded Onec", "M PLUS Rounded 1c", "Meiryo", sans-serif',
    weights: [400],
    defaultWeight: 400,
    description: "勢いのあるポップ体",
    aliases: ["ロック", "勢い", "元気"],
  },
  {
    value: "Klee One",
    label: "Klee One",
    family: '"Klee One", "Hina Mincho", "Yu Mincho", "Hiragino Mincho ProN", serif',
    weights: [400, 600],
    defaultWeight: 600,
    description: "手書き風",
    aliases: ["手書き", "手描き", "ゆるい"],
  },
  {
    value: "Hina Mincho",
    label: "Hina Mincho",
    family: '"Hina Mincho", "Klee One", "Yu Mincho", "Hiragino Mincho ProN", serif',
    weights: [400],
    defaultWeight: 400,
    description: "柔らかい手書き明朝",
    aliases: ["ひな明朝", "手書き明朝"],
  },
  {
    value: "Noto Serif JP",
    label: "Noto Serif JP",
    family: '"Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", "YuMincho", serif',
    weights: [400, 700, 900],
    defaultWeight: 700,
    description: "落ち着いた明朝",
  },
  {
    value: "Shippori Mincho",
    label: "Shippori Mincho",
    family: '"Shippori Mincho", "Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", serif',
    weights: [400, 700, 800],
    defaultWeight: 800,
    description: "やわらかい明朝",
    aliases: ["しっぽり", "重厚", "和風"],
  },
  {
    value: "Reggae One",
    label: "Reggae One",
    family: '"Reggae One", "Train One", "Mochiy Pop One", "Arial Black", "Meiryo", sans-serif',
    weights: [400],
    defaultWeight: 400,
    description: "バラエティ向けの強いインパクト",
    aliases: ["インパクト", "バラエティ", "レゲエ"],
  },
  {
    value: "Train One",
    label: "Train One",
    family: '"Train One", "Reggae One", "Arial Black", "Meiryo", sans-serif',
    weights: [400],
    defaultWeight: 400,
    description: "装飾的で強烈な見出し",
    aliases: ["トレイン", "強烈", "装飾"],
  },
  {
    value: "DotGothic16",
    label: "DotGothic16",
    family: '"DotGothicOneSix", "DotGothic16", "Osaka-Mono", "Menlo", monospace',
    weights: [400],
    defaultWeight: 400,
    description: "ドット/ゲーム風",
    aliases: ["ドット", "ゲーム", "ピクセル", "レトロ"],
  },
  {
    value: "Bebas Neue",
    label: "Bebas Neue",
    family: '"Bebas Neue", "Anton", "Arial Narrow", sans-serif',
    weights: [400],
    defaultWeight: 400,
    description: "英字の縦長見出し",
    aliases: ["英字", "英語", "アルファベット", "縦長"],
  },
  {
    value: "Anton",
    label: "Anton",
    family: '"Anton", "Bebas Neue", "Arial Black", sans-serif',
    weights: [400],
    defaultWeight: 400,
    description: "太い英字見出し",
    aliases: ["英字太字", "太い英字"],
  },
  {
    value: "Caveat",
    label: "Caveat",
    family: '"Caveat", "Klee One", cursive',
    weights: [400, 700],
    defaultWeight: 700,
    description: "英字の手書き筆記体",
    aliases: ["筆記体", "英字手書き", "script", "cursive"],
  },
  {
    value: "BIZ UDPGothic",
    label: "BIZ UDPGothic",
    family: '"BIZ UDPGothic", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Meiryo", sans-serif',
    weights: [400, 700],
    defaultWeight: 700,
    description: "実用的で視認性が高い",
  },
  {
    value: "Kosugi Maru",
    label: "Kosugi Maru",
    family: '"Kosugi Maru", "Zen Maru Gothic", "Hiragino Maru Gothic ProN", "Meiryo", sans-serif',
    weights: [400],
    defaultWeight: 400,
    description: "素朴な丸ゴシック",
  },
];

const defaultTelopStyleDirectives = [
  "グラデーションで2重の枠。白い内枠と濃い外枠で、読みやすく派手すぎない。",
  "通常は青、強調は黄オレンジ、落ち着いた場面は淡い水色、注意は赤、質問は緑。",
  "数字・結論・重要語は強調、問いかけは質問、否定や注意は注意、補足はシンプルにする。",
].join("\n");

const defaultFontFamily =
  '"Zen Kaku Gothic Antique", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Meiryo", sans-serif';

const builtinTelopStyles: Record<string, TelopStyle> = {
  default: {
    description: "青グラデ+白枠+濃紺枠",
    font_family: defaultFontFamily,
    font_size: 72,
    font_weight: 900,
    letter_spacing: "0.02em",
    line_height: 1.4,
    fill: { type: "gradient", gradient_from: "#7BB8DC", gradient_to: "#1E5DA8", gradient_direction: "vertical" },
    inner_stroke: { color: "#FFFFFF", width: 10 },
    outer_stroke: { color: "#1E3A5F", width: 18 },
    drop_shadow: "drop-shadow(0px 4px 6px rgba(0,0,0,0.4))",
    y_position_offset: 0,
  },
  highlight: {
    description: "黄オレンジの強調",
    font_family: defaultFontFamily,
    font_size: 96,
    font_weight: 900,
    letter_spacing: "0.02em",
    line_height: 1.3,
    fill: { type: "gradient", gradient_from: "#FFD93D", gradient_to: "#FF6B35", gradient_direction: "vertical" },
    inner_stroke: { color: "#FFFFFF", width: 12 },
    outer_stroke: { color: "#7A2A00", width: 24 },
    drop_shadow: "drop-shadow(0px 6px 10px rgba(0,0,0,0.5))",
    y_position_offset: -0.05,
  },
  calm: {
    description: "落ち着いた淡い水色",
    font_family: defaultFontFamily,
    font_size: 66,
    font_weight: 900,
    letter_spacing: "0.02em",
    line_height: 1.4,
    fill: { type: "gradient", gradient_from: "#D9F3FF", gradient_to: "#5E91B8", gradient_direction: "vertical" },
    inner_stroke: { color: "#FFFFFF", width: 9 },
    outer_stroke: { color: "#1C3D57", width: 17 },
    drop_shadow: "drop-shadow(0px 3px 6px rgba(0,0,0,0.35))",
    y_position_offset: 0,
  },
  warning: {
    description: "赤系の注意",
    font_family: defaultFontFamily,
    font_size: 80,
    font_weight: 900,
    letter_spacing: "0.02em",
    line_height: 1.3,
    fill: { type: "gradient", gradient_from: "#FF6B6B", gradient_to: "#C92A2A", gradient_direction: "vertical" },
    inner_stroke: { color: "#FFFFFF", width: 10 },
    outer_stroke: { color: "#5C0A0A", width: 20 },
    drop_shadow: "drop-shadow(0px 4px 8px rgba(0,0,0,0.5))",
    y_position_offset: 0,
  },
  question: {
    description: "緑系の質問",
    font_family: defaultFontFamily,
    font_size: 68,
    font_weight: 900,
    letter_spacing: "0.02em",
    line_height: 1.4,
    fill: { type: "gradient", gradient_from: "#A0E7A0", gradient_to: "#2F8F4F", gradient_direction: "vertical" },
    inner_stroke: { color: "#FFFFFF", width: 10 },
    outer_stroke: { color: "#1A4D2E", width: 18 },
    drop_shadow: "drop-shadow(0px 4px 6px rgba(0,0,0,0.4))",
    y_position_offset: 0,
  },
  simple: {
    description: "白文字+黒縁",
    font_family: defaultFontFamily,
    font_size: 56,
    font_weight: 900,
    letter_spacing: "0.02em",
    line_height: 1.4,
    fill: { type: "solid", color: "#FFFFFF" },
    inner_stroke: { color: "#000000", width: 8 },
    outer_stroke: null,
    drop_shadow: "drop-shadow(0px 3px 5px rgba(0,0,0,0.5))",
    y_position_offset: 0,
  },
};

const telopStyleLabels: Record<string, string> = {
  default: "通常",
  highlight: "強調",
  calm: "落ち着き",
  warning: "注意",
  question: "質問",
  simple: "補足",
};

const fontSceneOrder: FontSceneKey[] = ["default", "highlight", "warning", "question", "calm", "simple"];

const fontSceneDescriptions: Record<FontSceneKey, string> = {
  default: "通常シーン",
  highlight: "強調シーン",
  warning: "注意シーン",
  question: "質問シーン",
  calm: "落ち着いたシーン",
  simple: "補足シーン",
};

const fontMoodLabels: Record<FontMood, string> = {
  readable: "読みやすく信頼感",
  soft: "やさしい",
  serious: "重厚・落ち着き",
  pop: "可愛いポップ",
  impact: "バラエティ強め",
  handwritten: "手書き風",
};

const fontFillModeLabels: Record<FontFillMode, string> = {
  solid: "単色",
  gradient: "グラデーション",
};

const fontStrokeModeLabels: Record<FontStrokeMode, string> = {
  withStroke: "文字枠あり",
  withoutStroke: "文字枠なし",
};

const defaultFontQa: FontQaState = {
  mood: "readable",
  fillMode: "gradient",
  strokeMode: "withStroke",
};

const scenePalettes: Record<FontSceneKey, { solid: string; from: string; to: string; stroke: string }> = {
  default: { solid: "#1E5DA8", from: "#7BB8DC", to: "#1E5DA8", stroke: "#1E3A5F" },
  highlight: { solid: "#FF8A00", from: "#FFD93D", to: "#FF6B35", stroke: "#7A2A00" },
  warning: { solid: "#C92A2A", from: "#FF6B6B", to: "#C92A2A", stroke: "#5C0A0A" },
  question: { solid: "#2F8F4F", from: "#A0E7A0", to: "#2F8F4F", stroke: "#1A4D2E" },
  calm: { solid: "#5E91B8", from: "#D9F3FF", to: "#5E91B8", stroke: "#1C3D57" },
  simple: { solid: "#FFFFFF", from: "#FFFFFF", to: "#E8EEF7", stroke: "#111827" },
};

function readLocalFontProfiles(): SavedFontProfile[] {
  try {
    const raw = window.localStorage.getItem(localFontProfilesKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalFontProfiles(profiles: SavedFontProfile[]) {
  window.localStorage.setItem(localFontProfilesKey, JSON.stringify(profiles));
}

function localProfileId() {
  return window.crypto?.randomUUID?.() || `font_${Date.now()}`;
}

function saveLocalFontProfile(input: Partial<SavedFontProfile>) {
  const profiles = readLocalFontProfiles();
  const now = new Date().toISOString();
  const id = input.id || localProfileId();
  const next: SavedFontProfile = {
    id,
    name: input.name || "字幕フォント設定",
    patternCount: Math.max(1, Math.min(fontSceneOrder.length, Number(input.patternCount || 1))),
    scenes: input.scenes || {},
    directivesText: input.directivesText || "",
    createdAt: input.createdAt || now,
    updatedAt: now,
  };
  const index = profiles.findIndex((profile) => profile.id === id);
  const merged =
    index >= 0
      ? profiles.map((profile) => (profile.id === id ? { ...profile, ...next, createdAt: profile.createdAt || next.createdAt } : profile))
      : [next, ...profiles];
  writeLocalFontProfiles(merged);
  return merged;
}

function mergeFontProfiles(primary: SavedFontProfile[], secondary: SavedFontProfile[]) {
  const seen = new Set<string>();
  return [...primary, ...secondary].filter((profile) => {
    if (!profile.id || seen.has(profile.id)) return false;
    seen.add(profile.id);
    return true;
  });
}

async function listStoredFontProfiles() {
  const local = readLocalFontProfiles();
  if (typeof window.catcut.listFontProfiles !== "function") return local;
  try {
    const remote = (await window.catcut.listFontProfiles()) as SavedFontProfile[];
    const merged = mergeFontProfiles(remote, local);
    writeLocalFontProfiles(merged);
    return merged;
  } catch {
    return local;
  }
}

async function saveStoredFontProfile(input: Partial<SavedFontProfile>) {
  if (typeof window.catcut.saveFontProfile === "function") {
    try {
      const remote = (await window.catcut.saveFontProfile(input)) as SavedFontProfile[];
      const merged = mergeFontProfiles(remote, readLocalFontProfiles());
      writeLocalFontProfiles(merged);
      return merged;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("No handler registered")) throw err;
    }
  }
  return saveLocalFontProfile(input);
}

async function deleteStoredFontProfile(profileId: string) {
  if (typeof window.catcut.deleteFontProfile === "function") {
    try {
      const remote = (await window.catcut.deleteFontProfile(profileId)) as SavedFontProfile[];
      const localFiltered = readLocalFontProfiles().filter((profile) => profile.id !== profileId);
      const merged = mergeFontProfiles(remote, localFiltered);
      writeLocalFontProfiles(merged);
      return merged;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("No handler registered")) throw err;
    }
  }
  const merged = readLocalFontProfiles().filter((profile) => profile.id !== profileId);
  writeLocalFontProfiles(merged);
  return merged;
}

function fileNameFromPath(filePath: string) {
  return filePath.split(/[\\/]/).pop() || "";
}

function directoryFromPath(filePath: string) {
  const slashIndex = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return slashIndex >= 0 ? filePath.slice(0, slashIndex) : "";
}

function baseNameWithoutExtension(filePath: string) {
  const fileName = fileNameFromPath(filePath);
  const dotIndex = fileName.lastIndexOf(".");
  return (dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName).trim();
}

function ensureMp4FileName(fileName: string) {
  const trimmed = fileName.trim();
  if (!trimmed) return "";
  const dotIndex = trimmed.lastIndexOf(".");
  if (dotIndex < 1) return `${trimmed}.mp4`;
  const ext = trimmed.slice(dotIndex).toLowerCase();
  if (ext === ".mp4") return trimmed;
  return `${trimmed.slice(0, dotIndex)}.mp4`;
}

function defaultOutputFileName(videoPath: string) {
  const base = baseNameWithoutExtension(videoPath) || "catcut-output";
  return `${base}_catcut.mp4`;
}

function joinLocalPath(directory: string, fileName: string) {
  if (!directory) return "";
  return `${directory.replace(/[\\/]+$/, "")}/${fileName}`;
}

function outputPathFromSettings(settings: Settings | null, videoPath: string) {
  if (!settings?.outputDirectory) return "";
  const fileName = ensureMp4FileName(settings.outputFileName || defaultOutputFileName(videoPath));
  return joinLocalPath(settings.outputDirectory, fileName);
}

function updateStep(steps: Step[], stepId: string, status: StepStatus): Step[] {
  return steps.map((step) => (step.id === stepId ? { ...step, status } : step));
}

function cloneTelopStyle(style: TelopStyle): TelopStyle {
  return {
    ...style,
    fill: { ...style.fill },
    inner_stroke: style.inner_stroke ? { ...style.inner_stroke } : style.inner_stroke,
    outer_stroke: style.outer_stroke ? { ...style.outer_stroke } : style.outer_stroke,
  };
}

function normalizeTelopStyles(styles: Record<string, TelopStyle> | undefined | null) {
  const normalized: Record<string, TelopStyle> = {};
  for (const [name, style] of Object.entries({ ...builtinTelopStyles, ...(styles || {}) })) {
    if (!style?.fill) continue;
    normalized[name] = cloneTelopStyle(style);
  }
  return normalized;
}

function pageStyleName(page: TelopPage | undefined, defaultStyleName: string) {
  const match = page?.header.match(/@style=([\w-]+)/);
  return match?.[1] || defaultStyleName || "default";
}

function updatePageStyleHeader(header: string, styleName: string, defaultStyleName: string) {
  const withoutStyle = header.replace(/\s*@style=[\w-]+/g, "").trimEnd();
  if (!styleName || styleName === defaultStyleName) return withoutStyle;
  return `${withoutStyle} @style=${styleName}`;
}

function setPageStyle(text: string, pageId: string, styleName: string, defaultStyleName: string) {
  const parsed = parseTelopText(text);
  const pages = parsed.pages.map((page) =>
    page.id === pageId
      ? { ...page, header: updatePageStyleHeader(page.header, styleName, defaultStyleName) }
      : page,
  );
  return renderTelopText(parsed.preamble, pages);
}

function normalizeJapaneseText(text: string) {
  return text.replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
}

function inferStyleFromPageText(text: string, availableStyles: Set<string>) {
  const normalized = normalizeJapaneseText(text);
  const question = /[?？]|(ですか|ますか|でしょうか|なのか|どんな|なぜ|どう|何|いつ|どこ)/.test(normalized);
  if (question && availableStyles.has("question")) return "question";

  const warning = /(ダメ|だめ|危険|注意|警告|NG|ミス|失敗|焦|やっちゃ|禁止|避け|無理|できない)/i.test(normalized);
  if (warning && availableStyles.has("warning")) return "warning";

  const highlight =
    /(\d+|％|%|時間|分|点|単語|回|人|円|重要|結論|絶対|必ず|一番|ポイント|ゴール|マジ|いける|伸びる|必要)/.test(
      normalized,
    );
  if (highlight && availableStyles.has("highlight")) return "highlight";

  const calm = /(大丈夫|安心|落ち着|ゆっくり|丁寧|基本|まずは|一つずつ|整理|確認)/.test(normalized);
  if (calm && availableStyles.has("calm")) return "calm";

  const simple = /(ちなみに|補足|例えば|引用|というか|まあ|えっと)/.test(normalized);
  if (simple && availableStyles.has("simple")) return "simple";

  return "default";
}

function autoAssignTelopStyles(text: string, styles: Record<string, TelopStyle>, defaultStyleName: string) {
  const parsed = parseTelopText(text);
  const availableStyles = new Set(Object.keys(styles));
  const pages = parsed.pages.map((page) => {
    const pageText = visibleLines(page).join("");
    const styleName = inferStyleFromPageText(pageText, availableStyles);
    return { ...page, header: updatePageStyleHeader(page.header, styleName, defaultStyleName) };
  });
  return renderTelopText(parsed.preamble, pages);
}

function colorThemeFromText(text: string) {
  if (/紫|パープル|violet|purple/i.test(text)) {
    return { from: "#C7A5FF", to: "#6A4DD9", outer: "#2F246A" };
  }
  if (/赤|レッド|red|注意|警告|危険/i.test(text)) {
    return { from: "#FF6B6B", to: "#C92A2A", outer: "#5C0A0A" };
  }
  if (/緑|グリーン|green|質問|穏やか/i.test(text)) {
    return { from: "#A0E7A0", to: "#2F8F4F", outer: "#1A4D2E" };
  }
  if (/黄|オレンジ|orange|派手|強調|重要/i.test(text)) {
    return { from: "#FFD93D", to: "#FF6B35", outer: "#7A2A00" };
  }
  if (/落ち着|淡|水色|ライトブルー|calm/i.test(text)) {
    return { from: "#D9F3FF", to: "#5E91B8", outer: "#1C3D57" };
  }
  return { from: "#7BB8DC", to: "#1E5DA8", outer: "#1E3A5F" };
}

function buildGradientStyle(
  base: TelopStyle,
  from: string,
  to: string,
  outer: string,
  overrides: Partial<TelopStyle> = {},
): TelopStyle {
  return {
    ...cloneTelopStyle(base),
    ...overrides,
    fill: { type: "gradient", gradient_from: from, gradient_to: to, gradient_direction: "vertical" },
    inner_stroke: overrides.inner_stroke ?? base.inner_stroke ?? { color: "#FFFFFF", width: 10 },
    outer_stroke: overrides.outer_stroke ?? { color: outer, width: base.outer_stroke?.width ?? 18 },
  };
}

function naturalTelopStyles(text: string, current: Record<string, TelopStyle>) {
  const base = normalizeTelopStyles(current);
  const theme = colorThemeFromText(text);
  const wantsDoubleStroke = /2重|二重|多重|枠|縁取り|ふち|アウトライン/.test(text);
  const wantsSoft = /落ち着|上品|控えめ|柔らか|やわらか|穏やか/.test(text);
  const wantsBig = /大き|派手|目立|強調|インパクト/.test(text);

  const defaultSize = wantsSoft ? 66 : wantsBig ? 82 : base.default?.font_size ?? 72;
  const stroke = wantsDoubleStroke
    ? {
        inner_stroke: { color: "#FFFFFF", width: wantsBig ? 12 : 10 },
        outer_stroke: { color: theme.outer, width: wantsBig ? 22 : 18 },
      }
    : {};

  return normalizeTelopStyles({
    ...base,
    default: buildGradientStyle(base.default, theme.from, theme.to, theme.outer, {
      ...stroke,
      font_size: defaultSize,
      drop_shadow: wantsSoft ? "drop-shadow(0px 3px 5px rgba(0,0,0,0.32))" : base.default.drop_shadow,
      description: "自然言語から生成した通常スタイル",
    }),
    highlight: buildGradientStyle(base.highlight, "#FFD93D", "#FF6B35", "#7A2A00", {
      font_size: wantsBig ? 100 : base.highlight?.font_size ?? 96,
      inner_stroke: { color: "#FFFFFF", width: 12 },
      outer_stroke: { color: "#7A2A00", width: 24 },
      y_position_offset: -0.05,
      description: "数字・結論・重要語",
    }),
    calm: buildGradientStyle(base.calm ?? base.default, "#D9F3FF", "#5E91B8", "#1C3D57", {
      font_size: 66,
      inner_stroke: { color: "#FFFFFF", width: 9 },
      outer_stroke: { color: "#1C3D57", width: 17 },
      drop_shadow: "drop-shadow(0px 3px 6px rgba(0,0,0,0.35))",
      description: "落ち着いたシーン",
    }),
    warning: buildGradientStyle(base.warning, "#FF6B6B", "#C92A2A", "#5C0A0A", {
      font_size: 80,
      inner_stroke: { color: "#FFFFFF", width: 10 },
      outer_stroke: { color: "#5C0A0A", width: 20 },
      description: "否定・注意",
    }),
    question: buildGradientStyle(base.question, "#A0E7A0", "#2F8F4F", "#1A4D2E", {
      font_size: 68,
      inner_stroke: { color: "#FFFFFF", width: 10 },
      outer_stroke: { color: "#1A4D2E", width: 18 },
      description: "問いかけ",
    }),
  });
}

function telopGradientCss(style: TelopStyle) {
  if (style.fill.type === "solid") return "";
  const from = style.fill.gradient_from || "#FFFFFF";
  const to = style.fill.gradient_to || "#000000";
  const direction = style.fill.gradient_direction || "vertical";
  const angle = direction === "vertical" ? "180deg" : direction === "horizontal" ? "90deg" : "135deg";
  return `linear-gradient(${angle}, ${from} 0%, ${to} 100%)`;
}

function TelopStylePreview({
  lines,
  style,
  className,
  scale = 0.38,
}: {
  lines: string[];
  style: TelopStyle;
  className?: string;
  scale?: number;
}) {
  const fontSize = Math.max(14, Math.round((style.font_size || 72) * scale));
  const hasInnerStroke = Boolean(style.inner_stroke && style.inner_stroke.width > 0);
  const hasOuterStroke = Boolean(style.outer_stroke && style.outer_stroke.width > 0);
  const innerWidth = hasInnerStroke && style.inner_stroke ? Math.max(1, Math.round(style.inner_stroke.width * scale)) : 0;
  const outerWidth = hasOuterStroke && style.outer_stroke ? Math.max(1, Math.round(style.outer_stroke.width * scale)) : 0;
  const fillStyle: CSSProperties =
    style.fill.type === "solid"
      ? { color: style.fill.color || "#FFFFFF" }
      : {
          color: "transparent",
          backgroundImage: telopGradientCss(style),
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
        };
  const textStyle: CSSProperties = {
    fontFamily: style.font_family || defaultFontFamily,
    fontSize,
    fontWeight: style.font_weight || 900,
    letterSpacing: style.letter_spacing || "0.02em",
    lineHeight: style.line_height || 1.35,
  };

  if (lines.length === 0) {
    return (
      <div className={className}>
        <span className="mutedPreview">テロップなし</span>
      </div>
    );
  }

  return (
    <div className={className} style={{ filter: style.drop_shadow || undefined }}>
      {lines.map((line, index) => (
        <span className="telopPreviewLine" key={`${line}-${index}`}>
          {hasOuterStroke && style.outer_stroke && (
            <span
              className="telopPreviewLayer"
              style={{
                ...textStyle,
                color: "transparent",
                WebkitTextStroke: `${outerWidth}px ${style.outer_stroke.color}`,
              }}
            >
              {line}
            </span>
          )}
          {hasInnerStroke && style.inner_stroke && (
            <span
              className="telopPreviewLayer"
              style={{
                ...textStyle,
                color: "transparent",
                WebkitTextStroke: `${innerWidth}px ${style.inner_stroke.color}`,
              }}
            >
              {line}
            </span>
          )}
          <span className="telopPreviewLayer telopPreviewFill" style={{ ...textStyle, ...fillStyle }}>
            {line}
          </span>
        </span>
      ))}
    </div>
  );
}

function FontScenePreviewCard({
  scene,
  setting,
  telopStyle,
  editable,
  lines,
  frameWidth,
  onChange,
}: {
  scene: FontSceneKey;
  setting: FontSceneSetting;
  telopStyle: TelopStyle;
  editable: boolean;
  lines: string[];
  frameWidth: number;
  onChange?: (patch: Partial<FontSceneSetting>) => void;
}) {
  const font = googleFontByValue(setting.font);
  const previewStyle = telopStyleFromFontScene(telopStyle, setting);
  const widthRatio = fontSizeWidthRatio(setting.size, frameWidth);

  return (
    <div className="fontSceneCard">
      <div className="fontSceneHead">
        <div>
          <strong>{telopStyleLabels[scene]}</strong>
          <span>{fontSceneDescriptions[scene]}</span>
        </div>
        <code>{font.label}</code>
      </div>
      <div className="fontSceneSample">
        <TelopStylePreview lines={lines} style={previewStyle} scale={0.28} />
      </div>
      <div className="fontSizeMeter">
        <span>画面幅の約 {widthRatio}%</span>
        <div>
          <i style={{ width: `${Math.min(100, Math.max(4, widthRatio))}%` }} />
        </div>
      </div>
      {editable && (
        <div className="fontSceneControls">
          <label>
            フォント
            <select value={setting.font} onChange={(event) => onChange?.({ font: event.target.value })}>
              {googleFontOptions.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            サイズ
            <input
              type="range"
              min={48}
              max={120}
              value={setting.size}
              onChange={(event) => onChange?.({ size: Number(event.target.value) })}
            />
          </label>
          <label>
            太さ
            <select
              value={setting.weight}
              disabled={font.weights.length === 1}
              onChange={(event) => onChange?.({ weight: Number(event.target.value) })}
            >
              {font.weights.map((weight) => (
                <option value={weight} key={weight}>
                  {weight === font.defaultWeight ? `${weight} 標準` : weight}
                </option>
              ))}
            </select>
          </label>
          <label>
            表示
            <select value={setting.fillMode} onChange={(event) => onChange?.({ fillMode: event.target.value as FontFillMode })}>
              <option value="solid">単色</option>
              <option value="gradient">グラデーション</option>
            </select>
          </label>
          <label>
            色1
            <input
              type="color"
              value={setting.fillMode === "solid" ? setting.fillColor : setting.gradientFrom}
              onChange={(event) =>
                onChange?.(
                  setting.fillMode === "solid"
                    ? { fillColor: event.target.value }
                    : { gradientFrom: event.target.value },
                )
              }
            />
          </label>
          <label>
            色2
            <input
              type="color"
              value={setting.gradientTo}
              disabled={setting.fillMode === "solid"}
              onChange={(event) => onChange?.({ gradientTo: event.target.value })}
            />
          </label>
          <label>
            枠
            <select
              value={setting.strokeEnabled ? "withStroke" : "withoutStroke"}
              onChange={(event) => onChange?.({ strokeEnabled: event.target.value === "withStroke" })}
            >
              <option value="withStroke">あり</option>
              <option value="withoutStroke">なし</option>
            </select>
          </label>
          <label>
            枠色
            <input
              type="color"
              value={setting.outerStrokeColor}
              disabled={!setting.strokeEnabled}
              onChange={(event) => onChange?.({ outerStrokeColor: event.target.value })}
            />
          </label>
          <label>
            文字間 {setting.letterSpacing.toFixed(2)}em
            <input
              type="range"
              min={0}
              max={0.08}
              step={0.01}
              value={setting.letterSpacing}
              onChange={(event) => onChange?.({ letterSpacing: Number(event.target.value) })}
            />
          </label>
          <label>
            行間 {setting.lineHeight.toFixed(2)}
            <input
              type="range"
              min={1}
              max={1.6}
              step={0.05}
              value={setting.lineHeight}
              onChange={(event) => onChange?.({ lineHeight: Number(event.target.value) })}
            />
          </label>
        </div>
      )}
    </div>
  );
}

function StepIcon({ status }: { status: StepStatus }) {
  if (status === "done") return <CheckCircle2 size={17} className="stepIcon done" />;
  if (status === "running") return <Loader2 size={17} className="stepIcon running" />;
  if (status === "error") return <Circle size={17} className="stepIcon error" />;
  return <Circle size={17} className="stepIcon pending" />;
}

function findingLabel(type: string) {
  const labels: Record<string, string> = {
    dictionary: "誤認識候補",
    filler_only: "フィラーのみ",
    duplicate_line: "重複行",
    line_break: "改行候補",
    line_prefix: "欠落候補",
    page_boundary: "境界候補",
    number_check: "数字確認",
    proper_noun_check: "固有名詞確認",
    filler_check: "相槌確認",
    number: "数字差分",
    proper_noun: "固有名詞差分",
    filler: "相槌差分",
    notation: "表記差分",
    density: "密度",
    missing_generated: "生成なし",
    text_mismatch: "本文差分",
    ai_review: "AI候補",
  };
  return labels[type] || type;
}

function findingSourceLabel(finding: TelopFinding) {
  if (finding.id.startsWith("ollama_")) return "ローカルAI";
  if (finding.id.startsWith("user_rule_")) return "学習辞書";
  if (finding.id.startsWith("review_check_")) return "保存済み確認ルール";
  if (["line_break", "line_prefix", "page_boundary", "duplicate_line", "filler_only"].includes(finding.type)) {
    return "境界/改行ルール";
  }
  if (finding.type === "dictionary") return "辞書";
  return "レビュー";
}

function normalizeForAiComparison(value: string) {
  return value
    .normalize("NFKC")
    .replace(/ライン/g, "LINE")
    .toLowerCase()
    .replace(/[。、！？!?,.・\s]/g, "");
}

function isSafeAiSuggestion(type: string, source: string, suggestion: string) {
  if (!source || !suggestion) return false;
  const before = normalizeForAiComparison(source);
  const after = normalizeForAiComparison(suggestion);
  if (!before || !after) return false;
  if (before === after) return true;
  if (type === "page_boundary") return true;
  return type === "dictionary" && before === after;
}

function parseTelopText(text: string): { preamble: string[]; pages: TelopPage[] } {
  const preamble: string[] = [];
  const pages: TelopPage[] = [];
  let current: TelopPage | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const match = raw.trim().match(/^#\s*(cut_\d+_p\d+)\b/);
    if (match) {
      if (current) pages.push(current);
      current = { id: match[1], header: raw, body: [] };
      continue;
    }
    if (current) {
      current.body.push(raw);
    } else {
      preamble.push(raw);
    }
  }

  if (current) pages.push(current);
  return { preamble, pages };
}

function renderTelopText(preamble: string[], pages: TelopPage[]): string {
  const lines = [...preamble];
  if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");

  for (const page of pages) {
    lines.push(page.header);
    lines.push(...page.body);
    if (lines[lines.length - 1] !== "") lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function visibleLines(page: TelopPage | undefined): string[] {
  if (!page) return [];
  return page.body.filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
}

function transformPageBody(text: string, pageId: string, transform: (body: string[]) => string[]) {
  const parsed = parseTelopText(text);
  const pages = parsed.pages.map((page) =>
    page.id === pageId ? { ...page, body: transform(page.body) } : page,
  );
  return renderTelopText(parsed.preamble, pages);
}

function setPageBodyText(text: string, pageId: string, bodyText: string) {
  const nextLines = bodyText.split(/\r?\n/);
  return transformPageBody(text, pageId, () => (nextLines.length > 0 ? nextLines : [""]));
}

function parseTimeToMs(value: string) {
  const match = value.match(/^(\d+):(\d{2})\.(\d{2})$/);
  if (!match) return 0;
  return (Number(match[1]) * 60 + Number(match[2])) * 1000 + Number(match[3]) * 10;
}

function formatMsClock(ms: number) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function parseHeaderTimeRange(header: string): { startMs: number; endMs: number } | null {
  const match = header.match(/\[(\d+:\d{2}\.\d{2})-(\d+:\d{2}\.\d{2})\]/);
  if (!match) return null;
  return { startMs: parseTimeToMs(match[1]), endMs: parseTimeToMs(match[2]) };
}

function headerEndTime(header: string) {
  return header.match(/\[\d+:\d{2}\.\d{2}-(\d+:\d{2}\.\d{2})\]/)?.[1] || "";
}

function replaceHeaderEndTime(header: string, nextEnd: string) {
  if (!nextEnd) return header;
  return header.replace(/(\[\d+:\d{2}\.\d{2}-)(\d+:\d{2}\.\d{2})(\])/, `$1${nextEnd}$3`);
}

function pageBodyLines(page: TelopPage | undefined) {
  return visibleLines(page);
}

function removeTelopPage(text: string, pageId: string) {
  const parsed = parseTelopText(text);
  return renderTelopText(
    parsed.preamble,
    parsed.pages.filter((page) => page.id !== pageId),
  );
}

function replaceInBody(body: string[], source: string, target: string) {
  const joined = body.join("\n");
  if (joined.includes(source)) {
    return joined.replace(source, target).split("\n");
  }
  return body.map((line) => line.replace(source, target));
}

const reviewNumberExpressionPattern =
  /(?:\d[\d,]*(?:\.\d+)?|[〇零一二三四五六七八九十百千万億兆]+)(?:年|月|日|時|分|秒|時間|週間|ヶ月|か月|カ月|人|名|回|件|円|万円|億円|点|割|倍|%|パーセント|ページ|本|個|校|社|歳)?/g;
const reviewProperNounPattern = /[A-Za-z][A-Za-z0-9+.#_-]{1,}|[ァ-ヴー]{3,}/g;
const reviewBackchannelPattern = /(はいはい|はい|うんうん|うん|えー|えっと|あの|まあ|なんか|そうですね)/g;

function collectUniqueMatches(text: string, pattern: RegExp) {
  const matches = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    const value = match[0]?.trim();
    if (value) matches.add(value);
  }
  return Array.from(matches);
}

function buildUserRuleFindings(pages: TelopPage[], rules: UserRules | null): TelopFinding[] {
  if (!rules) return [];
  const findings: TelopFinding[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    const pageText = visibleLines(page).join("\n");
    for (const rule of rules.dictionary || []) {
      const wrong = String(rule.wrong || "").trim();
      const correct = String(rule.correct || "").trim();
      if (!wrong || !correct || wrong === correct || !pageText.includes(wrong)) continue;
      const id = `user_rule_${page.id}_${wrong}_${correct}`;
      if (seen.has(id)) continue;
      seen.add(id);
      findings.push({
        id,
        type: "dictionary",
        severity: "medium",
        page_id: page.id,
        line_index: null,
        message:
          rule.category === "proper_noun"
            ? "保存済みの固有名詞ルールです"
            : rule.category === "notation"
              ? "保存済みの表記統一ルールです"
              : "保存済みの誤認識ルールです",
        source: wrong,
        suggestion: correct,
        before: wrong,
        after: correct,
      });
    }
    for (const rule of rules.reviewChecks || []) {
      const checkType = String(rule.checkType || "");
      const specs =
        checkType === "number_expression"
          ? { pattern: reviewNumberExpressionPattern, type: "number_check", message: "保存済みルール: 数字表現は必ず確認してください" }
          : checkType === "proper_noun_like"
            ? { pattern: reviewProperNounPattern, type: "proper_noun_check", message: "保存済みルール: 固有名詞・英字・カタカナ語は確認してください" }
            : checkType === "filler_backchannel"
              ? { pattern: reviewBackchannelPattern, type: "filler_check", message: "保存済みルール: 相槌・フィラー候補です。意味がなければ削除候補にしてください" }
              : null;
      if (!specs) continue;
      for (const source of collectUniqueMatches(pageText, specs.pattern)) {
        const id = `review_check_${checkType}_${page.id}_${source}`;
        if (seen.has(id)) continue;
        seen.add(id);
        findings.push({
          id,
          type: specs.type,
          severity: checkType === "number_expression" || checkType === "proper_noun_like" ? "high" : "medium",
          page_id: page.id,
          line_index: null,
          message: specs.message,
          source,
          suggestion: source,
          before: source,
          after: source,
        });
      }
    }
  }
  return findings;
}

function fontPlanLabel(plan: FontPlan | null) {
  if (!plan || plan.patterns.length === 0) return "未適用";
  return plan.patterns
    .map((pattern) => `${pattern.label}:${pattern.google_font || pattern.profile_label}`)
    .join(" / ");
}

function strokeSummary(stroke?: { color: string; width: number } | null) {
  if (!stroke || stroke.width <= 0) return "なし";
  return `${stroke.width}px ${stroke.color}`;
}

function fillSummary(fill: TelopFill) {
  if (fill.type === "solid") return `単色 ${fill.color || "#FFFFFF"}`;
  return `グラデ ${fill.gradient_from || "#FFFFFF"} から ${fill.gradient_to || "#000000"}`;
}

function telopStyleSummary(style: TelopStyle) {
  return `${fillSummary(style.fill)} / 内枠 ${strokeSummary(style.inner_stroke)} / 外枠 ${strokeSummary(
    style.outer_stroke,
  )} / ${style.font_size || 72}px`;
}

function googleFontByValue(value: string) {
  return googleFontOptions.find((font) => font.value === value) || googleFontOptions[0];
}

function nearestWeightForFont(fontValue: string, requested: number) {
  const font = googleFontByValue(fontValue);
  return font.weights.reduce((best, weight) =>
    Math.abs(weight - requested) < Math.abs(best - requested) ? weight : best,
  font.defaultWeight);
}

function recommendNormalFont(qa: FontQaState) {
  if (qa.mood === "pop") return "Mochiy Pop One";
  if (qa.mood === "impact") return "Reggae One";
  if (qa.mood === "handwritten") return "Klee One";
  if (qa.mood === "serious") return "Shippori Mincho";
  if (qa.mood === "soft") return "M PLUS Rounded 1c";
  return "Zen Kaku Gothic Antique";
}

function sceneSetting(
  scene: FontSceneKey,
  font: string,
  weight: number,
  size: number,
  fillMode: FontFillMode,
  strokeEnabled: boolean,
  letterSpacing = 0.02,
  lineHeight = 1.35,
): FontSceneSetting {
  const palette = scenePalettes[scene];
  return {
    font,
    weight: nearestWeightForFont(font, weight),
    size,
    letterSpacing,
    lineHeight,
    fillMode,
    fillColor: palette.solid,
    gradientFrom: palette.from,
    gradientTo: palette.to,
    strokeEnabled,
    innerStrokeColor: "#FFFFFF",
    outerStrokeColor: palette.stroke,
    innerStrokeWidth: strokeEnabled ? 10 : 0,
    outerStrokeWidth: strokeEnabled ? 18 : 0,
  };
}

function buildSceneSettingsFromQa(qa: FontQaState): Record<FontSceneKey, FontSceneSetting> {
  const baseFont = recommendNormalFont(qa);
  const baseSize = 72;
  const baseWeight = qa.mood === "serious" ? 700 : 900;
  const strokeEnabled = qa.strokeMode === "withStroke";
  return fontSceneOrder.reduce(
    (acc, scene) => ({
      ...acc,
      [scene]: sceneSetting(scene, baseFont, baseWeight, baseSize, qa.fillMode, strokeEnabled, 0.02, 1.35),
    }),
    {} as Record<FontSceneKey, FontSceneSetting>,
  );
}

function activeFontScenes(patternCount: number) {
  return fontSceneOrder.slice(0, Math.max(1, Math.min(fontSceneOrder.length, patternCount)));
}

function settingDirective(scene: FontSceneKey, setting: FontSceneSetting, patternCount: number) {
  const target = patternCount === 1 ? "全テロップ" : telopStyleLabels[scene] || scene;
  return `${target}は、フォント[${setting.font}] 太さ[${setting.weight}] サイズ[${
    setting.size
  }] 文字間[${setting.letterSpacing.toFixed(2)}em] 行間[${setting.lineHeight.toFixed(2)}]。`;
}

function buildFontDirectivesFromScenes(patternCount: number, scenes: Record<FontSceneKey, FontSceneSetting>) {
  const activeScenes = activeFontScenes(patternCount);
  return [
    `使うフォントパターンは${activeScenes.length}つ。`,
    ...activeScenes.map((scene) => settingDirective(scene, scenes[scene], activeScenes.length)),
  ].join("\n");
}

function profileSceneSettings(profile: SavedFontProfile | null | undefined) {
  const fallback = buildSceneSettingsFromQa(defaultFontQa);
  if (!profile) return fallback;
  return fontSceneOrder.reduce(
    (acc, scene) => ({
      ...acc,
      [scene]: { ...fallback[scene], ...(profile.scenes?.[scene] || {}) },
    }),
    {} as Record<FontSceneKey, FontSceneSetting>,
  );
}

function telopStyleFromFontScene(base: TelopStyle, setting: FontSceneSetting): TelopStyle {
  const font = googleFontByValue(setting.font);
  return {
    ...base,
    font_family: font.family,
    font_weight: setting.weight,
    font_size: setting.size,
    letter_spacing: `${setting.letterSpacing.toFixed(2)}em`,
    line_height: setting.lineHeight,
    fill:
      setting.fillMode === "solid"
        ? { type: "solid", color: setting.fillColor }
        : {
            type: "gradient",
            gradient_from: setting.gradientFrom,
            gradient_to: setting.gradientTo,
            gradient_direction: "vertical",
          },
    inner_stroke: setting.strokeEnabled
      ? { color: setting.innerStrokeColor, width: setting.innerStrokeWidth }
      : null,
    outer_stroke: setting.strokeEnabled
      ? { color: setting.outerStrokeColor, width: setting.outerStrokeWidth }
      : null,
    drop_shadow: setting.strokeEnabled ? base.drop_shadow : "drop-shadow(0px 3px 5px rgba(0,0,0,0.35))",
  };
}

function telopStylesFromFontScenes(
  baseStyles: Record<string, TelopStyle>,
  scenes: Record<FontSceneKey, FontSceneSetting>,
) {
  return fontSceneOrder.reduce(
    (acc, scene) => ({
      ...acc,
      [scene]: telopStyleFromFontScene(acc[scene] || acc.default || builtinTelopStyles.default, scenes[scene]),
    }),
    { ...baseStyles },
  );
}

function fontSizeWidthRatio(size: number, frameWidth: number) {
  return Math.round((size / Math.max(frameWidth, 1)) * 100);
}

function selectedFontDirectives(font: GoogleFontOption, weight: number, size: number) {
  return `使うフォントパターンは1つ。\n全テロップは、フォント[${font.value}] 太さ[${weight}] サイズ[${size}]。`;
}

function naturalDirectiveTemplate(patternCount: number, weight: number, size: number) {
  const lines = [
    `使うフォントパターンは${patternCount}つ。`,
    patternCount === 1
      ? `全テロップは、太めで読みやすいゴシック。太さ[${weight}] サイズ[${size}]。`
      : `通常は、太めで読みやすいゴシック。太さ[${weight}] サイズ[${size}]。`,
  ];
  if (patternCount >= 2) {
    lines.push(`強調は、Mochiy Pop One みたいな可愛いポップ体。サイズ[${Math.min(size + 20, 120)}]。`);
  }
  if (patternCount >= 3) {
    lines.push(`注意は、Reggae One っぽいインパクト系。サイズ[${Math.min(size + 8, 110)}]。`);
  }
  if (patternCount >= 4) {
    lines.push(`質問は、M PLUS Rounded 1c の丸ゴ。サイズ[${Math.max(size - 4, 48)}]。`);
  }
  return lines.join("\n");
}

function numericParamFromText(text: string, labels: string[], fallback: number) {
  const normalized = text.replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
  for (const label of labels) {
    const match = normalized.match(new RegExp(`${label}\\s*[\\[:：=]\\s*(\\d{2,3})`, "i"));
    if (match) return Number(match[1]);
  }
  return fallback;
}

function previewFontFromNaturalText(text: string) {
  const normalized = text.toLowerCase();
  const explicit = googleFontOptions.find((font) => {
    const names = [font.value, font.label, ...(font.aliases || [])];
    return names.some((name) => normalized.includes(name.toLowerCase()) || text.includes(`フォント[${name}]`));
  });
  const font =
    explicit ||
    (/かわいい|可愛い|ポップ|ぷっくり/.test(text)
      ? googleFontOptions.find((item) => item.value === "Mochiy Pop One")
      : /手書き|手描き|ゆるい/.test(text)
        ? googleFontOptions.find((item) => item.value === "Klee One")
        : /ドット|ゲーム|ピクセル|レトロ/.test(text)
          ? googleFontOptions.find((item) => item.value === "DotGothic16")
          : /英字|英語|アルファベット|縦長/.test(text)
            ? googleFontOptions.find((item) => item.value === "Bebas Neue")
            : /インパクト|バラエティ|強烈|迫力/.test(text)
              ? googleFontOptions.find((item) => item.value === "Reggae One")
              : text.includes("明朝") || text.includes("重厚")
                ? googleFontOptions.find((item) => item.value === "Shippori Mincho")
                : text.includes("丸")
                  ? googleFontOptions.find((item) => item.value === "M PLUS Rounded 1c")
                  : text.includes("角") || text.includes("強")
                    ? googleFontOptions.find((item) => item.value === "Noto Sans JP")
                    : googleFontOptions[0]) ||
    googleFontOptions[0];

  return {
    font,
    weight: font.weights.includes(numericParamFromText(text, ["太さ", "weight", "font_weight"], font.defaultWeight))
      ? numericParamFromText(text, ["太さ", "weight", "font_weight"], font.defaultWeight)
      : font.defaultWeight,
    size: numericParamFromText(text, ["サイズ", "大きさ", "font_size"], 72),
  };
}

function directiveChunks(text: string) {
  return text
    .split(/\r?\n|(?<=。)|[;；]/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function previewFontForStyle(text: string, styleName: string) {
  const chunks = directiveChunks(text);
  const joined = chunks.join("\n");
  const isSinglePattern =
    /(?:1|１|一)\s*(?:つ|個|種類|パターン)/.test(joined) ||
    /(全テロップ|全体|全部|すべて|同じフォント|統一)/.test(joined);
  if (isSinglePattern) return previewFontFromNaturalText(joined);

  const keywords: Record<string, string[]> = {
    default: ["通常", "標準", "基本", "default"],
    highlight: ["強調", "重要", "結論", "highlight"],
    calm: ["落ち着", "説明", "calm"],
    warning: ["注意", "警告", "warning"],
    question: ["質問", "問い", "question"],
    simple: ["補足", "シンプル", "simple"],
  };
  const matched = chunks.find((line) => (keywords[styleName] || [styleName]).some((keyword) => line.includes(keyword)));
  return previewFontFromNaturalText(matched || joined);
}

export function App() {
  const electronReady = typeof window !== "undefined" && !!window.catcut;

  const [settings, setSettings] = useState<Settings | null>(null);
  const [apiKeysStatus, setApiKeysStatus] = useState<Awaited<ReturnType<typeof window.catcut.getApiKeysStatus>> | null>(null);
  const [apiWizardOpen, setApiWizardOpen] = useState(false);
  const [apiWizardRequired, setApiWizardRequired] = useState(false);
  const [videoPath, setVideoPath] = useState("");
  const [steps, setSteps] = useState<Step[]>(initialSteps);
  const [logs, setLogs] = useState("");
  const [running, setRunning] = useState(false);
  const [runName, setRunName] = useState("");
  const [runDir, setRunDir] = useState("");
  const [exportProgress, setExportProgress] = useState(0);
  const [outputs, setOutputs] = useState<CatCutOutputs | null>(null);
  const [reviewState, setReviewState] = useState<ReviewState | null>(null);
  const [reviewStage, setReviewStage] = useState<"transcript" | "telop">("transcript");
  const [transcriptState, setTranscriptState] = useState<TranscriptState | null>(null);
  const [transcriptApplying, setTranscriptApplying] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [transcriptSeekMs, setTranscriptSeekMs] = useState<number | null>(null);
  const [activeTranscriptWordId, setActiveTranscriptWordId] = useState<string | null>(null);
  const [telopText, setTelopText] = useState("");
  const [fontDirectives, setFontDirectives] = useState("");
  const [fontMode, setFontMode] = useState<FontMode>("natural");
  const [naturalPatternCount, setNaturalPatternCount] = useState(3);
  const [naturalWeight, setNaturalWeight] = useState(900);
  const [naturalSize, setNaturalSize] = useState(72);
  const [selectedGoogleFont, setSelectedGoogleFont] = useState("Zen Kaku Gothic Antique");
  const [selectedFontWeight, setSelectedFontWeight] = useState(900);
  const [selectedFontSize, setSelectedFontSize] = useState(72);
  const [fontApplyConfirmed, setFontApplyConfirmed] = useState(false);
  const [fontApplying, setFontApplying] = useState(false);
  const [fontProfiles, setFontProfiles] = useState<SavedFontProfile[]>([]);
  const [fontQa, setFontQa] = useState<FontQaState>(defaultFontQa);
  const [builderPatternCount, setBuilderPatternCount] = useState(4);
  const [builderProfileName, setBuilderProfileName] = useState("字幕フォント設定");
  const [builderScenes, setBuilderScenes] = useState<Record<FontSceneKey, FontSceneSetting>>(
    buildSceneSettingsFromQa(defaultFontQa),
  );
  const [fontProfileSaving, setFontProfileSaving] = useState(false);
  const [telopStyleMode, setTelopStyleMode] = useState<TelopStyleMode>("natural");
  const [telopStyleDirectives, setTelopStyleDirectives] = useState(defaultTelopStyleDirectives);
  const [telopStyles, setTelopStyles] = useState<Record<string, TelopStyle>>(normalizeTelopStyles(null));
  const [editingTelopStyle, setEditingTelopStyle] = useState("default");
  const [telopStyleApplyConfirmed, setTelopStyleApplyConfirmed] = useState(false);
  const [telopStyleApplying, setTelopStyleApplying] = useState(false);
  const [telopConfirmed, setTelopConfirmed] = useState(false);
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null);
  const [ollamaChecking, setOllamaChecking] = useState(false);
  const [ollamaPulling, setOllamaPulling] = useState(false);
  const [ollamaReviewing, setOllamaReviewing] = useState(false);
  const [ollamaMessage, setOllamaMessage] = useState("");
  const [userRules, setUserRules] = useState<UserRules | null>(null);
  const [ruleDraft, setRuleDraft] = useState({ wrong: "", correct: "", category: "common_misrecognition" as DictionaryRule["category"] });
  const [rulesSaving, setRulesSaving] = useState(false);
  const [groundTruth, setGroundTruth] = useState<GroundTruthResult | null>(null);
  const [groundTruthApplying, setGroundTruthApplying] = useState(false);
  const [groundTruthMessage, setGroundTruthMessage] = useState("");
  const [learningReport, setLearningReport] = useState<LearningReport | null>(null);
  const [ruleLabReport, setRuleLabReport] = useState<GroundTruthRuleReport | null>(null);
  const [ruleLabAnalyzing, setRuleLabAnalyzing] = useState(false);
  const [ruleLabFilter, setRuleLabFilter] = useState("all");
  const [ruleProposalSaving, setRuleProposalSaving] = useState<Record<string, boolean>>({});
  const [replacementDrafts, setReplacementDrafts] = useState<Record<string, string>>({});
  const [reviewedFindings, setReviewedFindings] = useState<Record<string, "accepted" | "ignored">>({});
  const [activePageId, setActivePageId] = useState("");
  const [error, setError] = useState("");
  const [resolvedSuspicionIds, setResolvedSuspicionIds] = useState<Record<string, boolean>>({});
  const [activeSuspicionId, setActiveSuspicionId] = useState<string | null>(null);
  const [flashWordId, setFlashWordId] = useState<string | null>(null);
  const [editRequestWordId, setEditRequestWordId] = useState<string | null>(null);
  const [followAlongMode, setFollowAlongMode] = useState(false);
  const [playbackRate, setPlaybackRate] = useState<PlaybackRate>(DEFAULT_NORMAL_RATE);
  const [maxReachedMs, setMaxReachedMs] = useState(0);
  const [waveform, setWaveform] = useState<WaveformResult | null>(null);
  const [waveformLoading, setWaveformLoading] = useState(false);
  const [waveformError, setWaveformError] = useState("");
  // 改善2(波形の縦スケール改善): 録音全体のグローバルピークをwaveform読み込み時に1回だけ計算し、
  // 各シーン行のミニ波形(SceneWaveformStrip)へpropsで配る。行ごとに毎回計算し直さないための最適化。
  const globalPeakMax = useMemo(() => computePeakMax(waveform?.peaks || []), [waveform]);
  const [selectedBoundary, setSelectedBoundary] = useState<SelectedBoundary | null>(null);
  const [focusCutCardSegmentIndex, setFocusCutCardSegmentIndex] = useState<number | null>(null);
  // --- 検品UI v2(シーン行UI, Phase 1) ---
  const [sceneFilter, setSceneFilter] = useState<"all" | "flagged">("all");
  const [previewCurrentMs, setPreviewCurrentMs] = useState(0);
  const [sceneApplying, setSceneApplying] = useState(false);
  // --- テロップ統合1画面化「テーマ×感情の自動スタイリング」(T-1〜T-5) ---
  // 選択テーマはユーザー既定として設定(settings.telopTheme)に永続化する(T-1)。
  const [telopThemeId, setTelopThemeIdState] = useState<TelopThemeId>(DEFAULT_THEME_ID);
  // 改善7-4(プリセットギャラリー約100種): テーマ選択はギャラリーモーダルで行う。
  const [themeGalleryOpen, setThemeGalleryOpen] = useState(false);
  const [inspectionCopyToast, setInspectionCopyToast] = useState<string | null>(null);
  // 改善7-3(保存済みフォントプロファイルをテーマの正に): userData/font_profiles.jsonの
  // 中からpickPrimaryFontProfile()で採用した1件("保存済み: <name>"のラベル表示・スタイル変換元)。
  // プロファイルが無ければnull。
  const [primaryFontProfile, setPrimaryFontProfile] = useState<FontProfile | null>(null);
  // --- 検品UI v2(シーン行UI, Phase 2: キーボード操作体系) ---
  // 改善5-6(ハサミモード): 旧「B=行の余白もスクラブ」は廃止し、Bはハサミモードのトグルになった。
  // ONの間は波形・チップ列のクリックが即分割になる(右クリック切り込みメニューは廃止)。
  const [scissorsMode, setScissorsMode] = useState(false);
  // 改善5-1(ホバー自動スクロールの抑制): <video>が実際に再生中かどうか(play/pauseイベント由来)。
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  // 改善5-2(チップのドラッグ複数選択): 選択は同時に1シーンのみ(他行をドラッグしたら切り替わる)。
  const [chipSelection, setChipSelection] = useState<ChipSelectionState | null>(null);
  // 改善5-9(ホバー行からSpace再生): マウスが乗っている行のsceneId。頻繁に更新されるためref。
  const hoveredSceneIdRef = useRef<string | null>(null);
  // 改善5-7(一括置換ポップアップ): テロップ枠フォーカス時点のテキストをsceneIdごとに保持し、
  // blur時にこれと比較して単語置換(A→B)を検出する。
  const telopFocusTextRef = useRef<Map<string, string>>(new Map());
  const [telopReplaceCandidate, setTelopReplaceCandidate] = useState<TelopReplaceCandidate | null>(null);
  const [telopReplaceSelectedKeys, setTelopReplaceSelectedKeys] = useState<Set<string>>(() => new Set());
  const [telopReplaceDictChecked, setTelopReplaceDictChecked] = useState(false);
  const [userDictionaryOpen, setUserDictionaryOpen] = useState(false);
  // フェーズT2.5-4: シーン種類→プリセットのマッピング(既定+userDataのユーザー設定)と設定ビュー開閉。
  const [telopTypeMapping, setTelopTypeMapping] = useState<TelopTypeMapping>(DEFAULT_TYPE_MAPPING);
  const [telopTypeMappingOpen, setTelopTypeMappingOpen] = useState(false);
  const isEditingSceneTelopRef = useRef(false);
  const scenePlayStopAtMsRef = useRef<number | null>(null);
  const scenesInitializedRunDirRef = useRef<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewPlayerRef = useRef<PreviewPlayerHandle>(null);
  const loadedSavedFontProfileIdRef = useRef("");

  const transcriptWords = transcriptState?.words || [];
  const transcriptFillerWordIdSet = useMemo(
    () => new Set(transcriptState?.fillerWordIds || []),
    [transcriptState?.fillerWordIds],
  );
  const keepSegmentsHistory = useKeepSegments({
    words: transcriptWords.map((word) => ({
      id: word.id,
      text: word.text,
      startMs: word.startMs,
      endMs: word.endMs,
    })),
    initialKeepSegments: transcriptState?.keepSegments || [],
    recomputeOptions: {
      maxGapMs: transcriptState?.maxGapMs || 600,
      segmentPaddingMs: transcriptState?.segmentPaddingMs || 50,
      originalDurationMs: transcriptState?.originalDurationMs || 0,
    },
  });
  // Phase B (B-4): 単語テキスト修正はkeepSegmentsHistory（Undo/Redoスタック）に統合済み。
  const pendingWordCorrections = keepSegmentsHistory.wordCorrections;
  const wordCorrectionHistory = keepSegmentsHistory.correctionOriginals;
  // 検品UI v2(シーン行UI): scenes配列を唯一の編集源として管理する(Phase 1)。
  const scenesHistory = useScenes([]);

  /** T-1: テーマ切替は全シーン一括反映・プレビュー即反映。ユーザー既定として設定に永続化する。 */
  function handleTelopThemeChange(nextThemeId: TelopThemeId) {
    setTelopThemeIdState(nextThemeId);
    if (electronReady) {
      window.catcut.saveSettings({ telopTheme: nextThemeId }).then(setSettings).catch(() => {});
    }
  }

  /** 改善9-B-3: 保存済みフォントプロファイルを削除し、選択中なら既定テーマへフォールバック。 */
  async function handleDeleteSavedTheme() {
    const profileId = primaryFontProfile?.id;
    if (!profileId) return;
    try {
      const profiles = await deleteStoredFontProfile(profileId);
      setFontProfiles(profiles);
      clearRuntimeTheme(SAVED_THEME_ID);
      const nextPrimary = pickPrimaryFontProfile(profiles);
      setPrimaryFontProfile(nextPrimary);
      if (nextPrimary) {
        setRuntimeTheme(SAVED_THEME_ID, mapFontProfileToEmotionStyles(nextPrimary));
      }
      if (telopThemeId === SAVED_THEME_ID && !nextPrimary) {
        handleTelopThemeChange(DEFAULT_THEME_ID);
      }
      if (settings?.selectedFontProfileId === profileId) {
        const nextSelectedId = nextPrimary?.id || "";
        saveCurrentSettings({ selectedFontProfileId: nextSelectedId, fontProfileMode: nextPrimary ? "saved" : "new" });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /** 改善9-B-1: 全シーンの検品テキストをクリップボードへコピー。 */
  async function handleCopyInspectionText() {
    const text = buildInspectionCopyText({
      runName: runName || runDir?.split(/[\\/]/).pop() || "未命名",
      scenes: scenesHistory.scenes,
      suspicionsBySceneId: sceneSuspicionsBySceneId,
    });
    try {
      await navigator.clipboard.writeText(text);
      setInspectionCopyToast("検品テキストをコピーしました");
    } catch {
      setInspectionCopyToast("コピーに失敗しました");
    }
  }

  useEffect(() => {
    if (!inspectionCopyToast) return undefined;
    const timer = window.setTimeout(() => setInspectionCopyToast(null), 2200);
    return () => window.clearTimeout(timer);
  }, [inspectionCopyToast]);
  // Phase 3: 行端の長押しスライド。ドラッグ中は確定コミット(Undoスタック)せず、
  // ここに生のポインタ位置(rawTargetMs)だけを保持し、表示用のプレビューをapplyEdgeTrimで都度導出する。
  const [edgeDrag, setEdgeDrag] = useState<{
    sceneId: string;
    edge: EdgeTrimEdge;
    rawTargetMs: number;
    chipSnapToleranceMs: number;
  } | null>(null);

  useEffect(() => {
    if (!electronReady) return;
    // 改善8-B-1(プリセット駆動テーマへ全面切替): 起動時に一度だけ`templates/telop_presets.yaml`を
    // IPC経由で読み込み、telopThemes.tsのカタログへ登録する。読み込み失敗時はFALLBACK_CATALOG
    // (telopThemes.ts内蔵の既存6プリセット)のまま動作する。
    if (typeof window.catcut.getTelopPresets === "function") {
      window.catcut
        .getTelopPresets()
        .then((presets) => {
          if (presets && Object.keys(presets).length) registerPresetCatalog(presets);
        })
        .catch(() => {});
    }
    // フェーズT2.5-4: シーン種類→プリセットの解決済みマッピング(既定YAML+userData)を読み込む。
    if (typeof window.catcut.getTelopTypeMapping === "function") {
      window.catcut
        .getTelopTypeMapping()
        .then((mapping) => setTelopTypeMapping(sanitizeTypeMapping(mapping)))
        .catch(() => {});
    }
  }, [electronReady]);

  useEffect(() => {
    if (!electronReady) return;
    // 改善7-3(保存済みフォントプロファイルをテーマの正に): settingsとfont_profiles.jsonの
    // 両方が揃ってから既定テーマを確定する(片方だけ先に届くとテーマの移行判定を誤るため)。
    // listStoredFontProfilesはFEATURES.fontDirectivesUi(旧テロップスタイル編集パネル)の
    // 表示有無に関わらず常に呼ぶ(このタスクはそのフラグと無関係に動作する必要があるため)。
    Promise.all([window.catcut.getSettings(), listStoredFontProfiles(), window.catcut.getApiKeysStatus()]).then(
      ([loaded, profiles, keysStatus]) => {
      setSettings(loaded);
      setApiKeysStatus(keysStatus);
      if (!keysStatus.elevenlabs.configured) {
        setApiWizardRequired(true);
        setApiWizardOpen(true);
      }
      setFontProfiles(profiles);
      const primary = pickPrimaryFontProfile(profiles);
      setPrimaryFontProfile(primary);
      const storedTheme = loaded.telopTheme;
      const isKnownTheme = storedTheme === SAVED_THEME_ID || THEME_IDS.includes(storedTheme);
      // 移行ヒューリスティック: ユーザーが一度もテーマを明示選択していない(=旧既定"simple"のまま)
      // 場合は、保存済みプロファイルがあればそれを新しい既定にする。"pop"/"business"や生成テーマなど
      // 明示的に選んだとみなせる値はそのまま尊重する。
      if (primary && storedTheme === "simple") {
        setTelopThemeIdState(SAVED_THEME_ID);
      } else if (isKnownTheme) {
        setTelopThemeIdState(storedTheme);
      } else if (primary) {
        setTelopThemeIdState(SAVED_THEME_ID);
      }
    });
    if (FEATURES.ollama) {
      window.catcut.getOllamaStatus().then(setOllamaStatus).catch(() => {
        setOllamaStatus(null);
      });
    }
    window.catcut.getUserRules().then(setUserRules).catch(() => {
      setUserRules(null);
    });
    return window.catcut.onJobEvent((event) => {
      if (event.type === "job:start") {
        setRunning(true);
        setRunName(event.runName);
        setRunDir(event.runDir);
        setOutputs(null);
        setReviewState(null);
        setTranscriptState(null);
        setReviewStage("transcript");
        setTelopText("");
        setFontDirectives("");
        setFontApplyConfirmed(false);
        setFontApplying(false);
        setTelopStyleDirectives(defaultTelopStyleDirectives);
        setTelopStyles(normalizeTelopStyles(null));
        setEditingTelopStyle("default");
        setTelopStyleApplyConfirmed(false);
        setTelopStyleApplying(false);
        setTelopConfirmed(false);
        setReplacementDrafts({});
        setReviewedFindings({});
        setActivePageId("");
        setLearningReport(null);
        setRuleLabReport(null);
        setRuleLabFilter("all");
        setRuleProposalSaving({});
        setError("");
        setExportProgress(0);
        setSteps(event.steps.map((step) => ({ ...step, status: "pending" as StepStatus })));
      }
      if (event.type === "export:start") {
        setRunning(true);
        setRunDir(event.runDir);
        setError("");
        setExportProgress(0);
      }
      if (event.type === "step:start") {
        setSteps((current) => updateStep(current, event.stepId, "running"));
      }
      if (event.type === "step:done") {
        setSteps((current) => updateStep(current, event.stepId, "done"));
      }
      if (event.type === "step:error") {
        setSteps((current) => updateStep(current, event.stepId, "error"));
      }
      if (event.type === "log") {
        setLogs((current) => `${current}${event.message}`);
      }
      if (event.type === "ollama:pull:progress") {
        setOllamaMessage(event.message.trim() || "モデルをダウンロード中です");
      }
      if (event.type === "export:progress") {
        setExportProgress(event.percent);
      }
      if (event.type === "learning:done") {
        setLearningReport(event.report);
        setGroundTruthMessage(
          `学習完了: 開始補正 ${event.report.appliedRules.timing.telopStartOffsetMs}ms / ` +
            `VAD強度 ${event.report.appliedRules.timing.wordVadClampStrength} / ` +
            `1行 ${event.report.appliedRules.telop.maxCharsPerLine}字 / ` +
            `${event.report.learnedRulesPath}`,
        );
      }
      if (event.type === "review:ready") {
        const nextStyles = normalizeTelopStyles(event.telopStyles);
        const nextDefaultStyle = event.defaultTelopStyle || "default";
        setRunning(false);
        setRunDir(event.runDir);
        setReviewStage("transcript");
        setReviewState({
          outputs: event.outputs,
          review: event.review,
          renderFinal: event.renderFinal,
          fontPlan: event.fontPlan,
          telopStyleDirectivesText: event.telopStyleDirectivesText,
          telopStylePlan: event.telopStylePlan,
          telopStyles: event.telopStyles,
          defaultTelopStyle: event.defaultTelopStyle,
          previewPages: event.previewPages,
        });
        setTelopText(autoAssignTelopStyles(event.telopText, nextStyles, nextDefaultStyle));
        setFontDirectives(event.fontDirectivesText);
        setTelopStyleDirectives(event.telopStyleDirectivesText || defaultTelopStyleDirectives);
        setTelopStyles(nextStyles);
        setEditingTelopStyle(Object.keys(nextStyles)[0] || "default");
        setFontApplyConfirmed(false);
        setTelopStyleApplyConfirmed(false);
        setTelopStyleApplying(false);
        setTelopConfirmed(false);
        setReplacementDrafts({});
        setReviewedFindings({});
        setActivePageId(event.review?.findings?.[0]?.page_id || "");
        window.catcut
          .loadTranscriptEditor(event.runDir)
          .then((transcript) => {
            setTranscriptState(transcript);
            setActiveTranscriptWordId(transcript.words[0]?.id || null);
          })
          .catch(() => {
            setTranscriptState(null);
          });
      }
      if (event.type === "job:done") {
        setRunning(false);
        setReviewState(null);
        setTranscriptState(null);
        setOutputs(event.outputs);
        setExportProgress(100);
      }
      if (event.type === "job:error") {
        setRunning(false);
        setError(event.error);
      }
      if (event.type === "job:cancelled") {
        setRunning(false);
      }
    });
  }, [electronReady]);

  // 改善8-B-5(保存済みフォントプロファイル): "saved"テーマはプロファイルのscene.sizeを
  // 絶対font_sizeとしてそのまま使う(fontProfileTheme.tsのコメント参照)ため、動画(telopFontSize)
  // に依存せずプロファイルが変わるたびに登録し直すだけでよい。
  useEffect(() => {
    if (!primaryFontProfile) {
      clearRuntimeTheme(SAVED_THEME_ID);
      return;
    }
    setRuntimeTheme(SAVED_THEME_ID, mapFontProfileToEmotionStyles(primaryFontProfile));
  }, [primaryFontProfile]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs]);

  const suspiciousFindings = useMemo(() => {
    const findings = reviewState?.review?.findings || [];
    const base = findings.filter((item) =>
      [
        "dictionary",
        "filler_only",
        "duplicate_line",
        "line_break",
        "line_prefix",
        "page_boundary",
        "number_check",
        "proper_noun_check",
        "filler_check",
        "ai_review",
      ].includes(item.type),
    );
    const learned = buildUserRuleFindings(parseTelopText(telopText).pages, userRules);
    const existingKeys = new Set(base.map((finding) => `${finding.page_id}:${finding.source}:${finding.suggestion}`));
    return [
      ...base,
      ...learned.filter((finding) => !existingKeys.has(`${finding.page_id}:${finding.source}:${finding.suggestion}`)),
    ];
  }, [reviewState, telopText, userRules]);

  const telopPages = useMemo(() => parseTelopText(telopText).pages, [telopText]);
  const activePage = useMemo(
    () => telopPages.find((page) => page.id === activePageId) || telopPages[0],
    [activePageId, telopPages],
  );
  const activePageIndex = useMemo(
    () => Math.max(0, telopPages.findIndex((page) => page.id === activePage?.id)),
    [activePage?.id, telopPages],
  );
  const previousPage = activePageIndex > 0 ? telopPages[activePageIndex - 1] : undefined;
  const nextPage = activePageIndex >= 0 && activePageIndex < telopPages.length - 1 ? telopPages[activePageIndex + 1] : undefined;
  const activePageLines = useMemo(() => visibleLines(activePage), [activePage]);
  const activePageBodyText = useMemo(() => activePageLines.join("\n"), [activePageLines]);
  const firstTelopLines = useMemo(() => visibleLines(telopPages[0]), [telopPages]);
  const fontPreviewLines = firstTelopLines.length > 0 ? firstTelopLines : ["テロッププレビュー"];
  const previewPages = useMemo(() => {
    const fallback = reviewState?.previewPages[0];
    if (!fallback) return [];
    return telopPages.map((page) => {
      const existing = reviewState?.previewPages.find((preview) => preview.pageId === page.id);
      const range = parseHeaderTimeRange(page.header);
      return {
        ...(existing || fallback),
        pageId: page.id,
        cutId: existing?.cutId || fallback.cutId,
        videoUrl: existing?.videoUrl || fallback.videoUrl,
        startMs: range?.startMs ?? existing?.startMs ?? fallback.startMs,
        endMs: range?.endMs ?? existing?.endMs ?? fallback.endMs,
        displayWidth: existing?.displayWidth || fallback.displayWidth,
        displayHeight: existing?.displayHeight || fallback.displayHeight,
      };
    });
  }, [reviewState, telopPages]);
  const activePreview = useMemo(
    () => previewPages.find((page) => page.pageId === activePage?.id),
    [activePage?.id, previewPages],
  );
  const ruleLabRows = useMemo(() => {
    const rows = ruleLabReport?.rows || [];
    if (ruleLabFilter === "all") return rows.slice(0, 18);
    return rows.filter((row) => row.types.includes(ruleLabFilter)).slice(0, 18);
  }, [ruleLabFilter, ruleLabReport]);
  const localAiReady = Boolean(ollamaStatus?.installed && ollamaStatus.running && ollamaStatus.modelInstalled);
  const previewFrameWidth = activePreview?.displayWidth || 1280;
  const selectedFont = useMemo(
    () => googleFontOptions.find((font) => font.value === selectedGoogleFont) || googleFontOptions[0],
    [selectedGoogleFont],
  );
  const naturalPreview = useMemo(() => previewFontFromNaturalText(fontDirectives), [fontDirectives]);
  const fontPreview =
    fontMode === "select"
      ? { font: selectedFont, weight: selectedFontWeight, size: selectedFontSize }
      : naturalPreview;
  const defaultTelopStyleName = reviewState?.defaultTelopStyle || "default";
  const telopStyleNames = useMemo(() => Object.keys(telopStyles), [telopStyles]);
  const activeStyleName = pageStyleName(activePage, defaultTelopStyleName);
  const activeTelopStyle = telopStyles[activeStyleName] || telopStyles[defaultTelopStyleName] || builtinTelopStyles.default;
  const pendingActiveFont =
    fontMode === "select" ? fontPreview : previewFontForStyle(fontDirectives, activeStyleName);
  const activePreviewTelopStyle = useMemo(
    () => ({
      ...activeTelopStyle,
      font_family: pendingActiveFont.font.family,
      font_weight: pendingActiveFont.weight,
    }),
    [activeTelopStyle, pendingActiveFont],
  );
  const editingStyle = telopStyles[editingTelopStyle] || telopStyles.default || builtinTelopStyles.default;
  const selectedFontProfileId = settings?.selectedFontProfileId || fontProfiles[0]?.id || "";
  const selectedSavedFontProfile = useMemo(
    () => fontProfiles.find((profile) => profile.id === selectedFontProfileId) || null,
    [fontProfiles, selectedFontProfileId],
  );
  const fontProfileMode: FontProfileMode =
    settings?.fontProfileMode === "saved" && selectedSavedFontProfile ? "saved" : "new";
  const builderDirectives = useMemo(
    () => buildFontDirectivesFromScenes(builderPatternCount, builderScenes),
    [builderPatternCount, builderScenes],
  );
  const styleAssignmentSummary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const page of telopPages) {
      const name = pageStyleName(page, defaultTelopStyleName);
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([name, count]) => `${telopStyleLabels[name] || name} ${count}ページ`)
      .join(" / ");
  }, [defaultTelopStyleName, telopPages]);
  const transcriptRemovedSummary = useMemo(() => {
    const words = transcriptState?.words || [];
    if (!words.length) {
      return {
        filler: { count: 0, durationMs: 0 },
        silence: { count: 0, durationMs: 0 },
      };
    }
    let fillerCount = 0;
    let fillerDurationMs = 0;
    let silenceCount = 0;
    let silenceDurationMs = 0;
    let previousReason: "filler" | "silence" | null = null;
    for (const word of words) {
      const kept = isWordInKeepSegments(word, keepSegmentsHistory.keepSegments);
      if (kept) {
        previousReason = null;
        continue;
      }
      const reason = keepSegmentsHistory.manualRemovedSet.has(word.id)
        ? "silence"
        : transcriptFillerWordIdSet.has(word.id)
          ? "filler"
          : "silence";
      const duration = Math.max(0, word.endMs - word.startMs);
      if (reason === "filler") {
        fillerDurationMs += duration;
        if (previousReason !== "filler") fillerCount += 1;
      } else {
        silenceDurationMs += duration;
        if (previousReason !== "silence") silenceCount += 1;
      }
      previousReason = reason;
    }
    return {
      filler: { count: fillerCount, durationMs: fillerDurationMs },
      silence: { count: silenceCount, durationMs: silenceDurationMs },
    };
  }, [keepSegmentsHistory.keepSegments, keepSegmentsHistory.manualRemovedSet, transcriptFillerWordIdSet, transcriptState?.words]);

  const displayTranscriptWords = useMemo(() => {
    if (!transcriptState) return [];
    if (!Object.keys(pendingWordCorrections).length) return transcriptState.words;
    return transcriptState.words.map((word) =>
      pendingWordCorrections[word.id] !== undefined ? { ...word, text: pendingWordCorrections[word.id] } : word,
    );
  }, [pendingWordCorrections, transcriptState]);

  const suspicionItems = useMemo<SuspicionItem[]>(() => {
    if (!transcriptState) return [];
    return buildSuspicionQueue({
      words: transcriptState.words,
      keepSegments: keepSegmentsHistory.keepSegments,
      telopFindings: reviewState?.review?.findings || [],
      fillerWordIds: transcriptState.fillerWordIds,
      dictionaryRules: userRules?.dictionary,
      aiReview: transcriptState.aiReview,
      wordSplitFlags: transcriptState.wordSplitFlags,
    });
  }, [keepSegmentsHistory.keepSegments, reviewState, transcriptState, userRules]);

  const resolvedSuspicionIdSet = useMemo(
    () => new Set(Object.keys(resolvedSuspicionIds).filter((id) => resolvedSuspicionIds[id])),
    [resolvedSuspicionIds],
  );

  // 検品UI v2(シーン行UI): runDirが変わったときだけscenesを初期化する。
  // transcriptState自体はapply後にも新しいオブジェクトになるが、runDirが同じ間は
  // scenes(telopEdited等のクライアント側の編集状態・Undo履歴)を保持したいため、
  // ref で「最後に初期化したrunDir」を記憶して再初期化を抑止する。
  useEffect(() => {
    if (!transcriptState) return;
    if (scenesInitializedRunDirRef.current === transcriptState.runDir) return;
    scenesInitializedRunDirRef.current = transcriptState.runDir;
    scenesHistory.reset(
      initializeScenes({
        words: transcriptState.words,
        sentences: transcriptState.sentences,
        keepSegments: transcriptState.keepSegments,
        // 改善8-B-3(シーン初期化=テロップページ): composition.jsonのBudouXページ境界があれば
        // それを優先する(1シーン=1テロップページ)。空配列ならinitializeScenes側で
        // 既存ヒューリスティックにフォールバックする。
        telopPageBoundaries: transcriptState.telopPageBoundaries,
      }),
    );
  }, [scenesHistory, transcriptState]);

  // 疑義キューはscenesから導出したkeep_segments(=単語再計算に頼らない唯一の編集源)を使う。
  const sceneSuspicionItems = useMemo<SuspicionItem[]>(() => {
    if (!transcriptState) return [];
    return buildSuspicionQueue({
      words: transcriptState.words,
      keepSegments: scenesHistory.keepSegments,
      telopFindings: reviewState?.review?.findings || [],
      fillerWordIds: transcriptState.fillerWordIds,
      dictionaryRules: userRules?.dictionary,
      aiReview: transcriptState.aiReview,
      wordSplitFlags: transcriptState.wordSplitFlags,
    });
  }, [reviewState, scenesHistory.keepSegments, transcriptState, userRules]);

  // フェーズT2: directedモード(演出ディレクティブ駆動)かどうか。スタイルバッジ表示と
  // 編集適用経路(telop_directives.jsonへの書き戻し)の切替に使う。
  const isDirectedTelopMode = transcriptState?.telopMode === "directed";

  const aiReviewBanner = useMemo(
    () => (transcriptState ? buildAiReviewBanner(transcriptState.aiReview || {}) : null),
    [transcriptState],
  );
  const sceneAiUsageSummary = useMemo(
    () =>
      transcriptState
        ? formatAiUsageSummary(
            transcriptState.aiReview?.transcriptUsage,
            transcriptState.aiReview?.telopUsage,
          )
        : null,
    [transcriptState],
  );

  const sceneSuspicionsBySceneId = useMemo(
    () => attachSuspicionsToScenes(scenesHistory.scenes, sceneSuspicionItems),
    [scenesHistory.scenes, sceneSuspicionItems],
  );

  const flaggedScenes = useMemo(
    () => scenesHistory.scenes.filter((scene) => (sceneSuspicionsBySceneId.get(scene.id)?.length ?? 0) > 0),
    [scenesHistory.scenes, sceneSuspicionsBySceneId],
  );

  const displayedScenes = sceneFilter === "flagged" ? flaggedScenes : scenesHistory.scenes;

  // --- Phase 3: 行端の長押しスライド(連動ロール／独立トリム) ---
  // ドラッグ中はscenesHistory.scenes(Undoスタック)を一切書き換えず、生のポインタ位置(rawTargetMs)
  // だけをstateに保持する。表示用のプレビューはapplyEdgeTrimを都度呼んで導出することで、
  // 「見た目のプレビュー」と「ポインタを離した瞬間に確定する結果」を常に一致させる(WYSIWYG)。
  const edgeDragSceneIndex = edgeDrag
    ? scenesHistory.scenes.findIndex((scene) => scene.id === edgeDrag.sceneId)
    : -1;
  const edgeTrimPreview = useMemo(() => {
    if (!edgeDrag || edgeDragSceneIndex === -1) return null;
    return applyEdgeTrim(scenesHistory.scenes, edgeDragSceneIndex, edgeDrag.edge, edgeDrag.rawTargetMs, {
      minDurationMs: MIN_SCENE_DURATION_MS,
      chipSnapToleranceMs: edgeDrag.chipSnapToleranceMs,
      sourceDurationMs: transcriptState?.originalDurationMs,
    });
  }, [edgeDrag, edgeDragSceneIndex, scenesHistory.scenes, transcriptState?.originalDurationMs]);

  // ドラッグ中は該当行(連動時は隣接行も)だけプレビュー内容に差し替えて描画する。
  const renderedScenes = useMemo(() => {
    if (!edgeTrimPreview) return displayedScenes;
    const previewById = new Map(edgeTrimPreview.scenes.map((scene) => [scene.id, scene]));
    return displayedScenes.map((scene) => previewById.get(scene.id) || scene);
  }, [displayedScenes, edgeTrimPreview]);

  // 行端の見た目状態(連動アイコン・ドラッグ中ツールチップ・隣接行ハイライト)。
  const edgeVisualBySceneId = useMemo(() => {
    const map = new Map<string, SceneEdgeVisual>();
    const scenes = scenesHistory.scenes;
    scenes.forEach((scene, index) => {
      map.set(scene.id, { linkedNext: isEdgeLinked(scenes, index, "end") });
    });
    if (edgeDrag && edgeTrimPreview && edgeDragSceneIndex !== -1) {
      const draggedScene = scenes[edgeDragSceneIndex];
      const originalMs = edgeDrag.edge === "end" ? draggedScene.sourceEndMs : draggedScene.sourceStartMs;
      const label = formatEdgeTrimDelta(edgeTrimPreview.appliedMs - originalMs);
      const draggedVisual = map.get(edgeDrag.sceneId);
      if (draggedVisual) draggedVisual.dragTooltip = { edge: edgeDrag.edge, label };
      if (edgeTrimPreview.linked && edgeTrimPreview.neighborIndex != null) {
        const neighborScene = scenes[edgeTrimPreview.neighborIndex];
        const neighborVisual = neighborScene ? map.get(neighborScene.id) : undefined;
        if (neighborVisual) neighborVisual.highlightEdge = edgeDrag.edge === "end" ? "start" : "end";
      }
    }
    return map;
  }, [scenesHistory.scenes, edgeDrag, edgeTrimPreview, edgeDragSceneIndex]);

  // ドラッグ中はプレビュー先の境界位置へ動画をシークして追従させる(仕様書「ドラッグ中のフィードバック」節)。
  useEffect(() => {
    if (!edgeTrimPreview) return;
    previewPlayerRef.current?.seekTo(edgeTrimPreview.appliedMs);
  }, [edgeTrimPreview]);

  function handleSceneEdgeDragMove(
    sceneId: string,
    edge: EdgeTrimEdge,
    rawTargetMs: number,
    chipSnapToleranceMs: number,
  ) {
    setEdgeDrag({ sceneId, edge, rawTargetMs, chipSnapToleranceMs });
  }

  function handleSceneEdgeDragEnd(
    sceneId: string,
    edge: EdgeTrimEdge,
    rawTargetMs: number,
    chipSnapToleranceMs: number,
  ) {
    scenesHistory.applyEdgeTrimAt(sceneId, edge, rawTargetMs, {
      minDurationMs: MIN_SCENE_DURATION_MS,
      chipSnapToleranceMs,
      sourceDurationMs: transcriptState?.originalDurationMs,
    });
    setEdgeDrag(null);
  }

  const currentSceneId = useMemo(() => {
    const index = findSceneIndexAtMs(scenesHistory.scenes, previewCurrentMs);
    return index >= 0 ? scenesHistory.scenes[index].id : null;
  }, [previewCurrentMs, scenesHistory.scenes]);

  const currentScene = useMemo(
    () => scenesHistory.scenes.find((scene) => scene.id === currentSceneId) || null,
    [currentSceneId, scenesHistory.scenes],
  );

  // T-4(プレビュー反映): 現在シーンのスタイル(色・縁取り・相対サイズ・背景帯)をプレビューに近似適用する。
  const currentSceneTelopStyle = useMemo(
    () =>
      currentScene
        ? resolveEffectiveStyle(telopThemeId, currentScene.emotionTag, currentScene.styleOverrideId)
        : undefined,
    [currentScene, telopThemeId],
  );

  const sceneNavFlagMarkers = useMemo<NavFlagMarker[]>(
    () =>
      sceneSuspicionItems
        .filter((item) => item.severity === "high" || item.severity === "medium")
        .map((item) => ({ ms: item.timestampMs, severity: item.severity })),
    [sceneSuspicionItems],
  );

  function handleScenePreviewTimeUpdate(currentMs: number) {
    setMaxReachedMs((current) => Math.max(current, currentMs));
    if (!isEditingSceneTelopRef.current) setPreviewCurrentMs(currentMs);
    const stopAtMs = scenePlayStopAtMsRef.current;
    if (stopAtMs != null && currentMs >= stopAtMs) {
      scenePlayStopAtMsRef.current = null;
      previewPlayerRef.current?.pause();
    }
  }

  function playScene(scene: Scene) {
    const player = previewPlayerRef.current;
    if (!player) return;
    scenePlayStopAtMsRef.current = scene.sourceEndMs;
    player.seekTo(scene.sourceStartMs);
    player.play();
  }

  /** シーン行の再生バーを指定ms位置へ移動する(プレビューもシーク追従する)。 */
  function seekScenePlayhead(ms: number) {
    setTranscriptSeekMs(ms);
  }

  // --- 検品UI v2(シーン行UI, Phase 2: キーボード操作体系) ---
  // previewCurrentMs は再生中rVFCループにより高頻度(最大60回/秒)で更新されるため、
  // キーボードeffectの依存配列に直接含めるとwindowリスナーの付け外しが頻発してしまう。
  // refで最新値をミラーし、キー押下時にだけ読み取ることで再購読を避ける(PreviewPlayer.tsxの
  // wordsRef等と同じ方針)。scenesHistory/displayedScenesも同様(呼び出し関数はuseScenes内で
  // 毎レンダー新規に生成されるため、依存配列に含めると同じ問題が起きる)。
  const previewCurrentMsRef = useRef(previewCurrentMs);
  previewCurrentMsRef.current = previewCurrentMs;
  const sceneActionsRef = useRef(scenesHistory);
  sceneActionsRef.current = scenesHistory;
  const displayedScenesRef = useRef(displayedScenes);
  displayedScenesRef.current = displayedScenes;

  /**
   * 改善3(チップ間ホバーキャレット): チップ列ホバー中の一時的な境界カーソル。previewCurrentMsとは
   * 独立した状態で(再生バーを動かさない)、高頻度なマウス移動でも再描画を発生させないようrefに
   * 保持する(previewCurrentMsRefと同じ方針)。キャレットが立っている間、Enter/Deleteのキー操作は
   * これを最優先で使う(handleSceneEnterSplit/handleSceneDeleteLeft参照)。
   */
  const chipCaretRef = useRef<{ sceneId: string; groupIndex: number } | null>(null);
  const handleChipCaretChange = useCallback((sceneId: string, groupIndex: number | null) => {
    if (groupIndex == null) {
      if (chipCaretRef.current?.sceneId === sceneId) chipCaretRef.current = null;
      return;
    }
    chipCaretRef.current = { sceneId, groupIndex };
  }, []);

  // scissorsMode/chipSelectionもキーボードeffectからrefミラー越しに読む(previewCurrentMsRefと同じ方針)。
  const scissorsModeRef = useRef(scissorsMode);
  scissorsModeRef.current = scissorsMode;
  const chipSelectionRef = useRef(chipSelection);
  chipSelectionRef.current = chipSelection;

  /** 改善5-2(チップのドラッグ複数選択): 行のチップ選択状態が変わった(またはnullになった)ことを受け取る。 */
  const handleChipSelectionChange = useCallback((sceneId: string, range: { start: number; end: number } | null) => {
    setChipSelection(range ? { sceneId, start: range.start, end: range.end } : null);
  }, []);

  /**
   * 改善5-2(チップのドラッグ複数選択): 選択がある場合、選択範囲の全グループを1回の操作で
   * まとめて削除する(1操作=Undo1回)。選択が無ければfalseを返す(呼び出し側は通常のDelete/
   * Backspace処理にフォールバックする)。「選択があるときのDeleteはキャレット削除より優先」の実装。
   */
  function tryDeleteChipSelection(): boolean {
    const selection = chipSelectionRef.current;
    if (!selection) return false;
    setChipSelection(null);
    const scene = sceneActionsRef.current.scenes.find((item) => item.id === selection.sceneId);
    if (!scene) return true;
    const wordIds = wordIdsForGroupRange(buildWordGroups(scene), selection.start, selection.end);
    if (wordIds.length) sceneActionsRef.current.setChipGroupDeletedState(scene.id, wordIds, true);
    return true;
  }

  /** 改善5-8(チップ間クリックで再生停止): キャレット確定クリック時、再生中なら一時停止する。 */
  function pauseIfPlaying() {
    const player = previewPlayerRef.current;
    if (player && !player.isPaused()) player.pause();
  }

  /** 改善5-6(ハサミモード): 波形上のクリックで任意ms位置に即分割する。 */
  function handleScissorsCutAtMs(sceneId: string, ms: number) {
    sceneActionsRef.current.splitAtMs(sceneId, ms);
    seekScenePlayhead(ms);
  }

  /** 改善5-6(ハサミモード): チップ列のクリックでグループ境界にスナップして即分割する。 */
  function handleScissorsSplitChip(sceneId: string, groupIndex: number) {
    const scene = sceneActionsRef.current.scenes.find((item) => item.id === sceneId);
    if (!scene) return;
    const target = resolveScissorsChipSplitTarget(scene, groupIndex);
    if (!target) return;
    sceneActionsRef.current.splitAtWord(target.sceneId, target.wordId);
    const word = scene.words.find((item) => item.id === target.wordId);
    if (word) seekScenePlayhead(word.startMs);
  }

  /** 改善5-7(一括置換ポップアップ): テロップ枠フォーカス時点のテキストを記録する。 */
  function handleTelopFocus(sceneId: string, text: string) {
    telopFocusTextRef.current.set(sceneId, text);
  }

  /**
   * 改善5-7(一括置換ポップアップ): テロップ編集確定(blur)。フォーカス時点のテキストとの差分から
   * 単語置換(A→B)を検出し、Aが他シーンにも出現する場合だけ確認ポップアップを出す。
   */
  function handleTelopBlur(sceneId: string) {
    const before = telopFocusTextRef.current.get(sceneId);
    telopFocusTextRef.current.delete(sceneId);
    if (before == null) return;
    const scene = sceneActionsRef.current.scenes.find((item) => item.id === sceneId);
    if (!scene) return;
    const after = scene.telopText;
    if (before === after) return;
    const replacement = detectTelopWordReplacement(before, after);
    if (!replacement) return;
    const occurrences = findTelopOccurrencesInOtherScenes(sceneActionsRef.current.scenes, sceneId, replacement.from);
    if (occurrences.length <= 0) return;
    setTelopReplaceSelectedKeys(new Set(occurrences.map((item) => occurrenceKey(item))));
    setTelopReplaceDictChecked(false);
    setTelopReplaceCandidate({ sceneId, from: replacement.from, to: replacement.to, occurrences });
  }

  /** 改善10-B-1(一括変更ポップアップ): 選択した出現箇所への置換とユーザー辞書登録(任意)。 */
  async function handleConfirmTelopReplace() {
    const candidate = telopReplaceCandidate;
    if (!candidate) return;
    const targets = candidate.occurrences.filter((item) => telopReplaceSelectedKeys.has(occurrenceKey(item)));
    if (targets.length) {
      scenesHistory.replaceSelectedTelopOccurrences(candidate.from, candidate.to, targets);
    }
    if (telopReplaceDictChecked) {
      try {
        await window.catcut.saveUserDictionaryEntry({ from: candidate.from, to: candidate.to });
      } catch {
        setError("ユーザー辞書の保存に失敗しました");
      }
    }
    setTelopReplaceCandidate(null);
    setTelopReplaceSelectedKeys(new Set());
  }

  function handleToggleTelopReplaceOccurrence(key: string, checked: boolean) {
    setTelopReplaceSelectedKeys((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function handleCancelTelopReplace() {
    setTelopReplaceCandidate(null);
    setTelopReplaceSelectedKeys(new Set());
  }

  // 改善5-2(チップのドラッグ複数選択): Esc・行外クリックで選択解除する。
  useEffect(() => {
    if (!chipSelection) return undefined;
    const handleOutsideMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(`.sceneRow[data-scene-id="${chipSelection.sceneId}"]`)) return;
      setChipSelection(null);
    };
    window.addEventListener("mousedown", handleOutsideMouseDown);
    return () => window.removeEventListener("mousedown", handleOutsideMouseDown);
  }, [chipSelection]);

  /**
   * Delete(Backspace): 再生バー左隣の単語グループチップを削除。行頭なら上の行と結合する。
   * 改善1: 文字word単位ではなくグループ単位で操作する(1グループ=1回のUndo操作)。
   * 改善3: チップ列ホバーキャレットが立っている間はそちらを優先する(クリック不要で即発動)。
   */
  function handleSceneDeleteLeft() {
    const scenes = sceneActionsRef.current.scenes;
    const caret = chipCaretRef.current;
    if (caret) {
      const caretSceneIndex = scenes.findIndex((item) => item.id === caret.sceneId);
      if (caretSceneIndex !== -1) {
        const caretScene = scenes[caretSceneIndex];
        if (isCaretAtLineStart(caret.groupIndex)) {
          if (caretSceneIndex > 0) sceneActionsRef.current.mergeWithNext(scenes[caretSceneIndex - 1].id);
          return;
        }
        const caretTarget = resolveCaretDeleteLeftTarget(caretScene, caret.groupIndex);
        if (caretTarget) {
          sceneActionsRef.current.setChipGroupDeletedState(caretTarget.sceneId, caretTarget.wordIds, true);
        }
        return;
      }
    }
    const nowMs = previewCurrentMsRef.current;
    if (isGroupCursorAtLineStart(scenes, nowMs)) {
      const sceneIndex = findSceneIndexAtMs(scenes, nowMs);
      if (sceneIndex > 0) sceneActionsRef.current.mergeWithNext(scenes[sceneIndex - 1].id);
      return;
    }
    const target = resolveGroupDeleteLeftTarget(scenes, nowMs);
    if (target) sceneActionsRef.current.setChipGroupDeletedState(target.sceneId, target.wordIds, true);
  }

  /** Fn+Delete(Forward Delete): 再生バー右隣の単語グループチップを削除する。 */
  function handleSceneDeleteRight() {
    const scenes = sceneActionsRef.current.scenes;
    const target = resolveGroupDeleteRightTarget(scenes, previewCurrentMsRef.current);
    if (target) sceneActionsRef.current.setChipGroupDeletedState(target.sceneId, target.wordIds, true);
  }

  /**
   * Enter: 再生バー位置でシーンを分割する。
   * 切り込み(cutMark)位置と一致する場合は任意ms分割(splitAtMs)、それ以外はグループ境界分割
   * (splitAtWordをグループ先頭の文字wordで呼ぶ)。分割後は仕様書の指示通り、再生バー(選択)を
   * 新しい下の行の先頭へ送る。
   * 改善3: チップ列ホバーキャレットが立っている間はそちらの境界で分割する(クリック不要)。
   */
  function handleSceneEnterSplit() {
    const scenes = sceneActionsRef.current.scenes;
    const caret = chipCaretRef.current;
    if (caret) {
      const caretScene = scenes.find((item) => item.id === caret.sceneId);
      if (caretScene) {
        const caretTarget = resolveCaretSplitTarget(caretScene, caret.groupIndex);
        if (caretTarget) {
          sceneActionsRef.current.splitAtWord(caretTarget.sceneId, caretTarget.wordId);
          const word = caretScene.words.find((item) => item.id === caretTarget.wordId);
          if (word) seekScenePlayhead(word.startMs);
        }
        return;
      }
    }
    const nowMs = previewCurrentMsRef.current;
    const cutMarkMatch = resolveMatchingCutMark(scenes, nowMs);
    if (cutMarkMatch) {
      sceneActionsRef.current.splitAtMs(cutMarkMatch.sceneId, cutMarkMatch.ms);
      seekScenePlayhead(cutMarkMatch.ms);
      return;
    }
    const wordTarget = resolveGroupSplitTarget(scenes, nowMs);
    if (!wordTarget) return;
    sceneActionsRef.current.splitAtWord(wordTarget.sceneId, wordTarget.wordId);
    const scene = scenes.find((item) => item.id === wordTarget.sceneId);
    const word = scene?.words.find((item) => item.id === wordTarget.wordId);
    if (word) seekScenePlayhead(word.startMs);
  }

  /** ⌘M: 現在行を下の行と結合する。 */
  function handleSceneMergeWithNext() {
    const scenes = sceneActionsRef.current.scenes;
    const sceneIndex = findSceneIndexAtMs(scenes, previewCurrentMsRef.current);
    if (sceneIndex !== -1) sceneActionsRef.current.mergeWithNext(scenes[sceneIndex].id);
  }

  /** ←/→: 再生バーを単語グループチップ単位で前後移動する(シーンをまたぐ移動も可)。 */
  function handleSceneAdjacentChip(direction: 1 | -1) {
    const targetMs = findAdjacentGroupBoundaryMs(sceneActionsRef.current.scenes, previewCurrentMsRef.current, direction);
    if (targetMs != null) seekScenePlayhead(targetMs);
  }

  /** ↑/↓: 行移動(要確認フィルタ中はフラグ行間)。移動先の行頭に再生バーを送る。 */
  function handleSceneAdjacentRow(direction: 1 | -1) {
    const scenes = sceneActionsRef.current.scenes;
    const nowMs = previewCurrentMsRef.current;
    const sceneIndex = findSceneIndexAtMs(scenes, nowMs);
    const currentId = sceneIndex !== -1 ? scenes[sceneIndex].id : null;
    const targetId = findAdjacentSceneId(displayedScenesRef.current, currentId, direction);
    if (!targetId) return;
    const targetScene = scenes.find((scene) => scene.id === targetId);
    if (targetScene) seekScenePlayhead(targetScene.sourceStartMs);
  }

  /** Tab: 現在行だけ再生する(行末で自動停止。既存playSceneを流用)。 */
  function handleScenePlayCurrentRow() {
    const scenes = sceneActionsRef.current.scenes;
    const sceneIndex = findSceneIndexAtMs(scenes, previewCurrentMsRef.current);
    if (sceneIndex !== -1) playScene(scenes[sceneIndex]);
  }

  useEffect(() => {
    if (FEATURES.legacyReviewUi) return undefined;
    if (reviewStage !== "transcript") return undefined;

    const onSceneKeyDown = (event: KeyboardEvent) => {
      // IME変換中のEnter/Spaceなどは一切奪わない。
      if (event.isComposing || event.keyCode === 229) return;
      const target = event.target as HTMLElement | null;
      // テキスト枠(textarea)に入力フォーカスがある間はグローバルキーを一切奪わない。
      // ツールバーのボタン(元に戻す/編集を適用等、シーン行の外側)にフォーカスがある場合も
      // ネイティブのクリック操作を優先する。ただしチップ/この行だけ再生ボタンはシーン行内の
      // 主要な操作導線なので除外しない(クリック後にフォーカスが残っても後続のキー操作を妨げない)。
      const isTypingTarget =
        !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      const isOutsideRowControlTarget =
        !!target && (target.tagName === "BUTTON" || target.tagName === "SELECT") && !target.closest(".sceneRow");
      if (isTypingTarget || isOutsideRowControlTarget) return;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) sceneActionsRef.current.redo();
        else sceneActionsRef.current.undo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "m") {
        event.preventDefault();
        handleSceneMergeWithNext();
        return;
      }

      switch (event.key) {
        case " ":
        case "Spacebar": {
          event.preventDefault();
          const player = previewPlayerRef.current;
          if (!player) return;
          // 改善5-9(ホバー行からSpace再生): マウスが乗っている行が現在再生中の行と異なれば、
          // その行の先頭から再生する。ホバー行が無い(または現在行と同じ)場合は従来通りトグル。
          const hoveredSceneId = hoveredSceneIdRef.current;
          if (hoveredSceneId) {
            const scenes = sceneActionsRef.current.scenes;
            const hoveredScene = scenes.find((item) => item.id === hoveredSceneId);
            const currentIndex = findSceneIndexAtMs(scenes, previewCurrentMsRef.current);
            const currentSceneIdNow = currentIndex !== -1 ? scenes[currentIndex].id : null;
            if (hoveredScene && hoveredSceneId !== currentSceneIdNow) {
              playScene(hoveredScene);
              return;
            }
          }
          if (player.isPaused()) player.play();
          else player.pause();
          return;
        }
        case "l":
        case "L": {
          event.preventDefault();
          setPlaybackRate((current) => cyclePlaybackRate(current, SCENE_PLAYBACK_RATES) as PlaybackRate);
          return;
        }
        case "b":
        case "B": {
          event.preventDefault();
          setScissorsMode((current) => !current);
          return;
        }
        case "a":
        case "A": {
          // 改善7-1(Aキーでハサミ解除): Escと同じくハサミモードをOFFにする。Escは
          // チップ選択解除も兼ねるためそちらは変更しない(Aはハサミ専用のショートカット)。
          if (scissorsModeRef.current) {
            event.preventDefault();
            setScissorsMode(false);
          }
          return;
        }
        case "Escape": {
          if (chipSelectionRef.current) {
            event.preventDefault();
            setChipSelection(null);
            return;
          }
          if (scissorsModeRef.current) {
            event.preventDefault();
            setScissorsMode(false);
            return;
          }
          return;
        }
        case "Tab": {
          event.preventDefault();
          handleScenePlayCurrentRow();
          return;
        }
        case "ArrowLeft":
          event.preventDefault();
          handleSceneAdjacentChip(-1);
          return;
        case "ArrowRight":
          event.preventDefault();
          handleSceneAdjacentChip(1);
          return;
        case "ArrowUp":
          event.preventDefault();
          handleSceneAdjacentRow(-1);
          return;
        case "ArrowDown":
          event.preventDefault();
          handleSceneAdjacentRow(1);
          return;
        case "Backspace":
          // Macキーボードの「削除」キー(左隣を消す)。改善5-2: チップ選択があればそちらを優先する。
          event.preventDefault();
          if (tryDeleteChipSelection()) return;
          handleSceneDeleteLeft();
          return;
        case "Delete":
          // Fn+Delete(Forward Delete、右隣を消す)。改善5-2: チップ選択があればそちらを優先する。
          event.preventDefault();
          if (tryDeleteChipSelection()) return;
          handleSceneDeleteRight();
          return;
        case "Enter":
          event.preventDefault();
          handleSceneEnterSplit();
          return;
        default:
          return;
      }
    };

    window.addEventListener("keydown", onSceneKeyDown);
    return () => window.removeEventListener("keydown", onSceneKeyDown);
    // scenesHistory/displayedScenesは毎レンダー新しい関数を返すため依存配列には含めない
    // (refミラー越しに常に最新値を読む。上部コメント参照)。previewCurrentMsも同様の理由で除外する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewStage]);

  async function applySceneEdits() {
    if (!transcriptState) return null;
    setSceneApplying(true);
    setError("");
    try {
      // フェーズT2(directedモード): テーマ×感情(T-5)経路は使わず、シーン編集を
      // directedスロット(文言・スタイルID・強調語・絶対ms範囲)としてmainへ送る。
      // main側が telop_directives.json を差し替えてから step08 を再実行する。
      if (isDirectedTelopMode) {
        const result = await window.catcut.applyTranscriptEdits({
          runDir: transcriptState.runDir,
          keepSegments: scenesHistory.keepSegments,
          corrections: [],
          directedSlots: deriveDirectedSlots(scenesHistory.scenes, telopTypeMapping),
        });
        scenesInitializedRunDirRef.current = result.transcript.runDir;
        setTranscriptState(result.transcript);
        setReviewState({
          outputs: result.review.outputs,
          review: result.review.review,
          renderFinal: reviewState?.renderFinal ?? true,
          fontPlan: result.review.fontPlan,
          telopStyleDirectivesText: result.review.telopStyleDirectivesText,
          telopStylePlan: result.review.telopStylePlan,
          telopStyles: result.review.telopStyles,
          defaultTelopStyle: result.review.defaultTelopStyle,
          previewPages: result.review.previewPages,
        });
        setTelopText(result.review.telopText);
        setFontDirectives(result.review.fontDirectivesText);
        return result;
      }
      // T-5: scenesから導出したcut単位のスタイルID配列と、実際に使うスタイルの辞書一式を
      // 一緒に送る(main側はtelop.txtへの@styleディレクティブ注入とtelop_style_plan.json書き込みに使う)。
      const telopStyleIdsByCut = deriveTelopStyleIds(scenesHistory.scenes, telopThemeId);
      const telopStylePlan = buildTelopStylePlan(
        telopStyleIdsByCut,
        transcriptState.telopFontSize || 52,
        telopThemeId,
      );
      const result = await window.catcut.applyTranscriptEdits({
        runDir: transcriptState.runDir,
        keepSegments: scenesHistory.keepSegments,
        corrections: [],
        telopOverrides: scenesHistory.telopOverrides,
        telopStyleIdsByCut,
        telopStylePlan,
      });
      scenesInitializedRunDirRef.current = result.transcript.runDir;
      setTranscriptState(result.transcript);
      setReviewState({
        outputs: result.review.outputs,
        review: result.review.review,
        renderFinal: reviewState?.renderFinal ?? true,
        fontPlan: result.review.fontPlan,
        telopStyleDirectivesText: result.review.telopStyleDirectivesText,
        telopStylePlan: result.review.telopStylePlan,
        telopStyles: result.review.telopStyles,
        defaultTelopStyle: result.review.defaultTelopStyle,
        previewPages: result.review.previewPages,
      });
      setTelopText(result.review.telopText);
      setFontDirectives(result.review.fontDirectivesText);
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setSceneApplying(false);
    }
  }

  async function exportFromScenes() {
    if (!transcriptState) return;
    const result = await applySceneEdits();
    if (!result) return;
    setError("");
    setRunning(true);
    const exportResult = await window.catcut.startExport({
      runDir: result.transcript.runDir,
      renderFinal: true,
      outputPath: outputPathFromSettings(settings, videoPath) || "",
    });
    if (!exportResult.ok) {
      setRunning(false);
      setError(exportResult.error ?? "書き出しを開始できませんでした");
    }
  }

  useEffect(() => {
    if (!activePageId && telopPages[0]) setActivePageId(telopPages[0].id);
    if (activePageId && telopPages.length > 0 && !telopPages.some((page) => page.id === activePageId)) {
      setActivePageId(telopPages[0].id);
    }
  }, [activePageId, telopPages]);

  useEffect(() => {
    if (!transcriptState) return;
    keepSegmentsHistory.reset({
      keepSegments: transcriptState.keepSegments,
      manualRemovedWordIds: [],
      wordCorrections: {},
      correctionOriginals: {},
    });
  }, [keepSegmentsHistory, transcriptState]);

  useEffect(() => {
    setResolvedSuspicionIds({});
    setActiveSuspicionId(null);
    setFollowAlongMode(false);
    setPlaybackRate(DEFAULT_NORMAL_RATE);
    setMaxReachedMs(0);
    setSelectedBoundary(null);
    setWaveform(null);
    setWaveformError("");
    setSceneFilter("all");
    setPreviewCurrentMs(0);
    setScissorsMode(false);
    setIsPreviewPlaying(false);
    setChipSelection(null);
    setTelopReplaceCandidate(null);
    setTelopReplaceSelectedKeys(new Set());
    telopFocusTextRef.current.clear();
  }, [transcriptState?.runDir]);

  // Phase C (C-1): runDirが変わるたびに波形データを取得する(2回目以降はmain側のキャッシュから即時返却される)。
  useEffect(() => {
    const runDir = transcriptState?.runDir;
    if (!runDir) return;
    let cancelled = false;
    setWaveformLoading(true);
    setWaveformError("");
    window.catcut
      .generateWaveform({ runDir })
      .then((result) => {
        if (!cancelled) setWaveform(result);
      })
      .catch((err) => {
        if (!cancelled) setWaveformError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setWaveformLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [transcriptState?.runDir]);

  useEffect(() => {
    if (!flashWordId) return undefined;
    const timer = window.setTimeout(() => setFlashWordId(null), 900);
    return () => window.clearTimeout(timer);
  }, [flashWordId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (reviewStage !== "transcript") return;
      // 検品UI v2(シーン行UI)への全面置き換えに伴い、旧UI専用のキー処理
      // (Tab疑義ジャンプ・Cmd+Zでの旧keepSegmentsHistory操作・境界ナッジ・追い読みモード)は
      // legacyReviewUi配下に隔離する。新体系のキー操作は別のeffect(handleSceneXxx群)で処理する。
      if (!FEATURES.legacyReviewUi) return;
      const target = event.target as HTMLElement | null;
      const isEditableTarget = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (event.key === "Tab" && !isEditableTarget && suspicionItems.length > 0) {
        event.preventDefault();
        moveSuspicionFocus(event.shiftKey ? -1 : 1);
        return;
      }
      if (FEATURES.commandPalette && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) keepSegmentsHistory.redo();
        else keepSegmentsHistory.undo();
        return;
      }
      // Phase C (C-3): 境界を選択した状態で [ ] = ±100ms、Shift+[ ] = ±20ms でナッジする。
      if (!isEditableTarget && selectedBoundary && (event.key === "[" || event.key === "]")) {
        event.preventDefault();
        const deltaBase = event.shiftKey ? 20 : 100;
        nudgeSelectedBoundary(event.key === "[" ? -deltaBase : deltaBase);
        return;
      }
      // Phase B (B-2): 追い読みモード専用のキーバインド。テキスト編集入力にフォーカスがある間は
      // TranscriptEditor側でstopPropagationされるため、ここには届かない。
      if (followAlongMode) {
        if (event.key === "Escape" && !isEditableTarget) {
          event.preventDefault();
          stopFollowAlong();
          return;
        }
        if (isEditableTarget) return;
        if (event.code === "Space" || event.key === " ") {
          event.preventDefault();
          beginFollowAlongWordEdit();
          return;
        }
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          seekFollowAlongAdjacentWord(event.key === "ArrowRight" ? 1 : -1);
          return;
        }
        if (event.key.toLowerCase() === "d") {
          event.preventDefault();
          toggleFollowAlongCurrentWord();
          return;
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeSuspicionId, followAlongMode, keepSegmentsHistory, reviewStage, selectedBoundary, suspicionItems, transcriptState]);

  useEffect(() => {
    if (!selectedFont.weights.includes(selectedFontWeight)) {
      setSelectedFontWeight(selectedFont.defaultWeight);
    }
  }, [selectedFont, selectedFontWeight]);

  useEffect(() => {
    if (fontProfileMode === "new") {
      setFontDirectives(builderDirectives);
    }
  }, [builderDirectives, fontProfileMode]);

  useEffect(() => {
    if (fontProfileMode !== "saved" || !selectedSavedFontProfile) {
      loadedSavedFontProfileIdRef.current = "";
      return;
    }
    if (loadedSavedFontProfileIdRef.current === selectedSavedFontProfile.id) return;
    loadedSavedFontProfileIdRef.current = selectedSavedFontProfile.id;
    applyProfileToBuilder(selectedSavedFontProfile);
  }, [fontProfileMode, selectedSavedFontProfile]);

  useEffect(() => {
    if (!telopStyles[editingTelopStyle]) {
      setEditingTelopStyle(telopStyleNames[0] || "default");
    }
  }, [editingTelopStyle, telopStyleNames, telopStyles]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activePreview) return;

    const seekToPage = () => {
      const currentMs = video.currentTime * 1000;
      const toleranceMs = 80;
      if (currentMs + toleranceMs >= activePreview.startMs && currentMs < activePreview.endMs - toleranceMs) {
        return;
      }
      video.currentTime = activePreview.startMs / 1000;
    };

    if (video.readyState >= 1) {
      seekToPage();
      return;
    }

    video.addEventListener("loadedmetadata", seekToPage, { once: true });
    return () => video.removeEventListener("loadedmetadata", seekToPage);
  }, [activePreview]);

  function handlePreviewTimeUpdate(event: SyntheticEvent<HTMLVideoElement>) {
    if (!previewPages.length) return;
    const currentMs = event.currentTarget.currentTime * 1000;
    const currentPage = previewPages.find(
      (page) => currentMs >= page.startMs && currentMs < page.endMs,
    );
    if (currentPage && currentPage.pageId !== activePageId) {
      setActivePageId(currentPage.pageId);
    }
  }

  function updateActivePageText(value: string) {
    if (!activePage) return;
    setTelopText((current) => setPageBodyText(current, activePage.id, value));
    markReviewDraftChanged();
  }

  function updateTelopPages(mutator: (pages: TelopPage[], activeIndex: number) => string | undefined) {
    if (!activePage) return;
    setTelopText((current) => {
      const parsed = parseTelopText(current);
      const index = parsed.pages.findIndex((page) => page.id === activePage.id);
      if (index < 0) return current;
      const pages = parsed.pages.map((page) => ({ ...page, body: pageBodyLines(page) }));
      const nextActiveId = mutator(pages, index);
      window.requestAnimationFrame(() => {
        setActivePageId(nextActiveId || pages[Math.min(index, pages.length - 1)]?.id || "");
      });
      return renderTelopText(parsed.preamble, pages);
    });
    markReviewDraftChanged();
  }

  function moveActiveLastLineToNext() {
    updateTelopPages((pages, index) => {
      const current = pages[index];
      const next = pages[index + 1];
      if (!current || !next) return current?.id;
      const lines = pageBodyLines(current);
      const moving = lines.pop();
      if (!moving) return current.id;
      current.body = lines;
      next.body = [moving, ...pageBodyLines(next)];
      return next.id;
    });
  }

  function moveActiveFirstLineToPrevious() {
    updateTelopPages((pages, index) => {
      const previous = pages[index - 1];
      const current = pages[index];
      if (!previous || !current) return current?.id;
      const lines = pageBodyLines(current);
      const moving = lines.shift();
      if (!moving) return current.id;
      previous.body = [...pageBodyLines(previous), moving];
      current.body = lines;
      return previous.id;
    });
  }

  function pullPreviousLastLine() {
    updateTelopPages((pages, index) => {
      const previous = pages[index - 1];
      const current = pages[index];
      if (!previous || !current) return current?.id;
      const previousLines = pageBodyLines(previous);
      const moving = previousLines.pop();
      if (!moving) return current.id;
      previous.body = previousLines;
      current.body = [moving, ...pageBodyLines(current)];
      return current.id;
    });
  }

  function pullNextFirstLine() {
    updateTelopPages((pages, index) => {
      const current = pages[index];
      const next = pages[index + 1];
      if (!current || !next) return current?.id;
      const nextLines = pageBodyLines(next);
      const moving = nextLines.shift();
      if (!moving) return current.id;
      current.body = [...pageBodyLines(current), moving];
      next.body = nextLines;
      return current.id;
    });
  }

  function mergeActiveWithPrevious() {
    updateTelopPages((pages, index) => {
      const previous = pages[index - 1];
      const current = pages[index];
      if (!previous || !current) return current?.id;
      previous.header = replaceHeaderEndTime(previous.header, headerEndTime(current.header));
      previous.body = [...pageBodyLines(previous), ...pageBodyLines(current)];
      pages.splice(index, 1);
      return previous.id;
    });
  }

  function mergeActiveWithNext() {
    updateTelopPages((pages, index) => {
      const current = pages[index];
      const next = pages[index + 1];
      if (!current || !next) return current?.id;
      current.header = replaceHeaderEndTime(current.header, headerEndTime(next.header));
      current.body = [...pageBodyLines(current), ...pageBodyLines(next)];
      pages.splice(index + 1, 1);
      return current.id;
    });
  }

  const canStart = useMemo(() => {
    if (!settings || running || !videoPath) return false;
    if (settings.sttProvider === "elevenlabs" && !apiKeysStatus?.elevenlabs.configured && !settings.elevenApiKeySet) return false;
    if (fontProfileMode === "saved" && !selectedSavedFontProfile) return false;
    return true;
  }, [apiKeysStatus?.elevenlabs.configured, fontProfileMode, running, selectedSavedFontProfile, settings, videoPath]);

  async function refreshApiKeysStatus() {
    if (!electronReady) return null;
    const status = await window.catcut.getApiKeysStatus();
    setApiKeysStatus(status);
    setSettings((current) => (current ? { ...current, elevenApiKeySet: status.elevenlabs.configured } : current));
    return status;
  }

  async function chooseVideo() {
    const selected = await window.catcut.chooseVideo();
    if (selected) setVideoPath(selected);
  }

  async function saveCurrentSettings(next?: Partial<Settings> & { elevenApiKey?: string }) {
    const merged = {
      sttProvider: settings?.sttProvider ?? "elevenlabs",
      whisperModel: settings?.whisperModel ?? "small",
      renderFinal: settings?.renderFinal ?? true,
      reviewBeforeExport: settings?.reviewBeforeExport ?? true,
      fontProfileMode: settings?.fontProfileMode ?? "new",
      selectedFontProfileId: settings?.selectedFontProfileId ?? "",
      outputDirectory: settings?.outputDirectory ?? "",
      outputFileName: settings?.outputFileName ?? "",
      ...next,
    };
    const saved = await window.catcut.saveSettings(merged);
    setSettings({
      ...saved,
      fontProfileMode: merged.fontProfileMode,
      selectedFontProfileId: merged.selectedFontProfileId,
      outputDirectory: merged.outputDirectory,
      outputFileName: merged.outputFileName,
    });
    await refreshApiKeysStatus();
  }

  async function refreshOllamaStatus() {
    if (!FEATURES.ollama) return;
    setOllamaChecking(true);
    setOllamaMessage("");
    try {
      const status = await window.catcut.getOllamaStatus();
      setOllamaStatus(status);
      if (!status.installed) {
        setOllamaMessage("Ollamaが未インストールです");
      } else if (!status.running) {
        setOllamaMessage("Ollamaアプリを起動してください");
      } else if (!status.modelInstalled) {
        setOllamaMessage(`${status.model} をダウンロードしてください`);
      } else {
        setOllamaMessage("ローカルAIレビューを使えます");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setOllamaMessage(
        message.includes("No handler registered")
          ? "Ollama連携のIPCがまだ読み込まれていません。アプリを再起動してください"
          : message,
      );
    } finally {
      setOllamaChecking(false);
    }
  }

  async function openOllamaInstallGuide() {
    if (!FEATURES.ollama) return;
    try {
      await window.catcut.openOllamaInstallGuide();
    } catch {
      window.open("https://ollama.com/download", "_blank", "noopener,noreferrer");
    }
  }

  async function pullOllamaModel() {
    if (!FEATURES.ollama) return;
    setOllamaPulling(true);
    setOllamaMessage(`${LOCAL_AI_MODEL} をダウンロード中です`);
    try {
      const result = await window.catcut.pullOllamaModel({ model: LOCAL_AI_MODEL });
      if (!result.ok) {
        setOllamaMessage(result.error || "モデルをダウンロードできませんでした");
        return;
      }
      if (result.status) setOllamaStatus(result.status);
      setOllamaMessage("モデルのダウンロードが完了しました");
    } catch (err) {
      setOllamaMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setOllamaPulling(false);
    }
  }

  async function runLocalAiReview() {
    if (!FEATURES.ollama || !reviewState) return;
    setOllamaReviewing(true);
    setOllamaMessage("ローカルAIでテロップを確認中です");
    try {
      const result = await window.catcut.reviewTelopWithOllama({ text: telopText, model: LOCAL_AI_MODEL });
      const findings = result.findings || [];
      addReviewFindings(findings, "ローカルAI");
    } catch (err) {
      setOllamaMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setOllamaReviewing(false);
    }
  }

  async function chooseGroundTruthText() {
    if (!FEATURES.groundTruth) return;
    setGroundTruthMessage("");
    try {
      const selected = await window.catcut.chooseGroundTruthText();
      if (!selected) return;
      setGroundTruth(selected);
      setRuleLabReport(null);
      setRuleLabFilter("all");
      setGroundTruthMessage(
        `読み込みました: ${selected.stats.entries}ページ / ${formatMsClock(selected.stats.firstStartMs)}-${formatMsClock(selected.stats.lastEndMs)}`,
      );
    } catch (err) {
      setGroundTruthMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async function analyzeGroundTruthRules() {
    if (!FEATURES.groundTruth || !reviewState || !groundTruth?.path) return;
    setRuleLabAnalyzing(true);
    setGroundTruthMessage("正解txtとの差分を解析しています。テロップ本文や正式ルールは変更しません。");
    try {
      const report = await window.catcut.analyzeGroundTruthRules({
        runDir: reviewState.outputs.runDir,
        path: groundTruth.path,
      });
      setRuleLabReport(report);
      setRuleLabFilter("all");
      setGroundTruthMessage(
        `差分解析: ${report.summary.mismatchPages}ページに差分 / ルール案 ${report.proposals.length}件`,
      );
    } catch (err) {
      setGroundTruthMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setRuleLabAnalyzing(false);
    }
  }

  async function saveGroundTruthRuleProposal(proposal: GroundTruthRuleProposal, action: "review" | "ignore_forever") {
    if (!FEATURES.groundTruth) return;
    setRuleProposalSaving((current) => ({ ...current, [proposal.id]: true }));
    try {
      const next = await window.catcut.applyGroundTruthRuleProposal({ proposal, action });
      setUserRules(next);
      setGroundTruthMessage(
        action === "ignore_forever"
          ? `無視ルールとして記録しました: ${proposal.title}`
          : `今後のレビュー用ルールに追加しました: ${proposal.title}`,
      );
    } catch (err) {
      setGroundTruthMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setRuleProposalSaving((current) => ({ ...current, [proposal.id]: false }));
    }
  }

  async function applyGroundTruthText() {
    if (!FEATURES.groundTruth || !reviewState || !groundTruth?.path) return;
    setGroundTruthApplying(true);
    setGroundTruthMessage("正解txtを現在のテロップとプレビューへ反映中です");
    try {
      const result = await window.catcut.applyGroundTruthText({
        runDir: reviewState.outputs.runDir,
        path: groundTruth.path,
      });
      const state = result.state;
      setReviewState({
        outputs: state.outputs,
        review: state.review,
        renderFinal: reviewState.renderFinal,
        fontPlan: state.fontPlan,
        telopStyleDirectivesText: state.telopStyleDirectivesText,
        telopStylePlan: state.telopStylePlan,
        telopStyles: state.telopStyles,
        defaultTelopStyle: state.defaultTelopStyle,
        previewPages: state.previewPages,
      });
      setTelopText(state.telopText);
      setTelopStyles(normalizeTelopStyles(state.telopStyles));
      setUserRules(result.userRules);
      setGroundTruth(result.groundTruth);
      setActivePageId(parseTelopText(state.telopText).pages[0]?.id || "");
      setTelopConfirmed(true);
      setGroundTruthMessage(
        `反映しました: ${result.groundTruth.stats.entries}ページ。開始時刻・区切り・表記傾向を学習しました。`,
      );
    } catch (err) {
      setGroundTruthMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setGroundTruthApplying(false);
    }
  }

  function addReviewFindings(findings: TelopFinding[], label: string) {
    setReviewState((current) => {
      if (!current) return current;
      const baseFindings = (current.review?.findings || []).filter((finding) => !finding.id.startsWith("ollama_"));
      const nextFindings = [...baseFindings, ...findings];
      return {
        ...current,
        review: {
          ...(current.review || {}),
          findings: nextFindings,
          stats: {
            ...(current.review?.stats || {}),
            findings: nextFindings.length,
            remaining_findings: nextFindings.length,
          },
        },
      };
    });
    setOllamaMessage(findings.length > 0 ? `${label}: ${findings.length}件の候補を追加しました` : `${label}: 取り込める候補はありません`);
  }

  async function saveDictionaryRule(input: { wrong: string; correct: string; category?: DictionaryRule["category"] }) {
    const wrong = input.wrong.trim();
    const correct = input.correct.trim();
    if (!wrong || !correct || wrong === correct) return;
    setRulesSaving(true);
    try {
      const next = await window.catcut.learnDictionaryRule({
        wrong,
        correct,
        category: input.category || "common_misrecognition",
      });
      setUserRules(next);
      setRuleDraft({ wrong: "", correct: "", category: "common_misrecognition" });
      setOllamaMessage(`学習辞書に保存しました: ${wrong} → ${correct}`);
    } catch (err) {
      setOllamaMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setRulesSaving(false);
    }
  }

  async function deleteDictionaryRule(rule: DictionaryRule) {
    if (!userRules) return;
    const nextRules = {
      ...userRules,
      dictionary: userRules.dictionary.filter((item) => item !== rule && item.id !== rule.id),
    };
    setRulesSaving(true);
    try {
      const saved = await window.catcut.saveUserRules(nextRules);
      setUserRules(saved);
      setOllamaMessage("学習辞書から削除しました");
    } catch (err) {
      setOllamaMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setRulesSaving(false);
    }
  }

  async function saveFindingAsRule(finding: TelopFinding) {
    const wrong = (finding.source || finding.before || "").trim();
    const correct = (replacementDrafts[finding.id] || finding.suggestion || finding.after || "").trim();
    await saveDictionaryRule({ wrong, correct, category: "common_misrecognition" });
  }

  async function chooseOutputDirectory() {
    if (!settings) return;
    const selected = await window.catcut.chooseOutputDirectory();
    if (!selected) return;
    await saveCurrentSettings({ outputDirectory: selected });
  }

  async function chooseOutputFile() {
    if (!settings) return;
    const selected = await window.catcut.saveOutputFile({
      defaultPath: outputPathFromSettings(settings, videoPath) || undefined,
      defaultFileName: ensureMp4FileName(settings.outputFileName || defaultOutputFileName(videoPath)),
    });
    if (!selected) return;
    await saveCurrentSettings({
      outputDirectory: directoryFromPath(selected),
      outputFileName: fileNameFromPath(selected),
    });
  }

  function toggleTranscriptWordIds(wordIds: string[]) {
    keepSegmentsHistory.toggleWords(wordIds);
  }

  function correctWord(wordId: string, newText: string) {
    const currentWord = transcriptState?.words.find((word) => word.id === wordId);
    if (!currentWord) return;
    keepSegmentsHistory.correctWord(wordId, newText, currentWord.text);
  }

  function selectSuspicionItem(item: SuspicionItem) {
    setActiveSuspicionId(item.id);
    setTranscriptSeekMs(item.timestampMs);
    const wordId = item.wordIds[0] || null;
    if (wordId) {
      setActiveTranscriptWordId(wordId);
      setFlashWordId(wordId);
    }
  }

  function moveSuspicionFocus(direction: 1 | -1) {
    if (!suspicionItems.length) return;
    const size = suspicionItems.length;
    const currentIndex = activeSuspicionId ? suspicionItems.findIndex((item) => item.id === activeSuspicionId) : -1;
    const base = currentIndex === -1 ? (direction === 1 ? -1 : 0) : currentIndex;
    const nextIndex = ((base + direction) % size + size) % size;
    selectSuspicionItem(suspicionItems[nextIndex]);
  }

  function toggleSuspicionResolved(item: SuspicionItem) {
    setResolvedSuspicionIds((current) => ({ ...current, [item.id]: !current[item.id] }));
  }

  function fixSuspicionItem(item: SuspicionItem) {
    selectSuspicionItem(item);
    // Phase C (C-3): 「境界はみ出し」の疑義は、単語編集ではなく該当境界の選択状態へ直行させる。
    if (item.type === "boundary_overrun") {
      const wordId = item.wordIds[0];
      const highlights = computeBoundaryOverrunHighlights(transcriptWords, keepSegmentsHistory.keepSegments);
      const highlight = wordId ? findBoundaryHighlightByWordId(highlights, wordId) : null;
      if (highlight) {
        setSelectedBoundary({ segmentIndex: highlight.segmentIndex, edge: highlight.edge });
        setFocusCutCardSegmentIndex(highlight.segmentIndex);
        return;
      }
    }
    const wordId = item.wordIds[0];
    if (wordId) setEditRequestWordId(wordId);
  }

  // --- Phase C (C-3): 境界ナッジ(ドラッグ・キーボード) ---

  /** ナッジ後、境界前後1.5秒(計3秒)を自動プレビュー再生する。 */
  function previewNudgeAtBoundary(boundaryMs: number) {
    const player = previewPlayerRef.current;
    if (!player) return;
    player.pause();
    player.seekTo(Math.max(0, boundaryMs - 1500));
    window.setTimeout(() => {
      player.play();
      window.setTimeout(() => player.pause(), 3000);
    }, 60);
  }

  function handleSelectBoundary(segmentIndex: number, edge: "start" | "end") {
    setSelectedBoundary({ segmentIndex, edge });
  }

  /** カットカード波形上でのIN/OUTハンドルドラッグ確定時に呼ばれる(20msスナップは純関数側で行う)。 */
  function handleCommitBoundaryDrag(segmentIndex: number, edge: "start" | "end", targetMs: number) {
    const sorted = [...keepSegmentsHistory.keepSegments].sort((a, b) => a.startMs - b.startMs);
    const nextSegments = setKeepSegmentBoundaryMs(sorted, segmentIndex, edge, targetMs, {
      snapMs: 20,
      maxMs: transcriptState?.originalDurationMs || 0,
    });
    keepSegmentsHistory.setKeepSegments(nextSegments);
    setSelectedBoundary({ segmentIndex, edge });
    const boundaryMs = edge === "start" ? nextSegments[segmentIndex]?.startMs : nextSegments[segmentIndex]?.endMs;
    if (boundaryMs != null) previewNudgeAtBoundary(boundaryMs);
  }

  /** `[` `]` (±100ms) / Shift+`[` `]` (±20ms) で選択中の境界をナッジする。 */
  function nudgeSelectedBoundary(deltaMs: number) {
    if (!selectedBoundary) return;
    const sorted = [...keepSegmentsHistory.keepSegments].sort((a, b) => a.startMs - b.startMs);
    const nextSegments = nudgeKeepSegmentBoundary(sorted, selectedBoundary.segmentIndex, selectedBoundary.edge, deltaMs, {
      snapMs: 20,
      maxMs: transcriptState?.originalDurationMs || 0,
    });
    keepSegmentsHistory.setKeepSegments(nextSegments);
    const segment = nextSegments[selectedBoundary.segmentIndex];
    if (!segment) return;
    const boundaryMs = selectedBoundary.edge === "start" ? segment.startMs : segment.endMs;
    previewNudgeAtBoundary(boundaryMs);
  }

  // --- Phase B: 追い読みレビューモード（B-1〜B-3） ---

  function startFollowAlong() {
    setFollowAlongMode(true);
    setPlaybackRate(DEFAULT_FOLLOW_ALONG_RATE);
    previewPlayerRef.current?.play();
  }

  function stopFollowAlong() {
    setFollowAlongMode(false);
    setPlaybackRate(DEFAULT_NORMAL_RATE);
    previewPlayerRef.current?.pause();
  }

  /** Space押下: 直前に読み上げられた単語（現在時刻-300ms時点）の編集を開始する（B-2）。 */
  function beginFollowAlongWordEdit() {
    const player = previewPlayerRef.current;
    if (!player) return;
    const currentMs = player.getCurrentTimeMs();
    player.pause();
    const wordIndex = findPreviousReadWordIndex(displayTranscriptWords, currentMs);
    const word = wordIndex >= 0 ? displayTranscriptWords[wordIndex] : null;
    if (!word) return;
    setActiveTranscriptWordId(word.id);
    setEditRequestWordId(word.id);
  }

  /** ←/→押下: 1単語シークする（B-2、非編集時のみ）。 */
  function seekFollowAlongAdjacentWord(direction: 1 | -1) {
    const player = previewPlayerRef.current;
    if (!player) return;
    const currentMs = player.getCurrentTimeMs();
    const wordIndex = findAdjacentWordIndex(displayTranscriptWords, currentMs, direction);
    if (wordIndex < 0) return;
    const word = displayTranscriptWords[wordIndex];
    player.seekTo(word.startMs);
    setActiveTranscriptWordId(word.id);
  }

  /** D押下: 現在の単語のカットを切り替える（B-2、非編集時のみ）。 */
  function toggleFollowAlongCurrentWord() {
    const player = previewPlayerRef.current;
    if (!player) return;
    const currentMs = player.getCurrentTimeMs();
    const wordIndex = findWordIndexAtOrBefore(displayTranscriptWords, currentMs);
    if (wordIndex < 0) return;
    toggleTranscriptWordIds([displayTranscriptWords[wordIndex].id]);
  }

  /** Enter/Esc（編集中）でTranscriptEditorの単語編集が終了した際のコールバック（B-2）。 */
  function handleFollowAlongEditFinished({ wordId, committed }: { wordId: string; committed: boolean }) {
    if (!followAlongMode) return;
    const player = previewPlayerRef.current;
    if (!player) return;
    if (committed) {
      const word = displayTranscriptWords.find((item) => item.id === wordId);
      if (word) player.seekTo(word.startMs);
    }
    player.play();
  }

  function restoreAllFillerCuts() {
    const restoredWordIds = transcriptState?.fillerWordIds || [];
    if (!restoredWordIds.length) return;
    keepSegmentsHistory.setWordsKept(restoredWordIds, true);
  }

  function applyAllFillerCuts() {
    if (!transcriptState) return;
    if (!transcriptState.fillerWordIds.length) return;
    keepSegmentsHistory.setWordsKept(transcriptState.fillerWordIds, false);
  }

  async function applyTranscriptEdits() {
    if (!transcriptState) return;
    setTranscriptApplying(true);
    setError("");
    try {
      const corrections = Object.entries(pendingWordCorrections).map(([wordId, text]) => ({ wordId, text }));
      const result = await window.catcut.applyTranscriptEdits({
        runDir: transcriptState.runDir,
        keepSegments: keepSegmentsHistory.keepSegments,
        corrections,
      });
      setTranscriptState(result.transcript);
      setReviewState({
        outputs: result.review.outputs,
        review: result.review.review,
        renderFinal: reviewState?.renderFinal ?? true,
        fontPlan: result.review.fontPlan,
        telopStyleDirectivesText: result.review.telopStyleDirectivesText,
        telopStylePlan: result.review.telopStylePlan,
        telopStyles: result.review.telopStyles,
        defaultTelopStyle: result.review.defaultTelopStyle,
        previewPages: result.review.previewPages,
      });
      setTelopText(result.review.telopText);
      setFontDirectives(result.review.fontDirectivesText);
      setActiveTranscriptWordId(result.transcript.words[0]?.id || null);
      setReviewStage("transcript");
      setTelopConfirmed(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTranscriptApplying(false);
    }
  }

  async function exportFromTranscriptStage() {
    if (!transcriptState) return;
    setError("");
    setRunning(true);
    const result = await window.catcut.startExport({
      runDir: transcriptState.runDir,
      renderFinal: true,
      outputPath: outputPathFromSettings(settings, videoPath) || "",
    });
    if (!result.ok) {
      setRunning(false);
      setError(result.error ?? "書き出しを開始できませんでした");
    }
  }

  async function runDeterministicCommand(command: DeterministicCommand) {
    if (!transcriptState) return;
    if (command === "filler_off") {
      restoreAllFillerCuts();
      return;
    }
    if (command === "filler_on") {
      applyAllFillerCuts();
      return;
    }
    try {
      setTranscriptApplying(true);
      const result = await window.catcut.runTranscriptCommand({
        runDir: transcriptState.runDir,
        command,
      });
      setTranscriptState(result.transcript);
      setReviewState({
        outputs: result.review.outputs,
        review: result.review.review,
        renderFinal: reviewState?.renderFinal ?? true,
        fontPlan: result.review.fontPlan,
        telopStyleDirectivesText: result.review.telopStyleDirectivesText,
        telopStylePlan: result.review.telopStylePlan,
        telopStyles: result.review.telopStyles,
        defaultTelopStyle: result.review.defaultTelopStyle,
        previewPages: result.review.previewPages,
      });
      setTelopText(result.review.telopText);
      setFontDirectives(result.review.fontDirectivesText);
      setActiveTranscriptWordId(result.transcript.words[0]?.id || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTranscriptApplying(false);
    }
  }

  async function startJob() {
    if (!settings) return;
    setLogs("");
    setError("");
    setOutputs(null);
    setReviewState(null);
    setTranscriptState(null);
    setReviewStage("transcript");
    setTelopText("");
    setFontDirectives("");
    setFontApplyConfirmed(false);
    setFontApplying(false);
    setTelopStyleDirectives(defaultTelopStyleDirectives);
    setTelopStyles(normalizeTelopStyles(null));
    setEditingTelopStyle("default");
    setTelopStyleApplyConfirmed(false);
    setTelopStyleApplying(false);
    setReplacementDrafts({});
    setReviewedFindings({});
    setActivePageId("");
    setSteps(initialSteps);
    const result = await window.catcut.startJob({
      videoPath,
      sttProvider: settings.sttProvider,
      whisperModel: settings.whisperModel,
      renderFinal: true,
      reviewBeforeExport: settings.reviewBeforeExport,
      fontProfileMode,
      savedFontProfileId: fontProfileMode === "saved" ? selectedSavedFontProfile?.id || "" : "",
      fontDirectivesText: fontProfileMode === "saved" ? selectedSavedFontProfile?.directivesText || "" : "",
      outputPath: outputPathFromSettings(settings, videoPath) || "",
    });
    if (!result.ok) {
      setError(result.error ?? "ジョブを開始できませんでした");
    }
  }

  async function startLearningJob() {
    if (!FEATURES.groundTruth || !settings || !groundTruth?.path) return;
    setLogs("");
    setError("");
    setOutputs(null);
    setReviewState(null);
    setTranscriptState(null);
    setReviewStage("transcript");
    setTelopText("");
    setFontDirectives("");
    setReplacementDrafts({});
    setReviewedFindings({});
    setLearningReport(null);
    setSteps(initialSteps);
    setGroundTruthMessage("動画を処理して、正解txtとの差分から正式ルールを学習します");
    const result = await window.catcut.startJob({
      videoPath,
      sttProvider: settings.sttProvider,
      whisperModel: settings.whisperModel,
      renderFinal: false,
      reviewBeforeExport: true,
      fontProfileMode,
      savedFontProfileId: fontProfileMode === "saved" ? selectedSavedFontProfile?.id || "" : "",
      fontDirectivesText: fontProfileMode === "saved" ? selectedSavedFontProfile?.directivesText || "" : "",
      outputPath: "",
      groundTruthPath: groundTruth.path,
      learningMode: true,
    });
    if (!result.ok) {
      setError(result.error ?? "学習を開始できませんでした");
    }
  }

  async function saveTelopOnly() {
    if (!reviewState) return;
    const state = await window.catcut.saveTelop({
      runDir: reviewState.outputs.runDir,
      text: telopText,
    });
    setReviewState({
      outputs: state.outputs,
      review: state.review,
      renderFinal: reviewState.renderFinal,
      fontPlan: state.fontPlan,
      telopStyleDirectivesText: state.telopStyleDirectivesText,
      telopStylePlan: state.telopStylePlan,
      telopStyles: state.telopStyles,
      defaultTelopStyle: state.defaultTelopStyle,
      previewPages: state.previewPages,
    });
    setTelopText(state.telopText);
    setTelopStyles(normalizeTelopStyles(state.telopStyles));
  }

  async function applyFontDirectives(overrideText?: string) {
    if (!reviewState) return false;
    setError("");
    setFontApplying(true);
    try {
      const directives =
        overrideText ??
        (fontMode === "select"
          ? selectedFontDirectives(selectedFont, selectedFontWeight, selectedFontSize)
          : fontDirectives);
      const state = await window.catcut.applyFontDirectives({
        runDir: reviewState.outputs.runDir,
        text: directives,
      });
      setReviewState({
        outputs: state.outputs,
        review: state.review,
        renderFinal: reviewState.renderFinal,
        fontPlan: state.fontPlan,
        telopStyleDirectivesText: state.telopStyleDirectivesText,
        telopStylePlan: state.telopStylePlan,
        telopStyles: state.telopStyles,
        defaultTelopStyle: state.defaultTelopStyle,
        previewPages: state.previewPages,
      });
      setFontDirectives(state.fontDirectivesText);
      setTelopStyles(normalizeTelopStyles(state.telopStyles));
      setFontApplyConfirmed(false);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setFontApplying(false);
    }
  }

  function markReviewDraftChanged() {
    setTelopConfirmed(false);
    setOutputs(null);
    setExportProgress(0);
  }

  function updateFontQa(patch: Partial<FontQaState>) {
    const next = { ...fontQa, ...patch };
    setFontQa(next);
    setBuilderScenes(buildSceneSettingsFromQa(next));
    setFontApplyConfirmed(false);
    markReviewDraftChanged();
  }

  function updateBuilderScene(scene: FontSceneKey, patch: Partial<FontSceneSetting>) {
    setBuilderScenes((current) => {
      const nextSetting = { ...current[scene], ...patch };
      if (patch.font) {
        nextSetting.weight = nearestWeightForFont(patch.font, nextSetting.weight);
      }
      return { ...current, [scene]: nextSetting };
    });
    setFontApplyConfirmed(false);
    markReviewDraftChanged();
  }

  function applyProfileToBuilder(profile: SavedFontProfile) {
    setBuilderPatternCount(Math.max(1, Math.min(fontSceneOrder.length, profile.patternCount || 1)));
    setBuilderProfileName(profile.name || "字幕フォント設定");
    setBuilderScenes(profileSceneSettings(profile));
    setFontDirectives(profile.directivesText);
    setFontApplyConfirmed(false);
  }

  async function saveBuilderFontProfile() {
    if (!settings) return;
    setError("");
    setFontProfileSaving(true);
    try {
      const directives = builderDirectives;
      const existingProfileId = fontProfileMode === "saved" ? selectedSavedFontProfile?.id : undefined;
      const profiles = await saveStoredFontProfile({
        id: existingProfileId,
        name: builderProfileName.trim() || "字幕フォント設定",
        patternCount: builderPatternCount,
        scenes: builderScenes,
        directivesText: directives,
      });
      setFontProfiles(profiles);
      const saved = profiles.find((profile) => profile.id === existingProfileId) || profiles[0];
      setFontDirectives(directives);
      const nextStyles = telopStylesFromFontScenes(telopStyles, builderScenes);
      setTelopStyles(nextStyles);
      const nextSettings = await window.catcut.saveSettings({
        ...settings,
        fontProfileMode: "saved",
        selectedFontProfileId: saved?.id || "",
      });
      setSettings({
        ...nextSettings,
        fontProfileMode: "saved",
        selectedFontProfileId: saved?.id || "",
      });
      if (reviewState) {
        const styleState = await window.catcut.applyTelopStyle({
          runDir: reviewState.outputs.runDir,
          text: telopText,
          directivesText: `saved font profile: ${saved?.name || builderProfileName}`,
          styles: nextStyles,
          defaultStyleName: defaultTelopStyleName,
        });
        setReviewState({
          outputs: styleState.outputs,
          review: styleState.review,
          renderFinal: reviewState.renderFinal,
          fontPlan: styleState.fontPlan,
          telopStyleDirectivesText: styleState.telopStyleDirectivesText,
          telopStylePlan: styleState.telopStylePlan,
          telopStyles: styleState.telopStyles,
          defaultTelopStyle: styleState.defaultTelopStyle,
          previewPages: styleState.previewPages,
        });
        setTelopText(styleState.telopText);
        setTelopStyles(normalizeTelopStyles(styleState.telopStyles));
        const fontsApplied = await applyFontDirectives(directives);
        if (fontsApplied) setTelopConfirmed(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFontProfileSaving(false);
    }
  }

  function updateEditingTelopStyle(patch: Partial<TelopStyle>) {
    setTelopStyles((current) => ({
      ...current,
      [editingTelopStyle]: {
        ...(current[editingTelopStyle] || builtinTelopStyles.default),
        ...patch,
        fill: patch.fill || current[editingTelopStyle]?.fill || builtinTelopStyles.default.fill,
      },
    }));
    setTelopStyleApplyConfirmed(false);
    markReviewDraftChanged();
  }

  function updateEditingFill(patch: Partial<TelopFill>) {
    const currentFill = editingStyle.fill || builtinTelopStyles.default.fill;
    updateEditingTelopStyle({ fill: { ...currentFill, ...patch } });
  }

  function updateEditingStroke(kind: "inner_stroke" | "outer_stroke", patch: { color?: string; width?: number }) {
    const currentStroke = editingStyle[kind] || { color: kind === "inner_stroke" ? "#FFFFFF" : "#1E3A5F", width: 10 };
    updateEditingTelopStyle({ [kind]: { ...currentStroke, ...patch } } as Partial<TelopStyle>);
  }

  function previewNaturalTelopStyle() {
    const next = naturalTelopStyles(telopStyleDirectives, telopStyles);
    setTelopStyles(next);
    setEditingTelopStyle(next[editingTelopStyle] ? editingTelopStyle : "default");
    setTelopStyleApplyConfirmed(false);
  }

  function assignActivePageStyle(styleName: string) {
    if (!activePage) return;
    setTelopText((current) => setPageStyle(current, activePage.id, styleName, defaultTelopStyleName));
    setTelopStyleApplyConfirmed(false);
    markReviewDraftChanged();
  }

  function autoAssignStyles() {
    setTelopText((current) => autoAssignTelopStyles(current, telopStyles, defaultTelopStyleName));
    setTelopStyleApplyConfirmed(false);
    markReviewDraftChanged();
  }

  async function applyTelopStyle() {
    if (!reviewState) return false;
    setError("");
    setTelopStyleApplying(true);
    try {
      const state = await window.catcut.applyTelopStyle({
        runDir: reviewState.outputs.runDir,
        text: telopText,
        directivesText: telopStyleDirectives,
        styles: telopStyles,
        defaultStyleName: defaultTelopStyleName,
      });
      setReviewState({
        outputs: state.outputs,
        review: state.review,
        renderFinal: reviewState.renderFinal,
        fontPlan: state.fontPlan,
        telopStyleDirectivesText: state.telopStyleDirectivesText,
        telopStylePlan: state.telopStylePlan,
        telopStyles: state.telopStyles,
        defaultTelopStyle: state.defaultTelopStyle,
        previewPages: state.previewPages,
      });
      setTranscriptState(await window.catcut.loadTranscriptEditor(state.outputs.runDir));
      setTelopText(state.telopText);
      setTelopStyleDirectives(state.telopStyleDirectivesText || defaultTelopStyleDirectives);
      setTelopStyles(normalizeTelopStyles(state.telopStyles));
      setTelopStyleApplyConfirmed(false);
      setTelopConfirmed(true);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setTelopStyleApplying(false);
    }
  }

  async function saveAndExport() {
    if (!reviewState) return;
    setError("");
    await saveTelopOnly();
    if (!telopConfirmed || telopStyleApplyConfirmed) {
      const telopStyleApplied = await applyTelopStyle();
      if (!telopStyleApplied) return;
    }
    if (fontApplyConfirmed) {
      const fontApplied = await applyFontDirectives();
      if (!fontApplied) return;
    }
    setRunning(true);
    const result = await window.catcut.startExport({
      runDir: reviewState.outputs.runDir,
      renderFinal: reviewState.renderFinal,
      outputPath: outputPathFromSettings(settings, videoPath) || "",
    });
    if (!result.ok) {
      setRunning(false);
      setError(result.error ?? "書き出しを開始できませんでした");
    }
  }

  async function restoreReviewFromOutputs() {
    if (!outputs) return;
    setError("");
    try {
      const state = await window.catcut.loadTelop(outputs.runDir);
      const nextStyles = normalizeTelopStyles(state.telopStyles);
      const pages = parseTelopText(state.telopText).pages;
      setRunDir(state.outputs.runDir);
      setOutputs(state.outputs);
      setReviewState({
        outputs: state.outputs,
        review: state.review,
        renderFinal: true,
        fontPlan: state.fontPlan,
        telopStyleDirectivesText: state.telopStyleDirectivesText,
        telopStylePlan: state.telopStylePlan,
        telopStyles: state.telopStyles,
        defaultTelopStyle: state.defaultTelopStyle,
        previewPages: state.previewPages,
      });
      setTelopText(state.telopText);
      setFontDirectives(state.fontDirectivesText);
      setTelopStyleDirectives(state.telopStyleDirectivesText || defaultTelopStyleDirectives);
      setTelopStyles(nextStyles);
      setEditingTelopStyle(Object.keys(nextStyles)[0] || "default");
      setFontApplyConfirmed(false);
      setTelopStyleApplyConfirmed(false);
      setTelopStyleApplying(false);
      setTelopConfirmed(true);
      setReplacementDrafts({});
      setReviewedFindings({});
      setActivePageId(state.review?.findings?.[0]?.page_id || pages[0]?.id || "");
      setExportProgress(0);
      setReviewStage("transcript");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function cancelJob() {
    await window.catcut.cancelJob();
  }

  function applyFinding(finding: TelopFinding) {
    setActivePageId(finding.page_id);
    setTelopText((current) => {
      if (finding.type === "filler_only") {
        return removeTelopPage(current, finding.page_id);
      }
      const replaceBlock = ["duplicate_line", "line_break"].includes(finding.type);
      const source = replaceBlock && finding.before && finding.after ? finding.before : finding.source;
      const fallbackTarget = replaceBlock ? finding.after ?? "" : finding.suggestion ?? finding.after ?? "";
      const target = replacementDrafts[finding.id] ?? fallbackTarget;
      if (!source) return current;
      return transformPageBody(current, finding.page_id, (body) => replaceInBody(body, source, target));
    });
    setReviewedFindings((current) => ({ ...current, [finding.id]: "accepted" }));
    window.catcut.recordLearningDecision({
      kind: "telop",
      action: "accepted",
      findingType: finding.type,
      pageId: finding.page_id,
      source: finding.source || finding.before,
      suggestion: replacementDrafts[finding.id] || finding.suggestion || finding.after,
      message: finding.message,
    }).catch(() => undefined);
    markReviewDraftChanged();
  }

  function ignoreFinding(finding: TelopFinding) {
    setActivePageId(finding.page_id);
    setReviewedFindings((current) => ({ ...current, [finding.id]: "ignored" }));
    window.catcut.recordLearningDecision({
      kind: "telop",
      action: "ignored",
      findingType: finding.type,
      pageId: finding.page_id,
      source: finding.source || finding.before,
      suggestion: finding.suggestion || finding.after,
      message: finding.message,
    }).catch(() => undefined);
  }

  function isFindingApplied(finding: TelopFinding) {
    const page = telopPages.find((item) => item.id === finding.page_id);
    const pageText = page ? page.body.join("\n") : "";
    if (finding.type === "filler_only") return !page;
    if (finding.before && finding.after) return !pageText.includes(finding.before) && pageText.includes(finding.after);
    if (finding.source && finding.suggestion) return !pageText.includes(finding.source) && pageText.includes(finding.suggestion);
    return reviewedFindings[finding.id] === "accepted";
  }

  if (!electronReady) {
    return (
      <div className="browserNotice">
        <h1>Cat-Cut は Electron アプリです</h1>
        <p>
          ブラウザ（Simple Browser / Chrome）で <code>http://127.0.0.1:5174</code> を開いても動きません。
        </p>
        <ol>
          <li>ターミナルで <code>cd video-podcast-saas/editor/desktop</code></li>
          <li>
            <code>nodenv exec npm run dev</code> を実行
          </li>
          <li>数秒待つと <strong>別ウィンドウ</strong>（Electron）が自動で開きます</li>
          <li>Dock に「Electron」または Cat-Cut ウィンドウが出ているか確認してください</li>
        </ol>
        <p className="browserNoticeHint">
          既に dev を起動済みなら、ブラウザのタブは閉じて Electron ウィンドウを探してください。
        </p>
      </div>
    );
  }

  if (!settings) {
    return <div className="boot">Cat-Cut</div>;
  }

  const statusLabel = running ? "処理中" : reviewState ? "レビュー中" : outputs ? "完了" : "待機中";
  const plannedOutputPath = outputPathFromSettings(settings, videoPath);
  const outputFilePlaceholder = defaultOutputFileName(videoPath);
  const logPanel = (
    <section className={`logPanel ${reviewState ? "reviewLogPanel" : ""}`}>
      <div className="logHeader">
        <span>ログ</span>
        <button onClick={() => setLogs("")}>消去</button>
      </div>
      <pre ref={logRef}>{logs || " "}</pre>
    </section>
  );

  return (
    <main className="appShell">
      <section className="leftPane">
        <header className="topBar">
          <div>
            <h1>Cat-Cut</h1>
            <p>{runName || "動画編集ワークフロー"}</p>
          </div>
          <div className="topBarActions">
            <button
              className="secondaryButton apiSettingsButton"
              type="button"
              onClick={() => {
                setApiWizardRequired(false);
                setApiWizardOpen(true);
              }}
              disabled={running}
              title="APIキー設定"
            >
              ⚙ API設定
            </button>
            <div className={`runBadge ${running ? "active" : outputs ? "done" : reviewState ? "review" : ""}`}>
              {statusLabel}
            </div>
          </div>
        </header>

        <section className="panel">
          <div className="panelTitle">
            <Video size={18} />
            <span>動画</span>
          </div>
          <div className="pathRow">
            <input value={videoPath} onChange={(event) => setVideoPath(event.target.value)} />
            <button className="iconButton" onClick={chooseVideo} title="動画を選択">
              <FolderOpen size={18} />
            </button>
          </div>
        </section>

        <section className="panel outputPanel">
          <div className="panelTitle">
            <Download size={18} />
            <span>動画の保存先</span>
          </div>
          <label className="outputField">
            <span>保存場所</span>
            <div className="pathRow">
              <input value={settings.outputDirectory || "未指定: 作業フォルダ内に保存"} readOnly />
              <button className="iconButton" onClick={chooseOutputDirectory} disabled={running} title="保存場所を選択">
                <FolderOpen size={18} />
              </button>
            </div>
          </label>
          <label className="outputField">
            <span>ファイル名</span>
            <input
              defaultValue={settings.outputFileName}
              disabled={running}
              key={settings.outputFileName}
              onBlur={(event) => saveCurrentSettings({ outputFileName: ensureMp4FileName(event.currentTarget.value) })}
              placeholder={outputFilePlaceholder}
            />
          </label>
          <button className="secondaryButton outputSaveAsButton" onClick={chooseOutputFile} disabled={running} type="button">
            <Save size={16} />
            <span>名前を付けて保存</span>
          </button>
          <div className="outputPreviewPath">
            {plannedOutputPath || "未指定の場合は作業フォルダ内の output/final.mp4 に保存されます"}
          </div>
        </section>

        <section className="panel settingsGrid">
          <div className="field">
            <label>STT</label>
            <select
              value={settings.sttProvider}
              onChange={(event) =>
                saveCurrentSettings({ sttProvider: event.target.value as Settings["sttProvider"] })
              }
              disabled={running}
            >
              <option value="elevenlabs">ElevenLabs</option>
              <option value="local-whisper">Local Whisper</option>
            </select>
          </div>

          <div className="field">
            <label>Whisper</label>
            <select
              value={settings.whisperModel}
              onChange={(event) => saveCurrentSettings({ whisperModel: event.target.value })}
              disabled={running || settings.sttProvider !== "local-whisper"}
            >
              <option value="small">small</option>
              <option value="medium">medium</option>
              <option value="large-v3">large-v3</option>
            </select>
          </div>

          <div className="exportModeChoices apiField" role="group" aria-label="書き出し方法">
            <button
              type="button"
              className={settings.reviewBeforeExport ? "active" : ""}
              onClick={() => saveCurrentSettings({ reviewBeforeExport: true, renderFinal: true })}
              disabled={running}
            >
              書き出し前にユーザーがレビューする
            </button>
            <button
              type="button"
              className={!settings.reviewBeforeExport ? "active" : ""}
              onClick={() => saveCurrentSettings({ reviewBeforeExport: false, renderFinal: true })}
              disabled={running}
            >
              チェックなしでMP4まで書き出す
            </button>
          </div>
        </section>

        {FEATURES.fontDirectivesUi && (
          <section className="panel fontStartPanel">
            <div className="panelTitle">
              <Type size={18} />
              <span>開始時のフォント</span>
            </div>
            <div className="fontStartChoices">
              <button
                type="button"
                className={fontProfileMode === "saved" ? "active" : ""}
                disabled={running || fontProfiles.length === 0}
                onClick={() =>
                  saveCurrentSettings({
                    fontProfileMode: "saved",
                    selectedFontProfileId: selectedFontProfileId || fontProfiles[0]?.id || "",
                  })
                }
              >
                過去に保存したフォントを使う
              </button>
              <button
                type="button"
                className={fontProfileMode === "new" ? "active" : ""}
                disabled={running}
                onClick={() => saveCurrentSettings({ fontProfileMode: "new" })}
              >
                フォントを新しく指定する
              </button>
            </div>
            {fontProfileMode === "saved" ? (
              <div className="fontProfilePicker">
                <label>
                  保存済み
                  <select
                    value={selectedFontProfileId}
                    onChange={(event) => {
                      const profile = fontProfiles.find((item) => item.id === event.target.value);
                      if (profile) applyProfileToBuilder(profile);
                      saveCurrentSettings({ selectedFontProfileId: event.target.value, fontProfileMode: "saved" });
                    }}
                    disabled={running || fontProfiles.length === 0}
                  >
                    {fontProfiles.map((profile) => (
                      <option value={profile.id} key={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                  </select>
                </label>
                <span>
                  {selectedSavedFontProfile
                    ? `${Math.max(1, Math.min(fontSceneOrder.length, selectedSavedFontProfile.patternCount))}種類`
                    : "保存済みなし"}
                </span>
              </div>
            ) : (
              <p className="fontStartNote">レビュー画面でQ&Aから新しいフォント設定を作成します。</p>
            )}
          </section>
        )}

        <section className="actionBar">
          <button className="primaryButton" onClick={startJob} disabled={!canStart}>
            <Play size={18} />
            <span>開始</span>
          </button>
          <button className="secondaryButton" onClick={cancelJob} disabled={!running}>
            <Square size={16} />
            <span>停止</span>
          </button>
        </section>

        {runDir && (
          <section className="panel compactPanel">
            <div className="metaLine">
              <span>作業</span>
              <button onClick={() => window.catcut.revealPath(runDir)}>{runDir}</button>
            </div>
          </section>
        )}

        {error && <div className="errorBox">{error}</div>}

        {outputs && (
          <section className="panel outputs">
            <div className="panelTitle">
              <CheckCircle2 size={18} />
              <span>書き出し結果</span>
            </div>
            <button className="wideOutputButton" onClick={restoreReviewFromOutputs}>レビューに戻る</button>
            <button onClick={() => window.catcut.openPath(outputs.finalVideo)}>MP4を開く</button>
            <button onClick={() => window.catcut.revealPath(outputs.finalVideo)}>保存場所</button>
            <button onClick={() => window.catcut.openPath(outputs.telop)}>telop.txt</button>
            <button onClick={() => window.catcut.openPath(outputs.telopStylePlan)}>style_plan.json</button>
            <button onClick={() => window.catcut.openPath(outputs.telopReview)}>telop_review.json</button>
            <button onClick={() => window.catcut.openPath(outputs.transcriptPatch)}>transcript_patch.json</button>
            <button onClick={() => window.catcut.revealPath(outputs.runDir)}>Finder</button>
          </section>
        )}
      </section>

      <section className={`rightPane ${reviewState ? "reviewMode" : ""}`}>
        <section className="stepsPanel">
          <div className="stepsHeader">
            <span>処理状況</span>
            {exportProgress > 0 && exportProgress < 100 && <strong>書き出し {exportProgress}%</strong>}
          </div>
          {exportProgress > 0 && exportProgress < 100 && (
            <div className="progressTrack">
              <div className="progressFill" style={{ width: `${exportProgress}%` }} />
            </div>
          )}
          <div className="stepsList">
            {steps.map((step) => (
              <div className={`stepItem ${step.status}`} key={step.id}>
                <StepIcon status={step.status} />
                <span>{step.label}</span>
              </div>
            ))}
          </div>
        </section>

        {reviewState && reviewStage === "transcript" && transcriptState && FEATURES.legacyReviewUi && (
          <section className="transcriptWorkspace">
            <div className="transcriptWorkspaceHeader">
              <div className="panelTitle">
                <FileText size={18} />
                <span>トランスクリプトエディタ</span>
              </div>
              <div className="transcriptWorkspaceActions">
                {!followAlongMode && (
                  <button
                    className="followAlongStartButton"
                    disabled={!transcriptState.words.length}
                    onClick={startFollowAlong}
                    type="button"
                  >
                    <Play size={16} />
                    <span>追い読み開始</span>
                  </button>
                )}
                {FEATURES.commandPalette && (
                  <button onClick={() => setCommandPaletteOpen(true)} type="button">
                    Cmd+K
                  </button>
                )}
                {FEATURES.telopStage ? (
                  <button onClick={() => setReviewStage("telop")} type="button">
                    テロップ確認へ
                  </button>
                ) : (
                  <button
                    className="primaryButton compactPrimary"
                    disabled={running}
                    onClick={exportFromTranscriptStage}
                    type="button"
                  >
                    <Download size={16} />
                    <span>書き出し</span>
                  </button>
                )}
              </div>
            </div>
            {followAlongMode && (
              <div className="followAlongBar">
                <span className="followAlongBadge">
                  <Play size={12} />
                  追い読みモード
                </span>
                <div className="followAlongKeyGuide">
                  <span>
                    <kbd>Space</kbd>直前の単語を修正
                  </span>
                  <span>
                    <kbd>Enter</kbd>確定して再開
                  </span>
                  <span>
                    <kbd>Esc</kbd>キャンセル/終了
                  </span>
                  <span>
                    <kbd>←</kbd>
                    <kbd>→</kbd>1単語シーク
                  </span>
                  <span>
                    <kbd>D</kbd>カット切替
                  </span>
                </div>
                <div className="followAlongSpeedControl">
                  {PLAYBACK_RATES.map((rate) => (
                    <button
                      className={playbackRate === rate ? "active" : ""}
                      key={rate}
                      onClick={() => setPlaybackRate(rate)}
                      type="button"
                    >
                      {rate}x
                    </button>
                  ))}
                </div>
                <span className="followAlongProgress">
                  追い読み済み {computeReadThroughProgressPercent(maxReachedMs, transcriptState.originalDurationMs)}%
                </span>
                <button className="followAlongExitButton" onClick={stopFollowAlong} type="button">
                  <X size={14} />
                  終了
                </button>
              </div>
            )}
            <div className="transcriptGuide">
              AIがカットした箇所は<span className="transcriptGuideStrike">取り消し線</span>で表示されています。
              単語をクリックすると文字を修正、ダブルクリックでカット/復元を切り替えられます。
              左の「要確認リスト」でAIが疑わしいと判断した箇所を確認し、確認できたら「編集を適用」→「書き出し」と進んでください。
              「追い読み開始」で全文を聴きながら倍速検品できます。
              下のカットカードの波形で、テキスト区間と動画カット区間がズレていないか目で確認できます。
            </div>
            <CutCardsPanel
              focusSegmentIndex={focusCutCardSegmentIndex}
              keepSegments={keepSegmentsHistory.keepSegments}
              onCommitBoundaryDrag={handleCommitBoundaryDrag}
              onFocusConsumed={() => setFocusCutCardSegmentIndex(null)}
              onSeek={(ms) => setTranscriptSeekMs(ms)}
              onSelectBoundary={handleSelectBoundary}
              selectedBoundary={selectedBoundary}
              waveform={waveform}
              waveformError={waveformError}
              waveformLoading={waveformLoading}
              words={displayTranscriptWords}
            />
            <div className="transcriptThreePane">
              <div className="transcriptLeftColumn">
                <SuspicionQueuePanel
                  activeItemId={activeSuspicionId}
                  aiReviewEnabled={transcriptState.aiReview?.enabled === true}
                  items={suspicionItems}
                  onFixItem={fixSuspicionItem}
                  onSelectItem={selectSuspicionItem}
                  onToggleResolved={toggleSuspicionResolved}
                  resolvedIds={resolvedSuspicionIdSet}
                />
                <AiSuggestionPanel
                  applying={transcriptApplying}
                  canRedo={keepSegmentsHistory.canRedo}
                  canUndo={keepSegmentsHistory.canUndo}
                  filler={transcriptRemovedSummary.filler}
                  onApply={applyTranscriptEdits}
                  onApplyFiller={applyAllFillerCuts}
                  onRedo={keepSegmentsHistory.redo}
                  onRestoreFiller={restoreAllFillerCuts}
                  onUndo={keepSegmentsHistory.undo}
                  silence={transcriptRemovedSummary.silence}
                />
              </div>
              <TranscriptEditor
                activeWordId={activeTranscriptWordId}
                correctionOriginals={wordCorrectionHistory}
                editRequestWordId={editRequestWordId}
                fillerWordIds={transcriptFillerWordIdSet}
                flashWordId={flashWordId}
                keepSegments={keepSegmentsHistory.keepSegments}
                manualRemovedWordIds={keepSegmentsHistory.manualRemovedSet}
                onCorrectWord={correctWord}
                onEditFinished={handleFollowAlongEditFinished}
                onEditRequestConsumed={() => setEditRequestWordId(null)}
                onSeekWord={(word) => {
                  setActiveTranscriptWordId(word.id);
                  setTranscriptSeekMs(word.startMs);
                }}
                onToggleWordIds={toggleTranscriptWordIds}
                sentences={transcriptState.sentences}
                words={displayTranscriptWords}
              />
              <PreviewPlayer
                keepSegments={keepSegmentsHistory.keepSegments}
                onActiveWordChange={setActiveTranscriptWordId}
                onSeekConsumed={() => setTranscriptSeekMs(null)}
                onTimeUpdate={(currentMs) => setMaxReachedMs((current) => Math.max(current, currentMs))}
                playbackRate={playbackRate}
                ref={previewPlayerRef}
                seekMs={transcriptSeekMs}
                videoUrl={transcriptState.sourceVideoUrl}
                words={transcriptState.words}
              />
            </div>
          </section>
        )}

        {reviewState && reviewStage === "transcript" && transcriptState && !FEATURES.legacyReviewUi && (
          <section className="transcriptWorkspace sceneWorkspaceSection">
            <div className="sceneThemeBar">
              <div className="sceneThemeBarThemes">
                {isDirectedTelopMode ? (
                  // フェーズT2.5-4(directedモード): テーマ×感情の代わりに
                  // 「シーン種類→プリセット」の設定ビューを開くボタンを出す。
                  <>
                    <span className="sceneThemeBarLabel">テロップデザイン</span>
                    <button
                      className="sceneThemeOpenButton"
                      onClick={() => setTelopTypeMappingOpen(true)}
                      type="button"
                    >
                      <span className="sceneThemeCardLabel">シーンの種類ごとの割り当て</span>
                      <span className="sceneThemeOpenButtonHint">変更…</span>
                    </button>
                  </>
                ) : (
                  <>
                    <span className="sceneThemeBarLabel">テロップテーマ</span>
                    <button className="sceneThemeOpenButton" onClick={() => setThemeGalleryOpen(true)} type="button">
                      <TelopStyleSample
                        className="sceneThemeCardSample"
                        fontSizePx={20}
                        style={describeThemeCard(telopThemeId).sampleStyle}
                      />
                      <span className="sceneThemeCardLabel">
                        {telopThemeId === SAVED_THEME_ID
                          ? `保存済み: ${primaryFontProfile?.name || ""}`
                          : describeThemeCard(telopThemeId).label}
                      </span>
                      <span className="sceneThemeOpenButtonHint">変更…</span>
                    </button>
                  </>
                )}
              </div>
              <div className="sceneThemeBarRight">
                <button
                  className="primaryButton compactPrimary"
                  disabled={running || sceneApplying}
                  onClick={exportFromScenes}
                  type="button"
                >
                  <Download size={16} />
                  <span>書き出し</span>
                </button>
                {scenesHistory.scenes.length > 0 && (
                  <span className="sceneThemeBarProgress">
                    検品{" "}
                    {scenesHistory.scenes.findIndex((scene) => scene.id === currentSceneId) + 1 || 1}/
                    {scenesHistory.scenes.length}
                  </span>
                )}
              </div>
            </div>
            <div className="transcriptWorkspaceHeader">
              <div className="panelTitle">
                <FileText size={18} />
                <span>シーン検品</span>
              </div>
              <div className="transcriptWorkspaceActions">
                <button disabled={!scenesHistory.canUndo} onClick={scenesHistory.undo} type="button">
                  元に戻す
                </button>
                <button disabled={!scenesHistory.canRedo} onClick={scenesHistory.redo} type="button">
                  やり直す
                </button>
                <button
                  className="transcriptApplyButton"
                  disabled={sceneApplying}
                  onClick={applySceneEdits}
                  type="button"
                >
                  {sceneApplying ? "適用中…" : "編集を適用"}
                </button>
                <button
                  className="primaryButton compactPrimary"
                  disabled={running || sceneApplying}
                  onClick={exportFromScenes}
                  type="button"
                >
                  <Download size={16} />
                  <span>書き出し</span>
                </button>
              </div>
            </div>
            <div className="transcriptGuide">
              チップをクリックするとその位置へ再生バーを確定します。チップを右クリック(または削除済みチップをクリック)するとカット/復元を切り替えられます。
              チップ列をドラッグすると範囲選択でき、Deleteでまとめて削除できます。
              下のテキスト枠は自由に書き換えられます(動画のタイミングには影響しません。書き換えると青字になります。クリックでそのシーンの先頭から再生します)。
              波形の左右端のつまみをドラッグすると動画の幅を微調整できます(🔗マークの行は隣と連動して伸縮します)。
              「要確認」タブでAIが疑わしいと判断した箇所を確認してください。
              確認できたら「編集を適用」→「書き出し」と進んでください。
            </div>
            <div className="sceneTabs">
              {aiReviewBanner ? (
                <p className={`sceneAiReviewBanner sceneAiReviewBanner--${aiReviewBanner.severity}`}>
                  {aiReviewBanner.message}
                </p>
              ) : null}
              {transcriptState.aiReview?.enabled ? (
                <p className="sceneAiReviewSummary">
                  AI校正済み・残り{sceneSuspicionItems.length}件を確認すれば完了です
                </p>
              ) : null}
              {sceneAiUsageSummary ? (
                <p className="sceneAiUsageSummary">{sceneAiUsageSummary}</p>
              ) : null}
              <button
                className={sceneFilter === "all" ? "active" : ""}
                onClick={() => setSceneFilter("all")}
                type="button"
              >
                すべて ({scenesHistory.scenes.length})
              </button>
              <button
                className={sceneFilter === "flagged" ? "active" : ""}
                onClick={() => setSceneFilter("flagged")}
                type="button"
              >
                要確認 ({flaggedScenes.length})
              </button>
              <button
                className="sceneInspectionCopyButton"
                disabled={scenesHistory.scenes.length === 0}
                onClick={() => void handleCopyInspectionText()}
                title="全シーンのテロップと警告をプレーンテキストでコピー（開発用）"
                type="button"
              >
                <Copy size={14} />
                <span>テキストをコピー</span>
              </button>
            </div>
            <div className="sceneMainArea">
              <div className="scenePreviewColumn">
                <PreviewPlayer
                  keepSegments={scenesHistory.keepSegments}
                  onActiveWordChange={setActiveTranscriptWordId}
                  onPlayingChange={setIsPreviewPlaying}
                  onSeekConsumed={() => setTranscriptSeekMs(null)}
                  onTimeUpdate={handleScenePreviewTimeUpdate}
                  playbackRate={playbackRate}
                  ref={previewPlayerRef}
                  seekMs={transcriptSeekMs}
                  telopText={currentScene?.telopText || ""}
                  telopStyle={currentSceneTelopStyle}
                  telopFontSize={transcriptState.telopFontSize}
                  telopBaseWidth={transcriptState.telopBaseWidth}
                  telopMaxCharsPerLine={transcriptState.telopMaxCharsPerLine}
                  videoUrl={transcriptState.sourceVideoUrl}
                  words={transcriptState.words}
                />
                <div className="sceneKeyGuide">
                  <div className="sceneKeyGuideRow">
                    <kbd>Space</kbd>
                    <span>再生/停止(ホバー中の行があればその行を再生)</span>
                  </div>
                  <div className="sceneKeyGuideRow">
                    <kbd>L</kbd>
                    <span>倍速 {playbackRate}x</span>
                  </div>
                  <div className="sceneKeyGuideRow">
                    <kbd>←</kbd>
                    <kbd>→</kbd>
                    <span>音節移動</span>
                  </div>
                  <div className="sceneKeyGuideRow">
                    <kbd>↑</kbd>
                    <kbd>↓</kbd>
                    <span>行移動</span>
                  </div>
                  <div className="sceneKeyGuideRow">
                    <kbd>Delete</kbd>
                    <span>左隣を削除(選択中はまとめて削除)</span>
                  </div>
                  <div className="sceneKeyGuideRow">
                    <kbd>Enter</kbd>
                    <span>ここで分割</span>
                  </div>
                  <div className="sceneKeyGuideRow">
                    <kbd>⌘M</kbd>
                    <span>下の行と結合</span>
                  </div>
                  <div className="sceneKeyGuideRow">
                    <kbd>Tab</kbd>
                    <span>この行だけ再生</span>
                  </div>
                  <div className="sceneKeyGuideRow">
                    <kbd className={scissorsMode ? "active" : ""}>B</kbd>
                    <span>ハサミ(クリックで分割){scissorsMode ? ": ON" : ""}</span>
                  </div>
                  <div className="sceneKeyGuideRow">
                    <kbd>A</kbd>
                    <span>ハサミ解除(Escでも解除)</span>
                  </div>
                </div>
              </div>
              <div
                className="sceneRowListPane"
                onMouseLeave={() => {
                  hoveredSceneIdRef.current = null;
                }}
                onMouseMove={(event) => {
                  // 改善5-9(ホバー行からSpace再生): マウスが乗っている行のsceneIdを追跡する
                  // (高頻度更新のため再描画を伴わないrefに保持する)。
                  const rowEl = (event.target as HTMLElement).closest(".sceneRow") as HTMLElement | null;
                  hoveredSceneIdRef.current = rowEl?.dataset.sceneId || null;
                }}
              >
                <SceneRowList
                  binMs={waveform?.binMs || 20}
                  chipSelection={chipSelection}
                  currentSceneId={currentSceneId}
                  edgeVisualBySceneId={edgeVisualBySceneId}
                  globalPeakMax={globalPeakMax}
                  isPlaybackActive={isPreviewPlaying}
                  onCaretConfirm={pauseIfPlaying}
                  onChipCaretChange={handleChipCaretChange}
                  onChipSelectionChange={handleChipSelectionChange}
                  onEditingChange={(editing) => {
                    isEditingSceneTelopRef.current = editing;
                  }}
                  editingRef={isEditingSceneTelopRef}
                  onEdgeDragEnd={handleSceneEdgeDragEnd}
                  onEdgeDragMove={handleSceneEdgeDragMove}
                  onHoverSeek={(ms) => setTranscriptSeekMs(ms)}
                  onPlayScene={playScene}
                  onScissorsCutMs={handleScissorsCutAtMs}
                  onScissorsSplitChip={handleScissorsSplitChip}
                  onSeek={(ms) => setTranscriptSeekMs(ms)}
                  onTelopBlur={handleTelopBlur}
                  onTelopChange={(sceneId, text) => scenesHistory.setTelopText(sceneId, text)}
                  onTelopFocus={handleTelopFocus}
                  onToggleChip={(sceneId, wordIds) => scenesHistory.toggleChipGroup(sceneId, wordIds)}
                  peaks={waveform?.peaks || []}
                  playheadMs={previewCurrentMs}
                  scenes={renderedScenes}
                  scissorsMode={scissorsMode}
                  suspicionsBySceneId={sceneSuspicionsBySceneId}
                  onOpenApiSettings={() => {
                    setApiWizardRequired(false);
                    setApiWizardOpen(true);
                  }}
                  themeId={telopThemeId}
                  onSetEmotionTag={(sceneId, tag) => scenesHistory.setEmotionTag(sceneId, tag)}
                  onSetStyleOverride={(sceneId, styleId) => scenesHistory.setStyleOverride(sceneId, styleId)}
                  onApplyStyleToEmotionGroup={(sceneId, styleId) =>
                    scenesHistory.applyStyleToEmotionGroup(sceneId, styleId)
                  }
                  directedMode={isDirectedTelopMode}
                  telopTypeMapping={telopTypeMapping}
                  onSetDirectedType={(sceneId, typeId) => scenesHistory.setDirectedType(sceneId, typeId)}
                  onSetDirectedStyle={(sceneId, styleId) => scenesHistory.setDirectedStyle(sceneId, styleId)}
                />
              </div>
            </div>
            <SceneNavBar
              binMs={waveform?.binMs || 20}
              currentMs={previewCurrentMs}
              durationMs={transcriptState.originalDurationMs}
              flagMarkers={sceneNavFlagMarkers}
              onSeek={(ms) => setTranscriptSeekMs(ms)}
              peaks={waveform?.peaks || []}
            />
          </section>
        )}

        {FEATURES.telopStage && reviewState && reviewStage === "telop" && (
          <section className="reviewPanel">
            <div className="reviewHeader">
              <div className="panelTitle">
                <FileText size={18} />
                <span>書き出し前チェック</span>
              </div>
              <div className="transcriptWorkspaceActions">
                <strong>{reviewState.review?.stats?.findings ?? suspiciousFindings.length}件</strong>
                <button onClick={() => setReviewStage("transcript")} type="button">
                  トランスクリプトへ戻る
                </button>
              </div>
            </div>

            <div className="reviewGrid">
              <div className="findingsList">
                {suspiciousFindings.length === 0 && <div className="emptyFindings">候補なし</div>}
                {suspiciousFindings.map((finding) => {
                  const draft = replacementDrafts[finding.id] ?? finding.suggestion ?? "";
                  const status = reviewedFindings[finding.id];
                  const applied = isFindingApplied(finding);
                  const sourceLabel = finding.source || finding.before || "";
                  const suggestionLabel = draft || finding.after || finding.suggestion || "削除";
                  return (
                    <div
                      className={`findingItem ${finding.severity} ${activePageId === finding.page_id ? "active" : ""}`}
                      key={finding.id}
                      onClick={() => setActivePageId(finding.page_id)}
                    >
                      <div className="findingMeta">
                        <AlertTriangle size={15} />
                        <span>{findingLabel(finding.type)}</span>
                        <em>{findingSourceLabel(finding)}</em>
                        <code>{finding.page_id}</code>
                      </div>
                      <div className="candidatePair">
                        <span>{sourceLabel || finding.message}</span>
                        <strong>{suggestionLabel}</strong>
                      </div>
                      <div className="findingText">{finding.message}</div>
                      {finding.type !== "filler_only" && (
                        <div className="replacementRow">
                          <input
                            value={draft}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) =>
                              setReplacementDrafts((current) => ({
                                ...current,
                                [finding.id]: event.target.value,
                              }))
                            }
                          />
                        </div>
                      )}
                      <div className="findingActions">
                        <button
                          type="button"
                          className={applied || status === "accepted" ? "accepted" : ""}
                          onClick={(event) => {
                            event.stopPropagation();
                            applyFinding(finding);
                          }}
                        >
                          <Check size={14} />
                          <span>{applied || status === "accepted" ? "採用済み" : "採用"}</span>
                        </button>
                        <button
                          type="button"
                          className={status === "ignored" ? "ignored" : ""}
                          onClick={(event) => {
                            event.stopPropagation();
                            ignoreFinding(finding);
                          }}
                        >
                          <X size={14} />
                          <span>{status === "ignored" ? "保留中" : "保留"}</span>
                        </button>
                        <button
                          type="button"
                          disabled={!(finding.source || finding.before) || !(draft || finding.suggestion || finding.after)}
                          onClick={(event) => {
                            event.stopPropagation();
                            saveFindingAsRule(finding);
                          }}
                        >
                          <Save size={14} />
                          <span>辞書に保存</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              <textarea
                className="telopEditor"
                value={telopText}
                onChange={(event) => {
                  setTelopText(event.target.value);
                  markReviewDraftChanged();
                }}
                spellCheck={false}
              />
            </div>

            {FEATURES.groundTruth && ENABLE_RULE_LAB && (
              <div className="groundTruthBox ruleLabBox">
                <div className="groundTruthHeader">
                  <div className="panelTitle">
                    <FileText size={17} />
                    <span>開発用 ルール検証</span>
                  </div>
                  <strong>{ruleLabReport ? `${ruleLabReport.proposals.length}件のルール案` : groundTruth ? `${groundTruth.stats.entries}ページ` : "未読み込み"}</strong>
                </div>
                <p>
                  正解txtとの差分を4層で確認します。ここではテロップ本文・プレビュー・正式ルールは自動変更せず、
                  採用したルールだけを今後のレビュー候補として保存します。
                </p>
                <div className="groundTruthActions">
                  <button type="button" onClick={chooseGroundTruthText} disabled={ruleLabAnalyzing || running}>
                    <FolderOpen size={15} />
                    <span>正解txtを読み込む</span>
                  </button>
                  <button
                    type="button"
                    className="primarySmall"
                    onClick={analyzeGroundTruthRules}
                    disabled={!groundTruth || ruleLabAnalyzing || running}
                  >
                    {ruleLabAnalyzing ? <Loader2 size={15} /> : <Wand2 size={15} />}
                    <span>{ruleLabAnalyzing ? "解析中" : "差分を解析"}</span>
                  </button>
                </div>
                {groundTruth && (
                  <div className="groundTruthStats">
                    <span>{groundTruth.path}</span>
                    <em>
                      {formatMsClock(groundTruth.stats.firstStartMs)} - {formatMsClock(groundTruth.stats.lastEndMs)}
                    </em>
                    <em>平均 {groundTruth.stats.avgDurationMs}ms</em>
                  </div>
                )}
                <div className="localAiReviewStatus">
                  {groundTruthMessage || "正解txtを読み込み、「差分を解析」を押すと、差分・分類・ルール案・保存操作を表示します。"}
                </div>
                {ruleLabReport && (
                  <div className="ruleLabContent">
                    <div className="ruleLabSummary">
                      <div>
                        <span>正解ページ</span>
                        <strong>{ruleLabReport.summary.truthPages}</strong>
                      </div>
                      <div>
                        <span>生成ページ</span>
                        <strong>{ruleLabReport.summary.generatedPages}</strong>
                      </div>
                      <div>
                        <span>完全一致</span>
                        <strong>{ruleLabReport.summary.exactMatches}</strong>
                      </div>
                      <div>
                        <span>差分あり</span>
                        <strong>{ruleLabReport.summary.mismatchPages}</strong>
                      </div>
                    </div>

                    <div className="ruleLabLayer">
                      <div className="ruleLabLayerTitle">
                        <strong>1. 差分表示</strong>
                        <span>STT / 生成テロップ / 正解txt を時間で対応付け</span>
                      </div>
                      <div className="ruleLabFilters">
                        <button type="button" className={ruleLabFilter === "all" ? "active" : ""} onClick={() => setRuleLabFilter("all")}>
                          全て
                        </button>
                        {Object.entries(ruleLabReport.summary.typeCounts).map(([type, count]) => (
                          <button
                            type="button"
                            className={ruleLabFilter === type ? "active" : ""}
                            onClick={() => setRuleLabFilter(type)}
                            key={type}
                          >
                            {findingLabel(type)} {count}
                          </button>
                        ))}
                      </div>
                      <div className="ruleDiffList">
                        {ruleLabRows.map((row) => (
                          <button
                            type="button"
                            className={`ruleDiffItem ${row.severity}`}
                            key={row.id}
                            onClick={() => row.pageId && setActivePageId(row.pageId)}
                          >
                            <div className="ruleDiffMeta">
                              <code>{row.pageId || row.truthId}</code>
                              <span>{row.types.map(findingLabel).join(" / ") || "差分なし"}</span>
                              <em>開始 {row.startOffsetMs == null ? "-" : `${row.startOffsetMs}ms`}</em>
                            </div>
                            <div className="ruleDiffTexts">
                              <span>
                                <b>STT</b>
                                {row.sttText || "なし"}
                              </span>
                              <span>
                                <b>生成</b>
                                {row.generatedText || "なし"}
                              </span>
                              <strong>
                                <b>正解</b>
                                {row.truthText}
                              </strong>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="ruleLabLayer">
                      <div className="ruleLabLayerTitle">
                        <strong>2. 問題タイプ分類</strong>
                        <span>数字・固有名詞・相槌・境界・改行に分けて見る</span>
                      </div>
                      <div className="ruleTypeGrid">
                        {Object.entries(ruleLabReport.summary.typeCounts).map(([type, count]) => (
                          <button type="button" onClick={() => setRuleLabFilter(type)} key={type}>
                            <span>{findingLabel(type)}</span>
                            <strong>{count}</strong>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="ruleLabLayer">
                      <div className="ruleLabLayerTitle">
                        <strong>3. ルール案</strong>
                        <span>採用したものだけ次回以降のレビューに使う</span>
                      </div>
                      <div className="ruleProposalList">
                        {ruleLabReport.proposals.map((proposal) => (
                          <div className="ruleProposalItem" key={proposal.id}>
                            <div>
                              <span>{findingLabel(proposal.type)}</span>
                              <strong>{proposal.title}</strong>
                              <p>{proposal.description}</p>
                              <em>根拠 {proposal.evidenceCount}件</em>
                            </div>
                            <div className="ruleProposalActions">
                              <button
                                type="button"
                                disabled={ruleProposalSaving[proposal.id]}
                                onClick={() => saveGroundTruthRuleProposal(proposal, "review")}
                              >
                                <CheckCircle2 size={14} />
                                <span>{proposal.kind === "dictionary" ? "辞書に追加" : "毎回チェックに追加"}</span>
                              </button>
                              <button
                                type="button"
                                disabled={ruleProposalSaving[proposal.id]}
                                onClick={() => saveGroundTruthRuleProposal(proposal, "ignore_forever")}
                              >
                                <X size={14} />
                                <span>永久に無視</span>
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="ruleLabLayer compact">
                      <div className="ruleLabLayerTitle">
                        <strong>4. 保存後の反映</strong>
                        <span>
                          保存した確認ルールはこの下の「学習辞書」とレビュー候補に入り、次回以降のテロップ確認で表示されます。
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {FEATURES.ollama && (
            <div className="localAiReviewBox">
              <div className="localAiReviewHeader">
                <div className="panelTitle">
                  <Wand2 size={17} />
                  <span>ローカルAIレビュー</span>
                </div>
                <strong>
                  {!ollamaStatus
                    ? "未確認"
                    : !ollamaStatus.installed
                      ? "Ollama未導入"
                      : !ollamaStatus.running
                        ? "Ollama停止中"
                        : ollamaStatus.modelInstalled
                          ? "利用可能"
                          : "モデル未DL"}
                </strong>
              </div>
              <p>
                レビューは「辞書」「境界/改行ルール」「ローカルAI補助」の3層で行います。
                Ollama候補も自動適用せず、採用したものだけ反映します。
              </p>
              <div className="localAiReviewActions">
                <button type="button" onClick={refreshOllamaStatus} disabled={ollamaChecking || ollamaPulling || ollamaReviewing}>
                  {ollamaChecking ? <Loader2 size={15} /> : <CheckCircle2 size={15} />}
                  <span>状態を確認</span>
                </button>
                <button
                  type="button"
                  onClick={openOllamaInstallGuide}
                  disabled={ollamaPulling || ollamaReviewing}
                >
                  <FolderOpen size={15} />
                  <span>Ollamaを入れる</span>
                </button>
                <button
                  type="button"
                  onClick={pullOllamaModel}
                  disabled={!ollamaStatus?.installed || ollamaPulling || ollamaReviewing}
                >
                  {ollamaPulling ? <Loader2 size={15} /> : <Download size={15} />}
                  <span>{LOCAL_AI_MODEL} をDL</span>
                </button>
                <button type="button" onClick={runLocalAiReview} disabled={!localAiReady || ollamaReviewing || running}>
                  {ollamaReviewing ? <Loader2 size={15} /> : <Wand2 size={15} />}
                  <span>AIでチェック</span>
                </button>
              </div>
              <div className="localAiReviewStatus">{ollamaMessage || `使用モデル: ${LOCAL_AI_MODEL}`}</div>
            </div>
            )}

            <div className="ruleEditorBox">
              <div className="ruleEditorHeader">
                <div className="panelTitle">
                  <SlidersHorizontal size={17} />
                  <span>学習辞書</span>
                </div>
                <strong>{(userRules?.dictionary.length || 0) + (userRules?.reviewChecks.length || 0)}件</strong>
              </div>
              <p>固有名詞・よくある誤認識・表記統一・確認ルールを保存すると、次回からレビュー候補に出ます。</p>
              <div className="ruleEditorForm">
                <select
                  value={ruleDraft.category}
                  onChange={(event) => setRuleDraft((current) => ({ ...current, category: event.target.value as DictionaryRule["category"] }))}
                >
                  <option value="common_misrecognition">誤認識</option>
                  <option value="proper_noun">固有名詞</option>
                  <option value="notation">表記統一</option>
                </select>
                <input
                  value={ruleDraft.wrong}
                  onChange={(event) => setRuleDraft((current) => ({ ...current, wrong: event.target.value }))}
                  placeholder="誤: マークモシ"
                />
                <input
                  value={ruleDraft.correct}
                  onChange={(event) => setRuleDraft((current) => ({ ...current, correct: event.target.value }))}
                  placeholder="正: マーク模試"
                />
                <button type="button" onClick={() => saveDictionaryRule(ruleDraft)} disabled={rulesSaving}>
                  追加
                </button>
              </div>
              {(userRules?.dictionary.length || 0) > 0 && (
                <div className="ruleList">
                  {userRules?.dictionary.slice(0, 8).map((rule) => (
                    <div className="ruleItem" key={rule.id || `${rule.wrong}-${rule.correct}`}>
                      <span>{rule.category === "proper_noun" ? "固有" : rule.category === "notation" ? "表記" : "誤認識"}</span>
                      <strong>{rule.wrong}</strong>
                      <em>→</em>
                      <strong>{rule.correct}</strong>
                      <button type="button" onClick={() => deleteDictionaryRule(rule)} disabled={rulesSaving}>
                        削除
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {(userRules?.reviewChecks.length || 0) > 0 && (
                <div className="ruleList">
                  {userRules?.reviewChecks.slice(0, 6).map((rule) => (
                    <div className="ruleItem reviewCheckRuleItem" key={String(rule.id || rule.checkType)}>
                      <span>確認</span>
                      <strong>{String(rule.title || rule.checkType || "確認ルール")}</strong>
                      <em>→</em>
                      <strong>候補表示</strong>
                      <button type="button" disabled>
                        保存済み
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {FEATURES.fontDirectivesUi && (
            <div className="fontDesignBox">
              <div className="fontDesignHeader">
                <div className="panelTitle">
                  <Type size={17} />
                  <span>フォント設定</span>
                </div>
                <strong>{fontPlanLabel(reviewState.fontPlan)}</strong>
              </div>

              {fontProfileMode === "saved" && selectedSavedFontProfile && (
                <div className="savedFontSummary">
                  <span>編集中</span>
                  <strong>{selectedSavedFontProfile.name}</strong>
                  <em>{activeFontScenes(builderPatternCount).length}種類</em>
                </div>
              )}

              <div className="fontBuilderGrid">
                <label>
                  Q1 テロップの印象
                  <select value={fontQa.mood} onChange={(event) => updateFontQa({ mood: event.target.value as FontMood })}>
                    {(Object.keys(fontMoodLabels) as FontMood[]).map((key) => (
                      <option value={key} key={key}>
                        {fontMoodLabels[key]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Q2 色の出し方
                  <select
                    value={fontQa.fillMode}
                    onChange={(event) => updateFontQa({ fillMode: event.target.value as FontFillMode })}
                  >
                    {(Object.keys(fontFillModeLabels) as FontFillMode[]).map((key) => (
                      <option value={key} key={key}>
                        {fontFillModeLabels[key]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Q3 文字枠
                  <select
                    value={fontQa.strokeMode}
                    onChange={(event) => updateFontQa({ strokeMode: event.target.value as FontStrokeMode })}
                  >
                    {(Object.keys(fontStrokeModeLabels) as FontStrokeMode[]).map((key) => (
                      <option value={key} key={key}>
                        {fontStrokeModeLabels[key]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  使う種類
                  <select
                    value={builderPatternCount}
                    onChange={(event) => {
                      setBuilderPatternCount(Number(event.target.value));
                      markReviewDraftChanged();
                    }}
                  >
                    {fontSceneOrder.map((_, index) => (
                      <option value={index + 1} key={index + 1}>
                        {index + 1}種類
                      </option>
                    ))}
                  </select>
                </label>
                <label className="fontProfileNameField">
                  保存名
                  <input
                    value={builderProfileName}
                    onChange={(event) => setBuilderProfileName(event.target.value)}
                  />
                </label>
              </div>

              <div className="fontSceneGrid">
                {activeFontScenes(builderPatternCount).map((scene) => (
                  <FontScenePreviewCard
                    editable
                    frameWidth={previewFrameWidth}
                    key={scene}
                    lines={fontPreviewLines}
                    scene={scene}
                    setting={builderScenes[scene]}
                    telopStyle={telopStyles[scene] || telopStyles.default || builtinTelopStyles.default}
                    onChange={(patch) => updateBuilderScene(scene, patch)}
                  />
                ))}
              </div>

              <div className="fontSaveRow">
                <textarea value={builderDirectives} readOnly />
                <button type="button" onClick={saveBuilderFontProfile} disabled={running || fontProfileSaving || fontApplying}>
                  {fontProfileSaving || fontApplying ? <Loader2 size={15} /> : <Save size={15} />}
                  <span>{fontProfileMode === "saved" ? "更新して反映" : "保存して反映"}</span>
                </button>
              </div>
            </div>
            )}

            <div className="reviewActions">
              <div className={`telopConfirmStatus ${telopConfirmed ? "done" : ""}`}>
                {telopConfirmed ? "確定済み。編集すると未確定に戻ります" : "編集内容は未確定です"}
              </div>
              <button onClick={saveTelopOnly} disabled={running}>
                <Save size={16} />
                <span>下書き保存</span>
              </button>
              <button className="confirmTelopButton" onClick={applyTelopStyle} disabled={running || telopStyleApplying}>
                {telopStyleApplying ? <Loader2 size={16} /> : <CheckCircle2 size={16} />}
                <span>{telopStyleApplying ? "反映中" : telopConfirmed ? "再確定" : "テロップを確定"}</span>
              </button>
              <button className="primaryButton compactPrimary" onClick={saveAndExport} disabled={running}>
                <Download size={16} />
                <span>{reviewState.renderFinal ? (telopConfirmed ? "保存して書き出し" : "確定して書き出し") : "保存して反映"}</span>
              </button>
            </div>
          </section>
        )}

        {FEATURES.telopStage && reviewState && reviewStage === "telop" && (
          <section className="previewPanel">
            <div className="previewHeader">
              <div className="panelTitle">
                <Video size={18} />
                <span>プレビュー</span>
              </div>
              <strong>{activePage?.id || ""}</strong>
            </div>
            <div className="previewBody">
              <div className="videoPreviewStage">
                {activePreview ? (
                  <video
                    className="previewVideo"
                    controls
                    key={activePreview.videoUrl}
                    onTimeUpdate={handlePreviewTimeUpdate}
                    preload="metadata"
                    ref={videoRef}
                    src={activePreview.videoUrl}
                  />
                ) : (
                  <div className="previewMissing">プレビュー動画が見つかりません</div>
                )}
                <TelopStylePreview lines={activePageLines} style={activePreviewTelopStyle} className="previewTelop" />
              </div>
              <div className="pageStrip">
                {telopPages.map((page, index) => (
                  <button
                    className={page.id === activePage?.id ? "active" : ""}
                    key={page.id}
                    onClick={() => setActivePageId(page.id)}
                  >
                    {index + 1}
                  </button>
                ))}
              </div>
              <div className="boundaryEditor">
                <div className="boundaryHeader">
                  <span>境界調整</span>
                  <strong>
                    {activePageIndex + 1} / {telopPages.length}
                  </strong>
                </div>
                <div className="boundaryActions">
                  <button type="button" onClick={pullPreviousLastLine} disabled={!previousPage}>
                    前の末尾をここへ
                  </button>
                  <button type="button" onClick={moveActiveFirstLineToPrevious} disabled={!previousPage || activePageLines.length === 0}>
                    先頭を前へ
                  </button>
                  <button type="button" onClick={moveActiveLastLineToNext} disabled={!nextPage || activePageLines.length === 0}>
                    末尾を次へ
                  </button>
                  <button type="button" onClick={pullNextFirstLine} disabled={!nextPage}>
                    次の先頭をここへ
                  </button>
                  <button type="button" onClick={mergeActiveWithPrevious} disabled={!previousPage}>
                    前と結合
                  </button>
                  <button type="button" onClick={mergeActiveWithNext} disabled={!nextPage}>
                    次と結合
                  </button>
                </div>
              </div>
              <label className="pageTelopEditor">
                <span>このシーンのテロップ</span>
                <textarea
                  value={activePageBodyText}
                  onChange={(event) => updateActivePageText(event.target.value)}
                  placeholder="このシーンに表示するテロップを入力"
                  spellCheck={false}
                />
              </label>
            </div>
          </section>
        )}
        {FEATURES.commandPalette && (
          <CommandPalette open={commandPaletteOpen} onClose={() => setCommandPaletteOpen(false)} onSubmit={runDeterministicCommand} />
        )}
        {scissorsMode && <ScissorsCursorOverlay />}
        <TelopReplaceModal
          candidate={telopReplaceCandidate}
          onCancel={handleCancelTelopReplace}
          onConfirm={() => void handleConfirmTelopReplace()}
          onOpenDictionary={() => setUserDictionaryOpen(true)}
          onToggleOccurrence={handleToggleTelopReplaceOccurrence}
          onToggleRegisterDict={setTelopReplaceDictChecked}
          registerDictChecked={telopReplaceDictChecked}
          selectedKeys={telopReplaceSelectedKeys}
        />
        <UserDictionaryModal onClose={() => setUserDictionaryOpen(false)} open={userDictionaryOpen} />
        <TelopTypeMappingModal
          mapping={telopTypeMapping}
          onClose={() => setTelopTypeMappingOpen(false)}
          onSave={async (nextMapping) => {
            // userDataへ永続化 → UIのバッジ色を即更新 → directedプロジェクトへ即時反映
            // (main側のstep08再実行が --type-mapping で最新マッピングを読み、
            // 個別上書きでないスロットのstyleをtypeから再解決する)。
            const saved = await window.catcut.saveTelopTypeMapping(nextMapping);
            setTelopTypeMapping(sanitizeTypeMapping(saved));
            if (isDirectedTelopMode && transcriptState) {
              await applySceneEdits();
            }
          }}
          open={telopTypeMappingOpen}
        />
        {themeGalleryOpen && (
          <TelopThemeGalleryModal
            currentThemeId={telopThemeId}
            onClose={() => setThemeGalleryOpen(false)}
            onDeleteSavedTheme={primaryFontProfile ? handleDeleteSavedTheme : undefined}
            onSelect={(nextThemeId) => {
              handleTelopThemeChange(nextThemeId);
              setThemeGalleryOpen(false);
            }}
            savedProfileName={primaryFontProfile?.name}
            savedThemeAvailable={hasRuntimeTheme(SAVED_THEME_ID)}
            savedThemeLabel={`保存済み: ${primaryFontProfile?.name || ""}`}
          />
        )}
        {inspectionCopyToast && <div className="inspectionCopyToast">{inspectionCopyToast}</div>}
        <ApiKeyWizard
          open={apiWizardOpen}
          onboardingRequired={apiWizardRequired}
          onClose={() => {
            setApiWizardOpen(false);
            setApiWizardRequired(false);
          }}
          onComplete={() => {
            void refreshApiKeysStatus();
          }}
        />
        {logPanel}
      </section>
    </main>
  );
}

/**
 * 改善5-6(ハサミモード): マウスに追従するハサミアイコン(CSSカスタムカーソルの代替)。
 * 高頻度なmousemoveでの再レンダリングを避けるため、stateではなくDOM要素へ直接styleを適用する。
 */
function ScissorsCursorOverlay() {
  const iconRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    function handleMove(event: MouseEvent) {
      const el = iconRef.current;
      if (!el) return;
      el.style.left = `${event.clientX}px`;
      el.style.top = `${event.clientY}px`;
    }
    window.addEventListener("mousemove", handleMove);
    return () => window.removeEventListener("mousemove", handleMove);
  }, []);
  return (
    <div className="scissorsCursorIcon" ref={iconRef}>
      <Scissors size={16} />
    </div>
  );
}
