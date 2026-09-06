// 実行時(値)importのため、node --experimental-strip-types でテストを直接実行できるよう拡張子を明示する。
import type { TelopStyleDef, TelopStroke } from "./telopThemes.ts";

/**
 * フェーズU6(テロップスタイル詳細エディタ)の純関数層。
 *
 * TelopStyleDef(yaml/Remotionと同一形状)は「drop_shadowがCSS文字列」「色にrgba/#RRGGBBAAが混在」
 * などUIフォームでそのまま扱いにくいため、スライダ・カラーピッカー向けのフラットな
 * TelopStyleFormState と相互変換する。変換はロスレスを目指すが、drop_shadowの多重
 * drop-shadow文字列(game系のグロウ手書き等)は先頭1個のみをフォームに載せ、残りは
 * 保持フィールド(dropShadowExtra)経由で復元する(編集で壊さないため)。
 */

// =============================================================================
// 色ヘルパー: #RRGGBB / #RGB / #RRGGBBAA / rgba() を「hex + 不透明度」に分解して扱う
// (<input type="color"> は#RRGGBBしか受けないため)
// =============================================================================

export type ColorParts = { hex: string; opacity: number };

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

function channelHex(value: number): string {
  return Math.min(255, Math.max(0, Math.round(value))).toString(16).padStart(2, "0");
}

/** 任意のCSS色文字列を {hex(#rrggbb), opacity(0-1)} へ分解する(解釈不能は白)。 */
export function parseColor(raw: string | null | undefined, fallbackHex = "#ffffff"): ColorParts {
  const value = String(raw || "").trim();
  if (!value) return { hex: fallbackHex, opacity: 1 };
  const hexMatch = /^#([0-9a-fA-F]{3,8})$/.exec(value);
  if (hexMatch) {
    const digits = hexMatch[1];
    if (digits.length === 3 || digits.length === 4) {
      const [r, g, b, a] = digits.split("");
      return {
        hex: `#${r}${r}${g}${g}${b}${b}`.toLowerCase(),
        opacity: a !== undefined ? clamp01(parseInt(`${a}${a}`, 16) / 255) : 1,
      };
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        hex: `#${digits.slice(0, 6)}`.toLowerCase(),
        opacity: digits.length === 8 ? clamp01(parseInt(digits.slice(6, 8), 16) / 255) : 1,
      };
    }
    return { hex: fallbackHex, opacity: 1 };
  }
  const rgbaMatch = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(value);
  if (rgbaMatch) {
    const [, r, g, b, a] = rgbaMatch;
    return {
      hex: `#${channelHex(Number(r))}${channelHex(Number(g))}${channelHex(Number(b))}`,
      opacity: a !== undefined ? clamp01(Number(a)) : 1,
    };
  }
  return { hex: fallbackHex, opacity: 1 };
}

