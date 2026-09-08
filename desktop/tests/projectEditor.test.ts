import test from "node:test";
import assert from "node:assert/strict";
import {
  createProjectEditor,
  deleteEditorSelection,
  emptyEditorDocument,
  resolveEditorSelection,
  type EditorDocument,
} from "../src/lib/projectEditor.ts";
import { deriveKeepSegments, isSceneFullyDeleted, setSceneTelopText, type Scene } from "../src/lib/scenes.ts";
import type { EditorSelection } from "../src/lib/editorSelection.ts";

function scene(id: string, startMs: number): Scene {
  return {
    id, sourceStartMs: startMs, sourceEndMs: startMs + 1000,
    words: [{ id: `${id}_word`, text: "表示本文", startMs, endMs: startMs + 1000, deleted: false }],
    telopText: "表示本文", telopEdited: false, cutMarks: [],
  };
}

function imageClip(id = "image_a") {
  return {
    id, file: `${id}.png`, start_ms: 0, end_ms: 1000,
    x: 0.5, y: 0.35, scale: 0.55, opacity: 1, url: `http://preview/${id}.png`,
  };
}

function bgmClip(id = "bgm_a") {
  return {
    id, file: `${id}.wav`, start_ms: 0, end_ms: 2000,
    volume: 1, fade_in_ms: 500, fade_out_ms: 500,
    url: `http://preview/${id}.wav`, audioDurationMs: 2000,
  };
}

function fixture() {
  const initial: EditorDocument = {
    scenes: [scene("scene_a", 0), scene("scene_b", 1000)],
    images: { clips: [imageClip(), imageClip("image_b")], timelineDurationMs: 2000 },
    bgm: { clips: [bgmClip(), bgmClip("bgm_b")], timelineDurationMs: 2000 },
  };
  const editor = createProjectEditor();
  editor.hydrate("/synthetic/run-a", initial);
  return { editor, initial };
}

test("four track deletions form one chronological Undo/Redo history", () => {
  const { editor, initial } = fixture();
  const snapshots = [initial];
  const selections: EditorSelection[] = [
    { kind: "image", id: "image_a" }, { kind: "bgm", id: "bgm_a" },
    { kind: "telop", id: "scene_b" }, { kind: "video", id: "scene_a" },
  ];
  for (const selection of selections) {
    const before = editor.getSnapshot().history;
    editor.select(selection);
    assert.equal(editor.getSnapshot().history, before, "selection alone must not consume Undo");
    editor.deleteSelected();
    snapshots.push(editor.getSnapshot().document);
  }
  assert.equal(editor.getSnapshot().history.past.length, 4);
  assert.equal(editor.getSnapshot().document.images!.clips.length, 1);
  assert.equal(editor.getSnapshot().document.bgm!.clips.length, 1);
  assert.equal(editor.getSnapshot().document.scenes[1].telopText, "");
  assert.equal(isSceneFullyDeleted(editor.getSnapshot().document.scenes[0]), true);
  for (let index = snapshots.length - 2; index >= 0; index--) {
    editor.undo();
    assert.equal(editor.getSnapshot().document, snapshots[index]);
  }
  for (let index = 1; index < snapshots.length; index++) {
    editor.redo();
    assert.equal(editor.getSnapshot().document, snapshots[index]);
  }
});

test("Delete changes only the selected track and telop deletion preserves video timing", () => {
  const { initial } = fixture();
  const telop = deleteEditorSelection(initial, { kind: "telop", id: "scene_a" });
  assert.equal(telop.scenes[0].telopText, "");
  assert.equal(telop.scenes[0].telopEdited, true);
  assert.equal(telop.scenes[0].words, initial.scenes[0].words);
  assert.deepEqual(deriveKeepSegments(telop.scenes), deriveKeepSegments(initial.scenes));
  assert.equal(telop.images, initial.images);
  assert.equal(telop.bgm, initial.bgm);

  const video = deleteEditorSelection(initial, { kind: "video", id: "scene_a" });
  assert.equal(isSceneFullyDeleted(video.scenes[0]), true);
  assert.deepEqual(deriveKeepSegments(video.scenes), deriveKeepSegments([initial.scenes[1]]));
  assert.equal(video.scenes[1], initial.scenes[1]);
  assert.equal(video.images, initial.images);
  assert.equal(video.bgm, initial.bgm);

  const image = deleteEditorSelection(initial, { kind: "image", id: "image_a" });
  assert.deepEqual(image.images!.clips, [initial.images!.clips[1]]);
  assert.equal(image.scenes, initial.scenes);
  assert.equal(image.bgm, initial.bgm);
  const bgm = deleteEditorSelection(initial, { kind: "bgm", id: "bgm_a" });
  assert.deepEqual(bgm.bgm!.clips, [initial.bgm!.clips[1]]);
  assert.equal(bgm.scenes, initial.scenes);
  assert.equal(bgm.images, initial.images);
});

