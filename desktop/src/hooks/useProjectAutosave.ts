import { useCallback, useEffect, useMemo, useRef } from "react";
import { createProjectAutosave, type ProjectSaveSnapshot } from "../lib/projectAutosave";

type DraftSaveStatus = {
  state: "idle" | "saving" | "saved" | "error";
  savedAt?: string;
};

export function useProjectAutosave(
  snapshot: ProjectSaveSnapshot | null,
  onStatus: (status: DraftSaveStatus) => void,
  onError: () => void,
) {
  const current = useRef(snapshot);
  current.current = snapshot;
  const callbacks = useRef({ onStatus, onError });
  callbacks.current = { onStatus, onError };
  const queue = useMemo(() => createProjectAutosave({
    api: {
      saveSceneEditsDraft: (value) => window.catcut.saveSceneEditsDraft(value),
      saveImages: (value) => window.catcut.saveImages(value),
      saveBgm: (value) => window.catcut.saveBgm(value),
    },
    onSaved: (value) => {
      const latest = current.current;
      if (!latest || latest.draft !== value.draft || latest.images !== value.images || latest.bgm !== value.bgm) return;
      callbacks.current.onStatus({ state: "saved", savedAt: new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) });
    },
    onError: (_error, value) => {
      if (current.current?.draft.runDir !== value.draft.runDir) return;
      callbacks.current.onStatus({ state: "error" });
      callbacks.current.onError();
    },
  }), []);
  useEffect(() => {
    if (!snapshot) return;
    callbacks.current.onStatus({ state: "saving" });
    queue.schedule(snapshot.draft.runDir, snapshot);
  }, [snapshot, queue]);
  return useCallback(async (latest: ProjectSaveSnapshot | null = current.current) => {
    if (!latest) throw new Error("編集データの読み込みが完了していません。");
    current.current = latest;
    callbacks.current.onStatus({ state: "saving" });
    queue.schedule(latest.draft.runDir, latest);
    await queue.flush(latest.draft.runDir);
  }, [queue]);
}
