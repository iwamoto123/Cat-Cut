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
    // A line break has no visible color. Keep the complete phrase so a short
    // fragment does not accidentally color another occurrence elsewhere.
    if (index < length && (text[index] === "\n" || text[index] === "\r")) continue;
    const highlighted = index < length && mask[index];
    if (highlighted && runStart === -1) runStart = index;
    if (!highlighted && runStart !== -1) {
      words.push(text.slice(runStart, index).replace(/[\r\n]/g, ""));
      runStart = -1;
    }
  }
  return [...new Set(words.filter((word) => word.length > 0))];
}

/** Keep character colors when replacing text, including IME conversion and pasted corrections. */
export function rebaseHighlightWords(
  beforeText: string,
  afterText: string,
  words: readonly string[] | undefined,
): string[] {
  if (!words?.length || !afterText) return [];
  const oldUnits = highlightMaskFromWords(beforeText, words);
  const before = Array.from(beforeText);
  const after = Array.from(afterText);
  let unit = 0;
  const oldMask = before.map((char) => {
    const highlighted = oldUnits[unit];
    unit += char.length;
    return highlighted;
  });
  const nextMask = after.map(() => false);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    nextMask[prefix] = oldMask[prefix];
    prefix += 1;
  }
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > prefix && newEnd > prefix && before[oldEnd - 1] === after[newEnd - 1]) {
    nextMask[--newEnd] = oldMask[--oldEnd];
  }
  const inheritReplacement = (oldStart: number, oldStop: number, newStart: number, newStop: number) => {
    // A replacement inherits a uniform selected color. Insertions inherit the preceding
    // character (or the first character at the beginning), as in a rich text editor.
    const selectedColors = oldMask.slice(oldStart, oldStop).filter((_, index) =>
      before[oldStart + index] !== "\n" && before[oldStart + index] !== "\r");
    let adjacent = oldStart > 0 ? oldStart - 1 : oldStart;
    while (adjacent > 0 && (before[adjacent] === "\n" || before[adjacent] === "\r")) adjacent -= 1;
    const highlighted = selectedColors.length
      ? selectedColors.every(Boolean)
      : Boolean(oldMask[adjacent]);
    nextMask.fill(highlighted, newStart, newStop);
  };
  const oldLength = oldEnd - prefix;
  const newLength = newEnd - prefix;
  // Bound paste cost. Typical telops use the LCS to retain unrelated highlights
  // across multiple edits; a very large changed region is treated as one replacement.
  if (oldLength * newLength <= 250_000 && oldLength && newLength) {
    const width = newLength + 1;
    const lengths = new Uint32Array((oldLength + 1) * width);
    for (let i = oldLength - 1; i >= 0; i -= 1) {
      for (let j = newLength - 1; j >= 0; j -= 1) {
        lengths[i * width + j] = before[prefix + i] === after[prefix + j]
          ? 1 + lengths[(i + 1) * width + j + 1]
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    let previousOld = prefix;
    let previousNew = prefix;
    while (i < oldLength && j < newLength) {
      if (before[prefix + i] === after[prefix + j]) {
        inheritReplacement(previousOld, prefix + i, previousNew, prefix + j);
        nextMask[prefix + j] = oldMask[prefix + i];
        previousOld = prefix + ++i;
        previousNew = prefix + ++j;
      } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
        i += 1;
      } else {
        j += 1;
      }
    }
    inheritReplacement(previousOld, oldEnd, previousNew, newEnd);
  } else {
    inheritReplacement(prefix, oldEnd, prefix, newEnd);
  }
  return highlightWordsFromMask(afterText, after.flatMap((char, index) => Array(char.length).fill(nextMask[index])));
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
    if (text[index] === "\r" || text[index] === "\n") continue;
    if (!mask[index]) return false;
  }
  return true;
}
