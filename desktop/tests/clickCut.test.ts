import test from "node:test";
import assert from "node:assert/strict";
import { previewClickCut } from "../src/lib/clickCut.ts";
import { cutSceneRangeMs } from "../src/lib/rangeCut.ts";
import { computeSceneKeptSubRanges, type Scene } from "../src/lib/scenes.ts";
import { createEditHistory, setHistoryPresent, undoEditHistory } from "../src/lib/editHistory.ts";

const scene: Scene = {
  id: "clicks", sourceStartMs: 0, sourceEndMs: 5000, telopText: "前後", telopEdited: false, cutMarks: [],
  words: [
    { id: "a", text: "前", startMs: 500, endMs: 1800, deleted: false },
    { id: "sil", text: "", startMs: 1800, endMs: 3200, deleted: false, silence: true },
    { id: "b", text: "後", startMs: 3200, endMs: 4500, deleted: false },
  ],
};

test("click cut: first interior incision makes a marker without splitting or consuming Undo", () => {
  const history = createEditHistory([scene]);
  const before = JSON.stringify(scene);
  const preview = previewClickCut(scene, 1800);
  assert.equal(preview.kind, "anchor");
  assert.equal(preview.pointMs, 1800);
  assert.equal(JSON.stringify(scene), before);
  assert.equal(history.past.length, 0);
});

test("click cut: second incision removes the interval in either direction with one Undo", () => {
  for (const [first, second] of [[1800, 3200], [3200, 1800]]) {
    const preview = previewClickCut(scene, second, first);
    assert.equal(preview.kind, "cut");
    assert.equal(preview.intent, "interval");
    assert.deepEqual([preview.appliedStartMs, preview.appliedEndMs], [1800, 3200]);
    const original = [scene];
    const next = cutSceneRangeMs(original, scene.id, preview.rawStartMs, preview.rawEndMs).scenes;
    assert.deepEqual(next.flatMap(computeSceneKeptSubRanges), [{ startMs: 0, endMs: 1800 }, { startMs: 3200, endMs: 5000 }]);
    const history = setHistoryPresent(createEditHistory(original), next);
    assert.equal(history.past.length, 1);
    assert.equal(undoEditHistory(history).present, original);
  }
});

test("click cut: one incision in leading or trailing non-speech trims only that edge", () => {
  const leading = previewClickCut(scene, 500);
  assert.equal(leading.kind, "cut");
  assert.equal(leading.mode, "trimStart");
  assert.deepEqual([leading.appliedStartMs, leading.appliedEndMs], [0, 500]);
  const trailing = previewClickCut(scene, 4500);
  assert.equal(trailing.kind, "cut");
  assert.equal(trailing.mode, "trimEnd");
  assert.deepEqual([trailing.appliedStartMs, trailing.appliedEndMs], [4500, 5000]);
});

test("click cut: clicking near an edge inside speech never guesses a destructive side", () => {
  const spokenEdges = { ...scene, words: [{ ...scene.words[0], startMs: 0, endMs: 5000 }] };
  for (const point of [100, 500, 2500, 4500, 4900]) assert.equal(previewClickCut(spokenEdges, point).kind, "anchor");
});

test("click cut: speechless scenes require explicit two-point intent", () => {
  for (const words of [[], [scene.words[1]]]) {
    assert.equal(previewClickCut({ ...scene, words }, 1000).kind, "anchor");
  }
});

test("click cut: already removed intervals cannot create an incision or delete more media", () => {
  const removed = previewClickCut({ ...scene, sourceKeepRanges: [{ startMs: 0, endMs: 1800 }, { startMs: 3200, endMs: 5000 }] }, 2500);
  assert.equal(removed.kind, "none");
  assert.equal(removed.unavailableReason, "removed");
  assert.equal(previewClickCut({ ...scene, words: scene.words.map((word) => ({ ...word, deleted: true })) }, 1000).kind, "none");
});

test("click cut: margin detection uses retained speech even when words cross multiple old cuts", () => {
  const clipped: Scene = {
    ...scene,
    sourceKeepRanges: [{ startMs: 0, endMs: 300 }, { startMs: 1000, endMs: 1800 }, { startMs: 3200, endMs: 5000 }],
    words: [
      { id: "b", text: "後", startMs: 3200, endMs: 4200, deleted: false },
      { id: "a", text: "前", startMs: 500, endMs: 3500, deleted: false },
    ],
  };
  assert.equal(previewClickCut(clipped, 1000).intent, "start");
  assert.equal(previewClickCut(clipped, 1600).kind, "anchor");
  assert.equal(previewClickCut(clipped, 4200).intent, "end");
  assert.equal(previewClickCut(clipped, 3600).kind, "anchor");
});

test("click cut: pending incision takes precedence over automatic edge intent", () => {
  const preview = previewClickCut(scene, 4600, 2000);
  assert.equal(preview.intent, "interval");
  assert.deepEqual([preview.appliedStartMs, preview.appliedEndMs], [2000, 4600]);
});

test("click cut: a second click under 80 ms apart cannot remove media", () => {
  for (const point of [2000, 2010, 2059]) assert.equal(previewClickCut(scene, point, 2000).kind, "none");
  assert.equal(previewClickCut(scene, 2080, 2000).kind, "cut");
});

test("click cut: hover bounds match authoritative commit with word snap and Option grid", () => {
  for (const chipSnapToleranceMs of [80, 0]) {
    const options = { chipSnapToleranceMs };
    const preview = previewClickCut(scene, 3169, 1829, options);
    const result = cutSceneRangeMs([scene], scene.id, preview.rawStartMs, preview.rawEndMs, options);
    assert.deepEqual([preview.appliedStartMs, preview.appliedEndMs, preview.mode], [result.appliedStartMs, result.appliedEndMs, result.mode]);
    assert.deepEqual([preview.appliedStartMs, preview.appliedEndMs], chipSnapToleranceMs ? [1800, 3200] : [1820, 3160]);
  }
});

test("click cut: an edge point can be the first explicit marker and invalid coordinates do nothing", () => {
  assert.equal(previewClickCut(scene, 0).kind, "anchor");
  assert.equal(previewClickCut(scene, 1000, 0).mode, "trimStart");
  assert.equal(previewClickCut(scene, NaN).kind, "none");
  assert.equal(previewClickCut(scene, 1000, Infinity).kind, "none");
});
