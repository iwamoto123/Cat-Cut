// フェーズT1-2(部分ハイライト A-emph): テロップ文言中の指定部分文字列だけ塗り色を変えるための
// 分割ロジック。描画(Telop.tsx)から独立した純関数として置き、node --experimental-strip-types の
// ユニットテストで直接検証できるようにする。
//
// 仕様:
// - highlight_words の各語について、行テキスト中の「全出現」をハイライト対象にする
// - 複数語が重なる・隣接する場合は範囲をマージして1つのハイライト区間として扱う
// - 明示改行は色指定の一致判定に影響しない。折返し後はブロック全体のマスクを行へ分配する。

/** ハイライト分割後の1区間。highlight=true の区間だけ塗り色を highlight_color に変える。 */
export interface HighlightRun {
  text: string;
  highlight: boolean;
}

/** テロップの既定ハイライト色(preset の highlight_color 省略時)。 */
export const DEFAULT_HIGHLIGHT_COLOR = "#E7305B";

/**
 * 行テキストを highlight_words に基づいて HighlightRun の並びに分割する。
 * ハイライトが1つも無い場合は「全体1区間(highlight=false)」を返す。
 */
export function splitHighlightRuns(
  lineText: string,
  highlightWords: readonly string[] | undefined,
): HighlightRun[] {
  if (!lineText) return [];
  const words = (highlightWords ?? []).map((word) => word.replace(/[\r\n]/g, "")).filter(Boolean);
  if (words.length === 0) return [{ text: lineText, highlight: false }];

  const sourceIndices: number[] = [];
  for (let index = 0; index < lineText.length; index += 1) {
    if (lineText[index] !== "\r" && lineText[index] !== "\n") sourceIndices.push(index);
  }
  const searchableText = lineText.replace(/[\r\n]/g, "");

  // 各語の全出現位置を [start, end) 区間として収集する
  const ranges: Array<[number, number]> = [];
  for (const word of words) {
    let from = 0;
    while (from <= searchableText.length - word.length) {
      const idx = searchableText.indexOf(word, from);
      if (idx < 0) break;
      ranges.push([sourceIndices[idx], sourceIndices[idx + word.length - 1] + 1]);
      from = idx + 1; // 重複出現も拾う(マージで正規化される)
    }
  }
  if (ranges.length === 0) return [{ text: lineText, highlight: false }];

  // 重なり・隣接する区間をマージ
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }

  // 区間の内外を交互に HighlightRun へ変換
  const runs: HighlightRun[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) runs.push({ text: lineText.slice(cursor, start), highlight: false });
    runs.push({ text: lineText.slice(start, end), highlight: true });
    cursor = end;
  }
  if (cursor < lineText.length) runs.push({ text: lineText.slice(cursor), highlight: false });
  return runs;
}
