import test from "node:test";
import assert from "node:assert/strict";
import {
  computeEdgeDragSceneOverrides,
  computeEdgeDragVisual,
  computeLinkedNextSceneIds,
} from "../src/lib/edgeDragVisual.ts";
import { applyEdgeTrim } from "../src/lib/edgeTrim.ts";
import type { Scene, SceneWord } from "../src/lib/scenes.ts";

function word(id: string, text: string, startMs: number, endMs: number, deleted = false): SceneWord {
  return { id, text, startMs, endMs, deleted };
}

function scene(id: string, sourceStartMs: number, sourceEndMs: number, words: SceneWord[]): Scene {
  return {
    id,
    sourceStartMs,
    sourceEndMs,
    words,
    telopText: words.filter((w) => !w.deleted).map((w) => w.text).join(""),
    telopEdited: false,
    cutMarks: [],
  };
}

/** s1(0-1000)とs2(1000-2000)は連動、s3(2500-3000)は独立。 */
function makeScenes(): Scene[] {
  return [
    scene("s1", 0, 1000, [word("w1", "あ", 0, 1000)]),
    scene("s2", 1000, 2000, [word("w2", "い", 1000, 2000)]),
    scene("s3", 2500, 3000, [word("w3", "う", 2500, 3000)]),
  ];
}

// --- computeLinkedNextSceneIds ---

test("computeLinkedNextSceneIds: 次の行と連続しているシーンidだけを含む", () => {
  const ids = computeLinkedNextSceneIds(makeScenes());
  assert.deepEqual([...ids].sort(), ["s1"]);
});

test("computeLinkedNextSceneIds: 空配列なら空集合", () => {
  assert.equal(computeLinkedNextSceneIds([]).size, 0);
});

// --- computeEdgeDragVisual ---

test("computeEdgeDragVisual: ドラッグしていなければnull", () => {
  const scenes = makeScenes();
  assert.equal(computeEdgeDragVisual(scenes, null, null), null);
});

test("computeEdgeDragVisual: 連動ロール中は隣接行のidと逆側の端が入る", () => {
  const scenes = makeScenes();
  const edgeDrag = { sceneId: "s1", edge: "end" as const, rawTargetMs: 800, chipSnapToleranceMs: 0 };
  const preview = applyEdgeTrim(scenes, 0, "end", 800, { chipSnapToleranceMs: 0 });
  const visual = computeEdgeDragVisual(scenes, edgeDrag, preview);
  assert.ok(visual);
  assert.equal(visual.sceneId, "s1");
  assert.equal(visual.tooltip.edge, "end");
  assert.equal(visual.neighborSceneId, "s2");
  assert.equal(visual.neighborHighlightEdge, "start");
});

test("computeEdgeDragVisual: 独立トリムでは隣接情報がnull", () => {
  const scenes = makeScenes();
  const edgeDrag = { sceneId: "s3", edge: "start" as const, rawTargetMs: 2600, chipSnapToleranceMs: 0 };
  const preview = applyEdgeTrim(scenes, 2, "start", 2600, { chipSnapToleranceMs: 0 });
  const visual = computeEdgeDragVisual(scenes, edgeDrag, preview);
  assert.ok(visual);
  assert.equal(visual.sceneId, "s3");
  assert.equal(visual.neighborSceneId, null);
  assert.equal(visual.neighborHighlightEdge, null);
});

test("computeEdgeDragVisual: ツールチップは適用後の移動量ラベルを持つ", () => {
  const scenes = makeScenes();
  const edgeDrag = { sceneId: "s1", edge: "end" as const, rawTargetMs: 800, chipSnapToleranceMs: 0 };
  const preview = applyEdgeTrim(scenes, 0, "end", 800, { chipSnapToleranceMs: 0 });
  const visual = computeEdgeDragVisual(scenes, edgeDrag, preview);
  assert.ok(visual);
  // 1000ms→800ms(20msグリッド)なので-0.20s。ラベル書式自体はformatEdgeTrimDeltaのテストで担保。
  assert.match(visual.tooltip.label, /^-0\.20/);
});

// --- computeEdgeDragSceneOverrides ---

test("computeEdgeDragSceneOverrides: 連動ロールでは対象行+隣接行の2件だけを含む", () => {
  const scenes = makeScenes();
  const edgeDrag = { sceneId: "s1", edge: "end" as const, rawTargetMs: 800, chipSnapToleranceMs: 0 };
  const preview = applyEdgeTrim(scenes, 0, "end", 800, { chipSnapToleranceMs: 0 });
  const overrides = computeEdgeDragSceneOverrides(edgeDrag, preview);
  assert.ok(overrides);
  assert.deepEqual([...overrides.keys()].sort(), ["s1", "s2"]);
  assert.equal(overrides.get("s1")?.sourceEndMs, preview.appliedMs);
  assert.equal(overrides.get("s2")?.sourceStartMs, preview.appliedMs);
});

test("computeEdgeDragSceneOverrides: 独立トリムでは対象行1件だけを含む", () => {
  const scenes = makeScenes();
  const edgeDrag = { sceneId: "s3", edge: "start" as const, rawTargetMs: 2600, chipSnapToleranceMs: 0 };
  const preview = applyEdgeTrim(scenes, 2, "start", 2600, { chipSnapToleranceMs: 0 });
  const overrides = computeEdgeDragSceneOverrides(edgeDrag, preview);
  assert.ok(overrides);
  assert.deepEqual([...overrides.keys()], ["s3"]);
});

test("computeEdgeDragSceneOverrides: ドラッグしていなければnull", () => {
  assert.equal(computeEdgeDragSceneOverrides(null, null), null);
});
