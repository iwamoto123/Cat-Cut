/**
 * 改善10-B-1(一括変更ポップアップ): テロップ内の出現箇所を文脈付きで列挙し、
 * 選択した箇所だけ置換する純関数。
 */

import type { Scene } from "./scenes.ts";
import { telopCharClass } from "./telopReplace.ts";
import { rebaseHighlightWords } from "./telopHighlightEdit.ts";

const CONTEXT_CHARS = 10;

export type TelopOccurrence = {
  sceneId: string;
  /** 1始まりのシーン番号(表示用)。 */
  sceneOrdinal: number;
  /** 当該シーン内での出現インデックス(0始まり)。 */
  occurrenceIndex: number;
  /** telopText内の開始/終了文字インデックス。 */
  start: number;
  end: number;
  contextBefore: string;
  match: string;
  contextAfter: string;
};

function countOccurrencesInText(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * W10-5(出現検索の境界チェック): searchTextが数字・英字・カタカナで始まる/終わる場合、
 * 一致箇所の直前/直後が同一文字種だと「連続語の途中の部分一致」(例:「170」内の「17」)なので
 * 対象にしない。ひらがな・漢字で始まる/終わる語は従来どおり部分文字列一致のまま。
 */
function occurrenceHasWordBoundary(text: string, start: number, end: number, searchText: string): boolean {
  const headClass = telopCharClass(searchText[0]);
  if (headClass && start > 0 && telopCharClass(text[start - 1]) === headClass) return false;
  const tailClass = telopCharClass(searchText[searchText.length - 1]);
  if (tailClass && end < text.length && telopCharClass(text[end]) === tailClass) return false;
  return true;
}

function sliceContext(text: string, start: number, end: number) {
  const beforeStart = Math.max(0, start - CONTEXT_CHARS);
  const afterEnd = Math.min(text.length, end + CONTEXT_CHARS);
  return {
    contextBefore: text.slice(beforeStart, start),
    match: text.slice(start, end),
    contextAfter: text.slice(end, afterEnd),
  };
}

/** 指定シーンを除く(既定)他シーンの出現箇所を列挙する。 */
export function findTelopOccurrencesInOtherScenes(
  scenes: Scene[],
  currentSceneId: string,
  searchText: string,
): TelopOccurrence[] {
  if (!searchText) return [];
  const occurrences: TelopOccurrence[] = [];
  scenes.forEach((scene, index) => {
    if (scene.id === currentSceneId) return;
    let cursor = 0;
    let occurrenceIndex = 0;
    while (cursor <= scene.telopText.length) {
      const found = scene.telopText.indexOf(searchText, cursor);
      if (found === -1) break;
      const end = found + searchText.length;
      // W10-5: 境界チェックに落ちた一致は結果に載せない。ただしoccurrenceIndexは
      // replaceTelopOccurrences(replaceNthOccurrence)の「全indexOf一致の通し番号」と
      // 揃える必要があるため、スキップした一致もカウントを進める。
      if (occurrenceHasWordBoundary(scene.telopText, found, end, searchText)) {
        occurrences.push({
          sceneId: scene.id,
          sceneOrdinal: index + 1,
          occurrenceIndex,
          start: found,
          end,
          ...sliceContext(scene.telopText, found, end),
        });
      }
      occurrenceIndex += 1;
      cursor = end;
    }
  });
  return occurrences;
}

export function countTelopOccurrencesInOtherScenesFromList(occurrences: TelopOccurrence[]): number {
  return occurrences.length;
}

export type TelopOccurrenceTarget = Pick<TelopOccurrence, "sceneId" | "occurrenceIndex">;

/** 選択した出現箇所だけ from→to に置換する。1回の呼び出し=1つのUndo操作想定。 */
export function replaceTelopOccurrences(
  scenes: Scene[],
  from: string,
  to: string,
  targets: TelopOccurrenceTarget[],
): Scene[] {
  if (!from || !targets.length) return scenes;
  const targetsByScene = new Map<string, number[]>();
  for (const target of targets) {
    const list = targetsByScene.get(target.sceneId) || [];
    list.push(target.occurrenceIndex);
    targetsByScene.set(target.sceneId, list);
  }

  return scenes.map((scene) => {
    const indices = targetsByScene.get(scene.id);
    if (!indices?.length) return scene;
    const sorted = [...indices].sort((a, b) => b - a);
    let nextText = scene.telopText;
    for (const occurrenceIndex of sorted) {
      nextText = replaceNthOccurrence(nextText, from, to, occurrenceIndex);
    }
    if (nextText === scene.telopText) return scene;
    const directedHighlightWords = rebaseHighlightWords(scene.telopText, nextText, scene.directedHighlightWords);
    return {
      ...scene, telopText: nextText, telopEdited: true,
      directedHighlightWords: directedHighlightWords.length ? directedHighlightWords : undefined,
    };
  });
}

function replaceNthOccurrence(text: string, from: string, to: string, occurrenceIndex: number): string {
  let count = 0;
  let cursor = 0;
  while (cursor <= text.length) {
    const found = text.indexOf(from, cursor);
    if (found === -1) return text;
    if (count === occurrenceIndex) {
      return text.slice(0, found) + to + text.slice(found + from.length);
    }
    count += 1;
    cursor = found + from.length;
  }
  return text;
}

/** テスト用: 他シーン合計出現回数(旧countTelopOccurrencesInOtherScenes互換)。 */
export function countTelopOccurrencesInOtherScenes(scenes: Scene[], currentSceneId: string, text: string): number {
  let total = 0;
  for (const scene of scenes) {
    if (scene.id === currentSceneId) continue;
    total += countOccurrencesInText(scene.telopText, text);
  }
  return total;
}
