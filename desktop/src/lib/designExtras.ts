// フェーズU7/U8: シーンタイトル(chapter_title)とOP(オープニング)設定のUI側ユーティリティ。
// 正規化規則は main/index.cjs の sanitizeOverlayTitleConfig / sanitizeOpConfig と同一に保つ
// (mainが最終防衛線だが、UIでも同じ既定に落として表示と保存値のズレを防ぐ)。
import {
  CHAPTER_TITLE_PATTERNS,
  DEFAULT_CHAPTER_TITLE_PATTERN,
  type ChapterTitlePattern,
} from "./overlayStyles.ts";
import {
  DEFAULT_OP_DECORATION,
  DEFAULT_OP_TEXT_ANIMATION,
  normalizeOpDecoration,
  normalizeOpTextAnimation,
  type OpDecoration,
  type OpTextAnimation,
} from "./opTimeline.ts";

export type OverlayTitleConfig = {
  enabled: boolean;
  style: ChapterTitlePattern;
};

export const DEFAULT_OVERLAY_TITLE: OverlayTitleConfig = {
  enabled: true,
  style: DEFAULT_CHAPTER_TITLE_PATTERN,
};

/** overlay_title の正規化。欠落・不正は「有効・box_accent」=従来挙動。 */
export function sanitizeOverlayTitle(raw: unknown): OverlayTitleConfig {
  const result: OverlayTitleConfig = { ...DEFAULT_OVERLAY_TITLE };
  if (!raw || typeof raw !== "object") return result;
  const obj = raw as Record<string, unknown>;
  if (obj.enabled === false) result.enabled = false;
  if (
    typeof obj.style === "string" &&
    (CHAPTER_TITLE_PATTERNS as readonly string[]).includes(obj.style)
  ) {
    result.style = obj.style as ChapterTitlePattern;
  }
  return result;
}

/** シーンタイトルパターンの表示名・説明(ミニプレビューカードの見出しに使う)。 */
export const CHAPTER_TITLE_PATTERN_INFO: Record<
  ChapterTitlePattern,
  { label: string; description: string }
> = {
  box_accent: { label: "スタンダード", description: "白フチ明朝の現行デザイン" },
  band_gradient: { label: "グラデ帯", description: "左端からのグラデ帯+白字" },
  tag_ribbon: { label: "タグリボン", description: "切り欠き付きのタグ風座布団" },
  minimal_line: { label: "ミニマル", description: "細字+アンダーラインのみ" },
  neon_plate: { label: "ネオン", description: "黒プレート+ネオン縁(ゲーム向き)" },
};

// ---- シーン映像ギミック(フェーズW2) ----

export type VideoEffectsConfig = {
  /** pinch: 辛辣シーンの縮小+暗転+チーンSFX。 */
  pinch: boolean;
  /** zoom: 強調シーンのゆっくりズームイン。 */
  zoom: boolean;
  /** W24 Phase C dim: 強調シーンの暗転強調(映像を暗くしてテロップを際立たせる)。既定OFF。 */
  dim: boolean;
  /** W24 Phase C face_zoom: 顔が検出できたカットで顔にゆっくり寄る。既定OFF。 */
  face_zoom: boolean;
  /** W24 Phase C slow_push: 各カット全長でごくゆっくり寄せ続ける常用モーション。既定OFF。 */
  slow_push: boolean;
};

export const DEFAULT_VIDEO_EFFECTS: VideoEffectsConfig = {
  pinch: true,
  zoom: true,
  dim: false,
  face_zoom: false,
  slow_push: false,
};

/**
 * video_effects 設定の正規化
 * (main側 sanitizeVideoEffectsConfig / python sanitize_video_effects_enabled と同じ規則)。
 * - pinch / zoom: 欠落・不正はON(既定=W2からの後方互換)。明示的な false のみOFF。
 * - dim / face_zoom / slow_push: 欠落・不正はOFF(既定=既存テーマは従来動作)。
 *   明示的な true のみON。
 */
export function sanitizeVideoEffects(raw: unknown): VideoEffectsConfig {
  const result: VideoEffectsConfig = { ...DEFAULT_VIDEO_EFFECTS };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return result;
  const obj = raw as Record<string, unknown>;
  if (obj.pinch === false) result.pinch = false;
  if (obj.zoom === false) result.zoom = false;
  if (obj.dim === true) result.dim = true;
  if (obj.face_zoom === true) result.face_zoom = true;
  if (obj.slow_push === true) result.slow_push = true;
  return result;
}

// ---- OP(オープニング) ----

// フェーズV5: OPは「なし / ハイライト予告」の2択に一本化。
// 旧パターン(title_card / question_hook)は読み込み時に highlight_teaser へ
// 無警告マイグレーションする(Remotion側レンダラは既存run互換のため残置)。
export const OP_PATTERNS = ["none", "highlight_teaser"] as const;

export type OpPattern = (typeof OP_PATTERNS)[number];

/** V5でUIから撤去した旧パターン。読んだら highlight_teaser として扱う。 */
const LEGACY_OP_PATTERNS = ["title_card", "question_hook"] as const;

