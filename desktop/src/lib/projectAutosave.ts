import { createDraftAutosave } from "./draftAutosave.ts";
import type { EditorDocument } from "./projectEditor.ts";

export type ProjectSaveSnapshot = {
  draft: Parameters<typeof window.catcut.saveSceneEditsDraft>[0];
  images: EditorDocument["images"];
  bgm: EditorDocument["bgm"];
};

/** Track successful writes separately so a failed track can be retried without rolling back another. */
export function createProjectAutosave(options: {
  api: Pick<typeof window.catcut, "saveSceneEditsDraft" | "saveImages" | "saveBgm">;
  onSaved?: (snapshot: ProjectSaveSnapshot) => void;
  onError?: (error: unknown, snapshot: ProjectSaveSnapshot) => void;
  delayMs?: number;
}) {
  const saved = new Map<string, Partial<ProjectSaveSnapshot>>();
  return createDraftAutosave<ProjectSaveSnapshot>({
    delayMs: options.delayMs,
    onSaved: options.onSaved,
    onError: options.onError,
    async save(snapshot) {
      const runDir = snapshot.draft.runDir;
      const previous = saved.get(runDir) ?? {};
      saved.set(runDir, previous);
      const writes: Promise<unknown>[] = [];
      if (previous.draft !== snapshot.draft) writes.push(options.api.saveSceneEditsDraft(snapshot.draft).then(() => {
        previous.draft = snapshot.draft;
      }));
      if (snapshot.images && previous.images !== snapshot.images) writes.push(options.api.saveImages({
        runDir, clips: snapshot.images.clips.map(({ url: _url, ...data }) => data),
      }).then(() => { previous.images = snapshot.images; }));
      if (snapshot.bgm && previous.bgm !== snapshot.bgm) writes.push(options.api.saveBgm({
        runDir, clips: snapshot.bgm.clips.map(({ url: _url, audioDurationMs: _duration, ...data }) => data),
      }).then(() => { previous.bgm = snapshot.bgm; }));
      // Wait for every track before retry or navigation; one rejection must not release the queue early.
      const results = await Promise.allSettled(writes);
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      // Only the open run needs a reference cache. Old runs are still serialized by createDraftAutosave.
      if (saved.size > 2) saved.delete(saved.keys().next().value!);
    },
  });
}
