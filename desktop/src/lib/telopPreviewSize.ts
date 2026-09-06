/**
 * 改善7-2(プレビューテロップの適正サイズ)向けの純関数群。
 * `2026-07-03_catcut-scene-row-ui-spec.md`「改善7」2項に準拠する。
 *
 * プレビューの<video>要素はCSSで`object-fit: contain`されているため、要素自身の
 * clientWidth/clientHeightと実際に描画される映像領域(コンテインされた矩形)は
 * アスペクト比が異なる場合にずれる(上下または左右に余白ができる)。
 * テロップの相対サイズ・センタリングは「実際に描画される映像領域」を基準にしないと
 * ずれてしまうため、まずこの矩形を計算する。
 */

export type ContainedBox = {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
};

/**
 * `object-fit: contain`のvideo要素において、コンテナのボックス(clientWidth/clientHeight)内で
 * 実際に映像が描画される矩形(幅・高さ・左右上下オフセット)を計算する。
 * 動画のメタデータ未取得時(intrinsic幅高さが0)はコンテナそのものをそのまま返す。
 */
export function computeContainedVideoBox(
  containerWidthPx: number,
  containerHeightPx: number,
  videoIntrinsicWidth: number,
  videoIntrinsicHeight: number,
): ContainedBox {
  if (!containerWidthPx || !containerHeightPx || !videoIntrinsicWidth || !videoIntrinsicHeight) {
    return { width: containerWidthPx || 0, height: containerHeightPx || 0, offsetX: 0, offsetY: 0 };
  }
  const containerAspect = containerWidthPx / containerHeightPx;
  const videoAspect = videoIntrinsicWidth / videoIntrinsicHeight;
  let width: number;
  let height: number;
  if (videoAspect > containerAspect) {
    width = containerWidthPx;
    height = containerWidthPx / videoAspect;
  } else {
    height = containerHeightPx;
    width = containerHeightPx * videoAspect;
  }
  return {
    width,
    height,
    offsetX: (containerWidthPx - width) / 2,
    offsetY: (containerHeightPx - height) / 2,
  };
}

/**
 * フェーズW8(キャンバス基準ステージ): プレビューステージ内で「キャンバス(=コンポジション)」が
 * 描画される矩形を計算する。テロップ・オーバーレイ・挿入画像はキャンバス座標系なので、
 * 素材の向きとキャンバスの向きが異なるrun(横素材+縦キャンバス等)でもこの矩形を基準にすれば
 * 書き出しと同じ配置になる。キャンバス寸法が未指定(0/undefined。旧run・composition未生成)の
 * 場合は従来どおり動画intrinsic寸法のアスペクトへフォールバックする。
 */
export function computeStageCanvasBox(
  containerWidthPx: number,
  containerHeightPx: number,
  canvasWidth: number | undefined,
  canvasHeight: number | undefined,
  videoIntrinsicWidth: number,
  videoIntrinsicHeight: number,
): ContainedBox {
  if (canvasWidth && canvasHeight && canvasWidth > 0 && canvasHeight > 0) {
    return computeContainedVideoBox(containerWidthPx, containerHeightPx, canvasWidth, canvasHeight);
  }
  return computeContainedVideoBox(containerWidthPx, containerHeightPx, videoIntrinsicWidth, videoIntrinsicHeight);
}

/**
 * Remotion書き出しと同じ相対比率(telop_font_size / 基準解像度幅)で、プレビュー上の
 * 「通常(sizeRatio=1.0)」相当のフォントサイズ(px)を算出する。
 * `telopStyleToCssProperties(style, baseFontSizePx)`のbaseFontSizePxにそのまま渡す想定。
 */
export function computeRelativeTelopFontPx(
  videoDisplayWidthPx: number,
  telopFontSize: number,
  baseWidth: number,
): number {
  if (!videoDisplayWidthPx || !telopFontSize || !baseWidth) return 0;
  const ratio = telopFontSize / baseWidth;
  return videoDisplayWidthPx * ratio;
}

