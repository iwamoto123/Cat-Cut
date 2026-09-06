import { splitHighlightRuns } from "./telopHighlight.ts";

/**
 * テキストボックスからの黄/白指定。highlight_words は部分文字列の配列なので、
 * 文字単位マスクへ展開してから書き戻すと、選択範囲の一部分だけ白に戻す操作ができる。
 */

export function highlightMaskFromWords(
  text: string,
  words: readonly string[] | undefined,
): boolean[] {
  const mask = Array.from({ length: text.length }, () => false);
  const runs = splitHighlightRuns(text, words);
  let cursor = 0;
  for (const run of runs) {
    if (run.highlight) {
      for (let index = 0; index < run.text.length; index += 1) mask[cursor + index] = true;
    }
    cursor += run.text.length;
  }
  return mask;
}

export function highlightWordsFromMask(text: string, mask: readonly boolean[]): string[] {
  const words: string[] = [];
  let runStart = -1;
  const length = Math.min(text.length, mask.length);
  for (let index = 0; index <= length; index += 1) {
    const highlighted = index < length && mask[index];
    if (highlighted && runStart === -1) runStart = index;
    if (!highlighted && runStart !== -1) {
      words.push(text.slice(runStart, index));
      runStart = -1;
    }
  }
  return [...new Set(words.filter((word) => word.length > 0))];
}

export function setHighlightRange(
  text: string,
  words: readonly string[] | undefined,
  start: number,
  end: number,
  highlighted: boolean,
): string[] {
  if (!text) return [];
  const from = Math.max(0, Math.min(start, end));
  const to = Math.min(text.length, Math.max(start, end));
  if (to <= from) return highlightWordsFromMask(text, highlightMaskFromWords(text, words));
  const mask = highlightMaskFromWords(text, words);
  for (let index = from; index < to; index += 1) mask[index] = highlighted;
  return highlightWordsFromMask(text, mask);
}

export function isRangeHighlighted(
  text: string,
  words: readonly string[] | undefined,
  start: number,
  end: number,
): boolean {
  const from = Math.max(0, Math.min(start, end));
  const to = Math.min(text.length, Math.max(start, end));
  if (to <= from) return false;
  const mask = highlightMaskFromWords(text, words);
  for (let index = from; index < to; index += 1) {
    if (!mask[index]) return false;
  }
  return true;
}
