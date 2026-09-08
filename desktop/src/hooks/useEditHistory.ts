import { useCallback, useMemo, useState } from "react";
import {
  createEditHistory,
  redoEditHistory,
  replaceHistoryPresent,
  setHistoryPresent,
  undoEditHistory,
} from "../lib/editHistory";

export function useEditHistory<T>(initialPresent: T) {
  const [history, setHistory] = useState(() => createEditHistory(initialPresent));

  const setPresent = useCallback((next: T | ((current: T) => T)) => {
    setHistory((current) => {
      const value = typeof next === "function" ? (next as (input: T) => T)(current.present) : next;
      return setHistoryPresent(current, value);
    });
  }, []);

  /**
   * W16-5: 履歴エントリを積まずに現在値だけ差し替える。テロップ編集中のキーストロークに使い、
   * 「編集セッション(focus→blur)=Undo1回」を実現する(初回入力だけsetPresentでpushする)。
   * 通常のsetPresentと同様、差し替え後のredo(future)は無効化する(標準的なエディタの挙動)。
   */
  const replacePresent = useCallback((next: T | ((current: T) => T)) => {
    setHistory((current) => {
      const value = typeof next === "function" ? (next as (input: T) => T)(current.present) : next;
      return replaceHistoryPresent(current, value);
    });
  }, []);

  const reset = useCallback((nextPresent: T) => {
    setHistory(createEditHistory(nextPresent));
  }, []);

  const undo = useCallback(() => {
    setHistory(undoEditHistory);
  }, []);

  const redo = useCallback(() => {
    setHistory(redoEditHistory);
  }, []);

  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;

  return useMemo(
    () => ({
      present: history.present,
      setPresent,
      replacePresent,
      reset,
      undo,
      redo,
      canUndo,
      canRedo,
    }),
    [canRedo, canUndo, history.present, redo, replacePresent, reset, setPresent, undo],
  );
}
