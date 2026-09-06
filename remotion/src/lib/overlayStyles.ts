// フェーズU1-5(プレビュー忠実化): オーバーレイ4種+captionの「見た目の数値・配色・フォント」を
// React/Remotionに依存しない純関数として切り出す。Remotion(Overlays.tsx)とデスクトップの
// プレビュー(PreviewOverlays.tsx)が同じ定義を使うことで、プレビュー≒書き出しMP4を担保する。
// このファイルは desktop/src/lib/overlayStyles.ts へ完全コピーされ、ファイル一致テスト
// (telopTypography方式)で同期が保証される。片方を変更したら必ずもう片方へコピーすること。
//
// サイズは動画高さ1080px基準のデザイン値で、呼び出し側が scale = 表示高さ/1080 を渡す。

import type { OverlayItem, OverlayPosition, OverlayType } from "./overlayItems.ts";
import { buildGlowFilter } from "./telopGlow.ts";

// React.CSSProperties と互換の形(React非依存でnodeテスト可能にするため自前定義)。
export type OverlayCssProperties = Record<string, string | number | undefined>;

export const OVERLAY_GOTHIC_FONT_FAMILY =
  '"Zen Kaku Gothic Antique", "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Meiryo", sans-serif';
// 章見出しは参考動画に合わせてセリフ系太字(op_brushと同じ暫定代替)
export const OVERLAY_MINCHO_FONT_FAMILY =
  '"Hiragino Mincho ProN", "Hiragino Mincho Pro", "Yu Mincho", serif';

// フェーズV8-3: profile_card の下端オフセット(1080p基準px)。
// 本編テロップ帯は telop_y=0.85 付近(2行・font 72で概ね y=820〜1010px)に出るため、
// 従来の bottom:44px ではカードがテロップ帯に重なっていた。テロップ帯より上に
// 固定マージンで逃がす(帯上端820pxに対しカード高さ約120px+余白を確保できる300px)。
export const PROFILE_CARD_BOTTOM_PX = 300;

// フェーズW3: cta_banner の下端オフセット(1080p基準px)。
// 従来の bottom:52px はテロップ帯(y=820〜1010px)の真上に乗り、CTAテロップと
// 黄色ボックスが2枚重なって見えた(「バナー2重」実データFB 20260707_194708)。
// profile_card と同じ考え方でテロップ帯上端(820px)より上へ逃がす
// (バナー高さ約100〜180pxを帯上端との間に確保できる290px)。
export const CTA_BANNER_BOTTOM_PX = 290;

/** position ごとの配置ラッパースタイル(絶対配置レイヤー内での置き場所)。
 * V8-3: type を渡すと profile_card だけ bottom_left の下端を引き上げる
 * (テロップ帯との重なり回避)。type省略時は従来の配置(後方互換)。
 * W3: cta_banner も同様に bottom の下端をテロップ帯より上へ引き上げる。 */
export function overlayPositionStyle(
  position: OverlayPosition,
  scale: number,
  type?: OverlayType,
): OverlayCssProperties {
  const base: OverlayCssProperties = { position: "absolute", display: "flex" };
  switch (position) {
    case "top_left":
      return { ...base, top: 28 * scale, left: 36 * scale };
    case "bottom_left":
      return {
        ...base,
        bottom: (type === "profile_card" ? PROFILE_CARD_BOTTOM_PX : 44) * scale,
        left: 44 * scale,
      };
    case "center":
      return { ...base, top: 0, right: 0, bottom: 0, left: 0, justifyContent: "center", alignItems: "center" };
    case "bottom":
      return {
        ...base,
        bottom: (type === "cta_banner" ? CTA_BANNER_BOTTOM_PX : 52) * scale,
        left: 0,
        right: 0,
        justifyContent: "center",
      };
  }
}

/** 縁取りテキスト(StrokeText)の1描画分の指定。 */
export type OverlayStrokeTextSpec = {
  fontSize: number;
  fontFamily: string;
  fontWeight: number;
  fillColor: string;
  strokeColor: string;
  strokeWidth: number;
};

/** テキスト系オーバーレイの色・フォントの既定値。style指定(preset参照)があれば上書きされる。 */
export type OverlayTextDefaults = { fontFamily: string; fillColor: string; strokeColor: string };

