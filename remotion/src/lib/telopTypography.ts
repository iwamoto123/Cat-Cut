/**
 * テロップの文字組み(タイポグラフィ)ルール。
 *
 * 1. 助詞縮小: 漢字・カタカナ・英数字に挟まれた単独ひらがな助詞(の・が・を等)を
 *    少し小さく描画する(プロのテロップの定番。決定的ルールでありAI/形態素解析は不要)。
 * 2. 和欧混植: 半角英数字の連続を欧文フォント(既定 SF Pro系 = iPhone/Macの
 *    システムフォント)で描画する。
 *
 * 重要: この分割は塗り・縁取り・影の全レイヤーで同一に適用すること。
 * レイヤー間でスパン分割やフォントサイズが異なると字幅がズレて多層縁が崩れる
 * (フェーズT2.5-1の行ズレ根絶と同じ制約)。
 */

/** 助詞縮小の既定スケール(80%)。プリセットの particle_scale で上書き可能。 */
export const DEFAULT_PARTICLE_SCALE = 0.8;

/**
 * 和欧混植の既定欧文フォント。プリセットの latin_font_family で上書き/無効化(null)可能。
 * -apple-system は macOS/iOSのシステムフォント(SF Pro)に解決される
 * (レンダリングはmacOS上のChromium系のため実質SF Pro。非mac環境ではHelvetica系に落ちる)。
 */
export const DEFAULT_LATIN_FONT_FAMILY =
  '-apple-system, "SF Pro Display", "Helvetica Neue", "Arial", sans-serif';

/** 縮小対象の単独ひらがな助詞。 */
const PARTICLES = new Set(["の", "が", "を", "に", "は", "で", "と", "へ", "も", "や"]);

/** 漢字・カタカナ・数字・英字など「実質的な内容語」を構成する文字か。 */
const SOLID_CHAR_RE =
  /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF々〆ヶヵ\u30A0-\u30FF0-9０-９A-Za-zＡ-Ｚａ-ｚ]/;

/** 和欧混植の対象(半角英数字と、数値に付随する記号)。 */
const LATIN_CHAR_RE = /[0-9A-Za-z]/;
const LATIN_JOINER_RE = /[.,%+\-:]/;

export type TypographyRunKind = "normal" | "particle" | "latin";

export interface TypographyRun {
  text: string;
  kind: TypographyRunKind;
}

/**
 * 1文字ごとの描画種別を決める。
 *
 * - particle: 前後を内容語(漢字・カタカナ・英数字)に挟まれた単独ひらがな助詞。
 *   「昨年の情報」の「の」は縮小するが、「下がったの知ってますか」の「の」は
 *   前がひらがなのため縮小しない(準体助詞の誤縮小を避ける安全側ルール)。
 * - latin: 半角英数字の連続(数値の中の . , % + - : を含む)。
 */
export function computeCharKinds(text: string): TypographyRunKind[] {
  const chars = Array.from(text);
  const kinds: TypographyRunKind[] = chars.map(() => "normal");

  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (LATIN_CHAR_RE.test(ch)) {
      kinds[i] = "latin";
      continue;
    }
    if (
      LATIN_JOINER_RE.test(ch) &&
      i > 0 &&
      i < chars.length - 1 &&
      LATIN_CHAR_RE.test(chars[i - 1]) &&
      LATIN_CHAR_RE.test(chars[i + 1])
    ) {
      // "3.5" "1,000" "50%↛" のような数値内の記号は欧文ランに含める(%は次の分岐)
      kinds[i] = "latin";
      continue;
    }
    if (
      PARTICLES.has(ch) &&
      i > 0 &&
      i < chars.length - 1 &&
      SOLID_CHAR_RE.test(chars[i - 1]) &&
      SOLID_CHAR_RE.test(chars[i + 1])
    ) {
      kinds[i] = "particle";
    }
  }

  // "50%" の % は直前が欧文なら欧文ランに含める(行末でも適用)
  for (let i = 1; i < chars.length; i += 1) {
    if (chars[i] === "%" && kinds[i - 1] === "latin") kinds[i] = "latin";
  }

  return kinds;
}

/** 文字種別の連続をランにまとめる。 */
export function splitTypographyRuns(text: string): TypographyRun[] {
  const chars = Array.from(text);
  if (chars.length === 0) return [];
  const kinds = computeCharKinds(text);
  const runs: TypographyRun[] = [];
  let current = { text: chars[0], kind: kinds[0] };
  for (let i = 1; i < chars.length; i += 1) {
    if (kinds[i] === current.kind) {
      current.text += chars[i];
    } else {
      runs.push(current);
      current = { text: chars[i], kind: kinds[i] };
    }
  }
  runs.push(current);
  return runs;
}

export interface StyledTypographyRun extends TypographyRun {
  /** 塗りレイヤー用: このランが部分ハイライト対象か。 */
  highlight: boolean;
}

/**
 * タイポグラフィ種別とハイライト区間を合成したランを返す。
 *
 * ハイライトは色だけを変え字幅に影響しないため、レイヤー間の整合には
 * kind(フォントサイズ・フォント)のみが効く。ここでは塗りレイヤーが1回の分割で
 * 両方を描けるよう、文字単位のマスク合成で一括分割する。
 */
export function splitStyledRuns(text: string, highlightMask: boolean[]): StyledTypographyRun[] {
  const chars = Array.from(text);
  if (chars.length === 0) return [];
  const kinds = computeCharKinds(text);
  const runs: StyledTypographyRun[] = [];
  let current = { text: chars[0], kind: kinds[0], highlight: Boolean(highlightMask[0]) };
  for (let i = 1; i < chars.length; i += 1) {
    const highlight = Boolean(highlightMask[i]);
    if (kinds[i] === current.kind && highlight === current.highlight) {
      current.text += chars[i];
    } else {
      runs.push(current);
      current = { text: chars[i], kind: kinds[i], highlight };
    }
  }
  runs.push(current);
  return runs;
}

/** highlight_words から文字単位のハイライトマスクを作る(複数語・複数出現対応)。 */
export function buildHighlightMask(text: string, highlightWords?: string[]): boolean[] {
  const chars = Array.from(text);
  const mask = chars.map(() => false);
  if (!highlightWords?.length) return mask;
  for (const word of highlightWords) {
    if (!word) continue;
    let fromIndex = 0;
    while (fromIndex <= text.length - word.length) {
      const found = text.indexOf(word, fromIndex);
      if (found === -1) break;
      // string index -> char index (サロゲートペア対応)
      const before = Array.from(text.slice(0, found)).length;
      const len = Array.from(word).length;
      for (let i = before; i < before + len && i < mask.length; i += 1) mask[i] = true;
      fromIndex = found + word.length;
    }
  }
  return mask;
}
