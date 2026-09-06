// フェーズT2.5(テロップ描画品質): 折返し・幅フィット・縦クランプの統合レイアウト計算。
//
// 従来は「wrapTelopLineの折返し」と「Telop.tsxの幅フィット縮小」が独立していて、
// 相互作用で画面はみ出しが起きていた(折返し後の行に対して幅フィットが効かない)。
// 本モジュールは折返しを1回だけ計算し(単一のlineTexts)、その最長行に対して
// フォントサイズを決定する。縁取り・塗りの全レイヤーはこの同じ行配列を描画する
// (レイヤー個別の再折返しを構造的に排除する = 多層縁の行ズレ根絶)。

// node --experimental-strip-types でテストを直接実行できるよう拡張子を明示する(desktop側と同じ流儀)。
import { weightedTelopLineLength, wrapTelopLine } from "./wrapTelopLine.ts";

/** 折返しの標準上限行数(仕様書T2.5-1「折返しは最大2行まで」)。 */
export const TELOP_MAX_LINES = 2;
/** 縮小下限でも収まらない極長文言のみ許可する保険の上限行数。 */
export const TELOP_ABSOLUTE_MAX_LINES = 3;
/** フォント自動縮小の下限(ベースフォントサイズに対する比率)。 */
export const TELOP_MIN_FONT_SCALE = 0.55;
/**
 * フェーズW26: 縦型(ショート)の縮小下限。0.55まで縮むと1080幅キャンバスで文字が
 * 小さくなりすぎるため、縦型は0.75で止めて先に2行折返しへ逃がす(改行改善)。
 */
export const VERTICAL_TELOP_MIN_FONT_SCALE = 0.75;
/**
 * フェーズW27: 縦型(ショート)の絶対最低フォントサイズ(px。1080幅キャンバス基準)。
 * 比率下限(min_font_scale)だけだと小さめプリセット×長文で60px未満まで落ちることが
 * あるため、絶対値でも床を張る。ただし床を適用した結果でも最長行がキャンバス幅
 * (フィット上限の約1.1倍=画面ほぼ端まで)を超える場合は、はみ出し防止を優先して
 * フィット計算値のまま描画する。
 */
export const VERTICAL_TELOP_MIN_FONT_PX = 68;
/** 上下セーフエリアのマージン(動画高さに対する比率)。 */
export const TELOP_SAFE_AREA_RATIO = 0.04;
/** ブロック背景なしのときの行間ギャップ(px。Telop.tsxのcolumn gapと同値)。 */
export const TELOP_LINE_GAP_PX = 8;
/** テロップ幅フィットの上限(キャンバス幅に対する比率)。 */
export const TELOP_FIT_WIDTH_RATIO = 0.92;
/**
 * フェーズW24 Phase A-2: 縦型はInstagram/TikTokの右端アイコン列を避けるため
 * 幅フィット上限を86%へ絞る(中央寄せなので左右対称で右端セーフゾーンを確保できる)。
 */
export const VERTICAL_TELOP_FIT_WIDTH_RATIO = 0.86;

/**
 * テロップ幅フィットの上限px。縦型キャンバス(高さ>幅)のみ86%、それ以外は従来の92%
 * (横型・旧runは完全従来動作)。
 */
export function telopFitWidth(videoWidth: number, videoHeight: number): number {
  const ratio =
    videoHeight > videoWidth ? VERTICAL_TELOP_FIT_WIDTH_RATIO : TELOP_FIT_WIDTH_RATIO;
  return videoWidth * ratio;
}

export type TelopBlockLayout = {
  /** 全レイヤー(縁取り・塗り)が共有する確定済みの行配列。 */
  lineTexts: string[];
  /** 幅フィット適用後のフォントサイズ(px)。 */
  fontSize: number;
};

/**
 * 複数セグメント(ページの行)を合計 totalMaxLines 行以内に折り返す。
 * 各セグメントには「後続セグメントに最低1行を残す」よう行数を配分する
 * (1セグメント: maxLinesまで折返し可 / 2セグメント: 各1行で確定し幅フィットに任せる)。
 */
export function wrapSegmentsWithMaxLines(
  segmentTexts: string[],
  maxCharsPerLine: number | undefined,
  totalMaxLines: number,
): string[] {
  const texts = segmentTexts.filter((text) => text !== undefined && text !== null);
  if (!maxCharsPerLine) return texts;
  const lines: string[] = [];
  let remaining = Math.max(texts.length, totalMaxLines);
  texts.forEach((text, index) => {
    const reserveForRest = texts.length - 1 - index;
    const segmentMaxLines = Math.max(1, remaining - reserveForRest);
    const wrapped = wrapTelopLine(text, maxCharsPerLine, segmentMaxLines);
    lines.push(...wrapped);
    remaining -= wrapped.length;
  });
  return lines;
}

/**
 * 折返し済みの行配列に対する幅フィット計算。最長行(重み付き文字幅: 全角=1em基準)が
 * fitWidth に収まるフォントサイズを求め、baseFontSize を上限にクランプする。
 */