/** overlay の style 参照解決に必要な最小限のプリセット形(Remotion TelopStyle のサブセット)。 */
export type OverlayPresetLike = {
  font_family?: string;
  fill: { type: "solid" | "gradient"; color?: string };
  inner_stroke?: { color: string; width: number } | null;
  outer_stroke?: { color: string; width: number } | null;
};

/** style指定(overlay用preset参照)からテキスト系オーバーレイの色・フォントを上書きする。 */
export function resolveOverlayTextStyle(
  item: Pick<OverlayItem, "style">,
  styles: Record<string, OverlayPresetLike | undefined> | undefined,
  defaults: OverlayTextDefaults,
): OverlayTextDefaults {
  const preset = item.style ? styles?.[item.style] : undefined;
  if (!preset) return defaults;
  return {
    fontFamily: preset.font_family ?? defaults.fontFamily,
    fillColor: preset.fill.type === "solid" ? (preset.fill.color ?? defaults.fillColor) : defaults.fillColor,
    strokeColor: preset.outer_stroke?.color ?? preset.inner_stroke?.color ?? defaults.strokeColor,
  };
}

/** chapter_title: 左上・黒文字+白太縁の章見出し(参考画像05)。 */
export const CHAPTER_TITLE_DEFAULTS: OverlayTextDefaults = {
  fontFamily: OVERLAY_MINCHO_FONT_FAMILY,
  fillColor: "#111111",
  strokeColor: "#FFFFFF",
};

export const CHAPTER_TITLE_FILTER = "drop-shadow(0px 3px 5px rgba(0,0,0,0.5))";

export function chapterTitleTextSpec(scale: number, resolved: OverlayTextDefaults): OverlayStrokeTextSpec {
  return {
    fontSize: 46 * scale,
    fontFamily: resolved.fontFamily,
    fontWeight: 800,
    fillColor: resolved.fillColor,
    strokeColor: resolved.strokeColor,
    strokeWidth: 9 * scale,
  };
}

// =============================================================================
// フェーズU7: シーンタイトル(chapter_title)の描画パターン
// =============================================================================
//
// overlay の style フィールドがパターンIDを指す(box_accent / band_gradient / tag_ribbon /
// minimal_line / neon_plate)。style無し・未知の値は box_accent(=U7以前の現行デザイン)に
// フォールバックし、既存run・既存compositionの見た目を一切変えない(後方互換)。
// 配色はパターン固有の固定パレット(ジャンル既定は design_scenes.yaml が選ぶ)。

export const CHAPTER_TITLE_PATTERNS = [
  "box_accent",
  "band_gradient",
  "tag_ribbon",
  "minimal_line",
  "neon_plate",
] as const;

export type ChapterTitlePattern = (typeof CHAPTER_TITLE_PATTERNS)[number];

export const DEFAULT_CHAPTER_TITLE_PATTERN: ChapterTitlePattern = "box_accent";

/** overlay.style をパターンIDへ解決する(未知・欠落は box_accent=現行デザイン)。 */
export function resolveChapterTitlePattern(style: string | undefined): ChapterTitlePattern {
  return (CHAPTER_TITLE_PATTERNS as readonly string[]).includes(style ?? "")
    ? (style as ChapterTitlePattern)
    : DEFAULT_CHAPTER_TITLE_PATTERN;
}

/**
 * chapter_title 1件の描画計画。Remotion(Overlays.tsx)とプレビュー(PreviewOverlays.tsx)は
 * この同一の計画をDOMへ写すだけにし、パターンごとの見た目差分をこのファイルに閉じ込める。
 * DOM構造: <div container> [<div plate>] <StrokeText text /> [<div underline>] [</div>] </div>
 */
export type ChapterTitleRenderSpec = {
  /** 最外ラッパ(影・グロウのfilter等)。 */
  container: OverlayCssProperties;
  /** 座布団・プレート(null=座布団なし。textとunderlineを内包する)。 */
  plate: OverlayCssProperties | null;
  /** 縁取りテキスト(StrokeText)の指定。 */
  text: OverlayStrokeTextSpec;
  /** テキスト直下の装飾バー(アンダーライン。null=なし)。 */
  underline: OverlayCssProperties | null;
};

// band_gradient / tag_ribbon / neon_plate の基調色(紺・深紅・ネオンシアン)
const TITLE_BAND_NAVY = "23,48,94"; // #17305E 相当のRGB(グラデのalpha合成に使う)
const TITLE_BAND_ACCENT = "#FFC400";
const TITLE_RIBBON_RED = "#C7362F";
const TITLE_NEON_CYAN = "#54FFFF";

