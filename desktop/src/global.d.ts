export {};

type SttProvider = "elevenlabs" | "local-whisper";
type TelopMode = "full" | "directed";

interface CatCutSettings {
  sttProvider: SttProvider;
  whisperModel: string;
  renderFinal: boolean;
  reviewBeforeExport: boolean;
  fontProfileMode: "saved" | "new";
  selectedFontProfileId: string;
  outputDirectory: string;
  outputFileName: string;
  elevenApiKeySet: boolean;
  /**
   * テーマ×感情の自動スタイリング(T-1): ユーザーが選んだテロップテーマの既定値。
   * 次回起動時も適用するため設定に永続化する。
   * 改善7-4(プリセットギャラリー約100種)により、生成マトリクスのテーマID
   * (例: "preset:news:band:navy")や改善7-3の"saved"を含む動的な値を取り得るため、
   * リテラルユニオンではなくstringとして扱う。
   */
  telopTheme: string;
  /** フェーズT2: full=従来テロップ / directed=演出決定エンジン(step06c) */
  telopMode: TelopMode;
  /**
   * フェーズU2: 選択中のデザインテーマID(userData/design_themes.json のテーマ)。
   * 空文字=スタンダード(既定マッピング)。開始時の実行時マッピングにこのテーマが使われる。
   */
  activeDesignThemeId: string;
}

/** フェーズU7: シーンタイトル(chapter_title)の設定。styleは overlayStyles.ts のパターンID。 */
interface CatCutOverlayTitleConfig {
  enabled: boolean;
  style: string;
}

/** フェーズW1: 話者カラー設定(mainのsanitizeで常に完全形)。 */
interface CatCutSpeakerColorsConfig {
  enabled: boolean;
  apply_types: string[];
  styles: Record<string, string>;
}

/** フェーズW2: シーン映像ギミックのON/OFF設定(mainのsanitizeで常に完全形)。 */
interface CatCutVideoEffectsConfig {
  pinch: boolean;
  zoom: boolean;
  /** W24 Phase C: 暗転強調(既定OFF)。 */
  dim: boolean;
  /** W24 Phase C: 顔ズーム(既定OFF)。 */
  face_zoom: boolean;
  /** W24 Phase C: ゆっくり寄り(既定OFF)。 */
  slow_push: boolean;
}

/** フェーズU8: OP(オープニング)の設定。pattern="none"=OPなし(既定)。 */
interface CatCutOpConfig {
  pattern: string;
  title: string;
  /** W11-5: タイトルを表示するか(false=「表示しない」)。省略=true(後方互換)。 */
  title_enabled: boolean;
  catch_copy: string;
}

/** フェーズV2: run単位OP設定(runs/<run>/op_config.json)のクリップ1件。msは元動画の絶対ms。 */
interface CatCutOpClip {
  cut_id: string;
  start_ms: number;
  end_ms: number;
  text: string;
  style: string;
}

/** フェーズV2: run単位のOP設定。clips=null はAI自動選定。 */
interface CatCutRunOpConfig extends CatCutOpConfig {
  clips: CatCutOpClip[] | null;
}

/** フェーズU2: templates/design_scenes.yaml の使用シーン1件(mainでバリデーション済み)。 */
interface CatCutDesignScene {
  id: string;
  label: string;
  description: string;
  type_styles: Record<string, CatCutTelopTypeMappingEntry>;
  /** フェーズU7: ジャンルごとのシーンタイトル既定(新規テーマ作成の初期値)。 */
  overlay_title: CatCutOverlayTitleConfig;
  /** フェーズV2: ジャンルごとのOP既定パターン(新規テーマ作成の初期値)。 */
  op: CatCutOpConfig;
}

/** フェーズU2: userData/design_themes.json の保存済みデザインテーマ1件。 */
interface CatCutDesignTheme {
  id: string;
  name: string;
  base_scene: string;
  type_styles: Record<string, CatCutTelopTypeMappingEntry>;
  /** フェーズU6: テーマ専用のカスタムスタイル定義(custom_* ID → TelopStyle)。type_stylesから参照する。 */
  custom_styles?: Record<string, CatCutTelopStyle>;
  /** フェーズU7: シーンタイトル設定(mainのsanitizeで常に付与される)。 */
  overlay_title?: CatCutOverlayTitleConfig;
  /** フェーズU8: OP設定(mainのsanitizeで常に付与される)。 */
  op?: CatCutOpConfig;
  /** フェーズW1: 話者カラー設定(mainのsanitizeで常に付与される)。 */
  speaker_colors?: CatCutSpeakerColorsConfig;
  /** フェーズW2: シーン映像ギミック設定(mainのsanitizeで常に付与される)。 */
  video_effects?: CatCutVideoEffectsConfig;
  created_at: string;
  updated_at: string;
}

interface CatCutStartOptions {
  videoPath: string;
  sttProvider: SttProvider;
  whisperModel: string;
  renderFinal: boolean;
  reviewBeforeExport: boolean;
  telopMode?: TelopMode;
  fontProfileMode?: "saved" | "new";
  savedFontProfileId?: string;
  fontDirectivesText?: string;
  outputPath?: string;
  groundTruthPath?: string;
  learningMode?: boolean;
  silenceTightness?: "loose" | "normal" | "tight";
  /**
   * フェーズW8: 出力キャンバスの向き(素材選択ポップアップの確定値)。
   * main が run直下 orientation.json へ永続化し、テンプレート選択・step08の
   * --orientation に反映する。未指定は従来どおり自動判定。
   */
  orientation?: CatCutOrientation;
  /**
   * フェーズW23(改善1): OP(冒頭ダイジェスト)を付けるか(解析開始前のチェックボックス)。
   * true=テーマのOP設定を使う(テーマがOPなしなら highlight_teaser へ昇格)、
   * false=OPなしで開始。未指定は従来どおりテーマ設定に従う(後方互換)。
   */
  opEnabled?: boolean;
}

interface CatCutOutputs {
  runDir: string;
  /** フェーズW7: レンダリング済みMP4が実在するか(適用のみのjob:doneと書き出し完了を区別する)。 */
  finalVideoExists: boolean;
  learning?: { examples: number; changed: boolean; warning?: string };
  telop: string;
  telopReview: string;
  fontDirectives: string;
  fontPlan: string;
  telopStyleDirectives: string;
  telopStylePlan: string;
  composition: string;
  finalVideo: string;
  transcriptPatch: string;
}

interface CatCutTelopFinding {
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
}

interface CatCutTelopReview {
  stats?: {
    findings?: number;
    remaining_findings?: number;
    applied?: number;
  };
  findings?: CatCutTelopFinding[];
  remaining_findings?: CatCutTelopFinding[];
}

interface CatCutOllamaStatus {
  installed: boolean;
  running: boolean;
  modelInstalled: boolean;
  model: string;
  version?: string;
  models?: string[];
  error?: string;
}

