// 実行時(値)importのため、node --experimental-strip-types でテストを直接実行できるよう拡張子を明示する。
import { EMOTION_TAGS, EMOTION_LABELS, type EmotionTag } from "./emotionTag.ts";

/**
 * 改善8-B(2026-07-03 実機テスト第2回分析「改善8」8-B節)のプリセット駆動テーマ。
 *
 * 改善7で作った `PRESET_GENRES` の生成マトリクス(フラット単色+1重縁×約96種)は、
 * rough-cut品質の `templates/telop_presets.yaml`(多重縁取り+グラデ)をバイパスして
 * 書き出しに流れてしまっていた根本原因(改善8③)であるため、本ファイルは
 * `telop_presets.yaml` を唯一のスタイル源として扱うプリセット駆動テーマに全面切替する。
 *
 * データフロー:
 *   1. Electron main プロセスが `templates/telop_presets.yaml` をIPC(`telop-presets:list`)で
 *      読み込み、レンダラー起動時に `registerPresetCatalog()` へ渡す(App.tsx)。
 *   2. `TelopStyleDef` は yaml のプリセット定義(および Remotion `TelopStyle`)と完全に同じ形を
 *      持つため、変換なしでそのまま書き出し用 telop_style_plan.json の値として使える。
 *   3. 「テーマ」は「プリセットファミリー」(カラーウェイ単位、またはyaml既存6種をまとめた
 *      "classic"ファミリー)を指し、4感情(通常/強調/疑問/驚き)それぞれに1プリセット名を
 *      割り当てる(FAMILIES参照)。個別オーバーライド・ギャラリー選択の仕組み(T-2/T-3)は維持する。
 *
 * node --experimental-strip-types でのユニットテスト実行に対応するため、このファイル自体は
 * I/Oを持たない(yaml読み込みはmain側)。テストは `registerPresetCatalog()` にフィクスチャを
 * 登録してから検証する。
 */

export type { EmotionTag };
export type TelopThemeId = string;

// =============================================================================
// スタイル型(telop_presets.yaml / Remotion TelopStyle と同一形状)
// =============================================================================

/**
 * `global.d.ts`のCatCutTelopStyle["fill"]と同じ形状(単一のフラットな型)にする。
 * IPC(telop-presets:list)経由で受け取るJSONはTypeScriptの判別可能ユニオンを保証できないため、
 * type: "solid"|"gradient" に応じてcolorまたはgradient_from/toのどちらか一方が入る形で
 * 全フィールドをoptionalにしている(実際の描画側では常にtypeで分岐して参照する)。
 */
export type TelopFill = {
  type: "solid" | "gradient";
  color?: string;
  gradient_from?: string;
  gradient_to?: string;
  gradient_direction?: "vertical" | "horizontal" | "diagonal";
};

export type TelopStroke = { color: string; width: number };

export type TelopStyleDef = {
  font_family?: string;
  font_size?: number;
  font_weight?: number;
  letter_spacing?: string;
  line_height?: number;
  fill: TelopFill;
  inner_stroke?: TelopStroke | null;
  outer_stroke?: TelopStroke | null;
  /** フェーズU6: outer_stroke のさらに外側の第3縁(多重テロップの「太枠」用。最背面)。 */
  outer_stroke2?: TelopStroke | null;
  drop_shadow?: string | null;
  /** フェーズU6: 光彩(グロウ)。drop-shadow多重で表現(telopGlow.ts)。radiusはfont_size基準px。 */
  glow?: { color: string; radius: number } | null;
  /** フェーズT2.5-2: ハードなオフセット影(縁レイヤーの下に(x,y)pxずらして描画)。 */
  shadow_offset?: { x: number; y: number; color: string } | null;
  y_position_offset?: number;
  underline?: boolean;
  /**
   * 背景。padding_x/padding_y(px)指定時は「行ごとの帯」ではなく文字ブロック全体の
   * 背後に1枚のベタ長方形を描く(box_yellow等。Remotion Telop.tsx の resolveBlockBackground と同じ規則)。
   */
  background?: {
    color: string;
    borderRadius?: string;
    padding_x?: number;
    padding_y?: number;
    border_radius?: number;
  } | null;
  /** フェーズT1-2(部分ハイライト): highlight_words の塗り色。省略時 DEFAULT_HIGHLIGHT_COLOR。 */
  highlight_color?: string;
  /** フェーズT3: プリセット既定の登場アニメーション(pop_big等。省略時はtimeline既定)。 */
  animation_in?: string | null;
  /** フェーズT3: プリセット既定の退場アニメーション。 */
  animation_out?: string | null;
  /** フェーズT3: 登場アニメの長さ(フレーム数。省略時は既定12)。 */
  animation_duration_frames?: number;
  /** フェーズT3: 登場時効果音ID(assets/sfx/。null/省略で鳴らさない)。 */
  sfx?: string | null;
  /** 助詞縮小: 内容語に挟まれた単独ひらがな助詞の縮小率。省略時0.8、1で無効。 */
  particle_scale?: number | null;
  /** 和欧混植: 半角英数字の連続に適用する欧文フォント。省略時Anton、nullで無効。 */
  latin_font_family?: string | null;
  /** フェーズW27: ブロック全体の回転(deg)。斜め文字プリセット用。省略=回転なし。 */
  rotate?: number | null;
  /** フェーズW27: 縦書き("vertical"=vertical-rl・縦1列)。短い決めゼリフ用。省略=横書き。 */
  writing_mode?: "vertical" | null;
  /** yaml側の説明文(ギャラリーのツールチップ等に使える。必須ではない)。 */
  description?: string;
};