export function fitFontSizeForLines(
  lineTexts: string[],
  options: { baseFontSize: number; letterSpacingEm: number; fitWidth: number },
): number {
  const { baseFontSize, letterSpacingEm, fitWidth } = options;
  const maxLineEm = Math.max(1, ...lineTexts.map((lineText) => weightedTelopLineLength(lineText)));
  const fitted = fitWidth / (maxLineEm * (1 + letterSpacingEm) + 0.6);
  return Math.min(baseFontSize, fitted);
}

/**
 * テロップブロックのレイアウト(行配列+フォントサイズ)を1回だけ確定する。
 *
 * 1. まず最大2行で折返し、折返し後の最長行に対して幅フィットを計算する
 * 2. 縮小が下限(minFontScale)を割る場合のみ3行を許可して再計算する(実質発生しない保険)
 */
export function computeTelopBlockLayout(options: {
  segmentTexts: string[];
  maxCharsPerLine?: number;
  baseFontSize: number;
  letterSpacingEm: number;
  fitWidth: number;
  minFontScale?: number;
  /**
   * フェーズW27: 絶対最低フォントサイズ(px)。フィット計算値がこれを下回る場合に
   * 引き上げる。ただし引き上げ後の最長行がフィット上限の1.1倍(画面ほぼ端)を超える
   * 場合は、はみ出し防止を優先して適用しない。縦型ショートで指定する。
   */
  minFontPx?: number;
}): TelopBlockLayout {
  const {
    segmentTexts,
    maxCharsPerLine,
    baseFontSize,
    letterSpacingEm,
    fitWidth,
    minFontScale = TELOP_MIN_FONT_SCALE,
    minFontPx,
  } = options;

  const applyFloor = (layout: TelopBlockLayout): TelopBlockLayout => {
    if (!minFontPx || layout.fontSize >= minFontPx) return layout;
    // 床を張っても画面からはみ出さないか(フィット上限の1.1倍まで許容)を確認する
    const hardCap = fitFontSizeForLines(layout.lineTexts, {
      baseFontSize: minFontPx,
      letterSpacingEm,
      fitWidth: fitWidth * 1.1,
    });
    return { ...layout, fontSize: Math.max(layout.fontSize, Math.min(minFontPx, hardCap)) };
  };

  const standard = wrapSegmentsWithMaxLines(segmentTexts, maxCharsPerLine, TELOP_MAX_LINES);
  const standardFontSize = fitFontSizeForLines(standard, { baseFontSize, letterSpacingEm, fitWidth });
  if (!maxCharsPerLine || standardFontSize >= baseFontSize * minFontScale) {
    return applyFloor({ lineTexts: standard, fontSize: standardFontSize });
  }

  // 保険: 下限でも収まらない極長文言のみ3行に増やして最長行を短くする
  const extended = wrapSegmentsWithMaxLines(segmentTexts, maxCharsPerLine, TELOP_ABSOLUTE_MAX_LINES);
  if (extended.length <= standard.length) {
    return applyFloor({ lineTexts: standard, fontSize: standardFontSize });
  }
  const extendedFontSize = fitFontSizeForLines(extended, { baseFontSize, letterSpacingEm, fitWidth });
  return applyFloor({ lineTexts: extended, fontSize: extendedFontSize });
}

/**
 * y_position_offset 適用後もテロップブロック全体が上下セーフエリア内に収まるよう
 * 縦位置(中心基準)をクランプする。戻り値はCSSの top に使うパーセント値(0〜100)。
 *
 * ブロック高さは「行数 × lineHeight × fontSize + 行間ギャップ + 背景の縦パディング」で概算する。
 */
export function clampTelopYPercent(options: {
  telopY: number;
  yOffset: number;
  lineCount: number;
  lineHeight: number;
  fontSize: number;
  videoHeight: number;
  lineGapPx?: number;
  blockPaddingY?: number;
  safeAreaRatio?: number;
}): number {
  const {
    telopY,
    yOffset,
    lineCount,
    lineHeight,
    fontSize,
    videoHeight,
    lineGapPx = TELOP_LINE_GAP_PX,
    blockPaddingY = 0,
    safeAreaRatio = TELOP_SAFE_AREA_RATIO,
  } = options;
  const blockHeightPx =
    lineCount * lineHeight * fontSize + Math.max(0, lineCount - 1) * lineGapPx + blockPaddingY * 2;
  const halfBlockRatio = videoHeight > 0 ? blockHeightPx / videoHeight / 2 : 0;
  const minY = safeAreaRatio + halfBlockRatio;
  const maxY = 1 - safeAreaRatio - halfBlockRatio;
  // ブロックがセーフエリアより高い場合は中央に置く(上下均等にはみ出させる)
  if (minY > maxY) return 50;
  const requested = telopY + yOffset;
  return Math.min(maxY, Math.max(minY, requested)) * 100;
}