interface CatCutDictionaryRule {
  id?: string;
  category: "proper_noun" | "common_misrecognition" | "notation";
  wrong: string;
  correct: string;
  count?: number;
  createdAt?: string;
  updatedAt?: string;
}

interface CatCutUserRules {
  version: string;
  dictionary: CatCutDictionaryRule[];
  boundary: Array<Record<string, unknown>>;
  filler: Array<Record<string, unknown>>;
  cut: Array<Record<string, unknown>>;
  reviewChecks: Array<Record<string, unknown>>;
  groundTruth: Array<Record<string, unknown>>;
  decisions: Array<Record<string, unknown>>;
  updatedAt?: string;
}

interface CatCutGroundTruthEntry {
  id: string;
  startMs: number;
  endMs: number;
  lines: string[];
  text: string;
}

interface CatCutGroundTruthResult {
  path: string;
  entries: CatCutGroundTruthEntry[];
  stats: {
    entries: number;
    firstStartMs: number;
    lastEndMs: number;
    avgDurationMs: number;
    avgChars: number;
  };
}

interface CatCutLearningReport {
  version: string;
  sourceVideoRunDir: string;
  sourceTruthPath: string;
  learnedRulesPath: string;
  createdAt: string;
  summary: {
    truthPages: number;
    generatedPages: number;
    comparablePages: number;
    textExactMatches: number;
    textMismatchPages: number;
    avgStartOffsetMs: number;
    medianStartOffsetMs: number;
    avgBoundaryOffsetMs: number;
    medianBoundaryOffsetMs: number;
  };
  appliedRules: {
    timing: {
      telopStartOffsetMs: number;
      vadStartBiasMs: number;
      vadEndBiasMs: number;
      wordVadClampStrength: number;
      reason: string;
    };
    edit: { maxGapMs: number; segmentPaddingMs: number; reason: string };
    telop: { maxCharsPerLine: number; maxLinesPerPage: number; reason: string };
    textRules: Array<{ category: string; wrong: string; correct: string }>;
  };
  samples: Array<Record<string, unknown>>;
}

interface CatCutGroundTruthDiffRow {
  id: string;
  truthId: string;
  pageId: string;
  startMs: number;
  endMs: number;
  generatedStartMs: number | null;
  generatedEndMs: number | null;
  startOffsetMs: number | null;
  endOffsetMs: number | null;
  sttText: string;
  generatedText: string;
  truthText: string;
  types: string[];
  severity: "high" | "medium" | "low";
}

interface CatCutGroundTruthRuleProposal {
  id: string;
  kind: "dictionary" | "review_check" | "filler" | "boundary" | "telop_density" | string;
  type: string;
  title: string;
  description: string;
  evidenceCount: number;
  payload?: Record<string, unknown>;
}

interface CatCutGroundTruthRuleReport {
  version: string;
  sourceVideoRunDir: string;
  sourceTruthPath: string;
  createdAt: string;
  summary: {
    truthPages: number;
    generatedPages: number;
    matchedPages: number;
    exactMatches: number;
    mismatchPages: number;
    typeCounts: Record<string, number>;
  };
  rows: CatCutGroundTruthDiffRow[];
  proposals: CatCutGroundTruthRuleProposal[];
}

interface CatCutFontPattern {
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
}

interface CatCutFontPlan {
  version: string;
  source: string;
  pattern_count: number;
  patterns: CatCutFontPattern[];
  notes?: string[];
}

interface CatCutTelopStyle {
  font_family?: string;
  font_size?: number;
  font_weight?: number;
  letter_spacing?: string;
  line_height?: number;
  fill: {
    type: "solid" | "gradient";
    color?: string;
    gradient_from?: string;
    gradient_to?: string;
    gradient_direction?: "vertical" | "horizontal" | "diagonal";
  };
  inner_stroke?: { color: string; width: number } | null;
  outer_stroke?: { color: string; width: number } | null;
  /** フェーズU6: outer_stroke のさらに外側の第3縁(多重テロップの「太枠」用。最背面)。 */
  outer_stroke2?: { color: string; width: number } | null;
  drop_shadow?: string | null;
  /** フェーズU6: 光彩(グロウ)。drop-shadow多重で表現。radiusはfont_size基準px。 */
  glow?: { color: string; radius: number } | null;
  /** フェーズT2.5-2: ハードなオフセット影 (縁レイヤーの下に(x,y)pxずらして描画)。 */
  shadow_offset?: { x: number; y: number; color: string } | null;
  y_position_offset?: number;
  description?: string;
  /** T-5(最小拡張): シンプルテーマの疑問スタイル向け下線表現。 */
  underline?: boolean;
  /**
   * T-5(最小拡張): 背景帯有無(仕様書T-1のスタイル属性)。
   * borderRadiusは改善7-4(プリセットギャラリー「半透明角丸」背景)向けの追加拡張。
   * padding_x/padding_y/border_radius はフェーズT1-2の背景ボックス(box系プリセット)。
   */
  background?: {
    color: string;
    borderRadius?: string;
    padding_x?: number;
    padding_y?: number;
    border_radius?: number;
  } | null;
  /** フェーズT1-2(部分ハイライト): highlight_words の塗り色。 */
  highlight_color?: string;
  /** フェーズT3: プリセット既定の登場/退場アニメーション・長さ・効果音。 */
  animation_in?: string | null;
  animation_out?: string | null;
  animation_duration_frames?: number;
  sfx?: string | null;
}

interface CatCutTelopStylePlan {
  version: string;
  source: string;
  updated_at?: string;
  default_style: string;
  styles: Record<string, CatCutTelopStyle>;
}

interface CatCutPreviewPage {
  pageId: string;
  cutId: string;
  videoUrl: string;
  startMs: number;
  endMs: number;
  displayWidth?: number;
  displayHeight?: number;
}

interface CatCutTranscriptWord {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  sentenceId: string;
  confidence: number;
  /** フェーズW1: diarize時の話者ID("speaker_0"等)。旧runでは undefined。 */
  speaker?: string;
}

interface CatCutTranscriptSentence {
  id: string;
  text: string;
  wordIds: string[];
  startMs: number;
  endMs: number;
}

interface CatCutKeepSegment {
  startMs: number;
  endMs: number;
}

interface CatCutTelopPageBoundary {
  telopPosition?: { x: number; y: number };
  startMs: number;
  endMs: number;
  /** 改善10-B-3: パイプライン適用済みページ本文。 */
  text?: string;
  /** フェーズT2(directedモード): ディレクティブのスタイルID。fullモードでは未指定。 */
  styleId?: string;
  /** フェーズT2.5-4(directedモード): シーンの意味種類(semantic type)。旧runでは未指定。 */
  typeId?: string;
  /** フェーズT2.5-4(directedモード): styleId が個別上書き(マッピングより優先)かどうか。 */
  styleOverridden?: boolean;
  /**
   * フェーズT3(directedモード): 登場アニメの個別上書き(UIピッカー由来。animation_overridden の
   * テロップのみ)。マッピング・プリセット既定由来の解決結果はここには入らない。
   */
  animationIn?: string;
  /** フェーズT2(directedモード): ディレクティブの部分強調語。 */
  highlightWords?: string[];
}

