import { type CSSProperties, type SyntheticEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUp,
  Check,
  CheckCircle2,
  Circle,
  Copy,
  Download,
  FileText,
  Film,
  FolderOpen,
  HardDrive,
  KeyRound,
  Loader2,
  MousePointer2,
  Palette,
  Play,
  Save,
  Undo2,
  Redo2,
  Scissors,
  Settings,
  SlidersHorizontal,
  Square,
  Type,
  Wand2,
  X,
  Video,
} from "lucide-react";
import { ApiKeyWizard } from "./components/ApiKeyWizard";
import "./components/EditorToolControls.css";
// W12-2: ライセンスモーダル(FEATURES.billing ONのときのみ描画)
import { LicenseModal } from "./components/LicenseModal";
// W13-1: キャッシュ管理モーダル(派生キャッシュのサイズ表示・削除)
import { CacheManagerModal } from "./components/CacheManagerModal";
import { AiSuggestionPanel } from "./components/AiSuggestionPanel";
import { CommandPalette, type DeterministicCommand } from "./components/CommandPalette";
import { OrientationChoiceModal, orientationLabel } from "./components/OrientationChoiceModal";
import { CutCardsPanel, type SelectedBoundary } from "./components/CutCardsPanel";
import { PreviewPlayer, type PreviewPlayerHandle } from "./components/PreviewPlayer";
import { SceneNavBar, type NavFlagMarker } from "./components/SceneNavBar";
// フェーズV1(統合タイムラインView): U9のFilmstripStrip/BgmTrackはタイムラインViewへ統合済み
import { TimelineView } from "./components/timeline/TimelineView";
import { SelectionInspector } from "./components/timeline/SelectionInspector";
import { stepPrecisionFrame } from "./lib/precisionMedia";
import { SceneRowList, type ChipSelectionState } from "./components/SceneRowList";
// フェーズW5-8: 要確認パネルのカードへ本物のSceneRowを埋め込む(編集動作の完全一致)
import { SceneRow } from "./components/SceneRow";
// フェーズW5: 要確認パネル(シーン検品リスト上部に常設)
import { ReviewHotspotsPanel } from "./components/ReviewHotspotsPanel";
import { buildReviewHotspots } from "./lib/reviewHotspots";
// W16-7: AI最終チェック(全シーンの表示テキストをLLMで一括再チェック)
import {
  buildFinalCheckScenesPayload,
  buildFinalCheckSuspicions,
  normalizeFinalCheckIssues,
  remapFinalCheckIssues,
  type FinalCheckIssue,
} from "./lib/finalCheck";
// W19-B1: 弱い区間の再文字起こし(step05b)の差分候補 → 要確認パネル項目
import { buildRetranscribeSuspicions, normalizeRetranscribeItems } from "./lib/retranscribe";
// W19-B3: 「AI修正を一括適用」の対象抽出・適用計画(純関数)
import { planBulkApplyAiFixes } from "./lib/aiFixBulkApply";
import { SuspicionQueuePanel } from "./components/SuspicionQueuePanel";
import { TelopReplaceModal, occurrenceKey } from "./components/TelopReplaceModal";
import { UserDictionaryModal } from "./components/UserDictionaryModal";
// W14-2: 編集前→編集後の修正ペア学習(語レベルdiff抽出と学習済み修正の一覧モーダル)
import type { CorrectionHistory } from "./lib/correctionPairs";
import { CorrectionHistoryModal } from "./components/CorrectionHistoryModal";
import { TranscriptEditor } from "./components/TranscriptEditor";
import { nudgeKeepSegmentBoundary, setKeepSegmentBoundaryMs } from "./lib/boundaryNudge";
import { computeBoundaryOverrunHighlights, findBoundaryHighlightByWordId } from "./lib/cutCards";
import { isWordInKeepSegments } from "./lib/keepSegments";
import {
  attachSuspicionsToScenes,
  computeSceneKeptSubRanges,
  deriveTelopStyleIds,
  findNextSelectionAfterSceneDelete,
  findSceneIndexAtEditMs,
  findTelopOccurrencesInOtherScenes,
  initializeScenes,
  type Scene,
} from "./lib/scenes";
import { deriveDirectedSlots, effectiveDirectedStyleId } from "./lib/directedTelop";
// フェーズU6: テロップスタイル詳細エディタ(3経路: プレビュークリック/スタイルバッジ/テーマ調整)
import { TelopStyleEditorModal, type TelopStyleEditorContext } from "./components/TelopStyleEditorModal";
import { TYPE_SAMPLE_TEXT } from "./components/TelopTypeMappingEditor";
import { customSceneStyleId, customThemeStyleId, mergeCustomStyles } from "./lib/telopStyleEditor";
import {
  filterHighlightWords,
  resolveDirectedSceneStyle,
  resolvePreviewAnimation,
  resolvePreviewSfxId,
} from "./lib/previewTelop";
import {
  activeOverlaysAtSourceMs,
  mergeOverlayEdits,
  sanitizeTimelineCutRanges,
  sourceMsToTimelineEditMs,
  timelineMsToSourceMs,
  type OverlayTextEdit,
} from "./lib/previewTimeline";
import { normalizeOverlays, type OverlayItem } from "./lib/overlayItems";
import { normalizeVideoEffects } from "./lib/videoEffects";
import {
  compactRangesToKeepSegments,
  compactedTimelineDurationMs,
  opTimelineShiftMs,
  resolveOpPreviewData,
  shiftTimelineCutRanges,
  shiftTimelineDurationMs,
} from "./lib/previewPlaylist";
import { DEFAULT_TYPE_MAPPING, isSemanticType, sanitizeTypeMapping, type SemanticType, type TelopTypeMapping } from "./lib/telopTypes";
import { TelopTypeMappingModal, type DesignExtras } from "./components/TelopTypeMappingModal";
import {
  DEFAULT_OP_CONFIG,
  DEFAULT_OVERLAY_TITLE,
  DEFAULT_VIDEO_EFFECTS,
  sanitizeOpConfig,
  sanitizeOverlayTitle,
  sanitizeVideoEffects,
} from "./lib/designExtras";
// フェーズW23: ステージ別UI最小化(home/analyzing/editing)の導出
import { uiStageFor } from "./lib/uiStage";
import type { SilenceTightness } from "./lib/silenceTightness";
// フェーズW1: 話者カラー(発動判定はpython step08と同じ条件)
import { DEFAULT_SPEAKER_COLORS, resolveActiveSpeakerColors, sanitizeSpeakerColors } from "./lib/speakerColors";
import { OpEditorModal } from "./components/OpEditorModal";
// フェーズW7: プロジェクト一覧(再編集)と書き出し設定・完了モーダル
import { ProjectListPage } from "./components/ProjectListPage";
import { ExportSettingsModal, type ExportSettingsValue } from "./components/ExportSettingsModal";
import { ExportDoneModal, type ExportDoneInfo } from "./components/ExportDoneModal";
import {
  buildExportOutputPath,
  concurrencyForRenderSpeed,
  crfForQuality,
  targetShortSideForResolution,
  videoBitrateForQuality,
} from "./lib/exportOptions";
// フェーズW6: シーン検品先頭のOP行(旧OpSummaryCardの後継。トリム・文言編集・プレビュー連動)
import { OpClipRows } from "./components/OpClipRows";
import { OverlayEditModal } from "./components/OverlayEditModal";
import { opClipMidpointMs, opClipsFromTimelineOp, type OpClip, type RunOpConfig } from "./lib/opEditor";
import { DesignThemePicker } from "./components/DesignThemePicker";
import { CatProgressBar } from "./components/CatProgressBar";
import { CatMark } from "./components/CatMark";
import { findRunningStepLabel, resolveCatProgressPercent } from "./lib/stepProgress";
import {
  findDesignTheme,
  resolveActiveDesignThemeId,
  sanitizeDesignScenes,
  sanitizeDesignThemes,
  STANDARD_DESIGN_THEME_ID,
  type DesignScene,
  type DesignTheme,
  type DesignThemeSaveInput,
} from "./lib/designThemes";
import {
  applyEdgeTrim,
  MIN_SCENE_DURATION_MS,
  type EdgeTrimEdge,
} from "./lib/edgeTrim";
import {
  computeEdgeDragSceneOverrides,
  computeEdgeDragVisual,
  computeLinkedNextSceneIds,
} from "./lib/edgeDragVisual";
import {
  cyclePlaybackRate,
  findAdjacentGroupBoundaryMs,
  findAdjacentSceneId,
  isCaretAtLineStart,
  isGroupCursorAtLineStart,
  resolveCaretDeleteLeftTarget,
  resolveCaretDeleteRightTarget,
  resolveCaretSplitTarget,
  resolveGroupDeleteLeftTarget,
  resolveGroupCursor,
  resolveGroupDeleteRightTarget,
  resolveGroupSplitTarget,
  resolveMatchingCutMark,
  resolveScissorsChipSplitTarget,
  SCENE_PLAYBACK_RATES,
} from "./lib/playhead";
// W16-4: Delete/Backspaceの削除アンカーは明示的操作(選択・シーン選択・確定キャレット・再生位置)
// からのみ解決する(ホバー由来の位置は使わない)。
import { resolveDeleteAnchor, type ConfirmedCaret, type DeleteAnchor } from "./lib/deleteAnchor";
import { createThrottledSeek, type ThrottledSeek } from "./lib/hoverSeekThrottle";
import { playheadStore, usePlayheadSourceMs } from "./lib/playheadStore";
import { buildInspectionCopyText } from "./lib/inspectionCopyText";
import { detectTelopWordReplacement } from "./lib/telopReplace";
import { computePeakMax } from "./lib/waveform";
import { loadWaveformWithRetry } from "./lib/waveformRequest";
import {
  buildTelopStylePlan,
  clearRuntimeTheme,
  DEFAULT_THEME_ID,
  describeThemeCard,
  getPresetStyle,
  hasRuntimeTheme,
  registerPresetCatalog,
  registerRuntimeStyles,
  resolveEffectiveStyle,
  SAVED_THEME_ID,
  setRuntimeTheme,
  THEME_IDS,
  type TelopStyleDef,
  type TelopThemeId,
} from "./lib/telopThemes";
import { mapFontProfileToEmotionStyles, pickPrimaryFontProfile, type FontProfile } from "./lib/fontProfileTheme";
import { buildSuspicionQueue, type SuspicionItem } from "./lib/suspicionQueue";
// W14-1: OP行操作での自動追従スクロール抑制(playbackScrollSuppressedの遷移ルール)
import { playbackScrollSuppressedFor } from "./lib/playbackScroll";
import { buildAiReviewBanner } from "./lib/aiReviewBanner";
import { formatAiUsageSummary } from "./lib/aiUsage";
import { TelopStyleSample } from "./components/TelopStyleSample";
import { TelopThemeGalleryModal } from "./components/TelopThemeGalleryModal";
import {
  buildWordGroups,
  initialShiftChipRange,
  shiftExtendChipRange,
  wordIdsForGroupRange,
} from "./lib/wordGroups";
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
import { useProjectAutosave } from "./hooks/useProjectAutosave";
import { useProjectEditor } from "./hooks/useProjectEditor";
import { useWorkspaceViewport } from "./hooks/useWorkspaceViewport";
import { deriveKeepSegments, deriveTelopOverrides } from "./lib/scenes";
import type { EditorSelection } from "./lib/editorSelection";
import {
  shouldIgnoreSceneKeyboard,
  isSceneToolShortcut,
  isRepeatedSceneCommand,
  resolveSceneSpaceAction,
  SCENE_KEYBOARD_DIALOG_SELECTOR,
  SCENE_EDITING_BUTTON_SELECTOR,
} from "./lib/sceneKeyboard";

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
  /**
   * W12-2: ライセンス課金(Stripe+ライセンスキー)の導線。金額・プラン未定のため既定OFF。
   * false の間はライセンス項目・購入導線を一切表示しない(既存動作を変えない)。
   * ONにする手順は billing/README.md「金額決定後にやること」を参照。
   */
  billing: false,
} as const;

type StepStatus = "pending" | "running" | "done" | "error";

type Step = {
  id: string;
  label: string;
  status: StepStatus;
};

/** W19-A2: ホバースクラブのシーク間引き間隔(ms)。 */
const HOVER_SEEK_THROTTLE_MS = 30;

/**
 * W19-A3: 追い読みモードの進捗%表示。再生ヘッド(playheadStore)を購読して
 * この小さなラベルだけが毎フレーム再レンダリングされる(App全体は再レンダリングしない)。
 * 最到達msはAppのmaxReachedMsRefから読む(onTimeUpdateで更新される)。
 */
function FollowAlongProgressLabel({
  maxReachedMsRef,
  durationMs,
}: {
  maxReachedMsRef: { current: number };
  durationMs: number;
}) {
  usePlayheadSourceMs();
  return (
    <span className="followAlongProgress">
      追い読み済み {computeReadThroughProgressPercent(maxReachedMsRef.current, durationMs)}%
    </span>
  );
}

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
  { id: "step05_ai_retake", label: "AI言い直し検出", status: "pending" },
  // W19-B1: 弱区間の再文字起こし(キー無し・失敗はnon-fatalでスキップ)
  { id: "step05b_retranscribe", label: "弱区間の再文字起こし", status: "pending" },
  { id: "step07_cut_proposal", label: "カット提案", status: "pending" },
  { id: "step06c_direction", label: "演出決定", status: "pending" },
  { id: "step08_composition", label: "コンポジション", status: "pending" },
  { id: "extract_telop", label: "テロップ抽出", status: "pending" },
  { id: "review_telop", label: "書き出し前チェック", status: "pending" },
  { id: "step06b_ai_refine", label: "AI校正", status: "pending" },
  { id: "font_directives", label: "フォント反映", status: "pending" },
  // W19-B2: AI最終チェック(step06d)の自動実行(検品準備完了の直前。non-fatal)
  { id: "step06d_final_check", label: "AI最終チェック", status: "pending" },
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

/** W28: 「要確認」の確認済みチェック(シーンid集合)のrun単位localStorageキー。 */
function resolvedReviewStorageKey(runDir: string) {
  return `catcut.reviewResolved.${runDir}`;
}

