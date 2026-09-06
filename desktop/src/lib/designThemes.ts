// 実行時(値)importのため、node --experimental-strip-types でテストを直接実行できるよう拡張子を明示する。
import {
  DEFAULT_TYPE_MAPPING,
  sanitizeTypeMapping,
  type SemanticType,
  type TelopTypeMapping,
} from "./telopTypes.ts";
import type { TelopStyleDef } from "./telopThemes.ts";
import {
  sanitizeOverlayTitle,
  sanitizeOpConfig,
  sanitizeVideoEffects,
  type OverlayTitleConfig,
  type OpConfig,
  type VideoEffectsConfig,
} from "./designExtras.ts";
import { sanitizeSpeakerColors, type SpeakerColorsConfig } from "./speakerColors.ts";

/**
 * フェーズU2(起動フロー=テロップデザイン選択)のUI側純関数。
 *
 * - 使用シーン(design scene): templates/design_scenes.yaml が定義する初期テンプレート4種。
 *   「新規作成」の出発点としてのみ使い、ユーザーデータには含めない。
 * - デザインテーマ(design theme): ユーザーが名前をつけて保存した type→preset マッピング一式
 *   (userData/design_themes.json)。開始時にアクティブテーマの type_styles が
 *   実行時マッピングとして telop_type_mapping 経路へ流し込まれる。
 * - 「スタンダード」= テーマ未選択(activeDesignThemeId が空)の既定状態。
 *   従来の「既定YAML+userData上書き」マッピングがそのまま使われ、既存runと後方互換。
 */

/** テーマ未選択(スタンダード=既定マッピング)を表すID。settings.activeDesignThemeId の空文字と対応。 */
export const STANDARD_DESIGN_THEME_ID = "";

export type DesignScene = {
  id: string;
  label: string;
  description: string;
  typeStyles: TelopTypeMapping;
  /** フェーズU7: ジャンルごとのシーンタイトル既定(新規テーマ作成の初期値)。 */
  overlayTitle: OverlayTitleConfig;
  /** フェーズV2: ジャンルごとのOP既定パターン(新規テーマ作成の初期値)。 */
  op: OpConfig;
};

export type DesignTheme = {
  id: string;
  name: string;
  /** 作成時に出発点にした使用シーンID(表示用。空文字=不明/スタンダード起点)。 */
  baseScene: string;
  typeStyles: TelopTypeMapping;
  /** フェーズU6: テーマ専属カスタムプリセット(custom_* ID → 定義)。type_stylesから参照される。 */
  customStyles: Record<string, TelopStyleDef>;
  /** フェーズU7: シーンタイトル(chapter_title)設定。 */
  overlayTitle: OverlayTitleConfig;
  /** フェーズU8: OP(オープニング)設定。 */
  op: OpConfig;
  /** フェーズW1: 話者カラー設定(旧テーマは既定=有効で補完される)。 */
  speakerColors: SpeakerColorsConfig;
  /** フェーズW2: シーン映像ギミック設定(旧テーマは既定=両方ONで補完される)。 */
  videoEffects: VideoEffectsConfig;
  createdAt: string;
  updatedAt: string;
};

/**
 * フェーズU6: カスタムスタイル定義群を検証する(main側 sanitizeCustomStyles と同じ規則:
 * 辞書かつfillを持つエントリのみ残す)。IPC経由の生JSONをUIの型へ安全に載せるための境界検証。
 */
export function sanitizeCustomStyleMap(raw: unknown): Record<string, TelopStyleDef> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, TelopStyleDef> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const styleId = String(key || "").trim();
    if (!styleId || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const def = value as TelopStyleDef;
    if (!def.fill || typeof def.fill !== "object") continue;
    result[styleId] = def;
  }
  return result;
}

/**
 * IPC design-scenes:list の生データを正規化する。
 * id/label が無いエントリは捨て、type_styles は既定マッピングで補完した完全形にする
 * (yamlの欠落・不正値があってもUIが必ず全typeを描画できるようにするため)。
 */
export function sanitizeDesignScenes(raw: unknown): DesignScene[] {
  if (!Array.isArray(raw)) return [];
  const scenes: DesignScene[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const source = item as Record<string, unknown>;
    const id = typeof source.id === "string" ? source.id.trim() : "";
    const label = typeof source.label === "string" ? source.label.trim() : "";
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    scenes.push({
      id,
      label,
      description: typeof source.description === "string" ? source.description.trim() : "",
      typeStyles: sanitizeTypeMapping(source.type_styles ?? source.typeStyles),
      overlayTitle: sanitizeOverlayTitle(source.overlay_title ?? source.overlayTitle),
      op: sanitizeOpConfig(source.op),
    });
  }
  return scenes;
}