/** {hex, opacity} をCSS色文字列へ戻す(不透明なら#RRGGBBのまま=yamlの既存表記と揃える)。 */
export function composeColor(hex: string, opacity: number): string {
  const parts = parseColor(hex);
  const alpha = clamp01(opacity);
  if (alpha >= 0.999) return parts.hex;
  const r = parseInt(parts.hex.slice(1, 3), 16);
  const g = parseInt(parts.hex.slice(3, 5), 16);
  const b = parseInt(parts.hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${Math.round(alpha * 100) / 100})`;
}

// =============================================================================
// drop_shadow文字列 ⇔ フォーム値(ぼかし・距離・角度・色)
// =============================================================================

export type DropShadowForm = {
  enabled: boolean;
  blur: number;
  /** 影のオフセット距離(px)。角度と合わせて x/y を導出する。 */
  distance: number;
  /** 角度(度)。0=右、90=下(CSS座標系)。 */
  angle: number;
  colorHex: string;
  colorOpacity: number;
  /** 2個目以降のdrop-shadow(…)をそのまま保持する(game系グロウ手書き等を編集で壊さない)。 */
  extra: string;
};

const DEFAULT_DROP_SHADOW_FORM: DropShadowForm = {
  enabled: false,
  blur: 6,
  distance: 4,
  angle: 90,
  colorHex: "#000000",
  colorOpacity: 0.4,
  extra: "",
};

/** "drop-shadow(2px 4px 6px rgba(0,0,0,0.4)) drop-shadow(...)" をフォーム値へ分解する。 */
export function parseDropShadow(raw: string | null | undefined): DropShadowForm {
  const value = String(raw || "").trim();
  if (!value) return { ...DEFAULT_DROP_SHADOW_FORM };
  const shadows = value.match(/drop-shadow\((?:[^()]|\([^()]*\))*\)/g) || [];
  const first = shadows[0];
  if (!first) return { ...DEFAULT_DROP_SHADOW_FORM };
  const inner = first.slice("drop-shadow(".length, -1).trim();
  // "Xpx Ypx [Bpx] color" 形式(colorはrgba()を含みうるので後方から取らず前方3値を読む)
  const numMatch = /^(-?[\d.]+)px\s+(-?[\d.]+)px(?:\s+(-?[\d.]+)px)?\s+(.+)$/.exec(inner);
  if (!numMatch) return { ...DEFAULT_DROP_SHADOW_FORM, enabled: true, extra: shadows.slice(1).join(" ") };
  const x = Number(numMatch[1]);
  const y = Number(numMatch[2]);
  const blur = numMatch[3] !== undefined ? Number(numMatch[3]) : 0;
  const color = parseColor(numMatch[4], "#000000");
  const distance = Math.round(Math.hypot(x, y) * 100) / 100;
  const angle = distance > 0 ? Math.round((Math.atan2(y, x) * 180) / Math.PI) : 90;
  return {
    enabled: true,
    blur,
    distance,
    angle: angle < 0 ? angle + 360 : angle,
    colorHex: color.hex,
    colorOpacity: color.opacity,
    extra: shadows.slice(1).join(" "),
  };
}

/** フォーム値を drop_shadow 文字列へ戻す(無効かつextraなしは null)。 */
export function buildDropShadow(form: DropShadowForm): string | null {
  const parts: string[] = [];
  if (form.enabled) {
    const rad = (form.angle * Math.PI) / 180;
    const x = Math.round(Math.cos(rad) * form.distance * 100) / 100;
    const y = Math.round(Math.sin(rad) * form.distance * 100) / 100;
    const color = composeColor(form.colorHex, form.colorOpacity);
    parts.push(`drop-shadow(${x}px ${y}px ${form.blur}px ${color})`);
  }
  if (form.extra.trim()) parts.push(form.extra.trim());
  return parts.length ? parts.join(" ") : null;
}

// =============================================================================
// フォーム状態(TelopStyleFormState) ⇔ TelopStyleDef
// =============================================================================

export type StrokeForm = { enabled: boolean; colorHex: string; width: number };

export type BackgroundMode = "none" | "band" | "box";

export type TelopStyleFormState = {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  /** 字間(em数値)。"0.02em" ⇔ 0.02。 */
  letterSpacing: number;
  lineHeight: number;
  fillMode: "solid" | "gradient";
  fillColorHex: string;
  fillOpacity: number;
  gradientFrom: string;
  gradientTo: string;
  gradientDirection: "vertical" | "horizontal" | "diagonal";
  /** 縁3段: [0]=第1(inner) / [1]=第2(outer) / [2]=第3(outer2=最背面の太枠)。 */
  strokes: [StrokeForm, StrokeForm, StrokeForm];
  dropShadow: DropShadowForm;
  glowEnabled: boolean;
  glowColorHex: string;
  glowRadius: number;
  hardShadowEnabled: boolean;
  hardShadowX: number;
  hardShadowY: number;
  hardShadowColorHex: string;
  backgroundMode: BackgroundMode;
  backgroundColorHex: string;
  backgroundOpacity: number;
  backgroundPaddingX: number;
  backgroundPaddingY: number;
  backgroundRadius: number;
  yPositionOffset: number;
  highlightColorHex: string;
  highlightEnabled: boolean;
  /** 助詞縮小率(1=無効)。 */
  particleScale: number;
  /** 欧文フォント(""=既定Anton、"none"=無効)。 */
  latinFontFamily: string;
  /** 登場アニメ(""=プリセット既定)。 */
  animationIn: string;
  /** 効果音(""=既定、"none"=鳴らさない)。 */
  sfx: string;
  /** 変換で表現できないフィールド(underline/animation_out等)を保持して復元する。 */
  passthrough: Partial<TelopStyleDef>;
};

const DEFAULT_STROKE_COLORS = ["#ffffff", "#1e3a5f", "#000000"];

function strokeToForm(stroke: TelopStroke | null | undefined, slot: number): StrokeForm {
  if (!stroke) return { enabled: false, colorHex: DEFAULT_STROKE_COLORS[slot] ?? "#000000", width: slot === 0 ? 8 : slot === 1 ? 16 : 26 };
  return { enabled: true, colorHex: parseColor(stroke.color, "#000000").hex, width: stroke.width };
}

function formToStroke(form: StrokeForm): TelopStroke | null {
  if (!form.enabled || form.width <= 0) return null;
  return { color: form.colorHex, width: Math.round(form.width * 10) / 10 };
}

/** TelopStyleDef → フォーム状態。エディタを開くとき・プリセット読み込み時に使う。 */
export function styleDefToFormState(def: TelopStyleDef): TelopStyleFormState {
  const fill = def.fill || { type: "solid" as const, color: "#ffffff" };
  const fillColor = parseColor(fill.color, "#ffffff");
  const letterSpacingMatch = /^(-?[\d.]+)em$/.exec(String(def.letter_spacing || "").trim());
  const background = def.background || null;
  const backgroundColor = parseColor(background?.color, "#000000");
  // padding_x/padding_y指定=文字ブロック全体のボックス(box_yellow等)、無指定=行帯(band)
  const backgroundMode: BackgroundMode = !background
    ? "none"
    : background.padding_x !== undefined || background.padding_y !== undefined
      ? "box"
      : "band";
  const glow = def.glow || null;
  const hardShadow = def.shadow_offset || null;
  // underline等、フォームUIを持たないフィールドは保持して formStateToStyleDef で復元する
  const passthrough: Partial<TelopStyleDef> = {};
  if (def.underline !== undefined) passthrough.underline = def.underline;
  if (def.animation_out !== undefined) passthrough.animation_out = def.animation_out;
  if (def.animation_duration_frames !== undefined) {
    passthrough.animation_duration_frames = def.animation_duration_frames;
  }
  if (def.description !== undefined) passthrough.description = def.description;
  if (background?.borderRadius !== undefined) {
    passthrough.background = { color: "", borderRadius: background.borderRadius };
  }
  return {
    fontFamily: def.font_family || "",
    fontSize: def.font_size ?? 72,
    fontWeight: def.font_weight ?? 900,
    letterSpacing: letterSpacingMatch ? Number(letterSpacingMatch[1]) : 0.02,
    lineHeight: def.line_height ?? 1.4,
    fillMode: fill.type === "gradient" ? "gradient" : "solid",
    fillColorHex: fillColor.hex,
    fillOpacity: fillColor.opacity,
    gradientFrom: parseColor(fill.gradient_from, "#7bb8dc").hex,
    gradientTo: parseColor(fill.gradient_to, "#1e5da8").hex,
    gradientDirection: fill.gradient_direction || "vertical",
    strokes: [strokeToForm(def.inner_stroke, 0), strokeToForm(def.outer_stroke, 1), strokeToForm(def.outer_stroke2, 2)],
    dropShadow: parseDropShadow(def.drop_shadow),
    glowEnabled: Boolean(glow),
    glowColorHex: parseColor(glow?.color, "#00e5ff").hex,
    glowRadius: glow?.radius ?? 12,
    hardShadowEnabled: Boolean(hardShadow),
    hardShadowX: hardShadow?.x ?? 6,
    hardShadowY: hardShadow?.y ?? 6,
    hardShadowColorHex: parseColor(hardShadow?.color, "#000000").hex,
    backgroundMode,
    backgroundColorHex: backgroundColor.hex,
    backgroundOpacity: background ? backgroundColor.opacity : 0.85,
    backgroundPaddingX: background?.padding_x ?? 48,
    backgroundPaddingY: background?.padding_y ?? 20,
    backgroundRadius: background?.border_radius ?? 0,
    yPositionOffset: def.y_position_offset ?? 0,
    highlightEnabled: Boolean(def.highlight_color),
    highlightColorHex: parseColor(def.highlight_color, "#ffdd00").hex,
    particleScale: def.particle_scale ?? 0.8,
    latinFontFamily: def.latin_font_family === null ? "none" : def.latin_font_family || "",
    animationIn: def.animation_in || "",
    sfx: def.sfx === null ? "none" : def.sfx || "",
    passthrough,
  };
}

/** フォーム状態 → TelopStyleDef。プレビュー即時反映・保存時に使う。 */
export function formStateToStyleDef(form: TelopStyleFormState): TelopStyleDef {
  const def: TelopStyleDef = {
    ...form.passthrough,
    font_family: form.fontFamily || undefined,
    font_size: form.fontSize,
    font_weight: form.fontWeight,
    letter_spacing: `${Math.round(form.letterSpacing * 1000) / 1000}em`,
    line_height: Math.round(form.lineHeight * 100) / 100,
    fill:
      form.fillMode === "gradient"
        ? {
            type: "gradient",
            gradient_from: form.gradientFrom,
            gradient_to: form.gradientTo,
            gradient_direction: form.gradientDirection,
          }
        : { type: "solid", color: composeColor(form.fillColorHex, form.fillOpacity) },
    inner_stroke: formToStroke(form.strokes[0]),
    outer_stroke: formToStroke(form.strokes[1]),
    outer_stroke2: formToStroke(form.strokes[2]),
    drop_shadow: buildDropShadow(form.dropShadow),
    glow: form.glowEnabled && form.glowRadius > 0 ? { color: form.glowColorHex, radius: Math.round(form.glowRadius) } : null,
    shadow_offset: form.hardShadowEnabled
      ? { x: Math.round(form.hardShadowX), y: Math.round(form.hardShadowY), color: form.hardShadowColorHex }
      : null,
    y_position_offset: form.yPositionOffset,
  };
  if (form.backgroundMode !== "none") {
    def.background = {
      color: composeColor(form.backgroundColorHex, form.backgroundOpacity),
      ...(form.backgroundMode === "box"
        ? {
            padding_x: Math.round(form.backgroundPaddingX),
            padding_y: Math.round(form.backgroundPaddingY),
            border_radius: Math.round(form.backgroundRadius),
          }
        : {}),
      ...(form.passthrough.background?.borderRadius !== undefined
        ? { borderRadius: form.passthrough.background.borderRadius }
        : {}),
    };
  } else {
    def.background = null;
  }
  if (form.highlightEnabled) def.highlight_color = form.highlightColorHex;
  if (Math.abs(form.particleScale - 0.8) > 1e-6) def.particle_scale = form.particleScale;
  if (form.latinFontFamily === "none") {
    def.latin_font_family = null;
  } else if (form.latinFontFamily) {
    def.latin_font_family = form.latinFontFamily;
  }
  if (form.animationIn) def.animation_in = form.animationIn;
  if (form.sfx === "none") {
    def.sfx = null;
  } else if (form.sfx) {
    def.sfx = form.sfx;
  }
  return def;
}

// =============================================================================
// カスタムスタイルID生成・マージ
// =============================================================================

/** IDに使える形へ正規化する(英数字とアンダースコアのみ)。 */
function slugify(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
}

/**
 * テーマ×semantic typeのカスタムスタイルID。同じテーマ×typeへの再保存は同じIDで
 * 上書きされる(定義の増殖を防ぎ、type_stylesの参照が安定する)。
 */
export function customThemeStyleId(themeId: string, semanticType: string): string {
  const theme = slugify(themeId) || "theme";
  const type = slugify(semanticType) || "default";
  return `custom_${theme}_${type}`;
}

/** シーン個別カスタムスタイルID(シーンごとに一意。同じシーンへの再保存は上書き)。 */
export function customSceneStyleId(sceneId: string): string {
  const scene = slugify(sceneId) || "scene";
  return `custom_scene_${scene}`;
}

export function isCustomStyleId(styleId: string | null | undefined): boolean {
  return typeof styleId === "string" && styleId.startsWith("custom_");
}

/** custom_styles 辞書のマージ(後勝ち)。null/undefinedは無視する。 */
export function mergeCustomStyles(
  ...maps: Array<Record<string, TelopStyleDef> | null | undefined>
): Record<string, TelopStyleDef> {
  const result: Record<string, TelopStyleDef> = {};
  for (const map of maps) {
    if (!map) continue;
    for (const [id, def] of Object.entries(map)) {
      if (id && def && typeof def === "object" && def.fill) result[id] = def;
    }
  }
  return result;
}

// =============================================================================
// フォント選択肢(remotion/src/Root.tsx で読み込むフォントと同期)
// =============================================================================

export type FontOption = {
  label: string;
  /** CSSのfont-familyスタック(フォールバック込み。プリセットの表記と揃える)。 */
  family: string;
};

/**
 * remotion/src/Root.tsx(Google Fonts+ローカルOTF/TTF)とdesktop styles.cssの@importで
 * 両方に読み込まれているフォントのみを列挙する(片側にしか無いフォントを選ぶと
 * プレビューと書き出しで見た目が変わるため)。
 */
export const FONT_OPTIONS: FontOption[] = [
  { label: "Zen角ゴシック", family: '"Zen Kaku Gothic Antique", "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Meiryo", sans-serif' },
  { label: "Noto Sans JP", family: '"Noto Sans JP", "Hiragino Sans", "Meiryo", sans-serif' },
  { label: "BIZ UDPゴシック", family: '"BIZ UDPGothic", "Hiragino Sans", "Meiryo", sans-serif' },
  { label: "Zen丸ゴシック", family: '"Zen Maru Gothic", "Hiragino Maru Gothic ProN", "Meiryo", sans-serif' },
  { label: "M PLUS Rounded", family: '"M PLUS Rounded 1c", "Hiragino Maru Gothic ProN", "Meiryo", sans-serif' },
  { label: "デラゴシック", family: '"Dela Gothic One", "Zen Kaku Gothic Antique", "Hiragino Sans", sans-serif' },
  { label: "源暎ゴシック極太", family: '"GenEi Gothic N U-KL", "Zen Kaku Gothic Antique", "Hiragino Sans", sans-serif' },
  { label: "源暎ゴシック太", family: '"GenEi Gothic N H-KL", "Zen Kaku Gothic Antique", "Hiragino Sans", sans-serif' },
  { label: "源暎きわみゴ", family: '"GenEi Kiwami Go", "Zen Kaku Gothic Antique", "Hiragino Sans", sans-serif' },
  { label: "源暎ぽっぷる", family: '"GenEi POPle Bk", "Zen Maru Gothic", "Hiragino Maru Gothic ProN", sans-serif' },
  { label: "けいふぉんと", family: '"Keifont", "Zen Maru Gothic", "Hiragino Maru Gothic ProN", sans-serif' },
  { label: "ラノベPOP", family: '"LanobePOP", "Zen Maru Gothic", "Hiragino Maru Gothic ProN", sans-serif' },
  { label: "もちいポップ", family: '"Mochiy Pop One", "Zen Maru Gothic", "Hiragino Maru Gothic ProN", sans-serif' },
  { label: "コスギ丸", family: '"Kosugi Maru", "Hiragino Maru Gothic ProN", "Meiryo", sans-serif' },
  { label: "ロックンロール", family: '"RocknRoll One", "Zen Kaku Gothic Antique", "Hiragino Sans", sans-serif' },
  { label: "クレー", family: '"Klee One", "Hiragino Maru Gothic ProN", "Meiryo", sans-serif' },
  { label: "しっぽり明朝", family: '"Shippori Mincho", "Hiragino Mincho ProN", "Yu Mincho", serif' },
  { label: "しっぽり明朝B1", family: '"Shippori Mincho B1", "Hiragino Mincho ProN", "Yu Mincho", serif' },
  { label: "Noto Serif JP", family: '"Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", serif' },
  { label: "ひな明朝", family: '"Hina Mincho", "Hiragino Mincho ProN", "Yu Mincho", serif' },
  { label: "游字シュク(筆)", family: '"Yuji Syuku", "Hiragino Mincho ProN", serif' },
  { label: "レゲエ", family: '"Reggae One", "Zen Kaku Gothic Antique", "Hiragino Sans", sans-serif' },
  { label: "トレイン", family: '"Train One", "Zen Kaku Gothic Antique", "Hiragino Sans", sans-serif' },
  { label: "ドットゴシック", family: '"DotGothic16", "Osaka-Mono", monospace' },
];

/**
 * スタイルのfont_familyスタックからFONT_OPTIONSの該当項目を探す(先頭ファミリー一致)。
 * プリセット由来の微妙に違うフォールバック表記でもドロップダウンが正しく選択されるようにする。
 */
export function matchFontOption(fontFamily: string | null | undefined): FontOption | null {
  const first = String(fontFamily || "").split(",")[0]?.trim().replace(/^["']|["']$/g, "");
  if (!first) return null;
  return (
    FONT_OPTIONS.find((option) => {
      const optionFirst = option.family.split(",")[0]?.trim().replace(/^["']|["']$/g, "");
      return optionFirst === first;
    }) ?? null
  );
}

/** 欧文フォントの選択肢(和欧混植)。 */
export const LATIN_FONT_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "", label: "既定(Anton)" },
  { id: "none", label: "無効(和文フォントのまま)" },
  { id: '"Bebas Neue", Anton, sans-serif', label: "Bebas Neue" },
  { id: '"Caveat", cursive', label: "Caveat(手書き)" },
];