export function chapterTitleRenderSpec(
  pattern: ChapterTitlePattern,
  scale: number,
  resolved: OverlayTextDefaults,
): ChapterTitleRenderSpec {
  switch (pattern) {
    case "band_gradient":
      // 左端からのグラデ帯+白字: 紺の帯が右へ溶け、左端のアクセントバーで視線を留める
      return {
        container: { filter: "drop-shadow(0px 2px 4px rgba(0,0,0,0.35))" },
        plate: {
          background: `linear-gradient(90deg, rgba(${TITLE_BAND_NAVY},0.92) 0%, rgba(${TITLE_BAND_NAVY},0.62) 62%, rgba(${TITLE_BAND_NAVY},0) 100%)`,
          borderLeft: `${6 * scale}px solid ${TITLE_BAND_ACCENT}`,
          padding: `${9 * scale}px ${72 * scale}px ${9 * scale}px ${22 * scale}px`,
        },
        text: {
          fontSize: 42 * scale,
          fontFamily: OVERLAY_GOTHIC_FONT_FAMILY,
          fontWeight: 800,
          fillColor: "#FFFFFF",
          strokeColor: "transparent",
          strokeWidth: 0,
        },
        underline: null,
      };
    case "tag_ribbon":
      // タグ/リボン風: 深紅の座布団の右端をclip-pathで尖らせる(タグの切り欠き表現)
      return {
        container: { filter: "drop-shadow(0px 3px 5px rgba(0,0,0,0.4))" },
        plate: {
          backgroundColor: TITLE_RIBBON_RED,
          padding: `${9 * scale}px ${44 * scale}px ${9 * scale}px ${26 * scale}px`,
          clipPath: `polygon(0 0, calc(100% - ${22 * scale}px) 0, 100% 50%, calc(100% - ${22 * scale}px) 100%, 0 100%)`,
        },
        text: {
          fontSize: 42 * scale,
          fontFamily: OVERLAY_GOTHIC_FONT_FAMILY,
          fontWeight: 900,
          fillColor: "#FFFFFF",
          strokeColor: "transparent",
          strokeWidth: 0,
        },
        underline: null,
      };
    case "minimal_line":
      // 細字+アンダーラインのみ: vlog/シネマ向け。映像を邪魔しない字間広めの白細字
      return {
        container: { filter: "drop-shadow(0px 2px 4px rgba(0,0,0,0.55))" },
        plate: null,
        text: {
          fontSize: 38 * scale,
          fontFamily: OVERLAY_GOTHIC_FONT_FAMILY,
          fontWeight: 500,
          fillColor: "#FFFFFF",
          strokeColor: "transparent",
          strokeWidth: 0,
        },
        underline: {
          height: 3 * scale,
          marginTop: 8 * scale,
          backgroundColor: "rgba(255,255,255,0.85)",
        },
      };
    case "neon_plate":
      // 黒プレート+ネオン縁: game向け。U6のグロウ(telopGlow)を流用してシアンに光らせる
      return {
        container: {
          filter: `${buildGlowFilter({ color: TITLE_NEON_CYAN, radius: 9 }, scale) ?? ""} drop-shadow(0px 3px 6px rgba(0,0,0,0.5))`.trim(),
        },
        plate: {
          backgroundColor: "rgba(0,0,0,0.82)",
          border: `${Math.max(1, 2 * scale)}px solid rgba(84,255,255,0.85)`,
          padding: `${9 * scale}px ${28 * scale}px`,
        },
        text: {
          fontSize: 42 * scale,
          fontFamily: OVERLAY_GOTHIC_FONT_FAMILY,
          fontWeight: 900,
          fillColor: "#EAFBFF",
          strokeColor: "transparent",
          strokeWidth: 0,
        },
        underline: null,
      };
    case "box_accent":
    default:
      // 現行デザイン(黒字+白太縁の章見出し)そのまま。preset参照(resolved)による
      // 色・フォント上書きもU7以前の挙動を維持する
      return {
        container: { filter: CHAPTER_TITLE_FILTER },
        plate: null,
        text: chapterTitleTextSpec(scale, resolved),
        underline: null,
      };
  }
}