/**
 * フェーズT3: type→presetマッピングの1エントリ(userData/telop_type_mapping.json)。
 * 旧形式(文字列=styleのみ)のデータも読めるが、保存は常にこの新形式で行う。
 */
interface CatCutTelopTypeMappingEntry {
  style: string;
  /** 種類ごとの既定登場アニメ(未指定=プリセット既定)。 */
  animation_in?: string;
  /** 種類ごとの既定効果音ID(未指定=プリセット既定。"none"=鳴らさない明示)。 */
  sfx?: string;
}

interface CatCutAiReviewTranscriptNeedsReview {
  word_ids?: string[];
  start_ms?: number;
  end_ms?: number;
  text?: string;
  reason?: string;
}

interface CatCutAiReviewTelopNeedsReview {
  page_id?: string;
  text?: string;
  reason?: string;
  suggestion?: string;
}

/** W5-1: step05のAI疑義ワード(ai_review.json の suspect_words)。旧runでは配列自体が無い。 */
interface CatCutAiReviewSuspectWord {
  word_ids?: string[];
  start_ms?: number;
  end_ms?: number;
  text?: string;
  reason?: string;
  suggestion?: string;
}

interface CatCutAiUsage {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number | null;
  provider: string;
  model: string;
}

interface CatCutAiReview {
  enabled: boolean;
  transcriptNeedsReview: CatCutAiReviewTranscriptNeedsReview[];
  /** W5-2: AI疑義ワード(文脈上あやしい語)。旧runでは空配列。 */
  suspectWords?: CatCutAiReviewSuspectWord[];
  telopNeedsReview: CatCutAiReviewTelopNeedsReview[];
  dismissedFindingIds: string[];
  transcriptRefineFailed?: boolean;
  telopRefineFailed?: boolean;
  transcriptRefineFailureReason?: string;
  telopRefineFailureReason?: string;
  transcriptFailedChunks?: number;
  telopFailedChunks?: number;
  /** 改善21-B: ai_review.json / refine.json 由来の失敗分類(旧runでは空文字)。 */
  transcriptErrorKind?: string;
  telopErrorKind?: string;
  transcriptErrorDetail?: string;
  telopErrorDetail?: string;
  transcriptProvider?: string;
  telopProvider?: string;
  transcriptUsage?: CatCutAiUsage | null;
  telopUsage?: CatCutAiUsage | null;
}

interface CatCutUserDictionaryEntry {
  from: string;
  to: string;
}

interface CatCutUserDictionary {
  entries: CatCutUserDictionaryEntry[];
}

/** W14-2: userData/correction_history.json の1ペア(全run横断の語レベル修正ペア)。 */
interface CatCutCorrectionHistoryPair {
  before: string;
  after: string;
  count: number;
  updatedAt?: string;
}

interface CatCutCorrectionHistory {
  version: string;
  pairs: CatCutCorrectionHistoryPair[];
}

/** W16-7: AI最終チェック(step06d)の指摘1件。surfaceは該当シーン本文の部分文字列。 */
interface CatCutFinalCheckIssue {
  scene_id: string;
  surface: string;
  suggestion?: string;
  reason: string;
}

/** W16-7: final-check:run の応答(issues.json)。enabled=false はキー無し・LLM失敗(non-fatal)。 */
interface CatCutFinalCheckResult {
  enabled: boolean;
  reason?: string;
  issues: CatCutFinalCheckIssue[];
}

/**
 * W19-B2: final-check:load の応答(保存済み issues.json の自動ロード)。
 * exists=false は issues.json 無し(旧run・未実行=完全従来動作)。
 * inputScenes は実行時入力(scenes_input.json)の本文で、パイプライン自動実行の指摘
 * (auto_XXXX仮ID)を現在のシーンIDへ本文一致で再マップするために使う。
 */
interface CatCutFinalCheckLoadResult {
  exists: boolean;
  enabled: boolean;
  issues: CatCutFinalCheckIssue[];
  inputScenes: Array<{ sceneId: string; text: string }>;
}

/** W19-B1: 弱い区間の再文字起こし(step05b)の差分候補1件(retranscribe.json items)。 */
interface CatCutRetranscribeItem {
  start_ms: number;
  end_ms: number;
  word_ids: string[];
  old_text: string;
  new_text: string;
  suggestion: string;
  reason: string;
}

/** W19-B1: retranscribe.json の内容(旧run・キー無しでは enabled=false / items空)。 */
interface CatCutRetranscribeState {
  enabled: boolean;
  items: CatCutRetranscribeItem[];
}

/** W14-2: runs/<run>/edit_history.json の1エントリ(シーン単位・beforeは初期テキスト)。 */
type CatCutEditingLearningKind = "proofreading" | "cut" | "scene_boundary" | "line_break";
interface CatCutEditingLearningSummary {
  projects: number;
  examples: number;
  counts: Record<CatCutEditingLearningKind, number>;
  recentExamples: Array<{
    exampleId: string;
    kind: CatCutEditingLearningKind;
    before: { text: string; keepSegments: Array<{ startMs: number; endMs: number }>; scenes: Array<{ startMs: number; endMs: number; text: string }> };
    after: { text: string; keepSegments: Array<{ startMs: number; endMs: number }>; scenes: Array<{ startMs: number; endMs: number; text: string }> };
    context?: { baselineProvenance?: string };
  }>;
}

interface CatCutEditHistoryEntry {
  scene_id: string;
  /** W15: 元テキスト(STT生テキスト)。W14時代のエントリでは空文字。 */
  source: string;
  before: string;
  after: string;
  ts: string;
}

interface CatCutEditHistory {
  version: string;
  entries: CatCutEditHistoryEntry[];
}

type CatCutApiKeyProvider = "elevenlabs" | "anthropic" | "openai" | "gemini";

type CatCutApiKeySource = "userData" | "env" | "dotenv" | "settings" | null;

interface CatCutApiKeyStatus {
  configured: boolean;
  lastFour: string | null;
  source: CatCutApiKeySource;
}

interface CatCutApiKeysStatusResponse {
  elevenlabs: CatCutApiKeyStatus;
  anthropic: CatCutApiKeyStatus;
  openai: CatCutApiKeyStatus;
  gemini: CatCutApiKeyStatus;
  activeAiRefineProvider: "anthropic" | "openai" | "gemini" | null;
}

type CatCutApiKeyTestResult =
  | { ok: true; message: string; detail?: string }
  | { ok: false; message: string };

interface CatCutWordSplitFlag {
  prev_end_ms: number;
  next_start_ms: number;
  tail_text: string;
  head_text: string;
  gap_ms: number;
}

