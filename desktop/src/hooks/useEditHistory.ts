import { useCallback, useMemo, useState } from "react";

type HistoryState<T> = {
  past: T[];
  present: T;
  future: T[];
};

export function useEditHistory<T>(initialPresent: T) {
  const [history, setHistory] = useState<HistoryState<T>>({
    past: [],
    present: initialPresent,
    future: [],
  });

  const setPresent = useCallback((next: T | ((current: T) => T)) => {
    setHistory((current) => {
      const value = typeof next === "function" ? (next as (input: T) => T)(current.present) : next;
      if (Object.is(value, current.present)) return current;
      return {
        past: [...current.past, current.present],
        present: value,
        future: [],
      };
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
      if (Object.is(value, current.present)) return current;
      return {
        past: current.past,
        present: value,
        future: [],
      };
    });
  }, []);

  const reset = useCallback((nextPresent: T) => {
    setHistory({
      past: [],
      present: nextPresent,
      future: [],
    });
  }, []);

  const undo = useCallback(() => {
    setHistory((current) => {
      if (!current.past.length) return current;
      const previous = current.past[current.past.length - 1];
      return {
        past: current.past.slice(0, -1),
        present: previous,
        future: [current.present, ...current.future],
      };
    });
  }, []);

  const redo = useCallback(() => {
    setHistory((current) => {
      if (!current.future.length) return current;
      const [next, ...rest] = current.future;
      return {
        past: [...current.past, current.present],
        present: next,
        future: rest,
      };
    });
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