/**
 * IPC design-themes:list / userData design_themes.json の生テーマ配列を正規化する。
 * id/name が無いものは捨てる(削除済み・壊れたエントリでUIが落ちないようにする)。
 */
export function sanitizeDesignThemes(raw: unknown): DesignTheme[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { themes?: unknown[] }).themes)
      ? (raw as { themes: unknown[] }).themes
      : [];
  const themes: DesignTheme[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const source = item as Record<string, unknown>;
    const id = typeof source.id === "string" ? source.id.trim() : "";
    const name = typeof source.name === "string" ? source.name.trim() : "";
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    themes.push({
      id,
      name,
      baseScene: typeof source.base_scene === "string" ? source.base_scene : typeof source.baseScene === "string" ? source.baseScene : "",
      typeStyles: sanitizeTypeMapping(source.type_styles ?? source.typeStyles),
      customStyles: sanitizeCustomStyleMap(source.custom_styles ?? source.customStyles),
      overlayTitle: sanitizeOverlayTitle(source.overlay_title ?? source.overlayTitle),
      op: sanitizeOpConfig(source.op),
      speakerColors: sanitizeSpeakerColors(source.speaker_colors ?? source.speakerColors),
      videoEffects: sanitizeVideoEffects(source.video_effects ?? source.videoEffects),
      createdAt: typeof source.created_at === "string" ? source.created_at : "",
      updatedAt: typeof source.updated_at === "string" ? source.updated_at : "",
    });
  }
  return themes;
}

export function findDesignTheme(themes: DesignTheme[], themeId: string | null | undefined): DesignTheme | null {
  if (!themeId) return null;
  return themes.find((theme) => theme.id === themeId) ?? null;
}

/**
 * アクティブテーマIDを実在するテーマへ解決する。
 * 削除済みIDが settings に残っていてもスタンダードへ安全にフォールバックする。
 */
export function resolveActiveDesignThemeId(themes: DesignTheme[], storedId: string | null | undefined): string {
  return findDesignTheme(themes, storedId) ? (storedId as string) : STANDARD_DESIGN_THEME_ID;
}

/** ミニプレビューに使う代表3種(説明・強調・質問)と短い見本テキスト。 */
export const DESIGN_SWATCH_SAMPLES: ReadonlyArray<{ type: SemanticType; text: string }> = [
  { type: "default", text: "説明" },
  { type: "emphasis", text: "強調!" },
  { type: "question", text: "質問?" },
];

export type DesignSwatchEntry = {
  type: SemanticType;
  text: string;
  styleId: string;
};

/**
 * マッピングから代表3種のスウォッチ(見本テキスト+プリセットID)を導出する。
 * プリセットの実スタイル解決(getPresetStyle)は描画側の責務(カタログ未読込時のフォールバックのため)。
 */
export function designSwatchEntries(mapping: Partial<TelopTypeMapping> | null | undefined): DesignSwatchEntry[] {
  const full = sanitizeTypeMapping(mapping ?? {});
  return DESIGN_SWATCH_SAMPLES.map(({ type, text }) => ({
    type,
    text,
    styleId: full[type].style,
  }));
}

/** スタンダード(既定マッピング)のスウォッチ。テーマ未保存時の先頭カードに使う。 */
export function standardSwatchEntries(currentMapping?: Partial<TelopTypeMapping> | null): DesignSwatchEntry[] {
  return designSwatchEntries(currentMapping ?? DEFAULT_TYPE_MAPPING);
}

/** design-themes:save へ渡す保存入力(新規は id 省略、上書きは id 指定)。 */
export type DesignThemeSaveInput = {
  id?: string;
  name: string;
  baseScene: string;
  typeStyles: TelopTypeMapping;
  /** フェーズU6: 省略時はmain側が既存テーマのcustom_stylesを維持する。 */
  customStyles?: Record<string, TelopStyleDef>;
  /** フェーズU7: 省略時はmain側が既存テーマのoverlay_titleを維持する。 */
  overlayTitle?: OverlayTitleConfig;
  /** フェーズU8: 省略時はmain側が既存テーマのopを維持する。 */
  op?: OpConfig;
  /** フェーズW1: 省略時はmain側が既存テーマのspeaker_colorsを維持する。 */
  speakerColors?: SpeakerColorsConfig;
  /** フェーズW2: 省略時はmain側が既存テーマのvideo_effectsを維持する。 */
  videoEffects?: VideoEffectsConfig;
};

/** テーマ名の検証(空・空白のみは不可)。保存ボタンの活性判定に使う。 */
export function isValidThemeName(name: string): boolean {
  return name.trim().length > 0;
}
