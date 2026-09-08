/** 1操作=1履歴の単位は維持し、古い履歴から解放する（2026-09-07承認済み）。 */
export const EDIT_HISTORY_LIMIT = 200;

export type EditHistoryState<T> = {
  past: T[];
  present: T;
  future: T[];
};

export function createEditHistory<T>(present: T): EditHistoryState<T> {
  return { past: [], present, future: [] };
}

/** 最新200操作を残す。各スナップショットの内容は複製せず構造共有を保つ。 */
function appendPast<T>(past: T[], present: T): T[] {
  return [...past.slice(-(EDIT_HISTORY_LIMIT - 1)), present];
}

export function setHistoryPresent<T>(current: EditHistoryState<T>, value: T): EditHistoryState<T> {
  if (Object.is(value, current.present)) return current;
  return { past: appendPast(current.past, current.present), present: value, future: [] };
}

/** テキストの同一編集セッション内の追加入力は、Undoの操作数を増やさない。 */
export function replaceHistoryPresent<T>(current: EditHistoryState<T>, value: T): EditHistoryState<T> {
  if (Object.is(value, current.present)) return current;
  return { past: current.past, present: value, future: [] };
}

export function undoEditHistory<T>(current: EditHistoryState<T>): EditHistoryState<T> {
  if (!current.past.length) return current;
  return {
    past: current.past.slice(0, -1),
    present: current.past[current.past.length - 1],
    future: [current.present, ...current.future],
  };
}

export function redoEditHistory<T>(current: EditHistoryState<T>): EditHistoryState<T> {
  if (!current.future.length) return current;
  const [next, ...rest] = current.future;
  return { past: appendPast(current.past, current.present), present: next, future: rest };
}