/** profile_card: 下部左寄せの白角丸ボックス・氏名(大)+肩書き(小)(参考画像04)。 */
export function profileCardBoxStyle(scale: number): OverlayCssProperties {
  return {
    backgroundColor: "#FFFFFF",
    border: `${Math.max(1, 2 * scale)}px solid #3A3A3A`,
    borderRadius: 18 * scale,
    padding: `${20 * scale}px ${44 * scale}px`,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 8 * scale,
    boxShadow: `0px ${5 * scale}px ${14 * scale}px rgba(0,0,0,0.35)`,
    // 幅は内容に合わせる(親が絶対配置のため%指定は幅崩壊する。nowrapで一行維持)
    width: "max-content",
  };
}

export function profileCardNameStyle(scale: number): OverlayCssProperties {
  return {
    fontFamily: OVERLAY_GOTHIC_FONT_FAMILY,
    fontSize: 44 * scale,
    fontWeight: 800,
    color: "#111111",
    letterSpacing: "0.06em",
    lineHeight: 1.2,
    textAlign: "center",
    whiteSpace: "nowrap",
  };
}

export function profileCardSubtitleStyle(scale: number): OverlayCssProperties {
  return {
    fontFamily: OVERLAY_GOTHIC_FONT_FAMILY,
    fontSize: 21 * scale,
    fontWeight: 700,
    color: "#222222",
    lineHeight: 1.25,
    textAlign: "center",
    whiteSpace: "nowrap",
  };
}

/** list_stack: 中央の縦積み列挙。黒ベタ+黄文字の帯を1行ずつ積む(参考画像11)。 */
export function listStackContainerStyle(scale: number): OverlayCssProperties {
  return {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 52 * scale,
    filter: "drop-shadow(0px 4px 8px rgba(0,0,0,0.4))",
  };
}

export function listStackLineStyle(scale: number): OverlayCssProperties {
  return {
    backgroundColor: "#000000",
    color: "#FFE600",
    fontFamily: OVERLAY_GOTHIC_FONT_FAMILY,
    fontSize: 56 * scale,
    fontWeight: 900,
    letterSpacing: "0.04em",
    lineHeight: 1.2,
    padding: `${8 * scale}px ${34 * scale}px`,
    whiteSpace: "pre-wrap",
  };
}

/** cta_banner: 下部の黄ベタ帯+黒文字1〜2行(参考画像12)。 */
export function ctaBannerBoxStyle(scale: number): OverlayCssProperties {
  return {
    backgroundColor: "#FFE600",
    padding: `${16 * scale}px ${52 * scale}px`,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    filter: "drop-shadow(0px 4px 10px rgba(0,0,0,0.4))",
  };
}

export function ctaBannerLineStyle(scale: number): OverlayCssProperties {
  return {
    color: "#000000",
    fontFamily: OVERLAY_GOTHIC_FONT_FAMILY,
    fontSize: 58 * scale,
    fontWeight: 900,
    letterSpacing: "0.02em",
    lineHeight: 1.25,
    textAlign: "center",
    whiteSpace: "pre-wrap",
  };
}

/** caption: 下部の白フチ黒字キャプション(B-roll用・T5で使用)。 */
export const CAPTION_DEFAULTS: OverlayTextDefaults = {
  fontFamily: OVERLAY_GOTHIC_FONT_FAMILY,
  fillColor: "#111111",
  strokeColor: "#FFFFFF",
};

export const CAPTION_FILTER = "drop-shadow(0px 3px 6px rgba(0,0,0,0.45))";

export function captionTextSpec(scale: number, resolved: OverlayTextDefaults): OverlayStrokeTextSpec {
  return {
    fontSize: 58 * scale,
    fontFamily: resolved.fontFamily,
    fontWeight: 900,
    fillColor: resolved.fillColor,
    strokeColor: resolved.strokeColor,
    strokeWidth: 10 * scale,
  };
}

/** StrokeText(多層WebkitTextStroke簡易版)のベースtextスタイル。 */
export function strokeTextBaseStyle(spec: OverlayStrokeTextSpec): OverlayCssProperties {
  return {
    fontFamily: spec.fontFamily,
    fontSize: spec.fontSize,
    fontWeight: spec.fontWeight,
    letterSpacing: "0.02em",
    lineHeight: 1.3,
    whiteSpace: "pre-wrap",
    wordBreak: "keep-all",
  };
}