interface CatCutTranscriptState {
  runDir: string;
  sourceVideoPath: string;
  sourceVideoUrl: string;
  words: CatCutTranscriptWord[];
  sentences: CatCutTranscriptSentence[];
  keepSegments: CatCutKeepSegment[];
  fillerWordIds: string[];
  maxGapMs: number;
  segmentPaddingMs: number;
  originalDurationMs: number;
  telopFontSize: number;
  /** 改善7-2(プレビューテロップの適正サイズ): telopFontSizeの算出基準となった解像度幅(px)。 */
  telopBaseWidth: number;
  /** 改善20-B: 1行の文字数バジェット。超過行のプレビュー折返し(wrapTelopLine)に使う。 */
  telopMaxCharsPerLine: number;
  /**
   * 改善8-B-3(シーン初期化=テロップページ): composition.jsonのBudouXテロップページ境界(絶対ms)。
   * 空配列の場合(旧run等でcomposition.jsonにvoice_data/telopsが無い)、UI側は
   * initializeScenesの既存ヒューリスティック分割にフォールバックする。
   */
  telopPageBoundaries: CatCutTelopPageBoundary[];
  /** フェーズT2: directedモード(演出ディレクティブ駆動)かどうか。旧runでは "full"。 */
  telopMode?: "full" | "directed";
  /** 改善13: AI校正結果(パス1+2)。enabled 時は要確認リストがAIモードになる。 */
  aiReview: CatCutAiReview;
  /** W19-B1: 弱い区間の再文字起こし(step05b)の差分候補(旧runでは undefined 可)。 */
  retranscribe?: CatCutRetranscribeState;
  /** 改善19-B: step07 の word_split_flags (旧runでは undefined 可)。 */
  wordSplitFlags?: CatCutWordSplitFlag[];
  // --- フェーズU1(プレビュー忠実化): composition.json由来の追加情報 ---
  /** U1-3: composition timeline.telop_y(0〜1の中心基準)。 */
  telopY?: number;
  /** U1-3: コンポジション高さ(meta.display_height)。縦位置クランプに使う。 */
  telopBaseHeight?: number;
  /**
   * フェーズW8(キャンバス基準プレビュー): コンポジションのキャンバス寸法(meta.display_*)。
   * composition未生成の旧runは0(プレビューはvideo intrinsic基準へフォールバック)。
   */
  canvasWidth?: number;
  canvasHeight?: number;
  /**
   * フェーズW9(映像フレーミング): ソース動画の表示解像度(rotation適用後)。
   * composition meta.source_*(W8)優先・旧runは preprocess display_* フォールバック。
   * どちらも無ければ0(プレビューはキャンバス寸法とみなす)。
   */
  sourceWidth?: number;
  sourceHeight?: number;
  /** フェーズW9: run正本 video_framing.json の正規化済みフレーミング(無ければidentity)。 */
  videoFraming?: CatCutVideoFraming;
  /** U1-6: timeline.fps(アニメ長さのframes→ms換算用)。 */
  timelineFps?: number;
  /** U1-6: timeline.animation_in(グローバル既定の登場アニメ。旧popIn等互換)。 */
  timelineAnimationIn?: string;
  /** U1-6: timeline.sfx_volume(効果音音量0〜1)。 */
  sfxVolume?: number;
  /** U1-6: 効果音ID→プレビュー配信URL(mainのプレビューサーバー)。 */
  sfxUrls?: Record<string, string>;
  /** U1-1: timeline.telop_styles(書き出しに実際に使われるスタイル辞書)。 */
  telopStyles?: Record<string, CatCutTelopStyle>;
  /** U1-1: timeline.default_telop_style。 */
  defaultTelopStyle?: string;
  /** U1-5: timeline.overlays(タイムラインms基準の未検証JSON)。 */
  overlays?: unknown[];
  /** U1-5: timeline.cuts[i]とkeep_segments[i]の対応表(元動画ms⇔タイムラインms写像用)。 */
  timelineCutRanges?: CatCutTimelineCutRange[];
  /** U9(BGMトラック): タイムライン総尺(ms。OP含む)。BGMクリップUIの横軸スケール用。 */
  timelineDurationMs?: number;
  /** V1(タイムラインView): timeline.op(未検証JSON)。OPグループブロック表示用。 */
  timelineOp?: unknown;
  /** フェーズW2: timeline.video_effects(タイムラインms基準の未検証JSON)。プレビュー適用用。 */
  videoEffects?: unknown[];
}

interface CatCutTimelineCutRange {
  sourceStartMs: number;
  sourceEndMs: number;
  timelineStartMs: number;
  timelineEndMs: number;
}

/** フェーズU9: フィルムストリップ(サムネイル帯)のフレーム1枚。 */
interface CatCutFilmstripFrame {
  /** 元動画上の時刻(ms)。 */
  ms: number;
  /** プレビューサーバー配信URL(jpg)。 */
  url: string;
}

interface CatCutFilmstripResult {
  count: number;
  height: number;
  durationMs: number;
  frames: CatCutFilmstripFrame[];
  /** true の場合 ui_cache/filmstrip/ からの即時返却(再生成なし)。 */
  cached: boolean;
}

/** フェーズU9: BGMクリップ(bgm.json由来+UI表示用の付加情報)。時刻はタイムラインms基準。 */
interface CatCutBgmClip {
  id: string;
  /** runs/<run>/bgm/ 内のファイル名。 */
  file: string;
  start_ms: number;
  end_ms: number;
  /** 0〜1。 */
  volume: number;
  fade_in_ms: number;
  fade_out_ms: number;
  /** プレビューサーバー配信URL。 */
  url: string;
  /** 音源自体の長さ(ms。取得失敗時0)。 */
  audioDurationMs: number;
}

interface CatCutBgmState {
  clips: CatCutBgmClip[];
  /** composition.json のタイムライン総尺(ms。OP含む)。composition未生成時0。 */
  timelineDurationMs: number;
}

/** フェーズV4: 画像挿入クリップ(images.json由来+UI表示用の付加情報)。時刻はタイムラインms基準。 */
interface CatCutImageClip {
  id: string;
  /** runs/<run>/images/ 内のファイル名。 */
  file: string;
  start_ms: number;
  end_ms: number;
  /** 画像中心のX位置(画面幅比0〜1)。 */
  x: number;
  /** 画像中心のY位置(画面高さ比0〜1)。 */
  y: number;
  /** 画像の表示幅(画面幅比0.1〜1.0)。 */
  scale: number;
  /** 0〜1。 */
  opacity: number;
  /** プレビューサーバー配信URL。 */
  url: string;
}

interface CatCutImagesState {
  clips: CatCutImageClip[];
  /** composition.json のタイムライン総尺(ms。OP含む)。composition未生成時0。 */
  timelineDurationMs: number;
}

/**
 * フェーズW9: 映像フレーミング(変形・クロップ)。run正本 runs/<run>/video_framing.json。
 * mainのsanitizeで常に完全形(クランプ済み)。全て既定値=identity(compositionへ転写されない)。
 */