// =============================================================================
// 改善8-B-4(プレビューのテロップ描画をプリセット忠実に): テキスト幅推定とフォントサイズ
// クランプ。「1行が動画表示幅の90%に収まる」ように逆算でフォントサイズを縮小し、
// それでも収まらない場合のみ2行に折り返す。
// =============================================================================

/**
 * `editor/python/shared/textwidth.py` の DEFAULT_WEIGHTS 移植(全角1文字=1.0単位とする
 * 相対文字幅)。Canvas 2D measureTextが使えない環境(ユニットテスト等、document未定義)での
 * フォールバック推定に使う。
 */
const GLYPH_WEIGHTS = {
  ascii_alnum: 0.55,
  ascii_space: 0.3,
  ascii_punct: 0.5,
  cjk_punct: 0.5,
  small_kana: 0.85,
  long_dash: 0.9,
  default: 1.0,
} as const;

const SMALL_KANA = new Set(["ぁ", "ぃ", "ぅ", "ぇ", "ぉ", "ゃ", "ゅ", "ょ"]);
const ASCII_PUNCT = new Set(["!", "?", ",", ".", "-", "'", '"']);

function classifyGlyph(ch: string): keyof typeof GLYPH_WEIGHTS {
  if (ch === " ") return "ascii_space";
  if ((ch >= "0" && ch <= "9") || (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z")) return "ascii_alnum";
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 0x3000 && code <= 0x303f) return "cjk_punct";
  if (ch === "ー" || ch === "―") return "long_dash";
  if (SMALL_KANA.has(ch)) return "small_kana";
  if (ASCII_PUNCT.has(ch)) return "ascii_punct";
  return "default";
}

/** textwidth.py の weighted_cpl 移植。1単位 ≈ 全角1文字ぶんの幅(em換算)とみなす。 */
function weightedGlyphLength(text: string): number {
  let total = 0;
  for (const ch of text) total += GLYPH_WEIGHTS[classifyGlyph(ch)];
  return total;
}

let measureCanvasCtx: CanvasRenderingContext2D | null | undefined;

function getMeasureContext(): CanvasRenderingContext2D | null {
  if (measureCanvasCtx !== undefined) return measureCanvasCtx;
  if (typeof document === "undefined") {
    measureCanvasCtx = null;
    return null;
  }
  const canvas = document.createElement("canvas");
  measureCanvasCtx = canvas.getContext("2d");
  return measureCanvasCtx;
}

/**
 * テキストの実描画幅(px)を推定する。Canvas 2D measureText が使える環境(実UI)では実測値を
 * 使い(Google Fontsの読み込み前は概算になり得るが、はみ出し防止という目的には十分)、
 * document が無い環境(node --experimental-strip-types でのユニットテスト等)では
 * weightedGlyphLength() による概算(1em ≈ 全角1文字)にフォールバックする。
 * letter-spacing は measureText に反映されないため、文字数-1個ぶんを別途加算する。
 */
export function measureTelopTextWidthPx(
  text: string,
  fontSizePx: number,
  fontFamily: string,
  fontWeight: number,
  letterSpacingEm: number,
): number {
  const chars = [...text];
  const letterSpacingPx = letterSpacingEm * fontSizePx;
  const extraPx = Math.max(0, chars.length - 1) * letterSpacingPx;
  const ctx = getMeasureContext();
  if (!ctx || !text) {
    return weightedGlyphLength(text) * fontSizePx + extraPx;
  }
  ctx.font = `${fontWeight} ${fontSizePx}px ${fontFamily}`;
  return ctx.measureText(text).width + extraPx;
}

/** letter_spacing文字列("0.02em"等)をem単位の数値に変換する(px/%等は0扱い)。 */
function parseLetterSpacingEm(letterSpacing: string | undefined): number {
  if (!letterSpacing) return 0;
  const match = /^(-?\d*\.?\d+)em$/.exec(letterSpacing.trim());
  return match ? Number(match[1]) : 0;
}

const wordSegmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("ja", { granularity: "word" }) : null;

function splitIntoWordUnits(text: string): string[] {
  if (!wordSegmenter) return [...text];
  return [...wordSegmenter.segment(text)].map((entry) => entry.segment);
}

/** 単語境界(Intl.Segmenter)で2行に分割する。境界が見つからない場合は文字数半分で機械的に折り返す。 */
function wrapTextIntoTwoLines(
  text: string,
  fontSizePx: number,
  fontFamily: string,
  fontWeight: number,
  letterSpacingEm: number,
  targetWidthPx: number,
): string[] {
  const units = splitIntoWordUnits(text);
  if (units.length <= 1) return [text];

  let firstLine = "";
  let splitIndex = -1;
  for (let index = 0; index < units.length; index += 1) {
    const candidate = firstLine + units[index];
    const width = measureTelopTextWidthPx(candidate, fontSizePx, fontFamily, fontWeight, letterSpacingEm);
    if (width > targetWidthPx && firstLine) {
      splitIndex = index;
      break;
    }
    firstLine = candidate;
  }
  if (splitIndex === -1) {
    const mid = Math.max(1, Math.ceil(units.length / 2));
    return [units.slice(0, mid).join(""), units.slice(mid).join("")].filter(Boolean);
  }
  return [units.slice(0, splitIndex).join(""), units.slice(splitIndex).join("")].filter(Boolean);
}

export type TelopFitOptions = {
  /** プレビュー内で実際に映像が描画される幅(px)。computeContainedVideoBoxのwidthを渡す想定。 */
  videoDisplayWidthPx: number;
  /** クランプ前の希望フォントサイズ(px)。computeRelativeTelopFontPxの結果を渡す想定。 */
  preferredFontSizePx: number;
  fontFamily: string;
  fontWeight: number;
  /** letter_spacing文字列("0.02em"等)。 */
  letterSpacing?: string;
  /** 1行が占めてよい動画表示幅に対する比率(既定0.9 = 90%)。 */
  widthRatio?: number;
  /** これ未満にはフォントサイズを縮小しない(下限)。未指定時はpreferredFontSizePxの50%。 */
  minFontSizePx?: number;
};

export type TelopFitResult = { fontSizePx: number; lines: string[] };

/**
 * 改善8-B-4: 「1行が動画表示幅の90%に収まる」ように逆算でフォントサイズをクランプする。
 * 1. preferredFontSizePxのまま1行に収まればそのまま使う。
 * 2. 収まらない場合、目標幅ちょうどに収まるフォントサイズまで比例縮小する(1行のまま)。
 * 3. 縮小後のサイズがminFontSizePxを下回ってしまう場合は、minFontSizePxのまま2行に折り返す
 *    (単語境界で分割。それでも1行が収まりきらない場合はそのまま表示する=無理な文字単位分割はしない)。
 */
export function fitTelopTextToWidth(text: string, options: TelopFitOptions): TelopFitResult {
  const { videoDisplayWidthPx, preferredFontSizePx, fontFamily, fontWeight } = options;
  if (!text) return { fontSizePx: preferredFontSizePx, lines: [] };
  if (!videoDisplayWidthPx || !preferredFontSizePx) return { fontSizePx: preferredFontSizePx, lines: [text] };

  const letterSpacingEm = parseLetterSpacingEm(options.letterSpacing);
  const widthRatio = options.widthRatio ?? 0.9;
  const minFontSizePx = options.minFontSizePx ?? Math.max(10, preferredFontSizePx * 0.5);
  const targetWidthPx = videoDisplayWidthPx * widthRatio;

  const widthAtPreferred = measureTelopTextWidthPx(text, preferredFontSizePx, fontFamily, fontWeight, letterSpacingEm);
  if (widthAtPreferred <= targetWidthPx) {
    return { fontSizePx: preferredFontSizePx, lines: [text] };
  }

  const scaledFontSizePx = (preferredFontSizePx * targetWidthPx) / widthAtPreferred;
  if (scaledFontSizePx >= minFontSizePx) {
    return { fontSizePx: scaledFontSizePx, lines: [text] };
  }

  const lines = wrapTextIntoTwoLines(text, minFontSizePx, fontFamily, fontWeight, letterSpacingEm, targetWidthPx);
  return { fontSizePx: minFontSizePx, lines: lines.length ? lines : [text] };
}