test("Delete without a live target and repeated Delete are no-ops for all tracks", () => {
  for (const selection of [
    { kind: "image", id: "image_a" }, { kind: "bgm", id: "bgm_a" },
    { kind: "telop", id: "scene_a" }, { kind: "video", id: "scene_a" },
  ] as EditorSelection[]) {
    const { editor, initial } = fixture();
    editor.deleteSelected();
    assert.equal(editor.getSnapshot().document, initial);
    editor.select(selection);
    editor.deleteSelected();
    const after = editor.getSnapshot().history;
    editor.deleteSelected();
    assert.equal(editor.getSnapshot().history, after, `${selection!.kind} repeated Delete`);
    editor.select({ kind: selection!.kind, id: "missing" });
    editor.deleteSelected();
    assert.equal(editor.getSnapshot().history, after);
  }
  assert.equal(deleteEditorSelection(emptyEditorDocument(), null).scenes.length, 0);
});

test("many image and BGM drag previews each become a single committed Undo step", () => {
  for (const key of ["images", "bgm"] as const) {
    const { editor, initial } = fixture();
    const state = initial[key]!;
    for (let step = 1; step <= 30; step++) {
      editor.changeMedia(key, {
        ...state, clips: state.clips.map((clip) => ({ ...clip, start_ms: step, end_ms: 1000 + step })),
      }, "preview");
      assert.equal(editor.getSnapshot().history.present, initial);
      assert.equal(editor.getSnapshot().history.past.length, 0);
    }
    const final = editor.getSnapshot().document[key]!;
    editor.changeMedia(key, final, "commit");
    assert.equal(editor.getSnapshot().preview, null);
    assert.equal(editor.getSnapshot().history.past.length, 1);
    assert.equal(editor.getSnapshot().document[key], final);
    editor.undo();
    assert.equal(editor.getSnapshot().document, initial);
    editor.redo();
    assert.equal(editor.getSnapshot().document[key], final);
  }
});

test("cancelled, reverted and same-value gestures do not consume history or clear Redo", () => {
  const { editor, initial } = fixture();
  const moved = { ...initial.images!, clips: initial.images!.clips.map((clip) => ({ ...clip, x: 0.7 })) };
  editor.changeMedia("images", moved);
  editor.undo();
  const history = editor.getSnapshot().history;
  editor.changeMedia("images", moved, "preview");
  editor.cancelPreview();
  assert.equal(editor.getSnapshot().history, history);
  assert.equal(editor.getSnapshot().document, initial);
  editor.changeMedia("images", moved, "preview");
  editor.changeMedia("images", structuredClone(initial.images!), "commit");
  assert.equal(editor.getSnapshot().history, history);
  assert.equal(editor.getSnapshot().preview, null);
  editor.changeMedia("images", structuredClone(initial.images!));
  editor.setScenes((scenes) => scenes);
  assert.equal(editor.getSnapshot().history, history);
  editor.redo();
  assert.equal(editor.getSnapshot().document.images, moved);
});

test("Undo or Redo during an unfinished gesture first cancels the preview", () => {
  const { editor, initial } = fixture();
  const moved = { ...initial.images!, clips: initial.images!.clips.map((clip) => ({ ...clip, x: 0.7 })) };
  editor.changeMedia("images", moved);
  const committed = editor.getSnapshot().document;
  editor.changeMedia("images", initial.images!, "preview");
  editor.undo();
  assert.equal(editor.getSnapshot().document, committed);
  assert.equal(editor.getSnapshot().history.past.length, 1);
  editor.undo();
  assert.equal(editor.getSnapshot().document, initial);
  editor.changeMedia("images", moved, "preview");
  editor.redo();
  assert.equal(editor.getSnapshot().document, initial);
  assert.equal(editor.getSnapshot().history.future.length, 1);
  editor.redo();
  assert.equal(editor.getSnapshot().document, committed);
});

test("switching selection commits the active drag once before the next edit", () => {
  const { editor, initial } = fixture();
  editor.select({ kind: "image", id: "image_a" });
  const moved = { ...initial.images!, clips: initial.images!.clips.map((clip) => ({ ...clip, x: 0.7 })) };
  editor.changeMedia("images", moved, "preview");
  editor.select({ kind: "bgm", id: "bgm_a" });
  assert.equal(editor.getSnapshot().history.past.length, 1);
  assert.equal(editor.getSnapshot().document.images, moved);
  editor.deleteSelected();
  assert.equal(editor.getSnapshot().history.past.length, 2);
  editor.undo();
  assert.equal(editor.getSnapshot().document.images, moved);
  assert.equal(editor.getSnapshot().document.bgm, initial.bgm);
  editor.undo();
  assert.equal(editor.getSnapshot().document, initial);
});