interface CatCutVideoFraming {
  transform: {
    /** cover フィット寸法への倍率(0.2〜4.0)。 */
    scale: number;
    /** 有効映像中心のオフセット(キャンバス幅比、-1〜1)。 */
    x: number;
    /** 有効映像中心のオフセット(キャンバス高さ比、-1〜1)。 */
    y: number;
  };
  crop: {
    /** ソース映像の各辺から切り落とす割合(0〜0.45)。 */
    left: number;
    top: number;
    right: number;
    bottom: number;
  };
}

interface CatCutWaveformResult {
  binMs: number;
  sampleRate: number;
  durationMs: number;
  /** binMsごとの正規化済み(0-1)ピーク配列。60分素材で約18万要素になり得る(カード側でスライスして使う)。 */
  peaks: number[];
  /** true の場合 ui_cache 内の保存済み波形から返却(再生成なし)。 */
  cached: boolean;
}

interface CatCutFontSceneSetting {
  font: string;
  weight: number;
  size: number;
  letterSpacing: number;
  lineHeight: number;
  fillMode: "solid" | "gradient";
  fillColor: string;
  gradientFrom: string;
  gradientTo: string;
  strokeEnabled: boolean;
  innerStrokeColor: string;
  outerStrokeColor: string;
  innerStrokeWidth: number;
  outerStrokeWidth: number;
}

interface CatCutSavedFontProfile {
  id: string;
  name: string;
  patternCount: number;
  scenes: Record<string, CatCutFontSceneSetting>;
  directivesText: string;
  createdAt?: string;
  updatedAt?: string;
}

interface CatCutTelopState {
  outputs: CatCutOutputs;
  telopText: string;
  review: CatCutTelopReview | null;
  fontDirectivesText: string;
  fontPlan: CatCutFontPlan | null;
  telopStyleDirectivesText: string;
  telopStylePlan: CatCutTelopStylePlan | null;
  telopStyles: Record<string, CatCutTelopStyle>;
  defaultTelopStyle: string;
  previewPages: CatCutPreviewPage[];
}

type CatCutJobEvent =
  | { type: "job:start"; runName: string; runDir: string; steps: Array<{ id: string; label: string }> }
  | { type: "job:done"; outputs: CatCutOutputs }
  | { type: "job:error"; error: string }
  | { type: "job:cancelled" }
  | { type: "export:start"; runDir: string }
  | {
      type: "review:ready";
      runDir: string;
      renderFinal: boolean;
      outputs: CatCutOutputs;
      telopText: string;
      review: CatCutTelopReview | null;
      fontDirectivesText: string;
      fontPlan: CatCutFontPlan | null;
      telopStyleDirectivesText: string;
      telopStylePlan: CatCutTelopStylePlan | null;
      telopStyles: Record<string, CatCutTelopStyle>;
      defaultTelopStyle: string;
      previewPages: CatCutPreviewPage[];
    }
  | { type: "step:start"; stepId: string }
  | { type: "step:done"; stepId: string }
  | { type: "step:error"; stepId: string }
  | { type: "log"; message: string }
  | { type: "learning:done"; report: CatCutLearningReport }
  | { type: "ollama:pull:progress"; message: string }
  | { type: "export:progress"; percent: number };