// 装飾・テキストアニメのID定義はRemotionと共有する opTimeline.ts(コピー一致テスト対象)が正
export {
  DEFAULT_OP_DECORATION,
  DEFAULT_OP_TEXT_ANIMATION,
  OP_DECORATIONS,
  OP_TEXT_ANIMATIONS,
} from "./opTimeline.ts";
export type { OpDecoration, OpTextAnimation };

export type OpConfig = {
  pattern: OpPattern;
  /** フェーズV5: highlight_teaser の装飾パターン(flash_pop / cinema_bars / color_wipe / neon_frame)。 */
  decoration: OpDecoration;
  /** フェーズV5: OPテロップの登場アニメ(全クリップ共通)。 */
  text_animation: OpTextAnimation;
  title: string;
  /** W11-5: タイトルを表示するか(false=「表示しない」チェック)。省略=true(後方互換)。 */
  title_enabled: boolean;
  catch_copy: string;
};

export const DEFAULT_OP_CONFIG: OpConfig = {
  pattern: "none",
  decoration: DEFAULT_OP_DECORATION,
  text_animation: DEFAULT_OP_TEXT_ANIMATION,
  title: "",
  title_enabled: true,
  catch_copy: "",
};

// W13-3: OPタイトル/キャッチコピーに実データとして混入しがちなプレースホルダ的文言。
// テーマ設定の試し入力がそのまま保存され動画に表示される事故があったため、
// 読み込み・保存の正規化で空文字(=非表示)へ落とす。
// main/index.cjs sanitizeOpConfig / python shared/opening.py と同一リストを保つこと
export const OP_PLACEHOLDER_TEXTS: readonly string[] = [
  "タイトルテキスト",
  "タイトルテスト",
  "キャッチコピー",
  "サンプルテキスト",
];

/** W13-3: プレースホルダ的文言は空文字へ正規化する(trim込み)。 */
export function normalizeOpUserText(value: string): string {
  const trimmed = value.trim();
  return OP_PLACEHOLDER_TEXTS.includes(trimmed) ? "" : trimmed;
}

/**
 * op 設定の正規化。欠落・不正は pattern=none=OPなし(後方互換)。
 * フェーズV5: 旧パターン値は highlight_teaser へ移行し、decoration / text_animation は
 * 未知値を既定(flash_pop / slide_left)へ落とす。
 * W11-5: title_enabled は明示false のみ「表示しない」(省略・不正値はtrue=後方互換)。
 */
export function sanitizeOpConfig(raw: unknown): OpConfig {
  const result: OpConfig = { ...DEFAULT_OP_CONFIG };
  if (!raw || typeof raw !== "object") return result;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.pattern === "string") {
    if ((OP_PATTERNS as readonly string[]).includes(obj.pattern)) {
      result.pattern = obj.pattern as OpPattern;
    } else if ((LEGACY_OP_PATTERNS as readonly string[]).includes(obj.pattern)) {
      result.pattern = "highlight_teaser";
    }
  }
  result.decoration = normalizeOpDecoration(obj.decoration);
  result.text_animation = normalizeOpTextAnimation(obj.text_animation);
  // W13-3: プレースホルダ的文言(「タイトルテキスト」等)は空扱いに正規化する
  if (typeof obj.title === "string") result.title = normalizeOpUserText(obj.title);
  result.title_enabled = obj.title_enabled !== false;
  const catchCopy = obj.catch_copy !== undefined ? obj.catch_copy : obj.catchCopy;
  if (typeof catchCopy === "string") result.catch_copy = normalizeOpUserText(catchCopy);
  return result;
}

/** OPパターンの表示名・説明・目安尺(選択カードに使う。尺は op_patterns.yaml と同期)。 */
export const OP_PATTERN_INFO: Record<
  OpPattern,
  { label: string; description: string; durationLabel: string }
> = {
  none: { label: "OPなし", description: "従来どおり本編から始める", durationLabel: "" },
  highlight_teaser: {
    label: "ハイライト予告",
    description: "見どころをフックワード付きで畳みかけ→タイトル被せ",
    durationLabel: "10〜15秒",
  },
};

/** フェーズV5: 装飾パターンの表示名・説明(ミニプレビューカードの見出しに使う)。 */
export const OP_DECORATION_INFO: Record<
  OpDecoration,
  { label: string; description: string }
> = {
  flash_pop: { label: "フラッシュ", description: "白フラッシュつなぎ+終端タイトル(現行)" },
  cinema_bars: { label: "シネマ帯", description: "上下黒帯+OPENING+クリップ番号" },
  color_wipe: { label: "カラーワイプ", description: "アクセント色の斜めワイプ+下部バー常駐" },
  neon_frame: { label: "ネオン枠", description: "縁ネオン+ズームイン転換(ゲーム向き)" },
};

/** フェーズV5: OPテロップ登場アニメの表示名。 */
export const OP_TEXT_ANIMATION_INFO: Record<OpTextAnimation, { label: string; description: string }> = {
  slide_left: { label: "横スライド", description: "左から流れ込む(既定)" },
  slide_up: { label: "下から", description: "下からスッと上がる" },
  stamp: { label: "スタンプ", description: "ドンと押される勢い重視" },
};