export type TelopPresetCatalog = Record<string, TelopStyleDef>;

export type TelopStyleOption = {
  id: string;
  label: string;
  style: TelopStyleDef;
};

// =============================================================================
// フォールバックカタログ(yaml未ロード時の安全網、および純関数テスト用の既定値)
// telop_presets.yaml の6既存プリセットと完全に一致させる(手動同期。変更頻度が低いため許容)。
// =============================================================================

const DEFAULT_FONT_FAMILY =
  '"Zen Kaku Gothic Antique", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Meiryo", sans-serif';

const FALLBACK_CATALOG: TelopPresetCatalog = {
  default: {
    font_family: DEFAULT_FONT_FAMILY,
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
    font_family: '"Zen Kaku Gothic Antique", "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Arial Black", "Meiryo", sans-serif',
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
  simple: {
    font_family: '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", sans-serif',
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
  calm: {
    font_family: DEFAULT_FONT_FAMILY,
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
    font_family: '"Zen Kaku Gothic Antique", "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Arial Black", "Meiryo", sans-serif',
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
    font_family: '"Hiragino Maru Gothic ProN", "Zen Kaku Gothic Antique", "Hiragino Sans", "Meiryo", sans-serif',
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
};

const FALLBACK_STYLE: TelopStyleDef = FALLBACK_CATALOG.simple;

let presetCatalog: TelopPresetCatalog = { ...FALLBACK_CATALOG };

/**
 * main プロセスがIPC(`telop-presets:list`)経由で読み込んだ `telop_presets.yaml` の
 * 内容(プリセット名→定義)を登録する。以後 `getPresetStyle`/`resolveStyleById` 等は
 * このカタログを優先して参照する(未登録のプリセット名はFALLBACK_CATALOGへフォールバック)。
 */
export function registerPresetCatalog(catalog: TelopPresetCatalog): void {
  presetCatalog = { ...FALLBACK_CATALOG, ...catalog };
  rebuildStyleRegistry();
}

export function getPresetCatalog(): TelopPresetCatalog {
  return presetCatalog;
}

export function getPresetStyle(name: string): TelopStyleDef | null {
  return presetCatalog[name] ?? null;
}

/**
 * フェーズU6(詳細エディタ): カスタムスタイル定義(custom_* ID)を実行時にカタログへ登録する。
 * registerPresetCatalog(起動時のyaml読み込み)と違いフォールバックへは戻さず追記のみ
 * (デザインテーマのcustom_styles・シーン個別カスタムをプレビューへ即時反映するため)。
 */
export function registerRuntimeStyles(defs: Record<string, TelopStyleDef> | null | undefined): void {
  if (!defs) return;
  const entries = Object.entries(defs).filter(([id, def]) => id && def && typeof def === "object" && def.fill);
  if (!entries.length) return;
  for (const [id, def] of entries) presetCatalog[id] = def;
  rebuildStyleRegistry();
}

// =============================================================================
// テーマ = プリセットファミリー(改善8-B-1「テーマ=プリセットファミリー単位で4感情に割り当て」)
// =============================================================================

export type PresetFamilyId = string;

export type PresetExtraOption = {
  /** STYLE_REGISTRY/スタイルIDとして使う一意なID。 */
  id: string;
  label: string;
  /** 参照するプリセット名(presetCatalogのキー)。 */
  presetName: string;
};

export type PresetFamilyDef = {
  id: PresetFamilyId;
  label: string;
  /** 4感情それぞれに割り当てるプリセット名(presetCatalogのキー)。 */
  emotionPresets: Record<EmotionTag, string>;
  /** 感情に紐づかない追加の選択肢(帯背景バリエーション・シンプル/落ち着き等)。 */
  extraOptions: PresetExtraOption[];
};

/** カラーウェイ12種のメタ情報(改善8-B-2)。帯背景バリエーションは6種のみ用意する。 */
const COLORWAY_FAMILIES: Array<{ id: string; label: string; hasBand: boolean }> = [
  { id: "blue", label: "ブルー", hasBand: true },
  { id: "orange", label: "オレンジ", hasBand: true },
  { id: "red", label: "レッド", hasBand: true },
  { id: "green", label: "グリーン", hasBand: true },
  { id: "purple", label: "パープル", hasBand: false },
  { id: "pink", label: "ピンク", hasBand: true },
  { id: "gold", label: "ゴールド", hasBand: true },
  { id: "white", label: "ホワイト", hasBand: false },
  { id: "black", label: "ブラック", hasBand: false },
  { id: "cyan", label: "サイアン", hasBand: false },
  { id: "navy", label: "ネイビー", hasBand: false },
  { id: "brown", label: "ブラウン", hasBand: false },
];

/**
 * "classic"ファミリー: telop_presets.yaml の既存6プリセット(rough-cut品質の第一世代)を
 * そのまま4感情+2エキストラへ割り当てる。既存の書き出し実績(改善「テロップ統合」)がある
 * プリセット名(default/highlight/question/warning)をそのまま使うため後方互換性が高い。
 */
function buildClassicFamily(): PresetFamilyDef {
  return {
    id: "classic",
    label: "クラシック",
    emotionPresets: { normal: "default", emphasis: "highlight", question: "question", surprise: "warning" },
    extraOptions: [
      { id: "classic_simple", label: "シンプル", presetName: "simple" },
      { id: "classic_calm", label: "落ち着き", presetName: "calm" },
    ],
  };
}

/**
 * カラーウェイファミリー: 同一カラーウェイ内の用途3種(標準/強調大/控えめ小)を4感情へ割り当てる。
 * 通常=標準、強調=強調大、疑問=控えめ小(トーンを落として問いかけらしさを出す)、驚き=強調大
 * (インパクト表現として強調と共有する。プリセットは用途3種のみのため意図的な流用)。
 */
function buildColorwayFamily(colorway: { id: string; label: string; hasBand: boolean }): PresetFamilyDef {
  return {
    id: colorway.id,
    label: colorway.label,
    emotionPresets: {
      normal: `${colorway.id}_standard`,
      emphasis: `${colorway.id}_emphasis`,
      question: `${colorway.id}_subtle`,
      surprise: `${colorway.id}_emphasis`,
    },
    extraOptions: colorway.hasBand ? [{ id: `${colorway.id}_band`, label: "帯背景", presetName: `${colorway.id}_band` }] : [],
  };
}

const FAMILIES: PresetFamilyDef[] = [buildClassicFamily(), ...COLORWAY_FAMILIES.map(buildColorwayFamily)];

const FAMILY_BY_ID: Record<PresetFamilyId, PresetFamilyDef> = FAMILIES.reduce(
  (acc, family) => {
    acc[family.id] = family;
    return acc;
  },
  {} as Record<PresetFamilyId, PresetFamilyDef>,
);

/** テーマ(ファミリー)ID一覧。ギャラリーUIの一覧表示に使う。 */
export const THEME_IDS: TelopThemeId[] = FAMILIES.map((family) => family.id);
export const THEME_LABELS: Record<string, string> = FAMILIES.reduce(
  (acc, family) => {
    acc[family.id] = family.label;
    return acc;
  },
  {} as Record<string, string>,
);

/** 既定テーマ: "classic"(rough-cut品質の第一世代プリセット、白谷塾青ベース)。 */
export const DEFAULT_THEME_ID: TelopThemeId = "classic";

// =============================================================================
// 改善7-3: 保存済みフォントプロファイルの実行時テーマ登録("saved"テーマ)
// =============================================================================

export const SAVED_THEME_ID = "saved";

const runtimeFamilies: Record<string, PresetFamilyDef> = {};

/**
 * 実行時に(非同期I/Oで読み込んだ)保存済みフォントプロファイル由来のスタイルをテーマとして
 * 登録する。`fontProfileTheme.ts` の `mapFontProfileToEmotionStyles()` の出力をここに渡す想定。
 * プリセットカタログとは別枠(`saved_${emotion}`という専用プリセット名)で登録することで、
 * yaml由来のプリセットと衝突しない。
 */
export function setRuntimeTheme(themeId: string, styles: Record<EmotionTag, TelopStyleDef>): void {
  const emotionPresets = {} as Record<EmotionTag, string>;
  for (const emotion of EMOTION_TAGS) {
    const presetName = `${themeId}_${emotion}`;
    presetCatalog[presetName] = styles[emotion];
    emotionPresets[emotion] = presetName;
  }
  runtimeFamilies[themeId] = { id: themeId, label: themeId, emotionPresets, extraOptions: [] };
  rebuildStyleRegistry();
}

export function clearRuntimeTheme(themeId: string): void {
  delete runtimeFamilies[themeId];
  for (const emotion of EMOTION_TAGS) delete presetCatalog[`${themeId}_${emotion}`];
  rebuildStyleRegistry();
}

export function hasRuntimeTheme(themeId: string): boolean {
  return Boolean(runtimeFamilies[themeId]);
}

function resolveFamily(themeId: TelopThemeId): PresetFamilyDef {
  return FAMILY_BY_ID[themeId] ?? runtimeFamilies[themeId] ?? FAMILY_BY_ID[DEFAULT_THEME_ID];
}

// =============================================================================
// スタイルID解決(styleId = `${themeId}_${emotion}` または family.extraOptions[].id)
// =============================================================================

export function themeEmotionStyleId(themeId: TelopThemeId, emotion: EmotionTag): string {
  return `${themeId}_${emotion}`;
}

let STYLE_REGISTRY: Record<string, TelopStyleDef> = {};

function rebuildStyleRegistry(): void {
  const registry: Record<string, TelopStyleDef> = {};
  const allFamilies = [...FAMILIES, ...Object.values(runtimeFamilies)];
  for (const family of allFamilies) {
    for (const emotion of EMOTION_TAGS) {
      const style = getPresetStyle(family.emotionPresets[emotion]);
      if (style) registry[themeEmotionStyleId(family.id, emotion)] = style;
    }
    for (const extra of family.extraOptions) {
      const style = getPresetStyle(extra.presetName);
      if (style) registry[extra.id] = style;
    }
  }
  STYLE_REGISTRY = registry;
}

rebuildStyleRegistry();

export function resolveStyleById(styleId: string): TelopStyleDef | null {
  return STYLE_REGISTRY[styleId] ?? null;
}

/**
 * スウォッチクリックで開く「あ」パレットの選択肢一覧(4感情+ファミリー固有のエキストラ)。
 */
export function paletteOptionsForTheme(themeId: TelopThemeId): TelopStyleOption[] {
  const family = resolveFamily(themeId);
  const emotionOptions: TelopStyleOption[] = EMOTION_TAGS.map((emotion) => ({
    id: themeEmotionStyleId(themeId, emotion),
    label: EMOTION_LABELS[emotion],
    style: getPresetStyle(family.emotionPresets[emotion]) ?? FALLBACK_STYLE,
  }));
  const extraOptions: TelopStyleOption[] = family.extraOptions.map((extra) => ({
    id: extra.id,
    label: extra.label,
    style: getPresetStyle(extra.presetName) ?? FALLBACK_STYLE,
  }));
  return [...emotionOptions, ...extraOptions];
}

/**
 * 有効スタイルIDの解決規則(T-3「個別変更（オーバーライド）は感情タグより優先」)。
 * 優先順位: styleOverrideId(個別オーバーライド) > emotionTag(感情タグ) > テーマ既定("normal")。
 */
export function resolveEffectiveStyleId(
  themeId: TelopThemeId,
  emotionTag: EmotionTag | undefined,
  styleOverrideId: string | null | undefined,
): string {
  if (styleOverrideId) return styleOverrideId;
  return themeEmotionStyleId(themeId, emotionTag ?? "normal");
}

/** 上記IDを実スタイル定義に解決する(未知のIDはテーマの"normal"にフォールバック)。 */
export function resolveEffectiveStyle(
  themeId: TelopThemeId,
  emotionTag: EmotionTag | undefined,
  styleOverrideId: string | null | undefined,
): TelopStyleDef {
  const id = resolveEffectiveStyleId(themeId, emotionTag, styleOverrideId);
  return (
    resolveStyleById(id) ??
    resolveStyleById(themeEmotionStyleId(themeId, "normal")) ??
    resolveStyleById(themeEmotionStyleId(DEFAULT_THEME_ID, "normal")) ??
    FALLBACK_STYLE
  );
}

/**
 * ギャラリーの「カラーウェイタブ×用途カード」表示用の1件(改善8-B-2)。
 * タブ(カラーウェイ)を選ぶとそのファミリーの用途バリエーション(標準/強調大/控えめ小/帯背景)が
 * 実スタイルのCSS近似(telopStyleToCssProperties)付きで一覧表示される。カードをクリックすると
 * (用途に関わらず)そのファミリー全体(themeId)を選択する(テーマ=ファミリー単位の原則を維持)。
 */
export type PresetVariantOption = { presetName: string; label: string; style: TelopStyleDef };

const CLASSIC_VARIANT_LABELS: EmotionTag[] = ["normal", "emphasis", "question", "surprise"];

export function variantOptionsForFamily(themeId: TelopThemeId): PresetVariantOption[] {
  const family = resolveFamily(themeId);
  if (family.id === "classic") {
    const emotionOptions = CLASSIC_VARIANT_LABELS.map((emotion) => ({
      presetName: family.emotionPresets[emotion],
      label: EMOTION_LABELS[emotion],
      style: getPresetStyle(family.emotionPresets[emotion]) ?? FALLBACK_STYLE,
    }));
    const extraOptions = family.extraOptions.map((extra) => ({
      presetName: extra.presetName,
      label: extra.label,
      style: getPresetStyle(extra.presetName) ?? FALLBACK_STYLE,
    }));
    return [...emotionOptions, ...extraOptions];
  }
  const variants: Array<{ suffix: string; label: string }> = [
    { suffix: "standard", label: "標準" },
    { suffix: "emphasis", label: "強調大" },
    { suffix: "subtle", label: "控えめ小" },
  ];
  const options: PresetVariantOption[] = variants
    .map((variant) => ({ presetName: `${family.id}_${variant.suffix}`, label: variant.label }))
    .filter((option) => Boolean(getPresetStyle(option.presetName)))
    .map((option) => ({ ...option, style: getPresetStyle(option.presetName) ?? FALLBACK_STYLE }));
  const bandPresetName = `${family.id}_band`;
  const bandStyle = getPresetStyle(bandPresetName);
  if (bandStyle) options.push({ presetName: bandPresetName, label: "帯背景", style: bandStyle });
  return options;
}

export type ThemeCardInfo = {
  label: string;
  sampleStyle: TelopStyleDef;
};

/** ギャラリーUI向け: テーマIDから表示ラベルとサンプルスタイル("normal")を引く。 */
export function describeThemeCard(themeId: string): ThemeCardInfo {
  const family = FAMILY_BY_ID[themeId];
  if (family) {
    return { label: family.label, sampleStyle: getPresetStyle(family.emotionPresets.normal) ?? FALLBACK_STYLE };
  }
  const runtime = runtimeFamilies[themeId];
  if (runtime) {
    return {
      label: themeId === SAVED_THEME_ID ? "保存済み" : themeId,
      sampleStyle: getPresetStyle(runtime.emotionPresets.normal) ?? FALLBACK_STYLE,
    };
  }
  return { label: themeId, sampleStyle: FALLBACK_STYLE };
}

// =============================================================================
// T-5(書き出し反映): telop_style_plan.json 相当のデータを組み立てる
// =============================================================================

/**
 * 実際に使われているスタイルIDだけを含む telop_style_plan.json 相当のデータを組み立てる
 * (main.js経由でrunDir/telop_style_plan.jsonへ書き込まれ、apply_telop.pyの
 * load_style_plan()/apply_style_plan()がcomposition.jsonへ反映する)。
 * `TelopStyleDef` は telop_presets.yaml / Remotion `TelopStyle` と同一形状のため、
 * 変換なしでそのまま書き出せる(改善8-B-1で `telopStyleToRemotionStyle` の変換層を廃止)。
 */
// =============================================================================
// CSS近似描画(簡易版): ギャラリーサムネイル・スウォッチ等の小サイズ表示専用。
// プレビュー本体(PreviewPlayer.tsx)は、より忠実な多層DOM描画コンポーネント
// <TelopStyledText>(telopPreviewSize.ts/PreviewPlayer.tsx参照)を使う。
// ここでのグラデ塗り(background-clip:text)は忠実に再現できるが、多重縁取りは
// 多層text-shadowによる近似であり、小サイズ表示では視覚差が出にくいためこれで十分とする。
// 帯背景(style.background)はテキスト自体のbackground-clip:textと競合するため、
// この簡易版では描画しない(帯背景の忠実描画はTelopStyledText側の責務とする)。
// =============================================================================

type CssPropertiesLike = Record<string, string | number | undefined>;

/**
 * 改善9-B-2: 表示フォントサイズ ÷ プリセット font_size の比率。
 * サムネイル・プレビュー・Remotion いずれもこの比率で縁取り・影をスケールする。
 */
export function telopDisplayScale(displayFontSizePx: number, presetFontSize: number): number {
  const base = presetFontSize || displayFontSizePx || 1;
  return displayFontSizePx / base;
}

/** 縁取り幅を表示サイズに合わせてスケールする。 */
export function scaleTelopStrokeWidth(
  widthPx: number,
  displayFontSizePx: number,
  presetFontSize: number,
): number {
  return Math.max(0.5, widthPx * telopDisplayScale(displayFontSizePx, presetFontSize));
}

/** drop-shadow() の px 値を表示サイズ比率でスケールする。 */
export function scaleTelopDropShadow(
  dropShadow: string | null | undefined,
  displayFontSizePx: number,
  presetFontSize: number,
): string | null | undefined {
  if (!dropShadow) return dropShadow;
  const scale = telopDisplayScale(displayFontSizePx, presetFontSize);
  if (Math.abs(scale - 1) < 1e-6) return dropShadow;
  return dropShadow.replace(/(-?\d+(?:\.\d+)?)px/g, (_match, value) => {
    const scaled = Number(value) * scale;
    const rounded = Math.abs(scaled) < 0.5 ? scaled.toFixed(2) : String(Math.round(scaled * 100) / 100);
    return `${rounded}px`;
  });
}

function gradientCssAngle(direction?: "vertical" | "horizontal" | "diagonal"): string {
  if (direction === "horizontal") return "to right";
  if (direction === "diagonal") return "135deg";
  return "to bottom";
}

function ringShadowLayers(color: string, radiusPx: number, steps: number): string[] {
  if (radiusPx <= 0) return [];
  const layers: string[] = [];
  for (let i = 0; i < steps; i += 1) {
    const angle = (2 * Math.PI * i) / steps;
    const x = Math.cos(angle) * radiusPx;
    const y = Math.sin(angle) * radiusPx;
    layers.push(`${x.toFixed(2)}px ${y.toFixed(2)}px 0 ${color}`);
  }
  return layers;
}

/** 縁取り幅widthPxを、同心円状に並べた複数のtext-shadowで塗りつぶして近似する。 */
function multiRingShadowLayers(color: string, widthPx: number): string[] {
  if (widthPx <= 0) return [];
  const steps = widthPx > 3 ? 12 : 8;
  const radii = widthPx > 3 ? [widthPx, widthPx * 0.6, widthPx * 0.3] : [widthPx];
  return radii.flatMap((radius) => ringShadowLayers(color, radius, steps));
}

/** "drop-shadow(0px 4px 6px rgba(0,0,0,0.4))" → "0px 4px 6px rgba(0,0,0,0.4)"(text-shadow用)。 */
function dropShadowToTextShadow(dropShadow: string | null | undefined): string | null {
  if (!dropShadow) return null;
  const match = /drop-shadow\(([^)]+)\)/.exec(dropShadow);
  return match ? match[1] : null;
}

/**
 * 実スタイル(TelopStyleDef)をCSSプロパティへ近似変換する(小サイズ表示向け簡易版)。
 * baseFontSizePxは表示先(サムネイル/スウォッチ)の実際のフォントサイズ(px)を直接指定する
 * (style.font_sizeそのものは使わず、縁取り幅等のスケーリング基準としてのみ使う)。
 */
export function telopStyleToCssProperties(style: TelopStyleDef, baseFontSizePx: number): CssPropertiesLike {
  const presetFontSize = style.font_size || baseFontSizePx || 1;
  const shadowLayers: string[] = [];
  if (style.inner_stroke) {
    shadowLayers.push(
      ...multiRingShadowLayers(
        style.inner_stroke.color,
        scaleTelopStrokeWidth(style.inner_stroke.width, baseFontSizePx, presetFontSize),
      ),
    );
  }
  if (style.outer_stroke) {
    shadowLayers.push(
      ...multiRingShadowLayers(
        style.outer_stroke.color,
        scaleTelopStrokeWidth(style.outer_stroke.width, baseFontSizePx, presetFontSize),
      ),
    );
  }
  // フェーズU6: 第3縁(最背面)も同心円shadowで近似する(小サイズ表示専用の簡易版)
  if (style.outer_stroke2) {
    shadowLayers.push(
      ...multiRingShadowLayers(
        style.outer_stroke2.color,
        scaleTelopStrokeWidth(style.outer_stroke2.width, baseFontSizePx, presetFontSize),
      ),
    );
  }
  // フェーズU6: グロウはぼかしtext-shadow1層で近似する(忠実描画はTelopStyledTextの責務)
  if (style.glow && style.glow.radius > 0) {
    const glowRadius = style.glow.radius * telopDisplayScale(baseFontSizePx, presetFontSize);
    shadowLayers.push(`0 0 ${Math.round(glowRadius * 100) / 100}px ${style.glow.color}`);
  }
  const dropShadowLayer = dropShadowToTextShadow(
    scaleTelopDropShadow(style.drop_shadow, baseFontSizePx, presetFontSize),
  );
  if (dropShadowLayer) shadowLayers.push(dropShadowLayer);

  const css: CssPropertiesLike = {
    fontFamily: style.font_family,
    fontWeight: style.font_weight ?? 900,
    letterSpacing: style.letter_spacing,
    lineHeight: style.line_height,
    fontSize: `${Math.max(1, Math.round(baseFontSizePx))}px`,
    textShadow: shadowLayers.length ? shadowLayers.join(", ") : undefined,
  };
  if (style.fill.type === "gradient") {
    const from = style.fill.gradient_from || "#FFFFFF";
    const to = style.fill.gradient_to || "#000000";
    css.backgroundImage = `linear-gradient(${gradientCssAngle(style.fill.gradient_direction)}, ${from}, ${to})`;
    css.WebkitBackgroundClip = "text";
    css.backgroundClip = "text";
    css.color = "transparent";
  } else {
    css.color = style.fill.color || "#FFFFFF";
  }
  return css;
}

/**
 * スウォッチボタン(丸いカラーチップ)向けに、スタイルを代表する塗り色・縁色の2値を取り出す。
 * グラデーションの場合は深い方の色(gradient_to)を塗り色とする(視認性を優先)。
 */
export function telopStyleSwatchColors(style: TelopStyleDef): { color: string; borderColor: string } {
  const color = style.fill.type === "gradient" ? style.fill.gradient_to : style.fill.color;
  const borderColor =
    style.outer_stroke2?.color ?? style.outer_stroke?.color ?? style.inner_stroke?.color ?? "#d9dde3";
  return { color: color || "#FFFFFF", borderColor };
}

export function buildTelopStylePlan(
  styleIds: string[],
  _baseFontSize: number,
  defaultThemeId: TelopThemeId,
): { defaultStyle: string; styles: Record<string, TelopStyleDef> } {
  const styles: Record<string, TelopStyleDef> = {};
  for (const id of new Set(styleIds)) {
    const def = resolveStyleById(id);
    if (def) styles[id] = def;
  }
  const defaultId = themeEmotionStyleId(defaultThemeId, "normal");
  if (!styles[defaultId]) {
    styles[defaultId] = resolveStyleById(defaultId) ?? FALLBACK_CATALOG.default;
  }
  return { defaultStyle: defaultId, styles };
}