declare global {
  /**
   * フェーズW8: 出力キャンバスの向き(素材選択時のユーザー選択)。
   * App.tsx とコンポーネント両方から使うため(このファイルはモジュールなので)global側に置く。
   */
  type CatCutOrientation = "horizontal" | "vertical";

  /**
   * フェーズW8: video:probe(ffprobe)の結果。displayWidth/Heightはrotation ±90/270適用後の
   * 表示寸法。ok=false は判定失敗(UIは横型を既定にする)。
   */
  type CatCutVideoProbeResult =
    | {
        ok: true;
        displayWidth: number;
        displayHeight: number;
        rotation: number;
        durationMs: number;
        orientation: CatCutOrientation;
      }
    | { ok: false };

  /**
   * フェーズW7: プロジェクト一覧の1件(検品段階に到達した runs/<run>/)。
   * App.tsx とコンポーネント両方から使うため(このファイルはモジュールなので)global側に置く。
   */
  interface CatCutProjectSummary {
    runDir: string;
    runName: string;
    title: string;
    createdAtMs: number;
    updatedAtMs: number;
    durationMs: number;
    sourceVideoPath: string;
    sourceVideoExists: boolean;
    /** 書き出し済みMP4の実在パス(未書き出しは空文字)。 */
    exportedVideoPath: string;
    /** 書き出し後の確認ダイアログで「保存する」を選んだか。 */
    saved: boolean;
    /** filmstripキャッシュ先頭フレームのdata URL(無ければ空文字)。 */
    thumbnailDataUrl: string;
  }

  /** W13-1: run 1件分の派生キャッシュ統計。 */
  interface CatCutRunCacheStats {
    runDir: string;
    runName: string;
    bytes: number;
    lastUsedMs: number;
    /** 最終利用が保持期間(7日)超か。 */
    old: boolean;
  }

  /** W13-1: cache:stats の応答。 */
  interface CatCutCacheStats {
    totalBytes: number;
    retentionDays: number;
    /** キャッシュを持つrunのみ(bytes降順)。 */
    runs: CatCutRunCacheStats[];
  }

  /** W13-1: cache:clean の応答。 */
  interface CatCutCacheCleanResult {
    ok: boolean;
    mode: "old" | "all";
    freedBytes: number;
    cleanedRuns: number;
  }

  /** フェーズW7: runs/<run>/project_meta.json の内容。 */
  interface CatCutProjectMeta {
    version: number;
    saved: boolean;
    title: string;
    savedAt: string;
  }

  /** W12-2: ライセンスキーのペイロード(署名対象。billing-serverが発行)。 */
  interface CatCutLicensePayload {
    licenseId: string;
    plan: string;
    kind: "subscription" | "one_time";
    issuedAt: string;
    stripeCustomerId: string;
    stripeSubscriptionId?: string;
  }

  /** W12-2: userData/license.json に保存されるライセンス。 */
  interface CatCutStoredLicense {
    key: string;
    payload: CatCutLicensePayload;
    /** billing-server確認時点の状態(active/past_due/revoked)。 */
    serverStatus: string;
    activatedAt: string;
    lastVerifiedAt: string;
  }

  /** W12-2: license:get の戻り値。 */
  interface CatCutLicenseState {
    license: CatCutStoredLicense | null;
    deviceId: string;
    /** ローカル署名検証結果。null=公開鍵未設定 or 未認証。 */
    locallyVerified: boolean | null;
    /** BILLING_SERVER_URL が設定済みか(空文字プレースホルダの間はfalse)。 */
    billingServerConfigured: boolean;
  }

  /** W12-2: license:activate / license:refresh の戻り値。 */
  interface CatCutLicenseActionResult {
    ok: boolean;
    error?: string;
    license?: CatCutStoredLicense | null;
  }

  interface Window {
    catcut: {
      getSettings: () => Promise<CatCutSettings>;
      saveSettings: (input: Partial<CatCutSettings> & { elevenApiKey?: string }) => Promise<CatCutSettings>;
      listFontProfiles: () => Promise<CatCutSavedFontProfile[]>;
      saveFontProfile: (input: Partial<CatCutSavedFontProfile>) => Promise<CatCutSavedFontProfile[]>;
      deleteFontProfile: (profileId: string) => Promise<CatCutSavedFontProfile[]>;
      /**
       * 改善8-B-1(プリセット駆動テーマへ全面切替): `templates/telop_presets.yaml` の
       * presetsセクション(プリセット名→スタイル定義)をそのまま返す。
       */
      getTelopPresets: () => Promise<Record<string, CatCutTelopStyle>>;
      /**
       * フェーズT2.5-4: シーン種類(semantic type)→プリセットIDの解決済みマッピング
       * (既定 templates/telop_type_mapping.yaml + userDataのユーザー上書き)。
       * フェーズT3: エントリは { style, animation_in?, sfx? } の新形式
       * (mainは旧形式=文字列だけのuserDataも読めるが、返却・保存は新形式で行う)。
       */
      getTelopTypeMapping: () => Promise<Record<string, CatCutTelopTypeMappingEntry | string>>;
      saveTelopTypeMapping: (
        input: Record<string, CatCutTelopTypeMappingEntry>,
        /** フェーズU7/U8/W1/W2: スタンダードのシーンタイトル・OP・話者カラー・シーン演出設定。undefinedのフィールドは既存を維持。 */
        extras?: {
          overlayTitle?: CatCutOverlayTitleConfig;
          op?: CatCutOpConfig;
          speakerColors?: CatCutSpeakerColorsConfig;
          videoEffects?: CatCutVideoEffectsConfig;
        },
      ) => Promise<Record<string, CatCutTelopTypeMappingEntry | string>>;
      /** フェーズU7/U8/W1/W2: 現在の選択(テーマ or スタンダード)のシーンタイトル・OP・話者カラー・シーン演出設定。 */
      getDesignExtras: () => Promise<{
        overlayTitle: CatCutOverlayTitleConfig;
        op: CatCutOpConfig;
        speakerColors: CatCutSpeakerColorsConfig;
        videoEffects: CatCutVideoEffectsConfig;
      }>;
      /** フェーズV2: run単位のOP設定(無ければテーマ設定から生成して返す)。 */
      getOpConfig: (runDir: string) => Promise<CatCutRunOpConfig>;
      /** フェーズV2: run単位のOP設定を保存する(次回の適用/step08再実行で反映)。 */
      saveOpConfig: (input: { runDir: string; config: CatCutRunOpConfig }) => Promise<CatCutRunOpConfig>;
      /** フェーズU2: 使用シーンバンドル(新規テーマ作成の出発点テンプレート)。 */
      getDesignScenes: () => Promise<CatCutDesignScene[]>;
      /** フェーズU2: 保存済みデザインテーマ一覧(userData/design_themes.json)。 */
      listDesignThemes: () => Promise<CatCutDesignTheme[]>;
      /** フェーズU2: テーマの新規作成(id省略)・上書き(id指定)。保存後の一覧と保存テーマを返す。 */
      saveDesignTheme: (input: {
        id?: string;
        name: string;
        baseScene?: string;
        typeStyles: Record<string, CatCutTelopTypeMappingEntry>;
        /** フェーズU6: テーマ専用カスタムスタイル定義。省略時は既存を維持する。 */
        customStyles?: Record<string, CatCutTelopStyle>;
        /** フェーズU7: シーンタイトル設定。省略時は既存を維持する。 */
        overlayTitle?: CatCutOverlayTitleConfig;
        /** フェーズU8: OP設定。省略時は既存を維持する。 */
        op?: CatCutOpConfig;
        /** フェーズW1: 話者カラー設定。省略時は既存を維持する。 */
        speakerColors?: CatCutSpeakerColorsConfig;
        /** フェーズW2: シーン映像ギミック設定。省略時は既存を維持する。 */
        videoEffects?: CatCutVideoEffectsConfig;
      }) => Promise<{ themes: CatCutDesignTheme[]; theme: CatCutDesignTheme }>;
      deleteDesignTheme: (themeId: string) => Promise<CatCutDesignTheme[]>;
      getUserRules: () => Promise<CatCutUserRules>;
      saveUserRules: (input: Partial<CatCutUserRules>) => Promise<CatCutUserRules>;
      learnDictionaryRule: (input: { wrong: string; correct: string; category?: CatCutDictionaryRule["category"] }) => Promise<CatCutUserRules>;
      /** 改善10-B-2: userData/user_dictionary.json (step02b向けユーザー辞書)。 */
      getUserDictionary: () => Promise<CatCutUserDictionary>;
      saveUserDictionaryEntry: (input: { from: string; to: string }) => Promise<CatCutUserDictionary>;
      deleteUserDictionaryEntry: (from: string) => Promise<CatCutUserDictionary>;
      /** W14-2: テロップ編集確定の記録(edit_history + correction_history を同時更新)。 */
      recordTelopEditLearning: (input: {
        runDir: string;
        sceneId: string;
        source: string;
        before: string;
        after: string;
        pairs: Array<{ before: string; after: string }>;
      }) => Promise<{ editHistory: CatCutEditHistory | null; correctionHistory: CatCutCorrectionHistory }>;
      loadEditHistory: (runDir: string) => Promise<CatCutEditHistory>;
      getCorrectionHistory: () => Promise<CatCutCorrectionHistory>;
      deleteCorrectionHistoryPair: (input: { before: string; after: string }) => Promise<CatCutCorrectionHistory>;
      /**
       * W15: 学習データ(全run edit_history + correction_history)を書き出す。
       * Nextcloudの共有フォルダがあればそこへ(shared=true)、無ければデスクトップへ。
       */
      exportLearningData: () => Promise<{
        path: string;
        summaryPath?: string;
        stats: { runs: number; editEntries: number; correctionPairs: number; editingExamples?: number; confirmedProjects?: number };
        shared: boolean;
      }>;
      initializeEditingLearning: (input: { runDir: string; scenes: unknown[] }) => Promise<{ ok: boolean; warning?: string }>;
      getEditingLearningSummary: () => Promise<CatCutEditingLearningSummary>;
      excludeEditingLearningExample: (input: { exampleId: string }) => Promise<CatCutEditingLearningSummary>;
      recordLearningDecision: (input: {
        kind: string;
        action: string;
        findingType?: string;
        pageId?: string;
        source?: string | null;
        suggestion?: string | null;
        message?: string | null;
      }) => Promise<CatCutUserRules>;
      chooseVideo: () => Promise<string | null>;
      /** フェーズW8: 素材の縦横自動判定(ffprobe)。失敗時 { ok: false }。 */
      probeVideo: (videoPath: string) => Promise<CatCutVideoProbeResult>;
      chooseGroundTruthText: () => Promise<CatCutGroundTruthResult | null>;
      analyzeGroundTruthRules: (input: { runDir: string; path: string }) => Promise<CatCutGroundTruthRuleReport>;
      applyGroundTruthRuleProposal: (input: {
        proposal: CatCutGroundTruthRuleProposal;
        action: "review" | "ignore_forever";
      }) => Promise<CatCutUserRules>;
      applyGroundTruthText: (input: { runDir: string; path: string }) => Promise<{
        groundTruth: CatCutGroundTruthResult;
        userRules: CatCutUserRules;
        state: CatCutTelopState;
      }>;
      chooseOutputDirectory: () => Promise<string | null>;
      saveOutputFile: (input?: { defaultPath?: string; defaultFileName?: string }) => Promise<string | null>;
      startJob: (options: CatCutStartOptions) => Promise<{ ok: boolean; error?: string }>;
      startExport: (options: {
        runDir: string;
        renderFinal: boolean;
        /** 適用した編集版。レンダリング中に更新されるドラフトとは分けて保持する。 */
        learningSnapshot?: { scenes: unknown[]; keepSegments: CatCutKeepSegment[] };
        outputPath?: string;
        /** フェーズW7(書き出し設定モーダル): 出力解像度の短辺上限(0/未指定=元のサイズ)。 */
        targetShortSide?: number;
        /** フェーズW7: h264のCRF値(0/未指定=Remotion既定。小さいほど高画質)。 */
        crf?: number;
        /** W10-11: render-cli --concurrency(0/未指定=4)。 */
        renderConcurrency?: number;
        /** W11-1b: HWエンコード(VideoToolbox)。if-possible=有効/未指定=従来のソフトウェアx264。 */
        hardwareAcceleration?: "if-possible" | "disable";
        /** W11-1b: 映像ビットレート(例 "10000k")。HWエンコード時はcrfの代わりにこちらを使う。 */
        videoBitrate?: string;
      }) => Promise<{ ok: boolean; error?: string }>;
      cancelJob: () => Promise<{ ok: boolean }>;
      loadTelop: (runDir: string) => Promise<CatCutTelopState>;
      loadTranscriptEditor: (runDir: string) => Promise<CatCutTranscriptState>;
      saveSceneEditsDraft: (input: {
        runDir: string;
        scenes: unknown[];
        keepSegments: CatCutKeepSegment[];
        /** W11-2: オーバーレイ文言の未保存編集(applySceneEdits の overlayEdits と同源)。 */
        overlayEdits: Record<string, { text?: string; subtitle?: string }>;
        /** W11-2: シーン個別カスタムスタイル定義(custom_scene_* ID → 定義)。 */
        customStyles: Record<string, CatCutTelopStyle>;
      }) => Promise<{
        version: string;
        updatedAt: string;
      }>;
      loadSceneEditsDraft: (runDir: string) => Promise<{
        version: string;
        updatedAt: string;
        scenes: unknown[];
        keepSegments: CatCutKeepSegment[];
        /** W11-2: 旧ドラフト(1.0.0)は空辞書(後方互換)。 */
        overlayEdits: Record<string, { text?: string; subtitle?: string }>;
        customStyles: Record<string, CatCutTelopStyle>;
      } | null>;
      applyTranscriptEdits: (input: {
        runDir: string;
        keepSegments: CatCutKeepSegment[];
        /** 全シーンの位置指定。未指定のpositionは、その区間を自動配置へ戻す。 */
        sceneTelopPositions?: Array<{ startMs: number; endMs: number; telopPosition?: { x: number; y: number } }>;
        corrections?: Array<{ wordId: string; text: string }>;
        /**
         * 検品UI v2(シーン行UI, Phase 1): keepSegmentsと同じ順序(cut_001, cut_002, ...)で
         * 対応するテロップ本文を上書きする。nullの要素は「自動生成テロップのまま」を意味する。
         */
        telopOverrides?: Array<string | null>;
        /**
         * T-5(テーマ×感情の自動スタイリング・書き出し反映): keepSegmentsと同じ順序(cut_001, ...)で
         * 対応するテロップページに適用するスタイル名(telopStylePlan.stylesのキー)。
         */
        telopStyleIdsByCut?: Array<string | null>;
        /** T-5: 現在のテーマ+個別オーバーライドから導出したスタイル辞書一式。telop_style_plan.jsonへ書き込む。 */
        telopStylePlan?: { defaultStyle: string; styles: Record<string, CatCutTelopStyle> };
        /**
         * フェーズT2(directedモード): シーン編集から導出したdirectedスロット一覧
         * (文言・スタイルID・強調語・元動画の絶対ms範囲)。main側が telop_directives.json の
         * slotsを差し替えてからstep08を再実行する。指定時はtelopOverrides等のfullモード経路は使わない。
         */
        directedSlots?: Array<{
          startMs: number;
          endMs: number;
          telopPosition?: { x: number; y: number };
          text: string;
          styleId: string;
          /** フェーズT2.5-4: シーンの意味種類(旧runのtype無しシーンはnull)。 */
          typeId?: string | null;
          /** フェーズT2.5-4: styleId が個別上書き(type→presetマッピングより優先)かどうか。 */
          styleOverridden?: boolean;
          /** フェーズT3: 登場アニメの個別上書き(null=上書きなし。マッピング→プリセット既定で解決)。 */
          animationIn?: string | null;
          highlightWords: string[];
        }>;
        /**
         * フェーズU6(詳細エディタ): シーン個別カスタムスタイルの定義(custom_scene_* ID → TelopStyle)。
         * main側が telop_directives.json の custom_styles へマージし、step08 が
         * composition.json の timeline.telop_styles へ注入する。
         */
        customStyles?: Record<string, CatCutTelopStyle>;
        /**
         * U1-5(オーバーレイの文言編集): プレビューでクリック編集したオーバーレイ文言。
         * main側が telop_directives.json の chapters[].title / overlays[].text・subtitle へ
         * 書き戻してから step08 を再実行する。
         */
        overlayEdits?: Array<{
          id: string;
          text?: string;
          subtitle?: string;
        }>;
      }) => Promise<{
        transcript: CatCutTranscriptState;
        review: CatCutTelopState;
      }>;
      runTranscriptCommand: (input: {
        runDir: string;
        command:
          | "silence_stronger"
          | "silence_weaker"
          | "filler_off"
          | "filler_on"
          | "telop_font_bigger"
          | "telop_font_smaller";
      }) => Promise<{ transcript: CatCutTranscriptState; review: CatCutTelopState }>;
      generateWaveform: (input: { runDir: string; binMs?: number }) => Promise<CatCutWaveformResult>;
      /** フェーズU9: フィルムストリップ(等間隔サムネイル)の生成(2回目以降はキャッシュ即時返却)。 */
      generateFilmstrip: (input: { runDir: string }) => Promise<CatCutFilmstripResult>;
      /** フェーズU9: BGMクリップ一覧(bgm.json + 配信URL・音源長)。 */
      listBgm: (input: { runDir: string }) => Promise<CatCutBgmState>;
      /** BGM実音源のピーク波形。逐次生成、最大4096ビン、音源更新時のみ再生成。 */
      getBgmWaveform: (input: { runDir: string; file: string }) => Promise<CatCutWaveformResult>;
      /**
       * フェーズU9: ファイル選択→runs/<run>/bgm/へコピー→既定値でクリップ追加。キャンセル時null。
       * V6-5: startMs=追加開始位置(既存クリップ最後尾の終端。レンダラーが計算して渡す)。
       */
      addBgm: (input: { runDir: string; startMs?: number }) => Promise<CatCutBgmState | null>;
      /** V6-4(D&D): ダイアログなし版。ドロップされたファイルのパス+開始msで直接追加する。 */
      addBgmFile: (input: {
        runDir: string;
        filePath: string;
        startMs?: number;
      }) => Promise<CatCutBgmState | null>;
      /** フェーズU9: bgm.json へ保存(伸縮・移動・音量・フェード・削除の即時永続化)。 */
      saveBgm: (input: {
        runDir: string;
        clips: Array<Omit<CatCutBgmClip, "url" | "audioDurationMs">>;
      }) => Promise<CatCutBgmState>;
      /** フェーズV4: 画像挿入クリップ一覧(images.json + 配信URL)。 */
      listImages: (input: { runDir: string }) => Promise<CatCutImagesState>;
      /**
       * フェーズV4: ファイル選択→runs/<run>/images/へコピー→既定値でクリップ追加(startMs=再生
       * ヘッド位置から4秒間)。キャンセル時null。
       */
      addImage: (input: { runDir: string; startMs?: number }) => Promise<CatCutImagesState | null>;
      /** V6-4(D&D): ダイアログなし版。ドロップされたファイルのパス+開始msで直接追加する。 */
      addImageFile: (input: {
        runDir: string;
        filePath: string;
        startMs?: number;
      }) => Promise<CatCutImagesState | null>;
      /** V6-4(D&D): ドロップされたFileのOSパス(preloadのwebUtils.getPathForFile)。 */
      getPathForFile: (file: File) => string;
      /** フェーズV4: images.json へ保存(伸縮・移動・配置・削除の即時永続化)。 */
      saveImages: (input: {
        runDir: string;
        clips: Array<Omit<CatCutImageClip, "url">>;
      }) => Promise<CatCutImagesState>;
      /** フェーズW9: run正本 video_framing.json の読み込み(無ければidentity)。 */
      getVideoFraming: (input: { runDir: string }) => Promise<CatCutVideoFraming>;
      /**
       * フェーズW9: video_framing.json へ保存(mainがクランプ・不正キー除去して書き込む)。
       * 保存はjsonのみでstep08再実行はしない(書き出し・適用の既存フローが読む)。
       */
      saveVideoFraming: (input: {
        runDir: string;
        framing: CatCutVideoFraming;
      }) => Promise<CatCutVideoFraming>;
      saveTelop: (input: { runDir: string; text: string }) => Promise<CatCutTelopState>;
      applyFontDirectives: (input: { runDir: string; text: string }) => Promise<CatCutTelopState>;
      applyTelopStyle: (input: {
        runDir: string;
        text: string;
        directivesText: string;
        styles: Record<string, CatCutTelopStyle>;
        defaultStyleName: string;
      }) => Promise<CatCutTelopState>;
      getOllamaStatus: () => Promise<CatCutOllamaStatus>;
      pullOllamaModel: (input?: { model?: string }) => Promise<{ ok: boolean; status?: CatCutOllamaStatus; error?: string }>;
      reviewTelopWithOllama: (input: { text: string; model?: string }) => Promise<{ findings: CatCutTelopFinding[]; raw?: string }>;
      openOllamaInstallGuide: () => Promise<void>;
      /** W13-1: 派生キャッシュ(segments/・preview_cut_sequence等)の統計。 */
      getCacheStats: () => Promise<CatCutCacheStats>;
      /** W13-1: 派生キャッシュの削除(old=7日超のみ / all=全run)。runフォルダは消えない。 */
      cleanCache: (input: { mode: "old" | "all" }) => Promise<CatCutCacheCleanResult>;
      /** フェーズW7: 検品段階に到達したrun一覧(更新日時降順)。 */
      listProjects: () => Promise<{ projects: CatCutProjectSummary[] }>;
      /** フェーズW7: project_meta.json へ保存フラグ・タイトルを書き込む。 */
      saveProjectMeta: (input: { runDir: string; title?: string }) => Promise<CatCutProjectMeta>;
      /** フェーズW7: runディレクトリごとプロジェクトを削除する。 */
      deleteProject: (input: { runDir: string }) => Promise<{ ok: boolean }>;
      revealPath: (targetPath: string) => Promise<void>;
      openPath: (targetPath: string) => Promise<void>;
      /** 改善11: APIキー設定状態（末尾4桁+検出元のみ。キー全文は返さない）。 */
      getApiKeysStatus: () => Promise<CatCutApiKeysStatusResponse>;
      setApiKey: (input: { provider: CatCutApiKeyProvider; apiKey: string }) => Promise<CatCutApiKeysStatusResponse>;
      deleteApiKey: (input: { provider: CatCutApiKeyProvider }) => Promise<CatCutApiKeysStatusResponse>;
      testApiKey: (input: { provider: CatCutApiKeyProvider; apiKey?: string }) => Promise<CatCutApiKeyTestResult>;
      openExternalUrl: (url: string) => Promise<void>;
      /** W12-2: ライセンス(FEATURES.billing ONで使用)。 */
      getLicense: () => Promise<CatCutLicenseState>;
      activateLicense: (input: { key: string }) => Promise<CatCutLicenseActionResult>;
      deactivateLicense: () => Promise<{ ok: boolean; error?: string }>;
      refreshLicense: () => Promise<CatCutLicenseActionResult>;
      startLicenseCheckout: (input: { plan: string }) => Promise<{ ok: boolean; url?: string; error?: string }>;
      onJobEvent: (callback: (event: CatCutJobEvent) => void) => () => void;
      /** W16-7: AI最終チェック(現在の表示テキスト全シーンのLLM再チェック)。 */
      runFinalTextCheck: (input: {
        runDir: string;
        scenes: Array<{ sceneId: string; text: string }>;
      }) => Promise<CatCutFinalCheckResult>;
      /** W19-B2: 保存済みAI最終チェック結果(issues.json)の自動ロード。 */
      loadFinalTextCheck: (runDir: string) => Promise<CatCutFinalCheckLoadResult>;
      /** W16-6: スリープ・画面ロック通知(受信でプレビュー再生を一時停止する)。 */
      onPowerSuspend: (callback: () => void) => () => void;
      /** W19-C5: 適用(step08セグメント抽出)中の進捗(0〜100%)通知。 */
      onApplyProgress: (callback: (payload: { percent: number }) => void) => () => void;
    };
  }
}