test("a different track commit preserves the existing preview as its own Undo step", () => {
  const { editor, initial } = fixture();
  const moved = { ...initial.images!, clips: initial.images!.clips.map((clip) => ({ ...clip, x: 0.7 })) };
  const volume = { ...initial.bgm!, clips: initial.bgm!.clips.map((clip) => ({ ...clip, volume: 0.4 })) };
  editor.changeMedia("images", moved, "preview");
  editor.changeMedia("bgm", volume, "commit");
  assert.equal(editor.getSnapshot().document.images, moved);
  assert.equal(editor.getSnapshot().document.bgm, volume);
  assert.equal(editor.getSnapshot().history.past.length, 2);
  editor.undo();
  assert.equal(editor.getSnapshot().document.images, moved);
  assert.equal(editor.getSnapshot().document.bgm, initial.bgm);
  editor.undo();
  assert.equal(editor.getSnapshot().document, initial);
});

test("starting a different track preview preserves the first drag and cancellation affects only the second", () => {
  const { editor, initial } = fixture();
  const moved = { ...initial.images!, clips: initial.images!.clips.map((clip) => ({ ...clip, x: 0.7 })) };
  const volume = { ...initial.bgm!, clips: initial.bgm!.clips.map((clip) => ({ ...clip, volume: 0.4 })) };
  editor.changeMedia("images", moved, "preview");
  editor.changeMedia("bgm", volume, "preview");
  assert.equal(editor.getSnapshot().history.past.length, 1);
  assert.equal(editor.getSnapshot().document.images, moved);
  editor.cancelPreview();
  assert.equal(editor.getSnapshot().document.images, moved);
  assert.equal(editor.getSnapshot().document.bgm, initial.bgm);
  editor.undo();
  assert.equal(editor.getSnapshot().document, initial);
});

test("mixed editing retains only the latest 200 operations and branching discards Redo", () => {
  const { editor, initial } = fixture();
  const snapshots = [initial];
  for (let step = 1; step <= 205; step++) {
    const current = editor.getSnapshot().document;
    switch (step % 4) {
      case 0:
        editor.setScenes((scenes) => setSceneTelopText(scenes, "scene_a", `編集${step}`));
        break;
      case 1:
        editor.setScenes((scenes) => scenes.map((item) => item.id === "scene_b"
          ? { ...item, cutMarks: [1000 + step] } : item));
        break;
      case 2:
        editor.changeMedia("images", {
          ...current.images!, clips: current.images!.clips.map((clip) => ({ ...clip, x: step / 1000 })),
        });
        break;
      case 3:
        editor.changeMedia("bgm", {
          ...current.bgm!, clips: current.bgm!.clips.map((clip) => ({ ...clip, volume: 1 - step / 1000 })),
        });
        break;
    }
    snapshots.push(editor.getSnapshot().document);
  }
  assert.equal(editor.getSnapshot().history.past.length, 200);
  for (let step = 204; step >= 5; step--) {
    editor.undo();
    assert.equal(editor.getSnapshot().document, snapshots[step]);
  }
  editor.undo();
  assert.equal(editor.getSnapshot().document, snapshots[5]);
  for (let step = 6; step <= 205; step++) {
    editor.redo();
    assert.equal(editor.getSnapshot().document, snapshots[step]);
  }
  editor.undo();
  editor.select({ kind: "image", id: "image_a" });
  editor.deleteSelected();
  assert.equal(editor.getSnapshot().history.future.length, 0);
  assert.equal(editor.getSnapshot().history.past.length, 200);
});

test("telop edits within one text session retain one Undo while preserving media", () => {
  const { editor, initial } = fixture();
  editor.setScenes((scenes) => setSceneTelopText(scenes, "scene_a", "編"));
  editor.setScenes((scenes) => setSceneTelopText(scenes, "scene_a", "編集途中"), true);
  editor.setScenes((scenes) => setSceneTelopText(scenes, "scene_a", "編集完了"), true);
  assert.equal(editor.getSnapshot().history.past.length, 1);
  assert.equal(editor.getSnapshot().document.images, initial.images);
  assert.equal(editor.getSnapshot().document.bgm, initial.bgm);
  editor.undo();
  assert.equal(editor.getSnapshot().document, initial);
  editor.redo();
  assert.equal(editor.getSnapshot().document.scenes[0].telopText, "編集完了");
});