function loadResolvedReviewSceneIds(runDir: string | undefined): Set<string> {
  if (!runDir) return new Set();
  try {
    const raw = window.localStorage.getItem(resolvedReviewStorageKey(runDir));
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
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
  // W12-2: ライセンスモーダル(FEATURES.billing=falseの間は導線ごと非表示)
  const [licenseModalOpen, setLicenseModalOpen] = useState(false);
  // W13-1: キャッシュ管理モーダル
  const [cacheManagerOpen, setCacheManagerOpen] = useState(false);
  const [videoPath, setVideoPath] = useState("");
  // フェーズW8(素材選択時の縦横選択): ffprobeの自動判定結果と、ユーザーが確定した向き。
  // null=未選択(旧来どおり自動判定に任せる)。チップクリックでモーダルを開き直して変更できる。
  const [videoProbe, setVideoProbe] = useState<CatCutVideoProbeResult | null>(null);
  const [videoOrientation, setVideoOrientation] = useState<CatCutOrientation | null>(null);
  const [orientationModalOpen, setOrientationModalOpen] = useState(false);
  const [silenceTightness, setSilenceTightness] = useState<SilenceTightness>("normal");
  const [steps, setSteps] = useState<Step[]>(initialSteps);
  const [logs, setLogs] = useState("");
  const [running, setRunning] = useState(false);
  const [runName, setRunName] = useState("");
  const [runDir, setRunDir] = useState("");
  const [exportProgress, setExportProgress] = useState(0);
  const [outputs, setOutputs] = useState<CatCutOutputs | null>(null);
  // フェーズW7: プロジェクト一覧(検品段階に到達したrun)と書き出し設定/完了モーダル
  const [projects, setProjects] = useState<CatCutProjectSummary[]>([]);
  const [projectOpeningRunDir, setProjectOpeningRunDir] = useState<string | null>(null);
  const [exportSettingsOpen, setExportSettingsOpen] = useState(false);
  const [exportDoneInfo, setExportDoneInfo] = useState<ExportDoneInfo | null>(null);
  const [exportDoneBusy, setExportDoneBusy] = useState(false);
  const [reviewState, setReviewState] = useState<ReviewState | null>(null);
  const [reviewStage, setReviewStage] = useState<"transcript" | "telop">("transcript");
  // フェーズV1(統合タイムラインView): 右ペインの「シーン検品｜タイムライン」タブ。
  // 初期はシーン検品(従来フロー維持)。プレビュープレイヤーは両タブ共通で上部に常駐する。
  const [reviewTab, setReviewTab] = useState<"scenes" | "timeline">("scenes");
  const workspaceViewportRef = useWorkspaceViewport(reviewTab === "timeline");
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
  // W19-A3: 追い読みの最到達msは毎フレーム更新されるためstateにしない(表示は
  // FollowAlongProgressLabelがplayheadStore購読で追従する)。
  const maxReachedMsRef = useRef(0);
  const [waveform, setWaveform] = useState<WaveformResult | null>(null);
  const [waveformLoading, setWaveformLoading] = useState(false);
  const [waveformError, setWaveformError] = useState("");
  const [waveformReload, setWaveformReload] = useState(0);
  // 改善2(波形の縦スケール改善): 録音全体のグローバルピークをwaveform読み込み時に1回だけ計算し、
  // 各シーン行のミニ波形(SceneWaveformStrip)へpropsで配る。行ごとに毎回計算し直さないための最適化。
  const globalPeakMax = useMemo(() => computePeakMax(waveform?.peaks || []), [waveform]);
  const [selectedBoundary, setSelectedBoundary] = useState<SelectedBoundary | null>(null);
  const [focusCutCardSegmentIndex, setFocusCutCardSegmentIndex] = useState<number | null>(null);
  // --- 検品UI v2(シーン行UI, Phase 1) ---
  // フェーズW5-6: 要確認タブ(sceneFilter)は廃止。要確認は上部のReviewHotspotsPanelに一本化。
  // フェーズW5-5: 要確認パネルからのシーンジャンプ先を2秒間ハイライトする(.jumpFlash)。
  const [flashSceneId, setFlashSceneId] = useState<string | null>(null);
  const flashSceneTimerRef = useRef<number | null>(null);
  // W19-A3: 再生ヘッドの元動画ms(旧previewCurrentMs)はplayheadStoreへ移行した。
  // Appはstateとして持たず、毎フレーム必要なコンポーネントだけがストアを購読する。
  const [sceneApplying, setSceneApplying] = useState(false);
  const [editorClosing, setEditorClosing] = useState(false);
  const editorTransitionBusyRef = useRef(false);
  editorTransitionBusyRef.current = sceneApplying || editorClosing;
  // W19-C5: 適用(step08セグメント抽出)中の進捗%。取れない段(テロップ生成等)はnull=従来表示
  const [sceneApplyProgress, setSceneApplyProgress] = useState<number | null>(null);
  // --- フェーズU1(プレビュー忠実化) ---
  // U1-5: オーバーレイのプレビュー表示トグルと、クリック文言編集(保存前のローカル上書き)。
  const [overlaysVisible, setOverlaysVisible] = useState(true);
  const [overlayEdits, setOverlayEdits] = useState<Record<string, OverlayTextEdit>>({});
  const [overlayEditorTarget, setOverlayEditorTarget] = useState<OverlayItem | null>(null);
  const [overlayEditorDraft, setOverlayEditorDraft] = useState<{ text: string; subtitle: string }>({
    text: "",
    subtitle: "",
  });
  // U1-6: 効果音のミュートトグル(プレビューのみ。書き出しには影響しない)。
  const [sfxMuted, setSfxMuted] = useState(false);
  // --- フェーズU9(BGMトラック) ---
  // 映像・テロップ・画像・BGMは共通履歴。ドラッグ中の表示と保存する確定値を分ける。
  const project = useProjectEditor();
  const pendingMediaImportsRef = useRef(new Set<Promise<void>>());
  const [mediaImporting, setMediaImporting] = useState(false);
  const bgmState = project.state.document.bgm;
  const [bgmMuted, setBgmMuted] = useState(false);
  // --- フェーズV4(画像挿入トラック) ---
  // 画像プレビューもトラックと同じ選択・履歴・自動保存を使う。
  const imagesState = project.state.document.images;
  // フェーズW9: 映像フレーミング(変形・クロップ)。run正本 video_framing.json のミラー。
  // null=未読込(identity扱い)。commit時に video-framing:save で保存する。
  const [videoFramingState, setVideoFramingState] = useState<Awaited<
    ReturnType<typeof window.catcut.getVideoFraming>
  > | null>(null);
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
  // 波形は2点クリックで区間カット、発話の外側は1クリックで端までカット。チップ列は境界分割。
  const [scissorsMode, setScissorsMode] = useState(false);
  // 改善5-1(ホバー自動スクロールの抑制): <video>が実際に再生中かどうか(play/pauseイベント由来)。
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  // 改善5-2(チップのドラッグ複数選択): 選択は同時に1シーンのみ(他行をドラッグしたら切り替わる)。
  const [chipSelection, setChipSelection] = useState<ChipSelectionState | null>(null);
  // W10-1(シーン単位の選択): 行番号チップのクリックでトグルする単一選択。チップ選択とは独立で、
  // Delete/Backspace時はチップ選択が優先される(選択中シーンはDeleteで丸ごと削除+連鎖選択)。
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  /** W17: 元テキスト/表示テキストを触っている「いまの行」(行番号クリックとは別管理)。 */
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
  // 改善5-9(ホバー行からSpace再生): マウスが乗っている行のsceneId。頻繁に更新されるためref。
  const hoveredSceneIdRef = useRef<string | null>(null);
  /** W21: ホバー行Space再生の「発動権」。行に乗せ直した時だけtrueになり、再生開始で消費する。
   *  これが無いと、マウスを置いたまま再生→停止→再生すると毎回その行の先頭へ戻ってしまい、
   *  停止位置からの再開ができない(再生中のSpace停止すら前の行の再生し直しになる)。 */
  const hoverPlayArmedRef = useRef(false);
  // フェーズW5-7: ホバー元が要確認パネルのカードかどうか(Space再生時の自動追従スクロール抑制用)。
  const hoveredFromHotspotRef = useRef(false);
  // フェーズW5-7: 要確認パネル発の再生中はシーン一覧の自動追従スクロールを止める。
  const [playbackScrollSuppressed, setPlaybackScrollSuppressed] = useState(false);
  // フェーズW5-10: シーン一覧を一定以上スクロールしたら「↑」丸ボタンで先頭(要確認パネル)へ戻れる。
  const sceneListPaneRef = useRef<HTMLDivElement | null>(null);
  const [showScrollTopButton, setShowScrollTopButton] = useState(false);
  // W10-9: ドラフト復元完了まで自動保存を抑止する。
  const scenesDraftReadyRef = useRef(false);
  const [scenesDraftReadyRunDir, setScenesDraftReadyRunDir] = useState<string | null>(null);
  const [editorLoadError, setEditorLoadError] = useState<string | null>(null);
  const [editorLoadAttempt, setEditorLoadAttempt] = useState(0);
  // W16-5(自動保存インジケータ): ドラフトdebounce保存の状態(保存中/保存済みHH:MM/失敗)。
  const [draftSaveStatus, setDraftSaveStatus] = useState<{
    state: "idle" | "saving" | "saved" | "error";
    savedAt?: string;
  }>({ state: "idle" });
  // 改善5-7(一括置換ポップアップ): テロップ枠フォーカス時点のテキストをsceneIdごとに保持し、
  // blur時にこれと比較して単語置換(A→B)を検出する。
  const telopFocusTextRef = useRef<Map<string, string>>(new Map());
  const [telopReplaceCandidate, setTelopReplaceCandidate] = useState<TelopReplaceCandidate | null>(null);
  const [telopReplaceSelectedKeys, setTelopReplaceSelectedKeys] = useState<Set<string>>(() => new Set());
  const [telopReplaceDictChecked, setTelopReplaceDictChecked] = useState(false);
  const [userDictionaryOpen, setUserDictionaryOpen] = useState(false);
  // W16-7(AI最終チェック): step06dの指摘・実行状態・「無視」済み指摘id。runごとにリセットする。
  const [finalCheckIssues, setFinalCheckIssues] = useState<FinalCheckIssue[]>([]);
  const [finalCheckRunning, setFinalCheckRunning] = useState(false);
  const [finalCheckStatus, setFinalCheckStatus] = useState("");
  // W16-7/W19-B1: 「無視」済み項目のID集合(final_check・retranscribe共用。run切替でリセット)。
  const [ignoredFinalCheckIds, setIgnoredFinalCheckIds] = useState<Set<string>>(() => new Set());
  // W19-B2: 解析時に自動実行されたAI最終チェック(issues.json)のロード結果。シーン初期化後に
  // 本文一致で現在のシーンIDへ再マップしてから finalCheckIssues へ反映する(1回だけ)。
  const [pendingFinalCheckLoad, setPendingFinalCheckLoad] = useState<{
    runDir: string;
    issues: FinalCheckIssue[];
    inputScenes: Array<{ sceneId: string; text: string }>;
  } | null>(null);
  // W14-2: 編集前→編集後の修正ペア学習。correctionHistoryは全run横断(userData)。
  const [correctionHistory, setCorrectionHistory] = useState<CorrectionHistory | null>(null);
  const [editingLearningSummary, setEditingLearningSummary] = useState<Awaited<ReturnType<typeof window.catcut.getEditingLearningSummary>> | null>(null);
  // W28(2026-08-22 実機フィードバック): 「要確認」カードの確認済みチェック(シーンid集合)。
  // 旧W14-2の「編集したら自動で消える」方式は波形・テキストを触った拍子にカードが一瞬で
  // 消えてしまうため廃止し、ユーザーがチェックを入れたカードだけ消す方式にした。
  // runごとにlocalStorageへ永続化する(アプリ再起動でも保持)。
  const [resolvedReviewSceneIds, setResolvedReviewSceneIds] = useState<Set<string>>(() => new Set());
  // 実機FB 2026-09-03: W28の左右レイアウトは「横に並べると見づらい」ため廃止。
  // 要確認(折りたたみ)→OP→通常シーンの縦積みに一本化した。
  const [correctionHistoryOpen, setCorrectionHistoryOpen] = useState(false);
  // フェーズT2.5-4: シーン種類→プリセットのマッピング(既定+userDataのユーザー設定)と設定ビュー開閉。
  const [telopTypeMapping, setTelopTypeMapping] = useState<TelopTypeMapping>(DEFAULT_TYPE_MAPPING);
  const [telopTypeMappingOpen, setTelopTypeMappingOpen] = useState(false);
  // フェーズU7/U8: スタンダード(テーマ未選択)のシーンタイトル・OP設定
  // (テーマ選択中はテーマ自身が保持するのでこのstateは使わない)。
  const [standardDesignExtras, setStandardDesignExtras] = useState<DesignExtras>({
    overlayTitle: { ...DEFAULT_OVERLAY_TITLE },
    op: { ...DEFAULT_OP_CONFIG },
    speakerColors: { ...DEFAULT_SPEAKER_COLORS },
    videoEffects: { ...DEFAULT_VIDEO_EFFECTS },
  });
  // フェーズV2: run単位のOP設定(op_config.json=このrunのOPの正本)とOP編集モーダル開閉。
  const [runOpConfig, setRunOpConfig] = useState<RunOpConfig | null>(null);
  const [opEditorOpen, setOpEditorOpen] = useState(false);
  // フェーズW6(OP行のクリップ再生): この タイムラインms に達したら一時停止する(クリップだけ再生)。
  const opPlayStopAtTimelineMsRef = useRef<number | null>(null);
  // フェーズW6: タイムラインシークの消化後に再生を開始する(OP行の再生ボタン)。
  const opPlayPendingRef = useRef(false);
  // フェーズV3(OPのプレビュー再生): タイムラインms基準のシーク要求(タイムラインViewのクリック。
  // OP区間へも入れる)と、プレビューが報告する現在のタイムラインms(OP込み。再生ヘッド描画用)。
  const [timelineSeekMs, setTimelineSeekMs] = useState<number | null>(null);
  // W19-A3: 現在のタイムラインms(旧previewTimelineMs)もplayheadStoreへ移行した
  // (タイムラインViewの再生ヘッドはTimelineView内部で購読する)。
  // フェーズU6: テロップスタイル詳細エディタ(null=閉)。
  const [styleEditorContext, setStyleEditorContext] = useState<TelopStyleEditorContext | null>(null);
  // フェーズU6: 未適用のシーン個別カスタムスタイル定義(custom_scene_* ID → 定義)。
  // 適用時に applyTranscriptEdits の customStyles として telop_directives.json へ書き戻される。
  const [sceneCustomStyles, setSceneCustomStyles] = useState<Record<string, TelopStyleDef>>({});
  // フェーズU2: 使用シーンバンドル(テンプレート)と保存済みデザインテーマ。
  const [designScenes, setDesignScenes] = useState<DesignScene[]>([]);
  const [designThemes, setDesignThemes] = useState<DesignTheme[]>([]);
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
  // フェーズW1: 話者カラーの発動判定(書き出しのstep08と同じ条件)。
  // 設定(テーマ優先)が有効 かつ 発話シェア10%以上の話者が2人以上 のときだけ非null。
  // 旧run(wordsにspeakerが無い)は自動的にnull=完全に従来のスタイル解決のまま。
  const activeSpeakerColors = useMemo(() => {
    const theme = findDesignTheme(
      designThemes,
      resolveActiveDesignThemeId(designThemes, settings?.activeDesignThemeId),
    );
    const config = theme ? theme.speakerColors : standardDesignExtras.speakerColors;
    return resolveActiveSpeakerColors(config, transcriptWords);
  }, [designThemes, settings?.activeDesignThemeId, standardDesignExtras.speakerColors, transcriptWords]);
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
  const scenesHistory = useScenes([], project.sceneHistory);

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
    // フェーズU2: アクティブなデザインテーマがあればmain側でテーマ優先に解決済み。
    if (typeof window.catcut.getTelopTypeMapping === "function") {
      window.catcut
        .getTelopTypeMapping()
        .then((mapping) => setTelopTypeMapping(sanitizeTypeMapping(mapping)))
        .catch(() => {});
    }
    // フェーズU2: 使用シーンテンプレートと保存済みデザインテーマを読み込む。
    if (typeof window.catcut.getDesignScenes === "function") {
      window.catcut
        .getDesignScenes()
        .then((scenes) => setDesignScenes(sanitizeDesignScenes(scenes)))
        .catch(() => {});
    }
    if (typeof window.catcut.listDesignThemes === "function") {
      window.catcut
        .listDesignThemes()
        .then((themes) => setDesignThemes(sanitizeDesignThemes(themes)))
        .catch(() => {});
    }
  }, [electronReady]);

  // フェーズU6: テーマ専属カスタムスタイル定義をプレビュー用カタログへ実行時登録する
  // (スウォッチ・ライブプレビューがcustom_* IDを解決できるようにする)。
  useEffect(() => {
    registerRuntimeStyles(mergeCustomStyles(...designThemes.map((theme) => theme.customStyles)));
  }, [designThemes]);

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
        // フェーズW7: 書き出し完了時はFinderで書き出したMP4を表示し、
        // プロジェクトを保存するかの確認ダイアログを出す
        if (event.outputs?.finalVideoExists && event.outputs.finalVideo) {
          window.catcut.revealPath(event.outputs.finalVideo);
          setExportDoneInfo({ runDir: event.outputs.runDir, finalVideo: event.outputs.finalVideo, learning: event.outputs.learning });
          window.catcut.getEditingLearningSummary?.().then(setEditingLearningSummary).catch(() => {});
        }
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
  // W10-9: scene_edits_draft.json があれば composition より優先して静かに復元する。
  useEffect(() => {
    if (!transcriptState) {
      scenesInitializedRunDirRef.current = null;
      scenesDraftReadyRef.current = false;
      setScenesDraftReadyRunDir(null);
      project.editor.hydrate(null);
      setEditorLoadError(null);
      keepSegmentsHistory.reset({
        keepSegments: [], manualRemovedWordIds: [], wordCorrections: {}, correctionOriginals: {},
      });
      return;
    }
    const runDir = transcriptState.runDir;
    if (scenesInitializedRunDirRef.current === runDir) return;
    scenesInitializedRunDirRef.current = runDir;
    scenesDraftReadyRef.current = false;
    setScenesDraftReadyRunDir(null);
    setEditorLoadError(null);
    setDraftSaveStatus({ state: "idle" });
    project.editor.hydrate(null);

    const baseScenes = initializeScenes({
      words: transcriptState.words,
      sentences: transcriptState.sentences,
      keepSegments: transcriptState.keepSegments,
      telopPageBoundaries: transcriptState.telopPageBoundaries,
    });

    let cancelled = false;
    (async () => {
      try {
        // Save the exact initial UI scenes before draft hydration or export changes the AI artifacts.
        // Failure to save learning evidence must not prevent opening the editing project.
        if (electronReady && window.catcut.initializeEditingLearning) {
          await window.catcut.initializeEditingLearning({ runDir, scenes: baseScenes }).catch(() => undefined);
          if (cancelled) return;
        }
        const [draft, images, bgm] = electronReady ? await Promise.all([
          window.catcut.loadSceneEditsDraft(runDir),
          window.catcut.listImages({ runDir }),
          window.catcut.listBgm({ runDir }),
        ]) : [null, null, null];
        if (cancelled) return;
        project.editor.hydrate(runDir, { scenes: draft?.scenes?.length ? draft.scenes as Scene[] : baseScenes, images, bgm });
        // W11-2(適用ボタン廃止): scenes から導出できない編集もドラフトから復元する。
        // 旧ドラフト(1.0.0)は空辞書が返る=従来と同じ初期状態。
        const draftOverlayEdits = draft?.overlayEdits ?? {};
        const draftCustomStyles = (draft?.customStyles ?? {}) as Record<string, TelopStyleDef>;
        setOverlayEdits(draftOverlayEdits);
        setSceneCustomStyles(draftCustomStyles);
        // カスタムスタイルはランタイム辞書へ登録しないとプレビューのスタイル解決が既定に落ちる
        if (Object.keys(draftCustomStyles).length > 0) registerRuntimeStyles(draftCustomStyles);
        scenesDraftReadyRef.current = true;
        setScenesDraftReadyRunDir(runDir);
      } catch (error) {
        if (!cancelled) {
          scenesInitializedRunDirRef.current = null;
          setEditorLoadError(`編集データを読み込めませんでした。${error instanceof Error ? error.message : String(error)}`);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (!scenesDraftReadyRef.current && scenesInitializedRunDirRef.current === runDir) {
        scenesInitializedRunDirRef.current = null;
      }
    };
    // reset is stable. Ordinary edits/rerenders must not cancel an in-flight draft load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [electronReady, transcriptState?.runDir, editorLoadAttempt]);

  // W10-9: scenes/keepSegments の変更を debounce 2秒で scene_edits_draft.json へ自動保存する。
  // W11-2(適用ボタン廃止): applySceneEdits の送信内容のうち scenes から導出できない
  // overlayEdits / sceneCustomStyles も保存対象に含める(それ以外の telopOverrides /
  // directedSlots 等は scenes と永続設定から導出できる)。
  const sceneDraft = useMemo(() => {
    if (!electronReady || !transcriptState?.runDir || !scenesDraftReadyRef.current ||
        scenesDraftReadyRunDir !== transcriptState.runDir) return null;
    return {
      runDir: transcriptState.runDir,
      scenes: scenesHistory.scenes,
      keepSegments: scenesHistory.keepSegments,
      overlayEdits,
      customStyles: sceneCustomStyles,
    };
  }, [
    electronReady,
    overlayEdits,
    sceneCustomStyles,
    scenesHistory.keepSegments,
    scenesHistory.scenes,
    scenesDraftReadyRunDir,
    transcriptState?.runDir,
  ]);
  const latestSceneDraftRef = useRef(sceneDraft);
  latestSceneDraftRef.current = sceneDraft;
  const projectSaveSnapshot = useMemo(() => sceneDraft ? ({
    draft: sceneDraft, images: project.state.history.present.images, bgm: project.state.history.present.bgm,
  }) : null, [sceneDraft, project.state.history.present.images, project.state.history.present.bgm]);
  const flushProjectSave = useProjectAutosave(projectSaveSnapshot, setDraftSaveStatus, () => {
    setInspectionCopyToast("自動保存に失敗しました。「再試行」から保存し直せます。");
  });
  async function flushSceneDraft(skipImport?: Promise<void>) {
    if (!sceneDraft) throw new Error("編集データの読み込みが完了していません。");
    await Promise.all([...pendingMediaImportsRef.current].filter((pending) => pending !== skipImport));
    const draft = latestSceneDraftRef.current;
    if (!draft || draft.runDir !== sceneDraft.runDir) throw new Error("プロジェクトの切り替え中です。");
    project.editor.commitPreview();
    const latest = project.editor.getSnapshot();
    if (latest.runDir !== sceneDraft.runDir) throw new Error("プロジェクトの切り替え中です。");
    const snapshot = {
      draft: latest.document.scenes === draft.scenes ? draft : {
        ...draft, scenes: latest.document.scenes, keepSegments: deriveKeepSegments(latest.document.scenes),
      },
      images: latest.history.present.images, bgm: latest.history.present.bgm,
    };
    await flushProjectSave(snapshot);
    return snapshot;
  }
  async function beginMediaImport(): Promise<() => void> {
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => { complete = resolve; });
    pendingMediaImportsRef.current.add(pending);
    setMediaImporting(true);
    const finish = () => {
      pendingMediaImportsRef.current.delete(pending);
      complete();
      setMediaImporting(pendingMediaImportsRef.current.size > 0);
    };
    try {
      // Register before the pre-import save so navigation cannot slip through that wait.
      await flushSceneDraft(pending);
      return finish;
    } catch (error) {
      finish();
      throw error;
    }
  }
  function handleEditorSelection(selection: EditorSelection) {
    telopEditSessionRef.current = null;
    project.editor.select(selection);
    setChipSelection(null);
    setSelectedSceneId(null);
  }

  // W14-2: 全run横断の修正ペア履歴(userData/correction_history.json)を読み込む。
  // 無ければ空履歴=完全従来動作(後方互換)。
  useEffect(() => {
    if (!electronReady) return;
    window.catcut
      .getCorrectionHistory()
      .then(setCorrectionHistory)
      .catch(() => {});
    window.catcut.getEditingLearningSummary?.().then(setEditingLearningSummary).catch(() => {});
  }, [electronReady]);

  // W16-6(スリープ/バックグラウンドのCPU対策): スリープ・画面ロック(main→power:suspend)と
  // ウィンドウ非表示(visibilitychange)でプレビュー再生を一時停止する。再生停止で
  // rAF系の駆動ループ(フレームループ・OP静止ループ・BGM同期)がすべてアイドルへ落ちる。
  useEffect(() => {
    const pausePreview = () => {
      const player = previewPlayerRef.current;
      if (player && !player.isPaused()) player.pause();
    };
    const handleVisibilityChange = () => {
      if (document.hidden) pausePreview();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    const unsubscribePowerSuspend = electronReady ? window.catcut.onPowerSuspend(pausePreview) : null;
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      unsubscribePowerSuspend?.();
    };
  }, [electronReady]);

  // W19-C5: 適用(step08セグメント抽出)の進捗を受信して適用中インジケータに%を表示する
  useEffect(() => {
    if (!electronReady) return undefined;
    const unsubscribe = window.catcut.onApplyProgress(({ percent }) => {
      if (Number.isFinite(percent)) {
        setSceneApplyProgress(Math.max(0, Math.min(100, Math.round(percent))));
      }
    });
    return unsubscribe;
  }, [electronReady]);

  // W28: 「要確認」の確認済みチェックをrun単位で読み込み・保存する(localStorage)。
  // 旧W14-2の「edit_history.json由来の編集済みシーンを自動除外」はここで廃止した。
  useEffect(() => {
    setResolvedReviewSceneIds(loadResolvedReviewSceneIds(transcriptState?.runDir));
  }, [transcriptState?.runDir]);

  useEffect(() => {
    const runDir = transcriptState?.runDir;
    if (!runDir) return;
    try {
      localStorage.setItem(
        resolvedReviewStorageKey(runDir),
        JSON.stringify([...resolvedReviewSceneIds]),
      );
    } catch {
      // localStorageが使えない環境では永続化せず動作のみ
    }
  }, [resolvedReviewSceneIds, transcriptState?.runDir]);

  // W19-B2: 解析パイプラインが自動実行したAI最終チェック(issues.json)をロードする
  // (review:ready・プロジェクト再オープンの両方=transcriptロード時)。旧run(ファイル無し)・
  // enabled=false(キー無し)は何もしない=完全従来動作。
  useEffect(() => {
    setPendingFinalCheckLoad(null);
    const runDir = transcriptState?.runDir;
    if (!electronReady || !runDir) return undefined;
    let cancelled = false;
    window.catcut
      .loadFinalTextCheck(runDir)
      .then((result) => {
        if (cancelled || !result.exists || !result.enabled) return;
        const issues = normalizeFinalCheckIssues(result.issues);
        if (!issues.length) return;
        setPendingFinalCheckLoad({ runDir, issues, inputScenes: result.inputScenes });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [electronReady, transcriptState?.runDir]);

  // W19-B2: シーン初期化(ドラフト復元含む)が終わったら、自動実行の指摘(auto_XXXX仮ID)を
  // 現在のシーンIDへ本文一致で再マップして反映する(runにつき1回)。手動実行(手動ボタン)の
  // 結果は既存どおり finalCheckIssues を直接上書きする。
  useEffect(() => {
    if (!pendingFinalCheckLoad) return;
    if (scenesInitializedRunDirRef.current !== pendingFinalCheckLoad.runDir) return;
    if (!scenesDraftReadyRef.current || !scenesHistory.scenes.length) return;
    const remapped = remapFinalCheckIssues(
      pendingFinalCheckLoad.issues,
      pendingFinalCheckLoad.inputScenes,
      scenesHistory.scenes,
    );
    setPendingFinalCheckLoad(null);
    if (!remapped.length) return;
    setFinalCheckIssues(remapped);
    setFinalCheckStatus(`AI最終チェック: 指摘${remapped.length}件（解析時に自動実行）`);
  }, [pendingFinalCheckLoad, scenesHistory.scenes]);

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

  // フェーズW5-6: 要確認タブ廃止に伴い、表示は常に全シーン(要確認はReviewHotspotsPanelが担当)。
  const displayedScenes = scenesHistory.scenes;

  // W16-7: AI最終チェックの指摘→要確認パネル項目(現在の本文基準。適用・編集済みは自然に消える)。
  const finalCheckItemsBySceneId = useMemo(
    () => buildFinalCheckSuspicions(finalCheckIssues, scenesHistory.scenes, ignoredFinalCheckIds),
    [finalCheckIssues, scenesHistory.scenes, ignoredFinalCheckIds],
  );

  // W19-B1: 弱い区間の再文字起こし(retranscribe.json)の差分候補→要確認パネル項目。
  // 旧run(retranscribe無し)は空=完全従来動作。「無視」はfinal_checkと同じID集合で管理する。
  const retranscribeItemsBySceneId = useMemo(() => {
    if (!transcriptState?.retranscribe?.enabled) return new Map<string, SuspicionItem[]>();
    return buildRetranscribeSuspicions(
      normalizeRetranscribeItems(transcriptState.retranscribe.items),
      scenesHistory.scenes,
      ignoredFinalCheckIds,
    );
  }, [transcriptState?.retranscribe, scenesHistory.scenes, ignoredFinalCheckIds]);

  // フェーズW5-5: 要確認パネルのカードデータ(シーン順・tinyシーン除外・改行疑義統合)。
  // W28: 旧W14-2の「編集済みシーンの疑義を自動除外」は廃止し、ユーザーが「確認済み」
  // チェックを入れたシーンだけを除外する(勝手に消えない・チェックで消す)。
  const reviewHotspots = useMemo(
    () =>
      buildReviewHotspots(scenesHistory.scenes, sceneSuspicionsBySceneId, {
        correctionHistoryPairs: correctionHistory?.pairs,
        finalCheckItemsBySceneId,
        retranscribeItemsBySceneId,
      }).filter((hotspot) => !resolvedReviewSceneIds.has(hotspot.scene.id)),
    [
      scenesHistory.scenes,
      sceneSuspicionsBySceneId,
      resolvedReviewSceneIds,
      correctionHistory,
      finalCheckItemsBySceneId,
      retranscribeItemsBySceneId,
    ],
  );

  // W19-B3: 「AI修正を一括適用(N件)」の適用計画(ボタンのN表示と実行の両方で同じ計画を使う)。
  const bulkApplyPlan = useMemo(() => planBulkApplyAiFixes(reviewHotspots), [reviewHotspots]);

  /**
   * W16-7: AI最終チェックの実行。現在の表示テキスト全シーンをmain経由でstep06dへ渡し、
   * 指摘を要確認パネルへ流す。キー無し・LLM失敗はnon-fatal(ステータス表示のみ)。
   */
  async function handleRunFinalCheck() {
    const runDir = transcriptState?.runDir;
    if (!electronReady || !runDir || finalCheckRunning) return;
    const payload = buildFinalCheckScenesPayload(scenesHistory.scenes);
    if (!payload.length) {
      setFinalCheckStatus("チェック対象のシーンがありません");
      return;
    }
    setFinalCheckRunning(true);
    setFinalCheckStatus("");
    try {
      const result = await window.catcut.runFinalTextCheck({ runDir, scenes: payload });
      if (!result.enabled) {
        setFinalCheckStatus(`AI最終チェックを実行できませんでした(${result.reason || "不明なエラー"})`);
        return;
      }
      const issues = normalizeFinalCheckIssues(result.issues);
      setFinalCheckIssues(issues);
      setIgnoredFinalCheckIds(new Set());
      setFinalCheckStatus(issues.length ? `AI最終チェック: 指摘${issues.length}件` : "AI最終チェック: 指摘はありません");
    } catch (err) {
      setFinalCheckStatus(`AI最終チェックに失敗しました(${err instanceof Error ? err.message : String(err)})`);
    } finally {
      setFinalCheckRunning(false);
    }
  }

  /**
   * W19-B3: 「AI修正を一括適用」。suggestion付きの全項目(suspect_word / final_check /
   * correction_history / retranscribe)のうち現在本文にsurfaceが実在するものを順に適用する。
   * - Undo履歴は1エントリ(setTelopTextBulkがsetPresentを1回だけ呼ぶ)=Cmd+Zで全件戻る
   * - 学習事例は書き出し成功時に確定する（取り消したAI提案を正解へ混ぜない）
   * - blur経路を通らないためTelopReplaceModal(一括置換ポップアップ)は開かない
   * - 適用できなかった項目は残件としてパネルに残る
   */
  function handleBulkApplyAiFixes() {
    const plan = planBulkApplyAiFixes(reviewHotspots);
    if (!plan.appliedCount) return;
    sceneActionsRef.current.setTelopTextBulk(
      plan.sceneEdits.map((edit) => ({ sceneId: edit.sceneId, text: edit.afterText })),
    );
    setInspectionCopyToast(`AI修正を${plan.appliedCount}件適用しました（Cmd+Zで戻せます）`);
  }

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

  // W19-A5: ドラッグ中の表示差し替えは全scenes配列を再構築せず、
  // 「対象行+連動する隣接行」だけのオーバーライドMapとして該当行にのみ渡す。
  // 他の行のsceneプロップは同一性が保たれるため、memo化と組み合わせて再レンダリングが局所化する。
  const edgeDragSceneOverrides = useMemo(
    () => computeEdgeDragSceneOverrides(edgeDrag, edgeTrimPreview),
    [edgeDrag, edgeTrimPreview],
  );

  // W19-A5(端ドラッグの局所化): 行端の見た目状態を2つに分離する。
  // - linkedNext(🔗連動アイコン)はscenesのみ依存(ドラッグ中は再計算されない)
  // - ドラッグ固有(ツールチップ・隣接ハイライト)は対象行+隣接行の2行分だけのオブジェクト
  // これによりドラッグmove中に見た目propが変わるSceneRowを該当行だけに限定する
  // (旧実装は全行分のSceneEdgeVisualをmoveごとに再生成し、リスト全体を再レンダリングしていた)。
  const linkedNextSceneIds = useMemo(
    () => computeLinkedNextSceneIds(scenesHistory.scenes),
    [scenesHistory.scenes],
  );
  const edgeDragVisual = useMemo(
    () => computeEdgeDragVisual(scenesHistory.scenes, edgeDrag, edgeTrimPreview),
    [scenesHistory.scenes, edgeDrag, edgeTrimPreview],
  );

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

  /**
   * W20-1(範囲選択カット): 波形の横ドラッグで選択した範囲をワンアクションでカットする
   * (1ドラッグ=1回のhistory push=Undo1回)。ドラッグ中の表示はSceneWaveformStrip内の
   * ローカルオーバーレイのみで、ここが唯一のscenes書き換え点。
   */
  function handleSceneRangeCut(sceneId: string, rawStartMs: number, rawEndMs: number, chipSnapToleranceMs: number) {
    scenesHistory.cutRangeInScene(sceneId, rawStartMs, rawEndMs, {
      minDurationMs: MIN_SCENE_DURATION_MS,
      chipSnapToleranceMs,
      sourceDurationMs: transcriptState?.originalDurationMs,
      keepSingleScene: false,
    });
    // カットで対象シーンの単語構成・グループindexが変わるため、古いチップ選択・確定キャレットを
    // 残さない(以降のDelete/Backspaceが別の位置に当たる事故を防ぐ)。
    if (chipSelectionRef.current?.sceneId === sceneId) setChipSelection(null);
    if (confirmedCaretRef.current?.sceneId === sceneId) setConfirmedCaret(null);
  }

  // W19-A3: currentSceneIdは「シーン境界を跨いだ時だけ」変わる低頻度state。
  // playheadStoreを購読して毎フレーム判定するが、setStateは値が変わった時だけ
  // (Reactは同値setStateで再レンダリングしない)なので、App全体の再レンダリングは境界跨ぎ時のみ。
  const [currentSceneId, setCurrentSceneId] = useState<string | null>(null);
  useEffect(() => {
    const scenes = scenesHistory.scenes;
    const update = () => {
      const index = findSceneIndexAtEditMs(scenes, playheadStore.getSourceMs());
      setCurrentSceneId(index >= 0 ? scenes[index].id : null);
    };
    update();
    return playheadStore.subscribe(update);
  }, [scenesHistory.scenes]);

  const currentScene = useMemo(
    () => scenesHistory.scenes.find((scene) => scene.id === currentSceneId) || null,
    [currentSceneId, scenesHistory.scenes],
  );

  // U1-1: composition timeline.telop_styles(書き出しに実際に使われるスタイル定義)。
  // directedのプリセット解決はこれを最優先し、無ければtelop-presets:listカタログへフォールバックする。
  const compositionTelopStyles = transcriptState?.telopStyles as
    | Record<string, TelopStyleDef>
    | undefined;

  // T-4(プレビュー反映): 現在シーンのスタイル(色・縁取り・相対サイズ・背景帯)をプレビューに適用する。
  // U1-1: directedモードは「シーン個別上書き > type×マッピング > fact_yellow」のプリセット解決
  // (書き出しと同じ経路)。fullモードは従来どおりテーマ×感情で解決する。
  const currentSceneTelopStyle = useMemo(() => {
    if (!currentScene) return undefined;
    if (isDirectedTelopMode) {
      return (
        resolveDirectedSceneStyle(currentScene, telopTypeMapping, compositionTelopStyles, activeSpeakerColors) ??
        undefined
      );
    }
    return resolveEffectiveStyle(telopThemeId, currentScene.emotionTag, currentScene.styleOverrideId);
  }, [currentScene, isDirectedTelopMode, telopTypeMapping, compositionTelopStyles, telopThemeId, activeSpeakerColors]);

  // V1(タイムラインView): 任意シーンのスタイル解決(テロップブロックの色に使う)。
  // currentSceneTelopStyleと同じ優先順位(書き出しと同じ経路)を全シーンへ適用できる形にする。
  const resolveSceneStyleForTimeline = useCallback(
    (scene: Scene) =>
      isDirectedTelopMode
        ? (resolveDirectedSceneStyle(scene, telopTypeMapping, compositionTelopStyles, activeSpeakerColors) ??
          undefined)
        : resolveEffectiveStyle(telopThemeId, scene.emotionTag, scene.styleOverrideId),
    [isDirectedTelopMode, telopTypeMapping, compositionTelopStyles, telopThemeId, activeSpeakerColors],
  );

  // U1-2: 現在シーンの部分強調語(directedのみ)。テロップ文言に実在する語だけ有効。
  const currentSceneHighlightWords = useMemo(() => {
    if (!isDirectedTelopMode || !currentScene) return undefined;
    return filterHighlightWords(currentScene.directedHighlightWords, currentScene.telopText);
  }, [isDirectedTelopMode, currentScene]);

  // U1-6: 現在シーンの登場アニメーション(種類とms長)。書き出しと同じ優先順位で解決する。
  const currentSceneAnimation = useMemo(
    () =>
      resolvePreviewAnimation({
        directedAnimationIn: isDirectedTelopMode ? currentScene?.directedAnimationIn : null,
        directedType: isDirectedTelopMode ? currentScene?.directedType : null,
        typeMapping: telopTypeMapping,
        style: currentSceneTelopStyle,
        timelineAnimationIn: transcriptState?.timelineAnimationIn,
        fps: transcriptState?.timelineFps,
      }),
    [
      isDirectedTelopMode,
      currentScene,
      telopTypeMapping,
      currentSceneTelopStyle,
      transcriptState?.timelineAnimationIn,
      transcriptState?.timelineFps,
    ],
  );

  // U1-6: 現在シーンの効果音URL(main側プレビューサーバー配信のwav)。
  // W13-5: 連続同一sfx抑止の判定用にIDも併せて返す
  const currentSceneSfx = useMemo(() => {
    const sfxId = resolvePreviewSfxId({
      directedType: isDirectedTelopMode ? currentScene?.directedType : null,
      typeMapping: telopTypeMapping,
      style: currentSceneTelopStyle,
    });
    const url = sfxId ? (transcriptState?.sfxUrls?.[sfxId] ?? null) : null;
    return { id: url ? sfxId : null, url };
  }, [isDirectedTelopMode, currentScene, telopTypeMapping, currentSceneTelopStyle, transcriptState?.sfxUrls]);

  // U1-5: composition timeline.overlays を正規化し、UI編集を重ねた上で
  // プレビュー再生位置(元動画ms)で表示中のものだけを描画する。
  const overlayItemsAll = useMemo(
    () => normalizeOverlays(transcriptState?.overlays),
    [transcriptState?.overlays],
  );
  const timelineCutRanges = useMemo(
    () => sanitizeTimelineCutRanges(transcriptState?.timelineCutRanges),
    [transcriptState?.timelineCutRanges],
  );
  // フェーズV3(OPのプレビュー再生): composition timeline.op + run正本(op_config.json)から
  // プレビュー用OPデータを解決する(run正本の明示クリップ・文言編集は適用前でも即時反映)。
  // OPなしrunは null=従来と完全同一の再生挙動。
  const opPreviewData = useMemo(
    () => resolveOpPreviewData(transcriptState?.timelineOp, timelineCutRanges, runOpConfig),
    [transcriptState?.timelineOp, timelineCutRanges, runOpConfig],
  );
  // フェーズW6(OP行): シーン検品先頭のOP行が編集するクリップ列。run正本(op_config.json)の
  // 明示クリップがあればそれ、無ければcomposition timeline.op のAI選定結果を初期表示にする
  // (OP編集モーダルの displayClips と同じ規則)。
  const opDisplayClips = useMemo(
    () => runOpConfig?.clips ?? opClipsFromTimelineOp(transcriptState?.timelineOp),
    [runOpConfig?.clips, transcriptState?.timelineOp],
  );
  // フェーズV5-1: 編集後OP尺(run正本)とcompositionのOP尺の差分。OP編集(クリップ追加・
  // OPなし化)を適用する前でも、本編ブロック・プレイリスト・総尺をこの分シフトして
  // 「編集後タイムライン軸」で統一する(適用後は0に戻る)。
  const opShiftMs = useMemo(
    () => opTimelineShiftMs(opPreviewData, transcriptState?.timelineOp),
    [opPreviewData, transcriptState?.timelineOp],
  );
  // シフト済みのカット対応表(タイムラインView・プレビュー再生の共通軸)。
  // オーバーレイの表示判定(activeOverlayItems)はcomposition軸のままの
  // timelineCutRanges を使い続ける(overlaysの start/end_ms がcomposition軸のため)。
  // V8追補(リップル削除): シーン削除(生きているkeepSegmentsの変化)を即座に詰めて反映する
  // (タイムラインタブでDeleteした瞬間に後続ブロックが前へ詰まる。適用後はcompositionと一致し無変換)。
  const shiftedTimelineCutRanges = useMemo(
    () => shiftTimelineCutRanges(timelineCutRanges, opShiftMs),
    [timelineCutRanges, opShiftMs],
  );
  const sceneKeepsReady = !!transcriptState && scenesDraftReadyRunDir === transcriptState.runDir;
  const editedTimelineCutRanges = useMemo(
    () => compactRangesToKeepSegments(shiftedTimelineCutRanges, scenesHistory.keepSegments, { keepSegmentsReady: sceneKeepsReady }),
    [shiftedTimelineCutRanges, scenesHistory.keepSegments, sceneKeepsReady],
  );
  // リップル削除で縮んだ分をルーラー総尺にも反映する
  const editedTimelineDurationMs = useMemo(
    () =>
      compactedTimelineDurationMs(
        shiftTimelineDurationMs(transcriptState?.timelineDurationMs ?? 0, opShiftMs),
        shiftedTimelineCutRanges,
        editedTimelineCutRanges,
      ),
    [transcriptState?.timelineDurationMs, opShiftMs, shiftedTimelineCutRanges, editedTimelineCutRanges],
  );
  const timelineEditingRef = useRef({ ranges: editedTimelineCutRanges, durationMs: editedTimelineDurationMs, fps: transcriptState?.timelineFps ?? 30 });
  timelineEditingRef.current = { ranges: editedTimelineCutRanges, durationMs: editedTimelineDurationMs, fps: transcriptState?.timelineFps ?? 30 };

  // W19-A3: 表示中オーバーレイの解決は再生ヘッド依存のためplayheadStoreを購読し、
  // 「表示すべきアイテムの組が実際に変わった時だけ」setStateする(オーバーレイ境界跨ぎ時のみ
  // App再レンダリング。マージ済みアイテムの参照は効果内で固定なので同一組=同一要素参照)。
  const [activeOverlayItems, setActiveOverlayItems] = useState<OverlayItem[]>([]);
  useEffect(() => {
    if (!overlaysVisible || !overlayItemsAll.length) {
      setActiveOverlayItems((current) => (current.length === 0 ? current : []));
      return undefined;
    }
    const merged = mergeOverlayEdits(overlayItemsAll, overlayEdits);
    const update = () => {
      const next = activeOverlaysAtSourceMs(merged, timelineCutRanges, playheadStore.getSourceMs());
      setActiveOverlayItems((current) =>
        current.length === next.length && current.every((item, i) => item === next[i]) ? current : next,
      );
    };
    update();
    return playheadStore.subscribe(update);
  }, [overlaysVisible, overlayItemsAll, overlayEdits, timelineCutRanges]);

  // フェーズW2(シーン映像ギミック): composition timeline.video_effects を正規化し、
  // 未適用のOP編集分(opShiftMs)だけタイムライン軸をシフトしてプレビューへ渡す
  // (editedTimelineCutRangesと同じ「編集後タイムライン軸」に揃える)。
  const previewVideoEffects = useMemo(() => {
    const normalized = normalizeVideoEffects(transcriptState?.videoEffects);
    if (!normalized.length || !opShiftMs) return normalized;
    return normalized.map((effect) => ({
      ...effect,
      start_ms: effect.start_ms + opShiftMs,
      end_ms: effect.end_ms + opShiftMs,
    }));
  }, [transcriptState?.videoEffects, opShiftMs]);

  /** U1-5: プレビューのオーバーレイをクリックしたら文言編集ポップアップを開く。 */
  function handleOverlayClick(item: OverlayItem) {
    previewPlayerRef.current?.pause();
    setOverlayEditorTarget(item);
    setOverlayEditorDraft({
      text: item.lines && item.lines.length > 0 ? item.lines.join("\n") : (item.text ?? ""),
      subtitle: item.subtitle ?? "",
    });
  }

  /** U1-5: オーバーレイ文言編集の確定(保存前のローカル上書き。適用時にdirectivesへ書き戻す)。 */
  function commitOverlayEdit() {
    if (!overlayEditorTarget) return;
    const target = overlayEditorTarget;
    setOverlayEdits((current) => ({
      ...current,
      [target.id]: {
        text: overlayEditorDraft.text,
        ...(target.type === "profile_card" ? { subtitle: overlayEditorDraft.subtitle } : {}),
      },
    }));
    setOverlayEditorTarget(null);
  }

  const sceneNavFlagMarkers = useMemo<NavFlagMarker[]>(
    () =>
      sceneSuspicionItems
        .filter((item) => item.severity === "high" || item.severity === "medium")
        .map((item) => ({ ms: item.timestampMs, severity: item.severity })),
    [sceneSuspicionItems],
  );

  function handleScenePreviewTimeUpdate(currentMs: number) {
    maxReachedMsRef.current = Math.max(maxReachedMsRef.current, currentMs);
    const stopAtMs = scenePlayStopAtMsRef.current;
    const reachedRowEnd = stopAtMs != null && currentMs >= stopAtMs;
    // 行再生のOUT点を先に確定し、次の行を一瞬ハイライトすることを防ぐ。
    if (!isEditingSceneTelopRef.current) playheadStore.setSourceMs(reachedRowEnd ? stopAtMs : currentMs);
    if (reachedRowEnd) {
      scenePlayStopAtMsRef.current = null;
      previewPlayerRef.current?.pause();
      previewPlayerRef.current?.seekTo(stopAtMs);
    }
  }

  function playScene(scene: Scene, options: { suppressAutoScroll?: boolean; stopAtEnd?: boolean } = {}) {
    const player = previewPlayerRef.current;
    if (!player) return;
    // W10-8b: 再生開始時は編集中シーン固定を解除し、再生位置で currentScene を追従させる。
    isEditingSceneTelopRef.current = false;
    // フェーズW5-7: 要確認パネルからのSpace再生ではシーン一覧の自動追従スクロールを止める
    // (パネルを見たまま該当部分だけ聴けるように)。通常の行再生では従来通り追従する。
    // W14-1: 遷移ルールは playbackScroll.ts に集約(OP行操作での抑制からの復帰もここが担う)。
    setPlaybackScrollSuppressed(
      playbackScrollSuppressedFor(options.suppressAutoScroll ? "hotspot-panel" : "scene-row"),
    );
    // フェーズW6: OPクリップ再生の停止予約が残っていると後の再生が突然止まるため解除する。
    opPlayStopAtTimelineMsRef.current = null;
    // W21: 既定は連続再生(次のシーンへ続く)。行末で自動停止するのは「この行だけ再生」と
    // 明示している導線(Tab・要確認パネルの▶)だけにする。
    // 予約はseekToの後に設定する(OP静止エントリ離脱のseekToは停止通知を出し、
    // handlePreviewPlayingChangeが停止予約を掃除するため、先に設定すると消える)。
    const kept = computeSceneKeptSubRanges(scene);
    if (!kept.length) return;
    player.seekTo(kept[0].startMs);
    scenePlayStopAtMsRef.current = options.stopAtEnd ? kept[kept.length - 1].endMs : null;
    player.play();
  }

  /**
   * フェーズW6(OP行): OPクリップだけ再生する。タイムラインms基準のシーク(setTimelineSeekMs)を
   * PreviewPlayerが消化した直後(onSeekTimelineConsumed)に再生を開始し、
   * onTimelineTimeUpdate が stopAt に達したら一時停止する。
   */
  function playOpClip(timelineStartMs: number, timelineEndMs: number) {
    // W14-1: OPクリップは本編シーンの区間を再生するため、再生ヘッド移動に釣られて
    // シーン一覧が該当シーンまで自動スクロールしないよう抑制フラグを立てる。
    setPlaybackScrollSuppressed(playbackScrollSuppressedFor("op-row"));
    scenePlayStopAtMsRef.current = null;
    opPlayStopAtTimelineMsRef.current = timelineEndMs;
    opPlayPendingRef.current = true;
    setTimelineSeekMs(timelineStartMs);
  }

  /** フェーズW6(OP行): 波形クリックでプレビューのOP該当位置へシークする(再生はしない)。 */
  function seekOpTimeline(timelineMs: number) {
    // W14-1: OP波形クリックのシークでも再生ヘッド由来の自動追従スクロールを抑制する。
    setPlaybackScrollSuppressed(playbackScrollSuppressedFor("op-row"));
    opPlayStopAtTimelineMsRef.current = null;
    setTimelineSeekMs(timelineMs);
  }

  /**
   * フェーズW6(OP行): クリップのトリム・文言のインライン編集。live(commit=false)は
   * runOpConfig state の更新のみ=プレビュー・タイムライン軸へ即時反映され、
   * commit=true で run正本(op_config.json)へ保存する(映像への反映は従来どおり「適用」)。
   * clips=null(AI自動選定)だった場合、最初の編集で手動選定へ切り替わる(OP編集モーダルと同じ)。
   */
  function handleOpClipsChange(clips: OpClip[], options: { commit: boolean }) {
    // W14-1: OP行の幅変更ドラッグ(トリム)ではタイムライン軸がずれて再生位置由来の
    // currentScene が変わり得るため、操作中はシーン一覧の自動追従スクロールを抑制する。
    setPlaybackScrollSuppressed(playbackScrollSuppressedFor("op-row"));
    const runDir = transcriptState?.runDir;
    const base: RunOpConfig = runOpConfig ?? { ...DEFAULT_OP_CONFIG, clips: null };
    const next: RunOpConfig = { ...base, clips };
    setRunOpConfig(next);
    if (!options.commit || !runDir) return;
    window.catcut
      .saveOpConfig({ runDir, config: next })
      .then((saved) => {
        setRunOpConfig(saved as RunOpConfig);
        // W11-2: 適用ボタン廃止に伴い文言変更(書き出し時に自動で適用される)
        setInspectionCopyToast("OPを保存しました。書き出し時に自動で反映されます");
      })
      .catch(() => setInspectionCopyToast("OPの保存に失敗しました"));
  }

  /**
   * シーン行の再生バーを指定ms位置へ移動する(プレビューもシーク追従する)。
   * W16-4: 明示的なシーク(クリック・キーボード・ジャンプ)なので削除アンカーmsを確定し、
   * 位置が変わった以上もう有効でない確定キャレットは解除する(←→キー等は解除後に再設定する)。
   */
  function seekScenePlayhead(ms: number) {
    hoverSeekThrottleRef.current?.cancel();
    hoverPlayArmedRef.current = false;
    playheadStore.setSourceMs(ms);
    playheadStore.setTimelineMs(sourceMsToTimelineEditMs(timelineEditingRef.current.ranges, ms));
    setTranscriptSeekMs(ms);
    deleteAnchorMsRef.current = ms;
    setConfirmedCaret(null);
  }

  /**
   * W10-8a: 再生中は波形ホバーシークを無効化する。停止中のみシーク。
   * W16-3: 再生中判定はReact stateでなくref(isPlaybackActiveRef)で読む。停止/再生直後の
   * state更新遅延でホバーが誤ってシーク扱いになり「勝手に再生位置が変わった」ように見える
   * 経路を塞ぐ。W16-4: ホバー由来のシークは削除アンカーを確定せず、逆に無効化する
   * (「マウスが通っただけの位置」でDeleteが発動しないようにする)。
   * W19-A2: transcriptSeekMs(state)を通さずPreviewPlayerのref直呼び(seekToSourceMs)へ変更。
   * 旧経路はmousemoveごとにApp全体が2回再レンダリングされていた(set→consumeでnullへ戻す)。
   * シーク自体も約30msへスロットリングする(trailingで最後のホバー位置には必ず着地する)。
   * クリック確定(seekScenePlayhead)は従来どおりstate経由。
   */
  const hoverSeekThrottleRef = useRef<ThrottledSeek | null>(null);
  function handleSceneHoverSeek(ms: number) {
    if (isPlaybackActiveRef.current) return;
    deleteAnchorMsRef.current = null;
    if (!hoverSeekThrottleRef.current) {
      hoverSeekThrottleRef.current = createThrottledSeek((seekMs) => {
        // trailing実行時点で再生が始まっていたらシークしない(W10-8aガードと同じ意図)
        if (isPlaybackActiveRef.current) return;
        previewPlayerRef.current?.seekToSourceMs(seekMs);
      }, HOVER_SEEK_THROTTLE_MS);
    }
    hoverSeekThrottleRef.current.request(ms);
  }

  function handleWaveformGestureStart() {
    hoverSeekThrottleRef.current?.cancel();
    hoverPlayArmedRef.current = false;
    pauseIfPlaying();
    setPlaybackScrollSuppressed(true);
  }

  function seekTimelinePlayhead(ms: number) {
    const { durationMs } = timelineEditingRef.current;
    const next = Math.max(0, Math.min(durationMs, ms));
    handleWaveformGestureStart();
    setChipSelection(null);
    setConfirmedCaret(null);
    playheadStore.setTimelineMs(next);
    setTimelineSeekMs(next);
  }

  function stepTimelinePlayhead(direction: 1 | -1, frames: number) {
    const { ranges, fps } = timelineEditingRef.current;
    const current = playheadStore.getTimelineMs() ?? sourceMsToTimelineEditMs(ranges, playheadStore.getSourceMs()) ?? 0;
    seekTimelinePlayhead(stepPrecisionFrame(current, direction, fps, frames));
  }

  function splitTimelineAtPlayhead() {
    handleWaveformGestureStart();
    const scenes = sceneActionsRef.current.scenes;
    const timelineMs = playheadStore.getTimelineMs();
    const ranges = timelineEditingRef.current.ranges;
    const endpoint = ranges.find((range) => timelineMs === range.timelineEndMs);
    const ms = timelineMs == null ? playheadStore.getSourceMs() : timelineMsToSourceMs(ranges, timelineMs) ?? endpoint?.sourceEndMs ?? playheadStore.getSourceMs();
    const index = findSceneIndexAtEditMs(scenes, ms);
    const scene = scenes[index];
    // OPの再生位置は本編の素材時間と重複するため、本編の区間内に限る。
    if (!scene || (timelineMs != null && !timelineEditingRef.current.ranges.some((range) => timelineMs >= range.timelineStartMs && timelineMs <= range.timelineEndMs))) return;
    if (ms <= scene.sourceStartMs || ms >= scene.sourceEndMs) return;
    setChipSelection(null);
    setConfirmedCaret(null);
    sceneActionsRef.current.splitAtMs(scene.id, ms, { allowEmptySpeechSide: true });
    seekScenePlayhead(ms);
  }

  // アンマウント時に保留中のtrailingシークを破棄する
  useEffect(() => () => hoverSeekThrottleRef.current?.cancel(), []);

  /**
   * フェーズW6(OP行): OPクリップの元シーン先頭へジャンプする(再生はしない。要確認ジャンプと同挙動)。
   */
  function handleJumpToOpSourceScene(clip: OpClip) {
    const midpoint = opClipMidpointMs(clip);
    const scene = sceneActionsRef.current.scenes.find(
      (item) => item.sourceStartMs <= midpoint && midpoint < item.sourceEndMs,
    );
    if (scene) handleJumpToScene(scene);
  }

  /**
   * フェーズW5-5(要確認パネル): 該当シーンへジャンプする。再生ヘッドを行頭へ確定し、
   * 行を2秒間フラッシュ表示する(SceneRow側でscrollIntoView+.jumpFlash。連打時はタイマー上書き)。
   */
  function handleJumpToScene(scene: Scene) {
    // W14-1: 明示的なジャンプは「行を見せる」操作なので、OP操作等で立てた抑制を解除して
    // jumpFlash の scrollIntoView を従来どおり効かせる。
    setPlaybackScrollSuppressed(playbackScrollSuppressedFor("jump-to-scene"));
    seekScenePlayhead(scene.sourceStartMs);
    if (flashSceneTimerRef.current != null) window.clearTimeout(flashSceneTimerRef.current);
    setFlashSceneId(scene.id);
    flashSceneTimerRef.current = window.setTimeout(() => {
      setFlashSceneId(null);
      flashSceneTimerRef.current = null;
    }, 2000);
  }

  // --- 検品UI v2(シーン行UI, Phase 2: キーボード操作体系) ---
  // 再生ヘッド位置は高頻度(最大60回/秒)で更新されるため、キーボードeffect等からは
  // playheadStore.getSourceMs()で読み取り時にだけ参照する(W19-A3で旧previewCurrentMsRefを置換)。
  // scenesHistory/displayedScenesはrefで最新値をミラーする(呼び出し関数はuseScenes内で
  // 毎レンダー新規に生成されるため、依存配列に含めるとリスナーの付け外しが頻発する)。
  const sceneActionsRef = useRef(scenesHistory);
  sceneActionsRef.current = scenesHistory;
  const activeSceneIdRef = useRef(activeSceneId);
  activeSceneIdRef.current = activeSceneId;
  const displayedScenesRef = useRef(displayedScenes);
  displayedScenesRef.current = displayedScenes;

  /**
   * 改善3(チップ間ホバーキャレット): チップ列ホバー中の一時的な境界カーソル。previewCurrentMsとは
   * 独立した状態で(再生バーを動かさない)、高頻度なマウス移動でも再描画を発生させないようrefに
   * 保持する(previewCurrentMsRefと同じ方針)。
   * W16-4: ホバーキャレットは表示専用へ戻した。Delete/Enterのターゲット解決には使わず、
   * Shift+←→の選択起点にのみ使う(誤削除の根本対策。deleteAnchor.ts参照)。
   */
  const chipCaretRef = useRef<{ sceneId: string; groupIndex: number } | null>(null);
  const handleChipCaretChange = useCallback((sceneId: string, groupIndex: number | null) => {
    if (groupIndex == null) {
      if (chipCaretRef.current?.sceneId === sceneId) chipCaretRef.current = null;
      return;
    }
    chipCaretRef.current = { sceneId, groupIndex };
  }, []);

  /**
   * W16-4(確定キャレット): チップ境界のクリック・←/→キーで明示的に確定したキャレット。
   * Delete/Backspace/Enterのターゲット解決はこれを使う(ホバーのchipCaretは使わない)。
   * 削除候補チップの下線表示に使うためstateで持ち、キーボードeffectから読むrefへミラーする。
   * シーン構成が変わる操作(分割・結合)や明示的シークで解除する。
   */
  const [confirmedCaret, setConfirmedCaretState] = useState<ConfirmedCaret | null>(null);
  const confirmedCaretRef = useRef<ConfirmedCaret | null>(null);
  const setConfirmedCaret = useCallback((value: ConfirmedCaret | null) => {
    confirmedCaretRef.current = value;
    setConfirmedCaretState(value);
  }, []);

  /** W16-4: チップ境界のクリック(SceneRowのonCaretCommit)でキャレットを確定する。
   *  クリックはonSeek(seekScenePlayhead=キャレット解除)の後に呼ばれるため、ここで再設定する。 */
  const handleCaretCommit = useCallback(
    (sceneId: string, groupIndex: number) => {
      setConfirmedCaret({ sceneId, groupIndex });
    },
    [setConfirmedCaret],
  );

  /**
   * W16-4(削除アンカーms): 明示的操作(クリックシーク・キーボードシーク・再生・一時停止)で
   * 確定した再生ヘッド位置。ホバースクラブで再生ヘッドが動いたらnullへ無効化し、
   * 「マウスが通っただけの位置」でDeleteが発動しないようにする。
   */
  const deleteAnchorMsRef = useRef<number | null>(null);

  /**
   * W16-3/W16-4: <video>の実際の再生状態をplay/pauseイベントから同期的に持つref。
   * isPreviewPlaying(state)は更新が1レンダー遅れるため、ホバーシークのガードと
   * 削除アンカー解決はこちらを読む。再生中は再生位置そのものが削除アンカーになり、
   * 一時停止した瞬間の位置をアンカーとして確定する。
   */
  const isPlaybackActiveRef = useRef(false);
  const handlePreviewPlayingChange = useCallback((playing: boolean) => {
    if (isPlaybackActiveRef.current && !playing) {
      deleteAnchorMsRef.current = playheadStore.getSourceMs();
    }
    if (playing) {
      // W21: 再生が始まったら(トランスポート▶含む)ホバー行Space再生の発動権を消費する。
      // 置いたままのマウス位置を「行を再生し直す意思」と誤解しないため。
      hoverPlayArmedRef.current = false;
      // W21: 再生中は必ず再生ヘッド(currentScene)を追従させる。テロップ編集中フラグが
      // 立ったまま再生が始まると、停止時に古い行へ戻ったように見える(playheadStore凍結)。
      isEditingSceneTelopRef.current = false;
    } else {
      // W21: 「この行だけ再生」の停止予約は、その再生が止まった時点で役目を終える。
      // 残したままだと次の再生(再開)が過去の行末で突然止まる。
      scenePlayStopAtMsRef.current = null;
    }
    isPlaybackActiveRef.current = playing;
    setIsPreviewPlaying(playing);
  }, []);

  // scissorsMode/chipSelectionもキーボードeffectからrefミラー越しに読む(previewCurrentMsRefと同じ方針)。
  const scissorsModeRef = useRef(scissorsMode);
  scissorsModeRef.current = scissorsMode;
  const chipSelectionRef = useRef(chipSelection);
  chipSelectionRef.current = chipSelection;
  // W10-1: シーン選択もキーボードeffectからrefミラー越しに読む。
  const selectedSceneIdRef = useRef(selectedSceneId);
  selectedSceneIdRef.current = selectedSceneId;
  // V6-2: Delete/Backspaceの挙動をタブで切り替えるため、reviewTabもrefミラー越しに読む。
  const reviewTabRef = useRef(reviewTab);
  reviewTabRef.current = reviewTab;

  /** W10-1(シーン単位の選択): 行番号チップのクリックで選択をトグルする。 */
  const handleToggleSceneSelect = useCallback((sceneId: string) => {
    setSelectedSceneId((current) => {
      const next = current === sceneId ? null : sceneId;
      if (next) setActiveSceneId(sceneId);
      return next;
    });
  }, []);

  /** W17(操作中シーン): 元テキストのホバー/クリック、表示テキストの編集開始で
   *  この行を「いま触っているシーン」としてハイライトする(行番号のトグル選択とは別)。 */
  const handleActivateScene = useCallback((sceneId: string) => {
    setActiveSceneId(sceneId);
    // 別行の「丸ごと削除」選択を残さない。元テキスト側へ移った後のDeleteが、
    // 以前チェックしたシーンへ当たる事故を防ぐ。クリック確定まではDeleteは何もしない。
    setSelectedSceneId(null);
    // 別行の古い確定キャレット（赤い削除候補）と再生ヘッド由来アンカーも解除する。
    // 新しい行では、実際に境界をクリックするまでDelete/Backspaceを発動させない。
    if (confirmedCaretRef.current?.sceneId !== sceneId) setConfirmedCaret(null);
    deleteAnchorMsRef.current = null;
  }, [setConfirmedCaret]);

  /** W10-1: 削除済みシーンのスタブ行から復元する(全単語のdeletedを解除。1操作=Undo1回)。 */
  function handleRestoreScene(sceneId: string) {
    const scene = sceneActionsRef.current.scenes.find((item) => item.id === sceneId);
    if (!scene) return;
    const wordIds = scene.words.filter((word) => word.deleted).map((word) => word.id);
    if (wordIds.length) sceneActionsRef.current.setChipGroupDeletedState(sceneId, wordIds, false);
  }

  /**
   * W10-1(シーン選択中のDelete): 選択中シーンを丸ごと削除し、選択を直前の(上の)未削除シーンへ
   * 連鎖移動する(先頭に達したら次の下の未削除シーンへ)。Delete連打で上のシーンが順に消える。
   * 選択が無ければfalseを返し、呼び出し側は従来のキャレット/再生ヘッド削除へフォールバックする。
   */
  function tryDeleteSelectedScene(): boolean {
    const selectedId = selectedSceneIdRef.current;
    if (!selectedId) return false;
    const scenes = sceneActionsRef.current.scenes;
    const sceneIndex = scenes.findIndex((item) => item.id === selectedId);
    if (sceneIndex === -1) {
      setSelectedSceneId(null);
      return false;
    }
    const scene = scenes[sceneIndex];
    const wordIds = scene.words.filter((word) => !word.deleted).map((word) => word.id);
    if (wordIds.length) sceneActionsRef.current.setChipGroupDeletedState(scene.id, wordIds, true);
    setSelectedSceneId(findNextSelectionAfterSceneDelete(scenes, sceneIndex));
    return true;
  }

  /** 改善5-2(チップのドラッグ複数選択): 行のチップ選択状態が変わった(またはnullになった)ことを受け取る。 */
  const handleChipSelectionChange = useCallback(
    (sceneId: string, range: { start: number; end: number; anchor?: number } | null) => {
      setChipSelection(range ? { sceneId, start: range.start, end: range.end, anchor: range.anchor } : null);
    },
    [],
  );

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

  /** 改善5-6(ハサミモード): 波形上のクリックで任意ms位置に即分割する。
   *  W28(2026-08-22 実機フィードバック): 無音区間でも波形クリックで分割する(旧W16-1は
   *  無音チップを選択するだけで「無音のところでBを入れても分割できない」原因だった)。
   *  無音チップの選択→Delete削除はチップ列クリック(SceneRowのhandleChipClick)が引き続き担う。 */
  function handleScissorsCutAtMs(sceneId: string, ms: number) {
    sceneActionsRef.current.splitAtMs(sceneId, ms, { allowEmptySpeechSide: true });
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

  /** 改善5-7(一括置換ポップアップ): テロップ枠フォーカス時点のテキストを記録する。
   *  W10-6: テキスト編集開始(focus)で再生中なら一時停止する(編集と再生の同時進行を防ぐ)。 */
  function handleTelopFocus(sceneId: string, text: string) {
    pauseIfPlaying();
    handleActivateScene(sceneId);
    telopFocusTextRef.current.set(sceneId, text);
    // W16-5: 新しい編集セッションを開始する(次の入力でUndoエントリを1つだけ積む)。
    telopEditSessionRef.current = null;
  }

  /**
   * W16-5(テロップ編集のUndo単位統合): 編集セッション(focus→blur)内の初回入力だけ
   * Undoエントリを積み(setTelopText)、以後のキーストロークは現在値の差し替え(replaceTelopText)に
   * する。これでCmd+Z一発で「編集開始前」まで戻せる(旧実装は1文字=1Undoエントリだった)。
   * セッション中にCmd+Zした場合はセッションを打ち切り、以後の入力は新しいエントリになる。
   */
  const telopEditSessionRef = useRef<{
    sceneId: string; snapshot: ReturnType<typeof project.editor.getSnapshot>["history"]["present"];
  } | null>(null);
  function handleTelopChangeLive(sceneId: string, text: string) {
    const session = telopEditSessionRef.current;
    if (session && session.sceneId === sceneId && session.snapshot === project.editor.getSnapshot().history.present) {
      sceneActionsRef.current.replaceTelopText(sceneId, text);
      session.snapshot = project.editor.getSnapshot().history.present;
      return;
    }
    sceneActionsRef.current.setTelopText(sceneId, text);
    telopEditSessionRef.current = { sceneId, snapshot: project.editor.getSnapshot().history.present };
  }

  /**
   * 改善5-7(一括置換ポップアップ): テロップ編集確定(blur)。フォーカス時点のテキストとの差分から
   * 単語置換(A→B)を検出し、Aが他シーンにも出現する場合だけ確認ポップアップを出す。
   */
  function handleTelopBlur(sceneId: string) {
    // W16-5: blurで編集セッションを閉じる(次のfocus→入力は新しいUndoエントリになる)。
    telopEditSessionRef.current = null;
    const before = telopFocusTextRef.current.get(sceneId);
    telopFocusTextRef.current.delete(sceneId);
    if (before == null) return;
    const scene = sceneActionsRef.current.scenes.find((item) => item.id === sceneId);
    if (!scene) return;
    const after = scene.telopText;
    if (before === after) return;
    // The draft preserves this edit. Learning is confirmed from the successful export snapshot.
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
   * W16-4: Delete/Backspaceキーの削除アンカーを解決する(deleteAnchor.tsの純関数へ委譲)。
   * ホバーで立つchipCaret・ホバースクラブ後の再生ヘッドはアンカーにしない。
   */
  function resolveSceneDeleteAnchor(): DeleteAnchor | null {
    return resolveDeleteAnchor({
      chipSelection: chipSelectionRef.current,
      selectedSceneId: selectedSceneIdRef.current,
      confirmedCaret: confirmedCaretRef.current,
      playbackActive: isPlaybackActiveRef.current,
      playheadMs: playheadStore.getSourceMs(),
      anchorMs: deleteAnchorMsRef.current,
    });
  }

  /**
   * Delete(Backspace): アンカー左隣の単語グループチップを削除。行頭なら上の行と結合する。
   * 改善1: 文字word単位ではなくグループ単位で操作する(1グループ=1回のUndo操作)。
   * W16-4: アンカーは確定キャレット(クリック/←→で確定)または明示的に確定した再生ヘッド位置のみ。
   */
  function handleSceneDeleteLeft(anchor: Extract<DeleteAnchor, { kind: "caret" | "playhead" }>) {
    const scenes = sceneActionsRef.current.scenes;
    if (anchor.kind === "caret") {
      const caretSceneIndex = scenes.findIndex((item) => item.id === anchor.sceneId);
      if (caretSceneIndex === -1) {
        setConfirmedCaret(null);
        return;
      }
      const caretScene = scenes[caretSceneIndex];
      if (isCaretAtLineStart(anchor.groupIndex)) {
        if (caretSceneIndex > 0) sceneActionsRef.current.mergeWithNext(scenes[caretSceneIndex - 1].id);
        // 行結合でシーン構成が変わるためキャレットは解除する。
        setConfirmedCaret(null);
        return;
      }
      const caretTarget = resolveCaretDeleteLeftTarget(caretScene, anchor.groupIndex);
      if (caretTarget) {
        sceneActionsRef.current.setChipGroupDeletedState(caretTarget.sceneId, caretTarget.wordIds, true);
      }
      return;
    }
    const nowMs = anchor.ms;
    if (isGroupCursorAtLineStart(scenes, nowMs)) {
      const sceneIndex = findSceneIndexAtEditMs(scenes, nowMs);
      if (sceneIndex > 0) sceneActionsRef.current.mergeWithNext(scenes[sceneIndex - 1].id);
      return;
    }
    const target = resolveGroupDeleteLeftTarget(scenes, nowMs);
    if (target) sceneActionsRef.current.setChipGroupDeletedState(target.sceneId, target.wordIds, true);
  }

  /** Fn+Delete(Forward Delete): アンカー右隣の単語グループチップを削除する。 */
  function handleSceneDeleteRight(anchor: Extract<DeleteAnchor, { kind: "caret" | "playhead" }>) {
    const scenes = sceneActionsRef.current.scenes;
    if (anchor.kind === "caret") {
      const caretScene = scenes.find((item) => item.id === anchor.sceneId);
      if (!caretScene) {
        setConfirmedCaret(null);
        return;
      }
      const target = resolveCaretDeleteRightTarget(caretScene, anchor.groupIndex);
      if (target) sceneActionsRef.current.setChipGroupDeletedState(target.sceneId, target.wordIds, true);
      return;
    }
    const target = resolveGroupDeleteRightTarget(scenes, anchor.ms);
    if (target) sceneActionsRef.current.setChipGroupDeletedState(target.sceneId, target.wordIds, true);
  }

  /** Delete always acts on the explicitly selected track clip, independent of playback. */
  function handleTimelineSceneDelete() {
    telopEditSessionRef.current = null;
    project.editor.deleteSelected();
  }

  /**
   * Enter: 再生バー位置でシーンを分割する。
   * 切り込み(cutMark)位置と一致する場合は任意ms分割(splitAtMs)、それ以外はグループ境界分割
   * (splitAtWordをグループ先頭の文字wordで呼ぶ)。分割後は仕様書の指示通り、再生バー(選択)を
   * 新しい下の行の先頭へ送る。
   * W18: Enterだけはホバー中の縦線位置を使える。Deleteは引き続きクリック/←→で
   * 確定した位置のみを使い、ホバーによる誤削除を防ぐ。
   * W10-3: チップ選択がある場合は最優先で「選択範囲の先頭チップの位置」で分割する
   * (選択チップから後ろが新シーンになる)。分割後は下側(新シーン)の先頭へ再生バーを送る。
   */
  function handleSceneEnterSplit() {
    if (reviewTabRef.current === "timeline") { splitTimelineAtPlayhead(); return; }
    const scenes = sceneActionsRef.current.scenes;
    const selection = chipSelectionRef.current;
    if (selection) {
      const selectionScene = scenes.find((item) => item.id === selection.sceneId);
      if (selectionScene) {
        const selectionTarget = resolveCaretSplitTarget(selectionScene, selection.start);
        setChipSelection(null);
        if (selectionTarget) {
          sceneActionsRef.current.splitAtWord(selectionTarget.sceneId, selectionTarget.wordId);
          const word = selectionScene.words.find((item) => item.id === selectionTarget.wordId);
          if (word) seekScenePlayhead(word.startMs);
        }
        return;
      }
    }
    const caret = chipCaretRef.current ?? confirmedCaretRef.current;
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
    const nowMs = playheadStore.getSourceMs();
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

  /** ⌘M: いま触っている行(なければ再生ヘッドの行)を下の生きている行と結合する。 */
  function handleSceneMergeWithNext(preferredSceneId?: string) {
    const scenes = sceneActionsRef.current.scenes;
    const preferredId = preferredSceneId ?? activeSceneIdRef.current;
    const preferredIndex = preferredId ? scenes.findIndex((scene) => scene.id === preferredId) : -1;
    const sceneIndex =
      preferredIndex !== -1 ? preferredIndex : findSceneIndexAtEditMs(scenes, playheadStore.getSourceMs());
    if (sceneIndex !== -1) sceneActionsRef.current.mergeWithNext(scenes[sceneIndex].id);
    // W16-4: 行結合でグループ境界が変わるため確定キャレットは解除する。
    setConfirmedCaret(null);
  }

  /** ←/→: 再生バーを単語グループチップ単位で前後移動する(シーンをまたぐ移動も可)。
   *  W16-4: 移動先のグループ境界を確定キャレットとして立てる(Delete/Enterの明示的アンカーになる)。 */
  function handleSceneAdjacentChip(direction: 1 | -1) {
    const scenes = sceneActionsRef.current.scenes;
    const targetMs = findAdjacentGroupBoundaryMs(scenes, playheadStore.getSourceMs(), direction);
    if (targetMs == null) return;
    seekScenePlayhead(targetMs);
    const cursor = resolveGroupCursor(scenes, targetMs);
    if (cursor) {
      const sceneId = scenes[cursor.sceneIndex].id;
      setConfirmedCaret({ sceneId, groupIndex: cursor.groupIndex });
      setActiveSceneId(sceneId);
      setSelectedSceneId(null);
    }
  }

  /**
   * W10-2(Shift+←/→): チップ選択をアンカー固定で1グループずつ拡張/縮小する。
   * 選択が無ければ、ホバーキャレット(優先)または再生ヘッド位置のグループ境界を起点に
   * 1チップの選択を新規に作る(以後の矢印で伸縮できる)。
   */
  function handleChipSelectionShiftExtend(direction: 1 | -1) {
    const scenes = sceneActionsRef.current.scenes;
    const selection = chipSelectionRef.current;
    if (selection) {
      const scene = scenes.find((item) => item.id === selection.sceneId);
      if (!scene) return;
      const groups = buildWordGroups(scene);
      const next = shiftExtendChipRange(selection, selection.anchor ?? selection.start, direction, groups.length);
      setChipSelection({ sceneId: selection.sceneId, ...next });
      return;
    }
    const caret = chipCaretRef.current;
    let sceneId: string;
    let boundaryIndex: number;
    if (caret) {
      sceneId = caret.sceneId;
      boundaryIndex = caret.groupIndex;
    } else {
      const cursor = resolveGroupCursor(scenes, playheadStore.getSourceMs());
      if (!cursor) return;
      sceneId = scenes[cursor.sceneIndex].id;
      boundaryIndex = cursor.groupIndex;
    }
    const scene = scenes.find((item) => item.id === sceneId);
    if (!scene) return;
    const initial = initialShiftChipRange(boundaryIndex, direction, buildWordGroups(scene).length);
    if (initial) setChipSelection({ sceneId, ...initial });
  }

  /** ↑/↓: 行移動。移動先の行頭に再生バーを送る。 */
  function handleSceneAdjacentRow(direction: 1 | -1) {
    const scenes = sceneActionsRef.current.scenes;
    const nowMs = playheadStore.getSourceMs();
    const sceneIndex = findSceneIndexAtEditMs(scenes, nowMs);
    const currentId = sceneIndex !== -1 ? scenes[sceneIndex].id : null;
    const targetId = findAdjacentSceneId(displayedScenesRef.current, currentId, direction);
    if (!targetId) return;
    const targetScene = scenes.find((scene) => scene.id === targetId);
    if (targetScene) seekScenePlayhead(targetScene.sourceStartMs);
  }

  /** Tab: 現在行だけ再生する(行末で自動停止。既存playSceneを流用)。 */
  function handleScenePlayCurrentRow() {
    const scenes = sceneActionsRef.current.scenes;
    const sceneIndex = findSceneIndexAtEditMs(scenes, playheadStore.getSourceMs());
    if (sceneIndex !== -1) playScene(scenes[sceneIndex], { stopAtEnd: true });
  }

  useEffect(() => {
    if (FEATURES.legacyReviewUi) return undefined;
    if (reviewStage !== "transcript") return undefined;

    const onSceneKeyDown = (event: KeyboardEvent) => {
      if (editorTransitionBusyRef.current) return;
      // IME変換中のEnter/Spaceなどは一切奪わない。
      if (event.isComposing || event.keyCode === 229) return;
      const target = event.target as HTMLElement | null;
      if (shouldIgnoreSceneKeyboard({
        key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey,
        isComposing: event.isComposing, keyCode: event.keyCode, defaultPrevented: event.defaultPrevented,
        hasOpenDialog: Boolean(document.querySelector(SCENE_KEYBOARD_DIALOG_SELECTOR)),
        tagName: target?.tagName, isContentEditable: target?.isContentEditable,
        inputType: target instanceof HTMLInputElement ? target.type : undefined,
        isSceneTelopInput: target?.classList.contains("sceneTelopInput"),
        isSceneEditingButton: Boolean(target?.closest(SCENE_EDITING_BUTTON_SELECTOR)),
        isWorkspaceControl: Boolean(target?.closest(".sceneWorkspaceSection")),
      })) return;
      // テキスト枠(textarea)に入力フォーカスがある間はグローバルキーを一切奪わない。
      // ツールバーのボタン(元に戻す/書き出し等、シーン行の外側)にフォーカスがある場合も
      // ネイティブのクリック操作を優先する。ただしチップ/この行だけ再生ボタンはシーン行内の
      // 主要な操作導線なので除外しない(クリック後にフォーカスが残っても後続のキー操作を妨げない)。
      const isTypingTarget =
        !!target && ((target.tagName === "INPUT" && !(target instanceof HTMLInputElement && target.type === "range")) || target.tagName === "TEXTAREA" || target.isContentEditable);
      const isOutsideRowControlTarget =
        !!target && (target.tagName === "BUTTON" || target.tagName === "SELECT") && !target.closest(".sceneRow");

      // W16-5: シーンテロップtextareaの編集中に限り、Cmd+Z/⇧Cmd+ZはisTypingTargetガードの
      // 例外としてグローバルUndo/Redoを効かせる(controlled textareaはネイティブUndoが効かず
      // 完全に無反応だった)。編集セッションは打ち切り、以後の入力は新しいUndoエントリになる。
      const isSceneTelopTarget =
        !!target && target.tagName === "TEXTAREA" && target.classList.contains("sceneTelopInput");
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && isSceneTelopTarget) {
        event.preventDefault();
        telopEditSessionRef.current = null;
        if (event.shiftKey) sceneActionsRef.current.redo();
        else sceneActionsRef.current.undo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "m" && isSceneTelopTarget) {
        event.preventDefault();
        handleSceneMergeWithNext();
        return;
      }

      if (isTypingTarget) return;
      const selectedKind = project.editor.getSnapshot().selection?.kind;
      const selectedMedia = selectedKind === "image" || selectedKind === "bgm";
      if (isOutsideRowControlTarget && !isSceneToolShortcut(event) && !((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z")) return;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        telopEditSessionRef.current = null;
        event.preventDefault();
        if (event.shiftKey) sceneActionsRef.current.redo();
        else sceneActionsRef.current.undo();
        return;
      }
      if (selectedMedia && (event.key === "Enter" || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "m"))) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "m") {
        event.preventDefault();
        handleSceneMergeWithNext();
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isRepeatedSceneCommand(event.key, event.repeat)) { event.preventDefault(); return; }

      switch (event.key) {
        case " ":
        case "Spacebar": {
          event.preventDefault();
          const player = previewPlayerRef.current;
          if (!player) return;
          const hoveredSceneId = hoveredSceneIdRef.current;
          const scenes = sceneActionsRef.current.scenes;
          const hoveredScene = scenes.find((scene) => scene.id === hoveredSceneId);
          const currentIndex = findSceneIndexAtEditMs(scenes, playheadStore.getSourceMs());
          const currentSceneIdNow = currentIndex !== -1 ? scenes[currentIndex].id : null;
          const action = resolveSceneSpaceAction(player.isPaused(), hoverPlayArmedRef.current, Boolean(hoveredScene && hoveredSceneId !== currentSceneIdNow));
          if (action === "pause") {
            player.pause();
            hoverPlayArmedRef.current = false;
            playheadStore.setSourceMs(player.getCurrentTimeMs());
            setPlaybackScrollSuppressed(true);
            return;
          }
          // 改善5-9(ホバー行からSpace再生): 行に乗せ直した直後(armed)にSpaceを押した場合のみ、
          // その行の先頭から再生する。W21: マウスを置いたままの再生→停止→再生は従来通りの
          // トグル(=停止位置からの再開)にする(前の行へ毎回巻き戻る問題の修正)。
          if (action === "play-hovered") {
            if (hoveredScene) {
              hoverPlayArmedRef.current = false;
              isEditingSceneTelopRef.current = false;
              playScene(hoveredScene, { suppressAutoScroll: hoveredFromHotspotRef.current });
              return;
            }
          }
          isEditingSceneTelopRef.current = false;
          player.play();
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
          if (project.editor.getSnapshot().selection || project.editor.getSnapshot().preview) {
            event.preventDefault();
            project.editor.cancelPreview();
            project.editor.select(null);
            return;
          }
          if (chipSelectionRef.current) {
            event.preventDefault();
            setChipSelection(null);
            return;
          }
          // W10-1: シーン選択もEscで解除する(チップ選択の解除より後段)。
          if (selectedSceneIdRef.current) {
            event.preventDefault();
            setSelectedSceneId(null);
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
          // W10-2: Shift+←はチップ選択の拡張/縮小(通常の←は従来どおり再生バー移動)。
          if (reviewTabRef.current === "timeline") { stepTimelinePlayhead(-1, event.shiftKey ? 10 : 1); return; }
          if (event.shiftKey) handleChipSelectionShiftExtend(-1);
          else handleSceneAdjacentChip(-1);
          return;
        case "ArrowRight":
          event.preventDefault();
          if (reviewTabRef.current === "timeline") { stepTimelinePlayhead(1, event.shiftKey ? 10 : 1); return; }
          if (event.shiftKey) handleChipSelectionShiftExtend(1);
          else handleSceneAdjacentChip(1);
          return;
        case "ArrowUp":
          event.preventDefault();
          handleSceneAdjacentRow(-1);
          return;
        case "ArrowDown":
          event.preventDefault();
          handleSceneAdjacentRow(1);
          return;
        case "Backspace": {
          // Macキーボードの「削除」キー(左隣を消す)。改善5-2: チップ選択があればそちらを優先する。
          // V6-2: タイムラインタブでは選択中シーンの丸ごと削除(input/textarea中は上のガードで無効)。
          // W10-1: シーン選択(行番号チップ)中は丸ごと削除+直前の未削除シーンへ連鎖選択。
          // W16-4: アンカーが解決できない(ホバーで通っただけ等)場合は何も削除しない。
          event.preventDefault();
          if (reviewTabRef.current === "timeline" || selectedMedia) {
            handleTimelineSceneDelete();
            return;
          }
          const anchor = resolveSceneDeleteAnchor();
          if (!anchor) return;
          if (anchor.kind === "selection") {
            tryDeleteChipSelection();
            return;
          }
          if (anchor.kind === "scene") {
            tryDeleteSelectedScene();
            return;
          }
          handleSceneDeleteLeft(anchor);
          return;
        }
        case "Delete": {
          // Fn+Delete(Forward Delete、右隣を消す)。改善5-2: チップ選択があればそちらを優先する。
          // V6-2: タイムラインタブではBackspaceと同じくシーン削除。
          // W10-1: シーン選択中はBackspaceと同じく丸ごと削除+連鎖選択。
          event.preventDefault();
          if (reviewTabRef.current === "timeline" || selectedMedia) {
            handleTimelineSceneDelete();
            return;
          }
          const anchor = resolveSceneDeleteAnchor();
          if (!anchor) return;
          if (anchor.kind === "selection") {
            tryDeleteChipSelection();
            return;
          }
          if (anchor.kind === "scene") {
            tryDeleteSelectedScene();
            return;
          }
          handleSceneDeleteRight(anchor);
          return;
        }
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
    if (!sceneDraft) {
      setError("編集データを読み込み中です。読み込み完了後にもう一度お試しください。");
      return null;
    }
    setSceneApplying(true);
    setSceneApplyProgress(null);
    setError("");
    try {
      const saved = await flushSceneDraft();
      const exportScenes = saved.draft.scenes;
      const exportKeepSegments = deriveKeepSegments(exportScenes);
      const sceneTelopPositions = exportScenes.map((scene) => ({ startMs: scene.sourceStartMs, endMs: scene.sourceEndMs, telopPosition: scene.telopPosition }));
      // フェーズT2(directedモード): テーマ×感情(T-5)経路は使わず、シーン編集を
      // directedスロット(文言・スタイルID・強調語・絶対ms範囲)としてmainへ送る。
      // main側が telop_directives.json を差し替えてから step08 を再実行する。
      if (isDirectedTelopMode) {
        const result = await window.catcut.applyTranscriptEdits({
          runDir: transcriptState.runDir,
          keepSegments: exportKeepSegments,
          sceneTelopPositions,
          corrections: [],
          directedSlots: deriveDirectedSlots(exportScenes, telopTypeMapping, activeSpeakerColors),
          // U1-5: プレビューでのオーバーレイ文言編集をdirectives(chapters/overlays)へ書き戻す。
          overlayEdits: Object.entries(saved.draft.overlayEdits).map(([id, edit]) => ({ id, ...edit })),
          // フェーズU6: シーン個別カスタムスタイルの定義(custom_scene_*)。main側が
          // telop_directives.json の custom_styles へマージし step08 が composition へ注入する。
          customStyles: saved.draft.customStyles,
        });
        // 適用後はcompositionが再生成されるため、ローカルのオーバーレイ上書きはクリアする。
        setOverlayEdits({});
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
        return { ...result, learningSnapshot: { scenes: exportScenes, keepSegments: exportKeepSegments } };
      }
      // T-5: scenesから導出したcut単位のスタイルID配列と、実際に使うスタイルの辞書一式を
      // 一緒に送る(main側はtelop.txtへの@styleディレクティブ注入とtelop_style_plan.json書き込みに使う)。
      const telopStyleIdsByCut = deriveTelopStyleIds(exportScenes, telopThemeId);
      const telopStylePlan = buildTelopStylePlan(
        telopStyleIdsByCut,
        transcriptState.telopFontSize || 52,
        telopThemeId,
      );
      const result = await window.catcut.applyTranscriptEdits({
        runDir: transcriptState.runDir,
        keepSegments: exportKeepSegments,
        sceneTelopPositions,
        corrections: [],
        telopOverrides: deriveTelopOverrides(exportScenes),
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
      return { ...result, learningSnapshot: { scenes: exportScenes, keepSegments: exportKeepSegments } };
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setSceneApplying(false);
    }
  }

  // フェーズW7: 「書き出し」ボタンは毎回この設定モーダルを開き、確定後に適用→書き出しへ進む
  async function startExportWithSettings(value: ExportSettingsValue) {
    if (!transcriptState) return;
    setExportSettingsOpen(false);
    // W19-C3: 書き出し(適用含む)開始時にプレビューを一時停止してレンダラー負荷を下げる
    // (W16-6のvisibilitychangeハンドラと同じpause経路)。ユーザーの明示再生はブロックしない。
    const player = previewPlayerRef.current;
    if (player && !player.isPaused()) player.pause();
    // 今回の保存場所・ファイル名を次回の既定値として設定に残す
    saveCurrentSettings({ outputDirectory: value.directory, outputFileName: value.fileName }).catch(() => undefined);
    const result = await applySceneEdits();
    if (!result) return;
    setError("");
    setRunning(true);
    const targetShortSide = targetShortSideForResolution(value.resolution);
    const crf = crfForQuality(value.quality);
    const renderConcurrency = concurrencyForRenderSpeed(value.renderSpeed);
    const exportResult = await window.catcut.startExport({
      runDir: result.transcript.runDir,
      renderFinal: true,
      learningSnapshot: result.learningSnapshot,
      outputPath: buildExportOutputPath(value.directory, value.fileName, videoPath),
      ...(targetShortSide ? { targetShortSide } : {}),
      // W11-1b: HWエンコードON時は crf 指定不可(Remotionの制約)のため、
      // 画質選択をビットレートへマップして渡す。OFFは従来どおりCRF指定
      ...(value.hardwareEncode
        ? {
            hardwareAcceleration: "if-possible" as const,
            videoBitrate: videoBitrateForQuality(value.quality, value.resolution),
          }
        : crf
          ? { crf }
          : {}),
      renderConcurrency,
    });
    if (!exportResult.ok) {
      setRunning(false);
      setError(exportResult.error ?? "書き出しを開始できませんでした");
    }
  }

  // --- フェーズW7: プロジェクト一覧(検品段階からの再編集) ---

  const refreshProjects = useCallback(() => {
    if (!electronReady) return;
    window.catcut
      .listProjects()
      .then((result) => setProjects(result.projects))
      .catch(() => undefined);
  }, [electronReady]);

  // 起動時と、処理・検品が終わって一覧に戻るたびに読み直す
  useEffect(() => {
    if (!running && !reviewState) refreshProjects();
  }, [refreshProjects, reviewState, running]);

  /** プロジェクト一覧から選んだrunを検品段階(review:readyと同じ状態)で開き直す */
  async function openProject(project: CatCutProjectSummary) {
    if (running) return;
    setError("");
    setProjectOpeningRunDir(project.runDir);
    try {
      const review = await window.catcut.loadTelop(project.runDir);
      const transcript = await window.catcut.loadTranscriptEditor(project.runDir);
      const nextStyles = normalizeTelopStyles(review.telopStyles);
      const nextDefaultStyle = review.defaultTelopStyle || "default";
      setOutputs(null);
      setExportProgress(0);
      setSteps(initialSteps);
      setRunName(project.runName);
      setRunDir(project.runDir);
      setVideoPath(transcript.sourceVideoPath || project.sourceVideoPath || "");
      // W8: 再オープンしたrunの向きは orientation.json 正本をmainが解決するため、
      // 新規開始用の選択state(チップ)は前のセッションの値を持ち越さない
      setVideoProbe(null);
      setVideoOrientation(null);
      setReviewStage("transcript");
      setReviewState({
        outputs: review.outputs,
        review: review.review,
        renderFinal: true,
        fontPlan: review.fontPlan,
        telopStyleDirectivesText: review.telopStyleDirectivesText,
        telopStylePlan: review.telopStylePlan,
        telopStyles: review.telopStyles,
        defaultTelopStyle: review.defaultTelopStyle,
        previewPages: review.previewPages,
      });
      setTelopText(autoAssignTelopStyles(review.telopText, nextStyles, nextDefaultStyle));
      setFontDirectives(review.fontDirectivesText);
      setTelopStyleDirectives(review.telopStyleDirectivesText || defaultTelopStyleDirectives);
      setTelopStyles(nextStyles);
      setEditingTelopStyle(Object.keys(nextStyles)[0] || "default");
      setFontApplyConfirmed(false);
      setTelopStyleApplyConfirmed(false);
      setTelopStyleApplying(false);
      setTelopConfirmed(false);
      setReplacementDrafts({});
      setReviewedFindings({});
      setActivePageId(review.review?.findings?.[0]?.page_id || "");
      setTranscriptState(transcript);
      setActiveTranscriptWordId(transcript.words[0]?.id || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProjectOpeningRunDir(null);
    }
  }

  /** Save the latest edit before leaving; a failed save must keep the editor open. */
  async function closeReviewToProjects() {
    if (editorTransitionBusyRef.current) return;
    const ok = window.confirm(
      "編集を保存してプロジェクト一覧に戻りますか？\n保存した編集は書き出し時に自動で適用されます。",
    );
    if (!ok) return;
    setEditorClosing(true);
    try {
      if (!editorLoadError) await flushSceneDraft();
    } catch (err) {
      setError(`編集を保存できませんでした。${err instanceof Error ? err.message : String(err)}`);
      setEditorClosing(false);
      return;
    }
    setReviewState(null);
    setTranscriptState(null);
    setOutputs(null);
    setExportProgress(0);
    scenesInitializedRunDirRef.current = null;
    scenesDraftReadyRef.current = false;
    project.editor.hydrate(null);
    keepSegmentsHistory.reset({
      keepSegments: [], manualRemovedWordIds: [], wordCorrections: {}, correctionOriginals: {},
    });
    setOverlayEdits({});
    setSceneCustomStyles({});
    setDraftSaveStatus({ state: "idle" });
    setEditorClosing(false);
  }

  async function handleDeleteProject(project: CatCutProjectSummary) {
    const mp4Warning =
      project.exportedVideoPath && project.exportedVideoPath.startsWith(`${project.runDir}/`)
        ? "\n書き出したMP4も作業フォルダ内にあるため一緒に削除されます。"
        : "";
    const ok = window.confirm(
      `プロジェクト「${project.title}」を削除しますか？この操作は元に戻せません。${mp4Warning}`,
    );
    if (!ok) return;
    try {
      await window.catcut.deleteProject({ runDir: project.runDir });
      if (runDir === project.runDir) {
        setRunDir("");
        setRunName("");
        setOutputs(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    refreshProjects();
  }

  async function saveProjectFromExportDone() {
    if (!exportDoneInfo) return;
    setExportDoneBusy(true);
    try {
      await window.catcut.saveProjectMeta({ runDir: exportDoneInfo.runDir });
      setExportDoneInfo(null);
      refreshProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExportDoneBusy(false);
    }
  }

  async function deleteProjectFromExportDone() {
    if (!exportDoneInfo) return;
    const ok = window.confirm("プロジェクトの作業データを削除しますか？この操作は元に戻せません。");
    if (!ok) return;
    setExportDoneBusy(true);
    try {
      await window.catcut.deleteProject({ runDir: exportDoneInfo.runDir });
      setExportDoneInfo(null);
      setOutputs(null);
      setRunDir("");
      setRunName("");
      refreshProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExportDoneBusy(false);
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
    maxReachedMsRef.current = 0;
    setSelectedBoundary(null);
    setFlashSceneId(null);
    // W19-A3: 再生ヘッド(sourceMs/timelineMs)はストア側をリセットする。
    playheadStore.reset();
    setScissorsMode(false);
    setIsPreviewPlaying(false);
    // W16-4: run切替で削除アンカー関連の状態もリセットする。
    isPlaybackActiveRef.current = false;
    deleteAnchorMsRef.current = null;
    setConfirmedCaret(null);
    // W16-7: AI最終チェックの結果もrun単位でリセットする。
    setFinalCheckIssues([]);
    setFinalCheckStatus("");
    setIgnoredFinalCheckIds(new Set());
    setChipSelection(null);
    setTelopReplaceCandidate(null);
    setTelopReplaceSelectedKeys(new Set());
    telopFocusTextRef.current.clear();
    setBgmMuted(false);
    setVideoFramingState(null);
    setReviewTab("scenes");
    setTimelineSeekMs(null);
  }, [transcriptState?.runDir]);

  // フレーミングは適用後の正本を再読込。画像/BGMは共通履歴の最新編集を保持する。
  useEffect(() => {
    const runDir = transcriptState?.runDir;
    if (!runDir) return undefined;
    let cancelled = false;
    // フェーズW9: 映像フレーミング(video_framing.json)。transcript:load 由来の値で初期化し、
    // 念のため run正本を読み直す(無ければ identity が返る)。
    setVideoFramingState(transcriptState?.videoFraming ?? null);
    window.catcut
      .getVideoFraming({ runDir })
      .then((result) => {
        if (!cancelled) setVideoFramingState(result);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [transcriptState]);

  // フェーズV2: run読み込み時にrun単位のOP設定(op_config.json)を読む(無ければmainが
  // テーマ設定から生成する)。タイムラインViewのOPブロック表示とOP編集モーダルの初期値に使う。
  useEffect(() => {
    const runDir = transcriptState?.runDir;
    setRunOpConfig(null);
    if (!runDir) return undefined;
    let cancelled = false;
    window.catcut
      .getOpConfig(runDir)
      .then((config) => {
        if (!cancelled) setRunOpConfig(config as RunOpConfig);
      })
      .catch(() => {
        if (!cancelled) setRunOpConfig(null);
      });
    return () => {
      cancelled = true;
    };
  }, [transcriptState?.runDir]);

  // One automatic retry recovers a transient read; the visible retry action remains available after that.
  useEffect(() => {
    const runDir = transcriptState?.runDir;
    setWaveform(null);
    setWaveformError("");
    if (!runDir) {
      setWaveformLoading(false);
      return;
    }
    const controller = new AbortController();
    setWaveformLoading(true);
    loadWaveformWithRetry(() => window.catcut.generateWaveform({ runDir }), controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setWaveform(result);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setWaveformError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setWaveformLoading(false);
      });
    return () => {
      controller.abort();
    };
  }, [transcriptState?.runDir, waveformReload]);

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
    if (!selected) return;
    setVideoPath(selected);
    // フェーズW8: 選択直後にffprobeで縦横を自動判定し、確認モーダルを開く。
    // 既定値(自動判定。失敗時は横型)を先にstateへ入れておくことで、
    // キャンセル(背景クリック/Esc)は「自動判定値の採用」になる。
    const probe = await window.catcut.probeVideo(selected);
    setVideoProbe(probe);
    setVideoOrientation(probe.ok ? probe.orientation : "horizontal");
    setOrientationModalOpen(true);
  }

  async function saveCurrentSettings(next?: Partial<Settings> & { elevenApiKey?: string }) {
    const merged = {
      sttProvider: settings?.sttProvider ?? "elevenlabs",
      whisperModel: settings?.whisperModel ?? "small",
      renderFinal: settings?.renderFinal ?? true,
      reviewBeforeExport: settings?.reviewBeforeExport ?? true,
      telopMode: settings?.telopMode ?? "full",
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

  // --- フェーズU2: デザインテーマ(起動フローのテロップデザイン選択) ---

  // 削除済みIDがsettingsに残っていてもスタンダードへフォールバックする
  const activeDesignThemeId = resolveActiveDesignThemeId(designThemes, settings?.activeDesignThemeId);
  const activeDesignTheme = findDesignTheme(designThemes, activeDesignThemeId);

  // フェーズU7/U8: スタンダード選択中はuserDataに保存済みのシーンタイトル・OP設定を取り直す
  // (テーマ選択中はテーマ自身の値を使うため不要。main側のdesign-extras:getは選択状態で解決する)。
  useEffect(() => {
    if (activeDesignThemeId !== STANDARD_DESIGN_THEME_ID) return;
    if (typeof window.catcut.getDesignExtras !== "function") return;
    window.catcut
      .getDesignExtras()
      .then((extras) =>
        setStandardDesignExtras({
          overlayTitle: sanitizeOverlayTitle(extras?.overlayTitle),
          op: sanitizeOpConfig(extras?.op),
          speakerColors: sanitizeSpeakerColors(extras?.speakerColors),
          videoEffects: sanitizeVideoEffects(extras?.videoEffects),
        }),
      )
      .catch(() => {});
  }, [activeDesignThemeId]);

  /** フェーズU7/U8: 調整モーダルへ渡す現在のシーンタイトル・OP設定(テーマ優先)。 */
  const currentDesignExtras: DesignExtras = activeDesignTheme
    ? {
        overlayTitle: activeDesignTheme.overlayTitle,
        op: activeDesignTheme.op,
        speakerColors: activeDesignTheme.speakerColors,
        videoEffects: activeDesignTheme.videoEffects,
      }
    : standardDesignExtras;

  // フェーズW23(改善1): 解析開始前の「OPを付ける」チェックボックス。
  // 初期値はアクティブテーマのOP設定(pattern !== "none")に追従し、ユーザーが明示的に
  // 触った値(override)はテーマを切り替えるまで保持する(テーマ切替で毎回追従へリセット)。
  const [opEnabledOverride, setOpEnabledOverride] = useState<boolean | null>(null);
  // W25: 縦型(ショート/リール)はOP無しが既定(2026-08-21 実機フィードバック)。
  // チェックを入れれば従来どおり付けられる。横型はテーマのOP設定に追従。
  const opEnabled =
    opEnabledOverride ??
    (videoOrientation === "vertical" ? false : currentDesignExtras.op.pattern !== "none");
  useEffect(() => {
    setOpEnabledOverride(null);
  }, [activeDesignThemeId]);

  /** main側で解決済み(テーマ優先)のマッピングを取り直してプレビューへ反映する。 */
  async function refreshEffectiveTypeMapping() {
    const mapping = await window.catcut.getTelopTypeMapping();
    setTelopTypeMapping(sanitizeTypeMapping(mapping));
  }

  /** マッピング変更をdirectedプロジェクトへ即時反映する(検品中のみ。step08再実行)。 */
  async function reapplyMappingToProject() {
    if (isDirectedTelopMode && transcriptState) {
      await applySceneEdits();
    }
  }

  async function handleSelectDesignTheme(themeId: string) {
    await saveCurrentSettings({ activeDesignThemeId: themeId });
    await refreshEffectiveTypeMapping();
    await reapplyMappingToProject();
  }

  /** 新規テーマの保存(DesignThemePickerの作成フロー・モーダルの「名前をつけて保存」)。保存後そのテーマを選択する。 */
  async function handleCreateDesignTheme(input: DesignThemeSaveInput) {
    const result = await window.catcut.saveDesignTheme({
      name: input.name,
      baseScene: input.baseScene,
      typeStyles: input.typeStyles,
      // フェーズU7/U8/W1/W2: undefinedはmain側が既定(有効box_accent/OPなし/話者カラー既定/演出ON)に落とす
      overlayTitle: input.overlayTitle,
      op: input.op,
      speakerColors: input.speakerColors,
      videoEffects: input.videoEffects,
    });
    setDesignThemes(sanitizeDesignThemes(result.themes));
    await saveCurrentSettings({ activeDesignThemeId: result.theme.id });
    await refreshEffectiveTypeMapping();
    await reapplyMappingToProject();
  }

  async function handleDeleteDesignTheme(themeId: string) {
    const themes = await window.catcut.deleteDesignTheme(themeId);
    setDesignThemes(sanitizeDesignThemes(themes));
    // 選択中テーマを消した場合はスタンダードへ戻す(選択肢の欠落を作らない)
    if (activeDesignThemeId === themeId) {
      await handleSelectDesignTheme(STANDARD_DESIGN_THEME_ID);
    }
  }

  /**
   * マッピングモーダルの「上書き保存」。テーマ選択中はテーマ更新、
   * スタンダードは従来どおり userData のユーザーマッピングへ保存する。
   */
  async function handleOverwriteTypeMapping(nextMapping: TelopTypeMapping, extras: DesignExtras) {
    if (activeDesignTheme) {
      const result = await window.catcut.saveDesignTheme({
        id: activeDesignTheme.id,
        name: activeDesignTheme.name,
        baseScene: activeDesignTheme.baseScene,
        typeStyles: nextMapping,
        overlayTitle: extras.overlayTitle,
        op: extras.op,
        speakerColors: extras.speakerColors,
        videoEffects: extras.videoEffects,
      });
      setDesignThemes(sanitizeDesignThemes(result.themes));
      await refreshEffectiveTypeMapping();
    } else {
      const saved = await window.catcut.saveTelopTypeMapping(nextMapping, {
        overlayTitle: extras.overlayTitle,
        op: extras.op,
        speakerColors: extras.speakerColors,
        videoEffects: extras.videoEffects,
      });
      setTelopTypeMapping(sanitizeTypeMapping(saved));
      setStandardDesignExtras(extras);
    }
    await reapplyMappingToProject();
  }

  // --- フェーズU6: テロップスタイル詳細エディタ(3経路の開閉と2種の保存フロー) ---

  /** 経路(a)(b): シーン文脈でエディタを開く(プレビューのテロップクリック/スタイルバッジメニュー)。 */
  function openStyleEditorForScene(sceneId: string) {
    const scene = scenesHistory.scenes.find((item) => item.id === sceneId);
    if (!scene) return;
    const styleDef = resolveDirectedSceneStyle(scene, telopTypeMapping, compositionTelopStyles, activeSpeakerColors);
    if (!styleDef) return;
    previewPlayerRef.current?.pause();
    setStyleEditorContext({
      initialStyle: styleDef,
      initialStyleId: effectiveDirectedStyleId(scene, telopTypeMapping, activeSpeakerColors),
      sampleText: scene.telopText,
      sceneId,
      semanticType: isSemanticType(scene.directedType) ? scene.directedType : null,
    });
  }

  /** 経路(c): デザインテーマ調整画面の行「編集」からtype文脈でエディタを開く。 */
  function openStyleEditorForType(type: SemanticType, currentStyleId: string) {
    const styleDef = getPresetStyle(currentStyleId);
    if (!styleDef) return;
    setStyleEditorContext({
      initialStyle: styleDef,
      initialStyleId: currentStyleId,
      sampleText: TYPE_SAMPLE_TEXT[type],
      sceneId: null,
      semanticType: type,
    });
  }

  /**
   * 保存フロー1「このシーンだけに適用」: custom_scene_* の定義を実行時カタログへ登録して
   * プレビューへ即時反映し、シーンの個別上書き(directedStyleId)に設定する。
   * 定義本体は次回適用時に applyTranscriptEdits の customStyles で telop_directives.json へ
   * 書き戻され、step08 が composition の telop_styles へ注入する(書き出しにも反映)。
   */
  function handleStyleEditorApplyToScene(sceneId: string, def: TelopStyleDef) {
    const styleId = customSceneStyleId(sceneId);
    registerRuntimeStyles({ [styleId]: def });
    setSceneCustomStyles((current) => ({ ...current, [styleId]: def }));
    scenesHistory.setDirectedStyle(sceneId, styleId);
  }

  /**
   * 保存フロー2「テーマの◯◯スタイルとして保存」: アクティブテーマの custom_styles へ
   * custom_<theme>_<type> として保存し、type_styles をそのIDへ向ける。
   * design-themes:save → effectiveTypeMappingArgs → step08 の経路で書き出しにも反映される。
   */
  async function handleStyleEditorSaveToTheme(type: SemanticType, def: TelopStyleDef) {
    if (!activeDesignTheme) return;
    const styleId = customThemeStyleId(activeDesignTheme.id, type);
    registerRuntimeStyles({ [styleId]: def });
    const result = await window.catcut.saveDesignTheme({
      id: activeDesignTheme.id,
      name: activeDesignTheme.name,
      baseScene: activeDesignTheme.baseScene,
      typeStyles: {
        ...activeDesignTheme.typeStyles,
        [type]: { ...activeDesignTheme.typeStyles[type], style: styleId },
      },
      customStyles: mergeCustomStyles(activeDesignTheme.customStyles, { [styleId]: def }),
    });
    setDesignThemes(sanitizeDesignThemes(result.themes));
    await refreshEffectiveTypeMapping();
    await reapplyMappingToProject();
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
      telopMode: settings.telopMode ?? "full",
      fontProfileMode,
      savedFontProfileId: fontProfileMode === "saved" ? selectedSavedFontProfile?.id || "" : "",
      fontDirectivesText: fontProfileMode === "saved" ? selectedSavedFontProfile?.directivesText || "" : "",
      outputPath: outputPathFromSettings(settings, videoPath) || "",
      // フェーズW8: 素材選択ポップアップで確定した出力キャンバスの向き(未選択なら自動判定)
      ...(videoOrientation ? { orientation: videoOrientation } : {}),
      silenceTightness,
      // フェーズW23(改善1): OP有無の事前選択(directedモードのみ。fullモードはOP機構なし=従来経路)
      ...(settings.telopMode === "directed" ? { opEnabled } : {}),
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
      telopMode: settings.telopMode ?? "full",
      fontProfileMode,
      savedFontProfileId: fontProfileMode === "saved" ? selectedSavedFontProfile?.id || "" : "",
      fontDirectivesText: fontProfileMode === "saved" ? selectedSavedFontProfile?.directivesText || "" : "",
      outputPath: "",
      groundTruthPath: groundTruth.path,
      learningMode: true,
      silenceTightness,
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
  // フェーズU4: 詳細設定(折りたたみ)の中身が既定値と異なるか。閉じたままでも分かるようバッジに出す
  const advancedChanges: string[] = [];
  if (settings.sttProvider !== "elevenlabs") advancedChanges.push(`STT: ${settings.sttProvider}`);
  if (settings.sttProvider === "local-whisper" && settings.whisperModel !== "small") {
    advancedChanges.push(`Whisper: ${settings.whisperModel}`);
  }
  if (!settings.reviewBeforeExport) advancedChanges.push("チェックなしでMP4まで書き出す");
  const advancedSettingsChanged = advancedChanges.join(" / ");
  const logPanel = (
    <section className={`logPanel ${reviewState ? "reviewLogPanel" : ""}`}>
      <div className="logHeader">
        <span>ログ</span>
        <button onClick={() => setLogs("")}>消去</button>
      </div>
      <pre ref={logRef}>{logs || " "}</pre>
    </section>
  );

  // フェーズW23(改善2): ステージ別UI最小化。editing(検品中。書き出し中含む)は
  // 左ペインを隠して検品ワークスペースを全幅にする。analyzing は停止ボタンのため左ペインを残す。
  const uiStage = uiStageFor({ running, hasReview: Boolean(reviewState) });

  return (
    <main className={`appShell${uiStage === "editing" ? " appShellEditing" : ""}${uiStage === "editing" && reviewTab === "timeline" ? " appShellTimeline" : ""}`}>
      {uiStage !== "editing" && (
      <section className="leftPane">
        <header className="topBar">
          <div>
            <h1>
              <span className="brandMark">
                <CatMark size={18} />
              </span>
              Cat-Cut
            </h1>
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
              <Settings size={14} />
              API設定
            </button>
            {/* W13-1: キャッシュ管理(派生キャッシュのサイズ表示・削除) */}
            <button
              className="secondaryButton apiSettingsButton"
              type="button"
              onClick={() => setCacheManagerOpen(true)}
              disabled={running}
              title="キャッシュ管理"
            >
              <HardDrive size={14} />
              キャッシュ
            </button>
            {/* W12-2: ライセンス設定への導線(FEATURES.billing ONのときのみ表示) */}
            {FEATURES.billing && (
              <button
                className="secondaryButton apiSettingsButton"
                type="button"
                onClick={() => setLicenseModalOpen(true)}
                disabled={running}
                title="ライセンス"
              >
                <KeyRound size={14} />
                ライセンス
              </button>
            )}
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
            <div className="videoPathCell">
              <input
                value={videoPath}
                onChange={(event) => {
                  setVideoPath(event.target.value);
                  // 手入力でパスが変わった場合は前の動画の判定・選択を持ち越さない(自動判定へ戻す)
                  setVideoProbe(null);
                  setVideoOrientation(null);
                }}
              />
              {/* フェーズW8: 縦横の選択結果チップ。クリックでモーダルを開き直して変更できる */}
              {videoPath && videoOrientation && (
                <button
                  className="orientationChip"
                  disabled={running}
                  onClick={() => setOrientationModalOpen(true)}
                  title="クリックで動画の向き(横型/縦型)を変更"
                  type="button"
                >
                  {orientationLabel(videoOrientation)}
                </button>
              )}
            </div>
            <button className="iconButton" onClick={chooseVideo} title="動画を選択">
              <FolderOpen size={18} />
            </button>
          </div>
        </section>

        {/* フェーズU2-3: 動画選択の直下にテロップデザイン選択(directedモード時)。
            fullモードは従来のテーマギャラリー(検品画面)を維持する */}
        {settings.telopMode === "directed" && (
          <section className="panel designThemePanel">
            <div className="panelTitle">
              <Type size={18} />
              <span>テロップデザイン</span>
              <span
                className="helpIcon"
                title={
                  "動画で使うテロップデザイン一式を選びます。\n" +
                  "「新規作成」から使用シーン(一人語り/対談/ビデオポッドキャスト/Vlog系)を選ぶと、シーンの種類ごとの割り当てを調整して名前をつけて保存できます。\n" +
                  "スタンダードは既定の割り当てです。"
                }
              >
                ?
              </span>
            </div>
            <DesignThemePicker
              activeThemeId={activeDesignThemeId}
              currentMapping={telopTypeMapping}
              disabled={running}
              onAdjust={() => setTelopTypeMappingOpen(true)}
              onCreate={handleCreateDesignTheme}
              onDelete={handleDeleteDesignTheme}
              onSelect={handleSelectDesignTheme}
              scenes={designScenes}
              themes={designThemes}
            />
            {/* フェーズW23(改善1): OP有無を解析開始前に選ぶ(初期値はテーマのOP設定に追従)。
                検品後の細かい調整は従来どおり OpEditorModal で行う */}
            <label className="opStartToggle">
              <input
                checked={opEnabled}
                disabled={running}
                onChange={(event) => setOpEnabledOverride(event.target.checked)}
                type="checkbox"
              />
              <span>オープニング（冒頭ダイジェスト）を付ける</span>
            </label>
          </section>
        )}

        <section className="panel silenceTightnessPanel">
          <div className="panelTitle">
            <Scissors size={18} />
            <span>無音カット</span>
          </div>
          <div className="silenceTightnessSegments" role="group" aria-label="無音カットのタイトさ">
            {(
              [
                ["loose", "ゆるめ"],
                ["normal", "標準"],
                ["tight", "タイト"],
              ] as const
            ).map(([value, label]) => (
              <button
                className={silenceTightness === value ? "active" : ""}
                disabled={running}
                key={value}
                onClick={() => setSilenceTightness(value)}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>
          <p className="silenceTightnessHint">タイトは間を短く切り、ゆるめは間を残します。</p>
        </section>

        {/* フェーズW7: 保存場所・ファイル名は書き出し時のモーダルで毎回指定する(旧: 動画の保存先パネル) */}
        <section className="panel settingsGrid">
          <div
            className="exportModeChoices apiField"
            role="group"
            aria-label="テロップ演出"
            title="演出モード(AI)はシーンの種類を判定してテロップデザイン・アニメ・効果音を自動で使い分けます"
          >
            <button
              type="button"
              className={settings.telopMode !== "directed" ? "active" : ""}
              onClick={() => saveCurrentSettings({ telopMode: "full" })}
              disabled={running}
            >
              通常テロップ
            </button>
            <button
              type="button"
              className={settings.telopMode === "directed" ? "active" : ""}
              onClick={() => saveCurrentSettings({ telopMode: "directed" })}
              disabled={running}
            >
              演出モード (AI)
            </button>
          </div>

          {/* フェーズU4: 使用頻度の低い設定は「詳細設定」へ収納(既定は閉。既定値と違うときはバッジ表示) */}
          <details className="advancedSettings">
            <summary>
              <span>詳細設定</span>
              {advancedSettingsChanged && (
                <span className="advancedSettingsBadge" title={advancedSettingsChanged}>
                  変更あり
                </span>
              )}
            </summary>
            <div className="field">
              <label title="文字起こしエンジン。通常はElevenLabsのままで問題ありません">STT</label>
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
              <label title="Local Whisper使用時のモデルサイズ(大きいほど高精度・低速)">Whisper</label>
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
          </details>
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
      )}

      <section className={`rightPane ${reviewState ? "reviewMode" : ""}`}>
        {/* フェーズW23(改善2): 処理状況は解析中のみ表示する。home は前回runの残骸が不要、
            editing の書き出し進捗は検品ツールバーのコンパクトバーが担う */}
        {uiStage === "analyzing" && (
        <section className="stepsPanel">
          <div className="stepsHeader">
            <span>処理状況</span>
            {exportProgress > 0 && exportProgress < 100 && <strong>書き出し {exportProgress}%</strong>}
          </div>
          {(running || (exportProgress > 0 && exportProgress < 100)) && (
            <CatProgressBar
              percent={resolveCatProgressPercent(steps, exportProgress)}
              active={running || (exportProgress > 0 && exportProgress < 100)}
              label={findRunningStepLabel(steps)}
            />
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
        )}

        {/* フェーズW7: 待機中はプロジェクト一覧を表示(クリックで検品段階から再編集) */}
        {!running && !reviewState && (
          <ProjectListPage
            disabled={running}
            onDelete={handleDeleteProject}
            onOpen={openProject}
            onReveal={(dir) => window.catcut.revealPath(dir)}
            openingRunDir={projectOpeningRunDir}
            projects={projects}
          />
        )}

        {reviewState && reviewStage === "transcript" && transcriptState && FEATURES.legacyReviewUi && (
          <section className="transcriptWorkspace">
            <div className="transcriptWorkspaceHeader" {...(sceneApplying || editorClosing ? { inert: "" } : {})}>
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
                <FollowAlongProgressLabel
                  durationMs={transcriptState.originalDurationMs}
                  maxReachedMsRef={maxReachedMsRef}
                />
                <button className="followAlongExitButton" onClick={stopFollowAlong} type="button">
                  <X size={14} />
                  終了
                </button>
              </div>
            )}
            <div className="transcriptGuide">
              AIがカットした箇所は<span className="transcriptGuideStrike">取り消し線</span>で表示されています。
              単語をクリックすると文字を修正、ダブルクリックでカット/復元を切り替えられます。
              左の「要確認リスト」でAIが疑わしいと判断した箇所を確認し、確認できたら「書き出し」へ進んでください（編集は自動保存され、書き出し時にまとめて反映されます）。
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
                onTimeUpdate={(currentMs) => {
                  maxReachedMsRef.current = Math.max(maxReachedMsRef.current, currentMs);
                  // 追い読み進捗ラベル(FollowAlongProgressLabel)の更新トリガーとしてストアも進める。
                  playheadStore.setSourceMs(currentMs);
                }}
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
          <section className={`transcriptWorkspace sceneWorkspaceSection${reviewTab === "timeline" ? " sceneWorkspaceTimeline" : ""}`}>
            <div className="sceneThemeBar" {...(sceneApplying || editorClosing ? { inert: "" } : {})}>
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
                  className="secondaryButton sceneProjectsBackButton"
                  disabled={running || sceneApplying || (!sceneDraft && !editorLoadError)}
                  onClick={closeReviewToProjects}
                  title="検品画面を閉じてプロジェクト一覧に戻る"
                  type="button"
                >
                  プロジェクト一覧
                </button>
                <button
                  className="primaryButton compactPrimary"
                  disabled={running || sceneApplying || !sceneDraft}
                  onClick={() => setExportSettingsOpen(true)}
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
            <div className="transcriptWorkspaceHeader" {...(sceneApplying || editorClosing ? { inert: "" } : {})}>
              {/* フェーズV1: シーン検品(従来フロー)とタイムラインViewのタブ切替 */}
              <div className="reviewViewTabs">
                <button
                  className={reviewTab === "scenes" ? "active" : ""}
                  onClick={() => { handleWaveformGestureStart(); project.editor.select(null); setReviewTab("scenes"); }}
                  type="button"
                >
                  <FileText size={15} />
                  <span>シーン検品</span>
                </button>
                <button
                  className={reviewTab === "timeline" ? "active" : ""}
                  onClick={() => { handleWaveformGestureStart(); project.editor.select(null); setReviewTab("timeline"); }}
                  type="button"
                >
                  <Film size={15} />
                  <span>タイムライン</span>
                </button>
              </div>
              <div className="editorToolControls" role="group" aria-label="編集ツール">
                <button type="button" aria-pressed={!scissorsMode} onClick={() => setScissorsMode(false)} title="選択ツール (A)">
                  <MousePointer2 size={14} /><span>選択</span><kbd>A</kbd>
                </button>
                <button type="button" className="editorCutTool" aria-pressed={scissorsMode} onClick={() => setScissorsMode(true)} title="カットツール (B)。選択に戻すにはA">
                  <Scissors size={14} /><span>カット</span><kbd>B</kbd>
                </button>
              </div>
              <span className="editorToolHint" role="status">
                {scissorsMode ? reviewTab === "timeline" ? "映像をクリックして分割 · Aで選択へ" : "波形を2点クリック／ドラッグで範囲カット · Escで取消" : "Spaceで再生／一時停止 · 文字入力を終えるにはEsc"}
              </span>
              <div className="transcriptWorkspaceActions">
                {/* フェーズW23(改善2-3): 検品中の適用・書き出し進捗のコンパクトバー。
                    editing では左ペイン(停止ボタン)を隠すため、書き出しの停止導線はここが受け皿 */}
                {(sceneApplying || running) && (
                  <div className="inspectJobProgress" role="status">
                    <span className="inspectJobProgressLabel">
                      {sceneApplying
                        ? sceneApplyProgress != null
                          ? `適用中… ${sceneApplyProgress}%`
                          : "適用中…"
                        : exportProgress > 0 && exportProgress < 100
                          ? `書き出し中 ${exportProgress}%`
                          : "書き出し準備中…"}
                    </span>
                    <span className="inspectJobProgressTrack">
                      <span
                        className="inspectJobProgressFill"
                        style={{
                          width: `${Math.max(
                            6,
                            Math.min(100, sceneApplying ? (sceneApplyProgress ?? 6) : exportProgress),
                          )}%`,
                        }}
                      />
                    </span>
                    {running && (
                      <button
                        className="inspectJobStopButton"
                        onClick={cancelJob}
                        title="書き出しを停止"
                        type="button"
                      >
                        <Square size={12} />
                        <span>停止</span>
                      </button>
                    )}
                  </div>
                )}
                {/* W16-5(自動保存インジケータ): ドラフトdebounce保存の状態を小さく表示する */}
                {draftSaveStatus.state !== "idle" && (
                  <span className={`draftSaveIndicator ${draftSaveStatus.state}`}>
                    {draftSaveStatus.state === "saving"
                      ? "保存中…"
                      : draftSaveStatus.state === "saved"
                        ? `保存済み ${draftSaveStatus.savedAt}`
                        : "自動保存に失敗"}
                  </span>
                )}
                {draftSaveStatus.state === "error" && (
                  <button type="button" onClick={() => void flushSceneDraft().catch(() => {})}>再試行</button>
                )}
                <button
                  disabled={!scenesHistory.canUndo}
                  onClick={scenesHistory.undo}
                  title="元に戻す (⌘Z・直近200操作)"
                  type="button"
                >
                  <Undo2 size={15} /><span>元に戻す</span>
                </button>
                <button
                  disabled={!scenesHistory.canRedo}
                  onClick={scenesHistory.redo}
                  title="やり直す (⇧⌘Z)"
                  type="button"
                >
                  <Redo2 size={15} /><span>やり直す</span>
                </button>
              </div>
            </div>
            {(waveformLoading || waveformError) && (
              <div className={`sceneWaveformStatus${waveformError ? " isError" : ""}`} role="status">
                <span title={waveformError || undefined}>
                  {waveformLoading ? "波形を読み込み中…" : "波形を読み込めませんでした。再読み込みしてください。"}
                </span>
                {waveformError && (
                  <button type="button" onClick={() => setWaveformReload((revision) => revision + 1)}>
                    波形を再読み込み
                  </button>
                )}
              </div>
            )}
            {reviewTab === "scenes" && (
            <details className="transcriptGuide sceneEditingGuide">
              <summary><span>B：2点クリック／ドラッグでカット · 両端をドラッグしてトリム</span><span>操作ガイド</span></summary>
              <p>チップをクリックして位置を決め、ドラッグで複数選択、Deleteで削除。右クリックでカット／復元を切り替えられます。
              テキスト枠では映像の長さを変えずにテロップを書き換えられます。
              波形の選択範囲はマウスを離すと確定、Escで取消。Optionで単語への吸着を解除します。
              編集は自動保存され、書き出し時に反映されます。</p>
            </details>
            )}
            {reviewTab === "scenes" && (
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
              {/* W14-2: 編集から自動学習した修正ペア数(クリックで一覧・個別削除)。
                  W15: 学習データ書き出しの入口も兼ねるため、0件でも表示する */}
              {correctionHistory ? (
                <button
                  className="sceneLearnedCorrectionsButton"
                  onClick={() => setCorrectionHistoryOpen(true)}
                  title="書き出しで確定した校正・カット・シーン区切り・改行の事例です。クリックで内容確認・除外・共有できます"
                  type="button"
                >
                  {editingLearningSummary ? `編集学習: ${editingLearningSummary.examples}件` : `学習済み修正: ${correctionHistory.pairs.length}件`}
                </button>
              ) : null}
              {/* W16-2: ユーザー辞書一覧・手動追加の常設入口(従来は一括置換ポップアップ内のリンクのみ) */}
              <button
                className="sceneLearnedCorrectionsButton"
                onClick={() => setUserDictionaryOpen(true)}
                title="次回の解析から自動修正されるユーザー辞書の一覧・手動追加・削除"
                type="button"
              >
                ユーザー辞書
              </button>
              {/* W16-7: 検品最終段階のAI一括再チェック。指摘は上の要確認パネルに出る */}
              <button
                className="sceneLearnedCorrectionsButton"
                disabled={finalCheckRunning || scenesHistory.scenes.length === 0}
                onClick={() => void handleRunFinalCheck()}
                title="現在の全シーンの表示テキストをAIで一括再チェックします(指摘は要確認パネルに表示されます)"
                type="button"
              >
                {finalCheckRunning ? "AI最終チェック中…" : "AI最終チェック"}
              </button>
              {finalCheckStatus ? <span className="finalCheckStatus">{finalCheckStatus}</span> : null}
              {/* フェーズW5-6: 「すべて/要確認」タブは廃止。要確認件数はReviewHotspotsPanelのヘッダに一本化 */}
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
            )}
            <div ref={workspaceViewportRef} className={`sceneMainArea${reviewTab === "timeline" ? " sceneMainAreaTimeline" : ""}${reviewTab === "timeline" && (transcriptState.canvasHeight ?? 0) > (transcriptState.canvasWidth ?? Infinity) ? " sceneMainAreaTimelineVertical" : ""}`} {...(sceneApplying || editorClosing ? { inert: "" } : {})} aria-busy={sceneApplying || editorClosing}>
              <div className="editorPreviewDock">
              <div className="scenePreviewColumn">
                <PreviewPlayer
                  key={transcriptState.runDir}
                  keepSegments={scenesHistory.keepSegments}
                  keepSegmentsReady={sceneKeepsReady}
                  onActiveWordChange={setActiveTranscriptWordId}
                  onPlayingChange={handlePreviewPlayingChange}
                  onSeekConsumed={() => setTranscriptSeekMs(null)}
                  onTimeUpdate={handleScenePreviewTimeUpdate}
                  playbackRate={playbackRate}
                  onPlaybackRateChange={(rate) => setPlaybackRate(rate as PlaybackRate)}
                  ref={previewPlayerRef}
                  seekMs={transcriptSeekMs}
                  telopText={currentScene?.telopText || ""}
                  telopPosition={currentScene?.telopPosition}
                  onTelopPositionChange={currentSceneId ? (position) => scenesHistory.setTelopPosition(currentSceneId, position) : undefined}
                  onAllTelopPositionsChange={(position) => scenesHistory.setAllTelopPositions(position)}
                  telopStyle={currentSceneTelopStyle}
                  telopFontSize={transcriptState.telopFontSize}
                  telopBaseWidth={transcriptState.telopBaseWidth}
                  telopBaseHeight={transcriptState.telopBaseHeight}
                  // フェーズW8: プレビューステージをキャンバス(コンポジション)基準にする。
                  // composition未生成(0)はundefined=従来のvideo intrinsic基準。
                  canvasWidth={transcriptState.canvasWidth || undefined}
                  canvasHeight={transcriptState.canvasHeight || undefined}
                  // フェーズW9: 映像フレーミング(変形・クロップ)。ソース寸法はrotation適用後
                  sourceWidth={transcriptState.sourceWidth || undefined}
                  sourceHeight={transcriptState.sourceHeight || undefined}
                  videoFraming={videoFramingState ?? undefined}
                  onVideoFramingChange={(framing, commit) => {
                    // ドラッグ中はライブ反映のみ、操作確定(commit)で video_framing.json へ保存する
                    setVideoFramingState(framing);
                    if (commit && transcriptState) {
                      void window.catcut
                        .saveVideoFraming({ runDir: transcriptState.runDir, framing })
                        .then(setVideoFramingState)
                        .catch(() => {});
                    }
                  }}
                  telopMaxCharsPerLine={transcriptState.telopMaxCharsPerLine}
                  telopY={transcriptState.telopY}
                  telopHighlightWords={currentSceneHighlightWords}
                  telopAnimationIn={currentSceneAnimation.animationIn}
                  telopAnimationDurationMs={currentSceneAnimation.durationMs}
                  telopSlotKey={currentSceneId}
                  sfxUrl={currentSceneSfx.url}
                  sfxId={currentSceneSfx.id}
                  sfxVolume={transcriptState.sfxVolume}
                  sfxMuted={sfxMuted}
                  overlayItems={activeOverlayItems}
                  overlayStyles={compositionTelopStyles}
                  onOverlayClick={handleOverlayClick}
                  bgmClips={bgmState?.clips ?? []}
                  bgmMuted={bgmMuted}
                  imageClips={imagesState?.clips ?? []}
                  selectedImageClipId={project.selection?.kind === "image" ? project.selection.id : null}
                  onImageSelect={(id) => handleEditorSelection(id ? { kind: "image", id } : null)}
                  onImageClipsChange={mediaImporting ? undefined : (clips, commit) => {
                    const current = project.editor.getSnapshot().document.images;
                    if (current) project.editor.changeMedia("images", { ...current, clips }, commit ? "commit" : "preview");
                  }}
                  timelineCutRanges={editedTimelineCutRanges}
                  videoEffects={previewVideoEffects}
                  opPreview={opPreviewData}
                  timelineFps={transcriptState.timelineFps}
                  opDefaultTelopStyleId={transcriptState.defaultTelopStyle}
                  sfxUrls={transcriptState.sfxUrls}
                  seekTimelineMs={timelineSeekMs}
                  onSeekTimelineConsumed={() => {
                    setTimelineSeekMs(null);
                    // フェーズW6(OP行の再生ボタン): シーク消化の次フレームで再生を開始する
                    // (PreviewPlayer内のenterEntryがシーク位置を確定してから再生する)。
                    if (opPlayPendingRef.current) {
                      opPlayPendingRef.current = false;
                      requestAnimationFrame(() => previewPlayerRef.current?.play());
                    }
                  }}
                  onTimelineTimeUpdate={(timelineMs) => {
                    // W19-A3: setStateではなくストアへ書く(タイムラインViewの再生ヘッドが購読)。
                    playheadStore.setTimelineMs(timelineMs);
                    // フェーズW6(OP行): クリップだけ再生の停止判定(タイムラインms基準)。
                    const stopAtMs = opPlayStopAtTimelineMsRef.current;
                    if (stopAtMs != null && timelineMs != null && timelineMs >= stopAtMs) {
                      opPlayStopAtTimelineMsRef.current = null;
                      previewPlayerRef.current?.pause();
                    }
                  }}
                  onTelopClick={
                    // フェーズU6 経路(a): プレビューのテロップクリックで詳細エディタを開く
                    isDirectedTelopMode && currentSceneId
                      ? () => openStyleEditorForScene(currentSceneId)
                      : undefined
                  }
                  videoUrl={transcriptState.sourceVideoUrl}
                  words={transcriptState.words}
                />
                {(overlayItemsAll.length > 0 || currentSceneSfx.url || (bgmState?.clips.length ?? 0) > 0) && (
                  <div className="previewFidelityToolbar">
                    {overlayItemsAll.length > 0 && (
                      <button
                        className={overlaysVisible ? "active" : ""}
                        onClick={() => setOverlaysVisible((current) => !current)}
                        title="左上タイトル・プロフィールカード等の装飾をプレビューに表示"
                        type="button"
                      >
                        タイトル・カード {overlaysVisible ? "ON" : "OFF"}
                      </button>
                    )}
                    <button
                      className={sfxMuted ? "" : "active"}
                      onClick={() => setSfxMuted((current) => !current)}
                      title="テロップ登場時の効果音(プレビューのみ。書き出しには影響しない)"
                      type="button"
                    >
                      効果音 {sfxMuted ? "OFF" : "ON"}
                    </button>
                    {(bgmState?.clips.length ?? 0) > 0 && (
                      <button
                        className={bgmMuted ? "" : "active"}
                        onClick={() => setBgmMuted((current) => !current)}
                        title="BGMのプレビュー並走再生(プレビューのみ。書き出しには影響しない)"
                        type="button"
                      >
                        BGM {bgmMuted ? "OFF" : "ON"}
                      </button>
                    )}
                  </div>
                )}
                {reviewTab === "scenes" && (
                <div className="sceneKeyGuide">
                  <div className="sceneKeyGuideRow">
                    <kbd>Space</kbd>
                    <span>再生／一時停止（再生中は必ず停止）</span>
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
                    <span>下の行と結合（カットは保持。テキスト編集中も可）</span>
                  </div>
                  <div className="sceneKeyGuideRow">
                    <kbd>Tab</kbd>
                    <span>この行だけ再生</span>
                  </div>
                  <div className="sceneKeyGuideRow">
                    <kbd className={scissorsMode ? "active" : ""}>B</kbd>
                    <span>
                      波形カット（2点クリック／ドラッグ。端の無音は1クリック、Escで取消）
                      {scissorsMode ? ": ON" : ""}
                    </span>
                  </div>
                  <div className="sceneKeyGuideRow">
                    <kbd>A</kbd>
                    <span>ハサミ解除(Escでも解除)</span>
                  </div>
                </div>
                )}
              </div>
              {reviewTab === "timeline" && sceneDraft && (
                <SelectionInspector
                  selection={project.selection}
                  scenes={scenesHistory.scenes}
                  timelineCutRanges={editedTimelineCutRanges}
                  timelineDurationMs={editedTimelineDurationMs}
                  bgmState={bgmState}
                  imagesState={imagesState}
                  fps={transcriptState.timelineFps}
                  disabled={mediaImporting || sceneApplying || editorClosing}
                  getBgmState={() => project.editor.getSnapshot().document.bgm}
                  getImagesState={() => project.editor.getSnapshot().document.images}
                  onBgmStateChange={(state, phase) => {
                    if (project.editor.getSnapshot().runDir === transcriptState.runDir) project.editor.changeMedia("bgm", state, phase);
                  }}
                  onImagesStateChange={(state, phase) => {
                    if (project.editor.getSnapshot().runDir === transcriptState.runDir) project.editor.changeMedia("images", state, phase);
                  }}
                  onSeekTimeline={seekTimelinePlayhead}
                  onSetSceneSpeed={scenesHistory.setSceneSpeed}
                  onEditSceneStyle={isDirectedTelopMode ? openStyleEditorForScene : undefined}
                  onSetAllScenesSpeed={scenesHistory.setAllScenesSpeed}
                  onDeleteSelection={handleTimelineSceneDelete}
                />
              )}
              </div>
              {!sceneDraft ? (
                <div className="editorLoadStatus" role={editorLoadError ? "alert" : "status"}>
                  <p>{editorLoadError ?? "編集データを読み込み中…"}</p>
                  {editorLoadError && <button type="button" onClick={() => setEditorLoadAttempt((attempt) => attempt + 1)}>再試行</button>}
                </div>
              ) : reviewTab === "timeline" ? (
                <TimelineView
                  scissorsMode={scissorsMode}
                  onBladeCut={(sceneId, ms) => {
                    handleWaveformGestureStart();
                    sceneActionsRef.current.splitAtMs(sceneId, ms, { allowEmptySpeechSide: true });
                    seekScenePlayhead(ms);
                  }}
                  fps={transcriptState.timelineFps}
                  getBgmState={() => project.editor.getSnapshot().document.bgm}
                  getImagesState={() => project.editor.getSnapshot().document.images}
                  onSplitAtPlayhead={splitTimelineAtPlayhead}
                  bgmState={bgmState}
                  currentSceneId={currentSceneId}
                  imagesState={imagesState}
                  selection={project.selection}
                  onSelectionChange={handleEditorSelection}
                  mediaImporting={mediaImporting}
                  onBeforeMediaAdd={beginMediaImport}
                  onMediaAddError={(message) => {
                    if (project.editor.getSnapshot().runDir === transcriptState.runDir) setError(message);
                  }}
                  onBgmStateChange={(state, phase) => {
                    if (project.editor.getSnapshot().runDir === transcriptState.runDir) project.editor.changeMedia("bgm", state, phase);
                  }}
                  onImagesStateChange={(state, phase) => {
                    if (project.editor.getSnapshot().runDir === transcriptState.runDir) project.editor.changeMedia("images", state, phase);
                  }}
                  onSetAllScenesSpeed={scenesHistory.setAllScenesSpeed}
                  onSetSceneSpeed={scenesHistory.setSceneSpeed}
                  onEditSceneStyle={isDirectedTelopMode ? openStyleEditorForScene : undefined}
                  onOpenOpSettings={
                    // フェーズV2: OPブロッククリックでrun単位のOP編集モーダルを開く
                    () => setOpEditorOpen(true)
                  }
                  // W11-3: プレイヘッドを掴んだら再生中でも一時停止してスクラブ
                  onScrubStart={handleWaveformGestureStart}
                  onSeekSource={seekScenePlayhead}
                  onSeekTimeline={seekTimelinePlayhead}
                  resolveSceneStyle={resolveSceneStyleForTimeline}
                  runDir={transcriptState.runDir}
                  runOpConfig={runOpConfig}
                  scenes={scenesHistory.scenes}
                  timelineCutRanges={editedTimelineCutRanges}
                  timelineDurationMs={editedTimelineDurationMs}
                  timelineOp={transcriptState.timelineOp}
                />
              ) : (
              <div
                className="sceneRowListPane"
                ref={sceneListPaneRef}
                onPointerDownCapture={() => project.editor.select(null)}
                onFocusCapture={() => project.editor.select(null)}
                onScroll={(event) => setShowScrollTopButton(event.currentTarget.scrollTop > 320)}
                onMouseLeave={() => {
                  hoveredSceneIdRef.current = null;
                  hoveredFromHotspotRef.current = false;
                  hoverPlayArmedRef.current = false;
                }}
                onMouseMove={(event) => {
                  // 改善5-9(ホバー行からSpace再生): マウスが乗っている行のsceneIdを追跡する
                  // (高頻度更新のため再描画を伴わないrefに保持する)。
                  // フェーズW5-7: 要確認パネルのカードも対象(Spaceでその部分だけ再生できる)。
                  const rowEl = (event.target as HTMLElement).closest(
                    ".sceneRow, .reviewHotspotCard",
                  ) as HTMLElement | null;
                  const nextHoveredSceneId = rowEl?.dataset.sceneId || null;
                  // W21: 別の行に乗せ直した時だけSpaceの「その行を再生」を発動可能にする
                  // (マウスを置いたままの停止→再生は現在位置からの再開を優先する)。
                  if (nextHoveredSceneId !== hoveredSceneIdRef.current) {
                    hoverPlayArmedRef.current = nextHoveredSceneId != null;
                  }
                  hoveredSceneIdRef.current = nextHoveredSceneId;
                  // パネル内はSceneRow埋め込み(W5-8)のため、パネル配下かどうかで判定する。
                  hoveredFromHotspotRef.current = Boolean(rowEl?.closest(".reviewHotspotsPanel"));
                }}
              >
                {/* フェーズW5-5/W5-8: 要確認パネル(旧「要確認」タブの後継)。カードには本物の
                    SceneRowを埋め込み、編集動作を通常一覧と完全一致させる。相違点は
                    autoScrollDisabled(自動追従スクロールなし)と、再生がそのクリップのみな点。
                    実機FB 2026-09-03: W28の左右レイアウトは廃止し、要確認(折りたたみ)→OP→
                    通常シーンの縦積みに一本化(カラムdivはdisplay:contentsで透過)。 */}
                <div className="reviewHotspotsColumn">
                <ReviewHotspotsPanel
                  bulkApplyCount={bulkApplyPlan.appliedCount}
                  hotspots={reviewHotspots}
                  onBulkApplyAiFixes={handleBulkApplyAiFixes}
                  onIgnoreItem={(item) =>
                    setIgnoredFinalCheckIds((current) => {
                      const next = new Set(current);
                      next.add(item.id);
                      return next;
                    })
                  }
                  onJumpToScene={handleJumpToScene}
                  onPlayScene={(scene) => playScene(scene, { suppressAutoScroll: true, stopAtEnd: true })}
                  onResolveScene={(sceneId) =>
                    setResolvedReviewSceneIds((current) => {
                      const next = new Set(current);
                      next.add(sceneId);
                      return next;
                    })
                  }
                  resolvedCount={resolvedReviewSceneIds.size}
                  onRestoreResolved={() => setResolvedReviewSceneIds(new Set())}
                  onTelopBlur={handleTelopBlur}
                  onTelopChange={(sceneId, text) => scenesHistory.setTelopText(sceneId, text)}
                  onTelopFocus={handleTelopFocus}
                  renderSceneRow={(scene, ordinal) => {
                    // edgeTrimドラッグ中は対象行だけプレビュー版シーンに差し替える(W19-A5)。
                    const liveScene = edgeDragSceneOverrides?.get(scene.id) ?? scene;
                    return (
                      <SceneRow
                        active={activeSceneId === scene.id}
                        autoScrollDisabled
                        binMs={waveform?.binMs || 20}
                        chipSelection={chipSelection && chipSelection.sceneId === scene.id ? chipSelection : null}
                        dragTooltip={edgeDragVisual?.sceneId === scene.id ? edgeDragVisual.tooltip : undefined}
                        editingRef={isEditingSceneTelopRef}
                        globalPeakMax={globalPeakMax}
                        highlightEdge={
                          edgeDragVisual?.neighborSceneId === scene.id
                            ? edgeDragVisual.neighborHighlightEdge
                            : undefined
                        }
                        isCurrent={scene.id === currentSceneId}
                        isPlaybackActive={isPreviewPlaying}
                        linkedNext={linkedNextSceneIds.has(scene.id)}
                        onApplyStyleToEmotionGroup={(styleId) =>
                          scenesHistory.applyStyleToEmotionGroup(scene.id, styleId)
                        }
                        onCaretConfirm={pauseIfPlaying}
                        onSceneActivate={() => handleActivateScene(scene.id)}
                        onCaretCommit={(groupIndex) => handleCaretCommit(scene.id, groupIndex)}
                        confirmedCaretIndex={
                          confirmedCaret && confirmedCaret.sceneId === scene.id ? confirmedCaret.groupIndex : null
                        }
                        onChipCaretChange={handleChipCaretChange}
                        onChipSelectionChange={(range) => handleChipSelectionChange(scene.id, range)}
                        onEdgeDragEnd={(edge, rawTargetMs, tolerance) =>
                          handleSceneEdgeDragEnd(scene.id, edge, rawTargetMs, tolerance)
                        }
                        onEdgeDragMove={(edge, rawTargetMs, tolerance) =>
                          handleSceneEdgeDragMove(scene.id, edge, rawTargetMs, tolerance)
                        }
                        onEditDesign={isDirectedTelopMode ? () => openStyleEditorForScene(scene.id) : undefined}
                        onEditingChange={(editing) => {
                          isEditingSceneTelopRef.current = editing;
                        }}
                        onHoverSeek={handleSceneHoverSeek}
                        onOpenApiSettings={() => {
                          setApiWizardRequired(false);
                          setApiWizardOpen(true);
                        }}
                        onRangeCutMs={(rawStartMs, rawEndMs, tolerance) =>
                          handleSceneRangeCut(scene.id, rawStartMs, rawEndMs, tolerance)
                        }
                        onScissorsCutMs={(ms) => handleScissorsCutAtMs(scene.id, ms)}
                        onScissorsSplitChip={(groupIndex) => handleScissorsSplitChip(scene.id, groupIndex)}
                        onEdgeDragCancel={() => setEdgeDrag(null)}
                        onWaveformGestureStart={handleWaveformGestureStart}
                        onSeek={seekScenePlayhead}
                        onSetDirectedAnimation={(animationId) =>
                          scenesHistory.setDirectedAnimation(scene.id, animationId)
                        }
                        onSetVideoEffectOverride={(override) =>
                          scenesHistory.setVideoEffectOverride(scene.id, override)
                        }
                        onSetHighlightWords={(words) =>
                          scenesHistory.setDirectedHighlightWords(scene.id, words)
                        }
                        onMergeWithNext={() => handleSceneMergeWithNext(scene.id)}
                        onSetDirectedStyle={(styleId) => scenesHistory.setDirectedStyle(scene.id, styleId)}
                        onSetDirectedType={(typeId) => scenesHistory.setDirectedType(scene.id, typeId)}
                        onSetEmotionTag={(tag) => scenesHistory.setEmotionTag(scene.id, tag)}
                        onSetStyleOverride={(styleId) => scenesHistory.setStyleOverride(scene.id, styleId)}
                        onTelopBlur={() => handleTelopBlur(scene.id)}
                        onTelopChange={(text) => handleTelopChangeLive(scene.id, text)}
                        onTelopFocus={() => handleTelopFocus(scene.id, liveScene.telopText)}
                        onToggleChip={(wordIds) => scenesHistory.toggleChipGroup(scene.id, wordIds)}
                        ordinal={ordinal}
                        peaks={waveform?.peaks || []}
                        scene={liveScene}
                        scissorsMode={scissorsMode}
                        speakerColors={activeSpeakerColors}
                        suspicions={sceneSuspicionsBySceneId.get(scene.id) || []}
                        telopTypeMapping={telopTypeMapping}
                        themeId={telopThemeId}
                        directedMode={isDirectedTelopMode}
                      />
                    );
                  }}
                />
                </div>
                {/* シーン一覧カラム(display:contentsで透過。スクロールは sceneRowListPane が担う)。 */}
                <div className="sceneListColumn">
                {/* フェーズW6: OPはシーンのダイジェストなので、シーン検品の先頭で行として見せる
                    (旧OpSummaryCardの後継。opPreviewData=run正本の編集を即時反映済み。OPなしrunは非表示)。
                    端ドラッグでクリップ幅の変更、文言のインライン編集、波形クリック・再生ボタンで
                    プレビューのOP区間と連動する。 */}
                {isDirectedTelopMode && opPreviewData && (
                  <OpClipRows
                    binMs={waveform?.binMs || 20}
                    clips={opPreviewData.pattern === "highlight_teaser" ? opDisplayClips : []}
                    globalPeakMax={globalPeakMax}
                    isAuto={!runOpConfig?.clips}
                    onClipsChange={handleOpClipsChange}
                    onJumpToSourceScene={handleJumpToOpSourceScene}
                    onOpenEditor={() => setOpEditorOpen(true)}
                    onPlayClip={playOpClip}
                    onSeekTimeline={seekOpTimeline}
                    onTextFocus={pauseIfPlaying}
                    op={opPreviewData}
                    peaks={waveform?.peaks || []}
                    scenes={displayedScenes}
                    videoDurationMs={transcriptState.originalDurationMs}
                  />
                )}
                <SceneRowList
                  binMs={waveform?.binMs || 20}
                  chipSelection={chipSelection}
                  currentSceneId={currentSceneId}
                  selectedSceneId={selectedSceneId}
                  activeSceneId={activeSceneId}
                  onToggleSceneSelect={handleToggleSceneSelect}
                  onRestoreScene={handleRestoreScene}
                  linkedNextSceneIds={linkedNextSceneIds}
                  edgeDragVisual={edgeDragVisual}
                  flashSceneId={flashSceneId}
                  globalPeakMax={globalPeakMax}
                  isPlaybackActive={isPreviewPlaying}
                  playbackScrollSuppressed={playbackScrollSuppressed}
                  onCaretConfirm={pauseIfPlaying}
                  onSceneActivate={handleActivateScene}
                  onCaretCommit={handleCaretCommit}
                  confirmedCaret={confirmedCaret}
                  onChipCaretChange={handleChipCaretChange}
                  onChipSelectionChange={handleChipSelectionChange}
                  onEditingChange={(editing) => {
                    isEditingSceneTelopRef.current = editing;
                  }}
                  editingRef={isEditingSceneTelopRef}
                  onEdgeDragEnd={handleSceneEdgeDragEnd}
                  onEdgeDragMove={handleSceneEdgeDragMove}
                  onEdgeDragCancel={() => setEdgeDrag(null)}
                  onWaveformGestureStart={handleWaveformGestureStart}
                  onRangeCut={handleSceneRangeCut}
                  onHoverSeek={handleSceneHoverSeek}
                  onScissorsCutMs={handleScissorsCutAtMs}
                  onScissorsSplitChip={handleScissorsSplitChip}
                  onSeek={seekScenePlayhead}
                  onTelopBlur={handleTelopBlur}
                  onTelopChange={handleTelopChangeLive}
                  onTelopFocus={handleTelopFocus}
                  onToggleChip={(sceneId, wordIds) => scenesHistory.toggleChipGroup(sceneId, wordIds)}
                  peaks={waveform?.peaks || []}
                  sceneOverrideById={edgeDragSceneOverrides}
                  scenes={displayedScenes}
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
                  speakerColors={activeSpeakerColors}
                  onSetDirectedType={(sceneId, typeId) => scenesHistory.setDirectedType(sceneId, typeId)}
                  onSetDirectedStyle={(sceneId, styleId) => scenesHistory.setDirectedStyle(sceneId, styleId)}
                  onSetDirectedAnimation={(sceneId, animationId) =>
                    scenesHistory.setDirectedAnimation(sceneId, animationId)
                  }
                  onSetVideoEffectOverride={(sceneId, override) =>
                    scenesHistory.setVideoEffectOverride(sceneId, override)
                  }
                  onSetHighlightWords={(sceneId, words) =>
                    scenesHistory.setDirectedHighlightWords(sceneId, words)
                  }
                  onMergeWithNext={(sceneId) => handleSceneMergeWithNext(sceneId)}
                  onEditDesign={isDirectedTelopMode ? openStyleEditorForScene : undefined}
                />
                {/* フェーズW5-10: 一定以上スクロールしたら左下に出る「↑」丸ボタン(先頭=要確認パネルへ戻る)。
                    position: sticky でペイン内の可視領域下端に張り付く。 */}
                {showScrollTopButton && (
                  <button
                    className="sceneListScrollTopButton"
                    onClick={() => sceneListPaneRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
                    title="一番上へ戻る"
                    type="button"
                  >
                    <ArrowUp size={22} />
                  </button>
                )}
                </div>
              </div>
              )}
            </div>
            {/* フェーズV1: サムネ帯・BGMトラック(旧U9 UI)はタイムラインViewへ統合。波形ナビのみ残す */}
            {reviewTab === "scenes" && (
            <div className="navTracksStack">
              <SceneNavBar
                binMs={waveform?.binMs || 20}
                durationMs={transcriptState.originalDurationMs}
                flagMarkers={sceneNavFlagMarkers}
                onSeek={seekScenePlayhead}
                // W11-3: ドラッグスクラブ開始で再生中なら一時停止
                onScrubStart={handleWaveformGestureStart}
                peaks={waveform?.peaks || []}
              />
            </div>
            )}
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
        {/* W14-2: 学習済み修正の一覧・個別削除(誤learningの解除手段) */}
        <CorrectionHistoryModal
          editingSummary={editingLearningSummary}
          onExcludeExample={async (exampleId) => {
            const summary = await window.catcut.excludeEditingLearningExample({ exampleId });
            setEditingLearningSummary(summary);
          }}
          onClose={() => setCorrectionHistoryOpen(false)}
          onDelete={async (pair) => {
            try {
              const next = await window.catcut.deleteCorrectionHistoryPair(pair);
              setCorrectionHistory(next);
            } catch {
              setError("学習済み修正の削除に失敗しました");
            }
          }}
          onExport={() => window.catcut.exportLearningData()}
          open={correctionHistoryOpen}
          pairs={correctionHistory?.pairs || []}
        />
        <TelopTypeMappingModal
          activeThemeName={activeDesignTheme?.name ?? null}
          extras={currentDesignExtras}
          mapping={telopTypeMapping}
          onClose={() => setTelopTypeMappingOpen(false)}
          onSave={handleOverwriteTypeMapping}
          onSaveAsTheme={async (nextMapping, name, extras) => {
            // フェーズU2: 検品画面からの調整を新しいデザインテーマとして保存し、そのまま選択する
            await handleCreateDesignTheme({
              name,
              baseScene: activeDesignTheme?.baseScene ?? "",
              typeStyles: nextMapping,
              overlayTitle: extras.overlayTitle,
              op: extras.op,
              speakerColors: extras.speakerColors,
              videoEffects: extras.videoEffects,
            });
          }}
          onEditStyle={openStyleEditorForType}
          open={telopTypeMappingOpen}
        />
        {/* フェーズV2: OP編集モーダル(タイムラインViewのOPブロッククリックから開く) */}
        {transcriptState && (
          <OpEditorModal
            config={runOpConfig}
            onClose={() => setOpEditorOpen(false)}
            onSaved={(saved) => {
              // フェーズV5-2: 保存の即時反映(タイムラインのOPブロック+本編シフト)と
              // フィードバック。トーストは検品コピーと同じ仕組みを流用する
              setRunOpConfig(saved);
              // W11-2: 適用ボタン廃止に伴い文言変更(書き出し時に自動で適用される)
              setInspectionCopyToast("保存しました。書き出し時に自動で反映されます");
            }}
            open={opEditorOpen}
            runDir={transcriptState.runDir}
            scenes={scenesHistory.scenes}
            timelineOp={transcriptState.timelineOp}
          />
        )}
        {/* V8-5: オーバーレイ文言編集モーダル(プレビューのオーバーレイクリックから開く)。
            プレビュー列内でのインライン描画をやめ、他モーダルと同じ背景dim中央配置にする */}
        {overlayEditorTarget && (
          <OverlayEditModal
            draft={overlayEditorDraft}
            onCancel={() => setOverlayEditorTarget(null)}
            onCommit={commitOverlayEdit}
            onDraftChange={setOverlayEditorDraft}
            target={overlayEditorTarget}
          />
        )}
        {/* フェーズU6: テロップスタイル詳細エディタ(3経路から開く) */}
        {styleEditorContext && (
          <TelopStyleEditorModal
            activeTheme={activeDesignTheme ? { id: activeDesignTheme.id, name: activeDesignTheme.name } : null}
            context={styleEditorContext}
            onApplyToScene={handleStyleEditorApplyToScene}
            onClose={() => setStyleEditorContext(null)}
            onSaveToTheme={handleStyleEditorSaveToTheme}
          />
        )}
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
        {/* フェーズW7: 書き出し設定(毎回)と書き出し完了(Finder表示+プロジェクト保存確認) */}
        {/* W11-4a: ファイル名はモーダル側が現在runの元動画名から毎回生成する(保存場所のみ前回値) */}
        <ExportSettingsModal
          initialDirectory={settings.outputDirectory || ""}
          onCancel={() => setExportSettingsOpen(false)}
          onSubmit={startExportWithSettings}
          open={exportSettingsOpen}
          videoPath={videoPath}
        />
        <ExportDoneModal
          busy={exportDoneBusy}
          info={exportDoneInfo}
          onClose={() => setExportDoneInfo(null)}
          onDeleteProject={deleteProjectFromExportDone}
          onSaveProject={saveProjectFromExportDone}
          onShareLearning={() => window.catcut.exportLearningData()}
        />
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
        {/* W12-2: ライセンスモーダル(FEATURES.billing=falseの間は描画自体しない) */}
        {FEATURES.billing && <LicenseModal open={licenseModalOpen} onClose={() => setLicenseModalOpen(false)} />}
        {/* W13-1: キャッシュ管理 */}
        <CacheManagerModal open={cacheManagerOpen} onClose={() => setCacheManagerOpen(false)} />
        {/* フェーズW8: 素材選択時の縦横選択。キャンセルは自動判定既定(chooseVideoで設定済み)を維持する */}
        <OrientationChoiceModal
          current={videoOrientation}
          onCancel={() => setOrientationModalOpen(false)}
          onConfirm={(orientation) => {
            setVideoOrientation(orientation);
            setOrientationModalOpen(false);
          }}
          open={orientationModalOpen}
          probe={videoProbe}
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
