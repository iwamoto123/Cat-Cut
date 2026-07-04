export {};

type SttProvider = "elevenlabs" | "local-whisper";

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
}

interface CatCutStartOptions {
  videoPath: string;
  sttProvider: SttProvider;
  whisperModel: string;
  renderFinal: boolean;
  reviewBeforeExport: boolean;
  fontProfileMode?: "saved" | "new";
  savedFontProfileId?: string;
  fontDirectivesText?: string;
  outputPath?: string;
  groundTruthPath?: string;
  learningMode?: boolean;
}

interface CatCutOutputs {
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
  drop_shadow?: string | null;
  y_position_offset?: number;
  description?: string;
  /** T-5(最小拡張): シンプルテーマの疑問スタイル向け下線表現。 */
  underline?: boolean;
  /**
   * T-5(最小拡張): 背景帯有無(仕様書T-1のスタイル属性)。
   * borderRadiusは改善7-4(プリセットギャラリー「半透明角丸」背景)向けの追加拡張。
   */
  background?: { color: string; borderRadius?: string } | null;
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
  startMs: number;
  endMs: number;
  /** 改善10-B-3: パイプライン適用済みページ本文。 */
  text?: string;
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

interface CatCutAiReview {
  enabled: boolean;
  transcriptNeedsReview: CatCutAiReviewTranscriptNeedsReview[];
  telopNeedsReview: CatCutAiReviewTelopNeedsReview[];
  dismissedFindingIds: string[];
  transcriptRefineFailed?: boolean;
  telopRefineFailed?: boolean;
  transcriptRefineFailureReason?: string;
  telopRefineFailureReason?: string;
  transcriptFailedChunks?: number;
  telopFailedChunks?: number;
}

interface CatCutUserDictionaryEntry {
  from: string;
  to: string;
}

interface CatCutUserDictionary {
  entries: CatCutUserDictionaryEntry[];
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
  /**
   * 改善8-B-3(シーン初期化=テロップページ): composition.jsonのBudouXテロップページ境界(絶対ms)。
   * 空配列の場合(旧run等でcomposition.jsonにvoice_data/telopsが無い)、UI側は
   * initializeScenesの既存ヒューリスティック分割にフォールバックする。
   */
  telopPageBoundaries: CatCutTelopPageBoundary[];
  /** 改善13: AI校正結果(パス1+2)。enabled 時は要確認リストがAIモードになる。 */
  aiReview: CatCutAiReview;
}

interface CatCutWaveformResult {
  binMs: number;
  sampleRate: number;
  durationMs: number;
  /** binMsごとの正規化済み(0-1)ピーク配列。60分素材で約18万要素になり得る(カード側でスライスして使う)。 */
  peaks: number[];
  /** true の場合 ui_cache/waveform.json からの即時返却(再生成なし)。 */
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
      getUserRules: () => Promise<CatCutUserRules>;
      saveUserRules: (input: Partial<CatCutUserRules>) => Promise<CatCutUserRules>;
      learnDictionaryRule: (input: { wrong: string; correct: string; category?: CatCutDictionaryRule["category"] }) => Promise<CatCutUserRules>;
      /** 改善10-B-2: userData/user_dictionary.json (step02b向けユーザー辞書)。 */
      getUserDictionary: () => Promise<CatCutUserDictionary>;
      saveUserDictionaryEntry: (input: { from: string; to: string }) => Promise<CatCutUserDictionary>;
      deleteUserDictionaryEntry: (from: string) => Promise<CatCutUserDictionary>;
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
      startExport: (options: { runDir: string; renderFinal: boolean; outputPath?: string }) => Promise<{ ok: boolean; error?: string }>;
      cancelJob: () => Promise<{ ok: boolean }>;
      loadTelop: (runDir: string) => Promise<CatCutTelopState>;
      loadTranscriptEditor: (runDir: string) => Promise<CatCutTranscriptState>;
      applyTranscriptEdits: (input: {
        runDir: string;
        keepSegments: CatCutKeepSegment[];
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
      revealPath: (targetPath: string) => Promise<void>;
      openPath: (targetPath: string) => Promise<void>;
      /** 改善11: APIキー設定状態（末尾4桁+検出元のみ。キー全文は返さない）。 */
      getApiKeysStatus: () => Promise<CatCutApiKeysStatusResponse>;
      setApiKey: (input: { provider: CatCutApiKeyProvider; apiKey: string }) => Promise<CatCutApiKeysStatusResponse>;
      deleteApiKey: (input: { provider: CatCutApiKeyProvider }) => Promise<CatCutApiKeysStatusResponse>;
      testApiKey: (input: { provider: CatCutApiKeyProvider; apiKey?: string }) => Promise<CatCutApiKeyTestResult>;
      openExternalUrl: (url: string) => Promise<void>;
      onJobEvent: (callback: (event: CatCutJobEvent) => void) => () => void;
    };
  }
}
