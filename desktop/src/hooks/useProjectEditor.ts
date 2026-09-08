import { useMemo, useSyncExternalStore } from "react";
import { createProjectEditor, resolveEditorSelection } from "../lib/projectEditor";

export function useProjectEditor() {
  const editor = useMemo(createProjectEditor, []);
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  const sceneHistory = useMemo(() => ({
    present: state.document.scenes,
    setPresent: editor.setScenes,
    replacePresent: (next: Parameters<typeof editor.setScenes>[0]) => editor.setScenes(next, true),
    reset: editor.resetScenes,
    undo: editor.undo,
    redo: editor.redo,
    canUndo: state.history.past.length > 0 || state.preview !== null,
    canRedo: state.history.future.length > 0,
  }), [editor, state.document.scenes, state.history, state.preview]);
  return { editor, state, sceneHistory, selection: resolveEditorSelection(state.document, state.selection) };
}