test("late image import preserves newer edits and never resurrects previously known deleted IDs", async () => {
  const { editor, initial } = fixture();
  let deliver!: (value: NonNullable<EditorDocument["images"]>) => void;
  const pending = new Promise<NonNullable<EditorDocument["images"]>>((resolve) => { deliver = resolve; })
    .then((state) => editor.changeMedia("images", state, "import"));
  // One clip existed at hydration; a second was committed and deleted while import was pending.
  editor.select({ kind: "image", id: "image_a" });
  editor.deleteSelected();
  editor.changeMedia("images", {
    ...initial.images!, clips: [imageClip("image_b"), imageClip("image_c")],
  });
  editor.select({ kind: "image", id: "image_c" });
  editor.deleteSelected();
  const movedB = { ...imageClip("image_b"), x: 0.8 };
  editor.changeMedia("images", { ...initial.images!, clips: [movedB] });
  const beforeImport = editor.getSnapshot().document;
  deliver({ ...initial.images!, clips: [imageClip(), imageClip("image_b"), imageClip("image_c"), imageClip("image_d")] });
  await pending;
  assert.deepEqual(editor.getSnapshot().document.images!.clips, [movedB, imageClip("image_d")]);
  editor.undo();
  assert.equal(editor.getSnapshot().document, beforeImport);
  editor.redo();
  assert.deepEqual(editor.getSnapshot().document.images!.clips, [movedB, imageClip("image_d")]);
});

test("late BGM import preserves volume and removed clips while appending only new IDs", () => {
  const { editor, initial } = fixture();
  editor.select({ kind: "bgm", id: "bgm_a" });
  editor.deleteSelected();
  const quieter = { ...bgmClip("bgm_b"), volume: 0.3 };
  editor.changeMedia("bgm", { ...initial.bgm!, clips: [quieter] });
  const beforeImport = editor.getSnapshot().document;
  editor.changeMedia("bgm", {
    ...initial.bgm!, clips: [bgmClip(), bgmClip("bgm_b"), bgmClip("bgm_new")],
  }, "import");
  assert.deepEqual(editor.getSnapshot().document.bgm!.clips, [quieter, bgmClip("bgm_new")]);
  editor.undo();
  assert.equal(editor.getSnapshot().document, beforeImport);
});

test("a duplicate delayed import after Undo cannot reapply the undone addition or erase Redo", () => {
  const { editor, initial } = fixture();
  const imported = { ...initial.images!, clips: [...initial.images!.clips, imageClip("image_new")] };
  editor.changeMedia("images", imported, "import");
  editor.undo();
  const history = editor.getSnapshot().history;
  editor.changeMedia("images", imported, "import");
  assert.equal(editor.getSnapshot().history, history);
  editor.redo();
  assert.equal(editor.getSnapshot().document.images!.clips.at(-1)!.id, "image_new");
});

test("run hydration resets selection, gestures, histories, and known import IDs", () => {
  const { editor, initial } = fixture();
  editor.select({ kind: "image", id: "image_a" });
  editor.deleteSelected();
  editor.changeMedia("images", initial.images!, "preview");
  const next: EditorDocument = { scenes: [], images: { clips: [], timelineDurationMs: 1000 }, bgm: null };
  editor.hydrate("/synthetic/run-b", next);
  assert.equal(editor.getSnapshot().document, next);
  assert.equal(editor.getSnapshot().selection, null);
  assert.equal(editor.getSnapshot().preview, null);
  assert.equal(editor.getSnapshot().history.past.length, 0);
  assert.equal(editor.getSnapshot().history.future.length, 0);
  editor.changeMedia("images", { clips: [imageClip()], timelineDurationMs: 1000 }, "import");
  assert.equal(editor.getSnapshot().document.images!.clips.length, 1);
  editor.undo();
  assert.equal(editor.getSnapshot().document, next);
});

test("selection resolution suppresses missing/deleted targets without switching to another track", () => {
  const { initial } = fixture();
  for (const selection of [
    { kind: "video", id: "scene_a" }, { kind: "image", id: "image_a" }, { kind: "bgm", id: "bgm_a" },
  ] as EditorSelection[]) {
    assert.equal(resolveEditorSelection(initial, selection), selection);
    assert.equal(resolveEditorSelection(deleteEditorSelection(initial, selection), selection), null);
  }
  assert.equal(resolveEditorSelection(initial, { kind: "bgm", id: "image_a" }), null);
  assert.equal(resolveEditorSelection(initial, null), null);
});
