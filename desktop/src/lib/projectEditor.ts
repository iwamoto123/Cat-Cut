import {
  createEditHistory, setHistoryPresent, replaceHistoryPresent, undoEditHistory, redoEditHistory,
  type EditHistoryState,
} from "./editHistory.ts";
import { isSceneFullyDeleted, setSceneTelopText, setChipsDeleted, type Scene } from "./scenes.ts";
import type { EditorSelection, MediaEditPhase } from "./editorSelection.ts";

export type EditorImages = Awaited<ReturnType<typeof window.catcut.listImages>>;
export type EditorBgm = Awaited<ReturnType<typeof window.catcut.listBgm>>;
export type EditorDocument = { scenes: Scene[]; images: EditorImages | null; bgm: EditorBgm | null };
type MediaKey = "images" | "bgm";
type MediaPreview = { key: MediaKey; value: EditorImages | EditorBgm } | null;
export type ProjectEditorState = {
  runDir: string | null;
  history: EditHistoryState<EditorDocument>;
  document: EditorDocument;
  preview: MediaPreview;
  selection: EditorSelection;
};

export const emptyEditorDocument = (): EditorDocument => ({ scenes: [], images: null, bgm: null });

function sameMedia(a: EditorImages | EditorBgm | null, b: EditorImages | EditorBgm | null): boolean {
  // Media lists are small; ignore fresh object references from a click or cancelled gesture.
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export function deleteEditorSelection(document: EditorDocument, selection: EditorSelection): EditorDocument {
  if (!selection) return document;
  if (selection.kind === "image" || selection.kind === "bgm") {
    const key = selection.kind === "image" ? "images" : "bgm";
    const state = document[key];
    if (!state || !state.clips.some((clip) => clip.id === selection.id)) return document;
    return { ...document, [key]: { ...state, clips: state.clips.filter((clip) => clip.id !== selection.id) } };
  }
  const scene = document.scenes.find((item) => item.id === selection.id);
  if (!scene || isSceneFullyDeleted(scene)) return document;
  if (selection.kind === "telop" && scene.telopText === "") return document;
  const scenes = selection.kind === "telop"
    ? setSceneTelopText(document.scenes, scene.id, "")
    : setChipsDeleted(document.scenes, scene.id, scene.words.map((word) => word.id), true);
  return scenes === document.scenes ? document : { ...document, scenes };
}

export function resolveEditorSelection(document: EditorDocument, selection: EditorSelection): EditorSelection {
  if (!selection) return null;
  if (selection.kind === "image") return document.images?.clips.some((c) => c.id === selection.id) ? selection : null;
  if (selection.kind === "bgm") return document.bgm?.clips.some((c) => c.id === selection.id) ? selection : null;
  return document.scenes.some((scene) => scene.id === selection.id && !isSceneFullyDeleted(scene)) ? selection : null;
}

/** Synchronous store keeps overlapping UI events, drag commits and save flushes on the same snapshot. */
export function createProjectEditor() {
  const initial = emptyEditorDocument();
  let state: ProjectEditorState = {
    runDir: null, history: createEditHistory(initial), document: initial, preview: null, selection: null,
  };
  const listeners = new Set<() => void>();
  const knownIds = { images: new Set<string>(), bgm: new Set<string>() };
  function publish(next: ProjectEditorState) {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  }
  function applyHistory(history: EditHistoryState<EditorDocument>) {
    if (history === state.history && !state.preview) return;
    publish({ ...state, history, document: history.present, preview: null });
  }
  const editor = {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    hydrate(runDir: string | null, document: EditorDocument = emptyEditorDocument()) {
      for (const key of ["images", "bgm"] as const) {
        knownIds[key].clear();
        for (const clip of document[key]?.clips ?? []) knownIds[key].add(clip.id);
      }
      publish({ runDir, history: createEditHistory(document), document, preview: null, selection: null });
    },
    select(selection: EditorSelection) {
      if (state.selection?.kind === selection?.kind && state.selection?.id === selection?.id) return;
      editor.commitPreview();
      publish({ ...state, selection });
    },
    setScenes(next: Scene[] | ((current: Scene[]) => Scene[]), replace = false) {
      editor.commitPreview();
      const current = state.history.present;
      const scenes = typeof next === "function" ? next(current.scenes) : next;
      if (scenes === current.scenes) return;
      const document = { ...current, scenes };
      applyHistory(replace ? replaceHistoryPresent(state.history, document) : setHistoryPresent(state.history, document));
    },
    resetScenes(scenes: Scene[]) {
      const document = { ...state.history.present, scenes };
      applyHistory(createEditHistory(document));
    },
    changeMedia<K extends MediaKey>(key: K, value: NonNullable<EditorDocument[K]>, phase: MediaEditPhase = "commit") {
      if (state.preview && state.preview.key !== key) editor.commitPreview();
      if (phase === "preview") {
        // Only one gesture can own a preview. A different track commits the previous gesture first.
        if (state.preview && state.preview.key !== key) editor.commitPreview();
        publish({ ...state, preview: { key, value }, document: { ...state.history.present, [key]: value } });
        return;
      }
      let next = value as EditorImages | EditorBgm;
      if (phase === "import") {
        editor.commitPreview();
        // Imports return a disk snapshot. Keep any newer local edits and append only new IDs.
        const latest = state.history.present[key];
        const ids = knownIds[key];
        next = { ...value, clips: [...(latest?.clips ?? []), ...value.clips.filter((clip) => !ids.has(clip.id))] } as typeof next;
      }
      for (const clip of next.clips) knownIds[key].add(clip.id);
      const baseline = state.history.present;
      if (sameMedia(baseline[key], next)) {
        if (state.preview) publish({ ...state, document: baseline, preview: null });
        return;
      }
      applyHistory(setHistoryPresent(state.history, { ...baseline, [key]: next }));
    },
    commitPreview() {
      if (!state.preview) return;
      const { key, value } = state.preview;
      editor.changeMedia(key, value, "commit");
    },
    cancelPreview() {
      if (state.preview) publish({ ...state, preview: null, document: state.history.present });
    },
    deleteSelected() {
      editor.commitPreview();
      applyHistory(setHistoryPresent(state.history, deleteEditorSelection(state.history.present, state.selection)));
    },
    undo() {
      if (state.preview) { editor.cancelPreview(); return; }
      applyHistory(undoEditHistory(state.history));
    },
    redo() {
      if (state.preview) { editor.cancelPreview(); return; }
      applyHistory(redoEditHistory(state.history));
    },
  };
  return editor;
}
