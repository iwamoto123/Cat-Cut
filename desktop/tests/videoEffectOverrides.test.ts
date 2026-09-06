import assert from "node:assert/strict";
import test from "node:test";

import { deriveDirectedSlots } from "../src/lib/directedTelop.ts";
import {
  initializeScenes,
  mergeSceneWithNext,
  resetSceneIdCounterForTests,
  setSceneVideoEffectOverride,
  splitSceneAtWord,
  type SourceWord,
} from "../src/lib/scenes.ts";
import { VIDEO_EFFECT_CATALOG, videoEffectOverrideLabel } from "../src/lib/videoEffectCatalog.ts";

function words(): SourceWord[] {
  return [
    { id: "w1", text: "前半です", startMs: 0, endMs: 1000 },
    { id: "w2", text: "後半です", startMs: 1000, endMs: 2000 },
  ];
}

function buildScenes(videoEffectOverride?: "none" | "pinch" | "zoom") {
  resetSceneIdCounterForTests();
  return initializeScenes({
    words: words(),
    keepSegments: [{ startMs: 0, endMs: 2000 }],
    telopPageBoundaries: [{
      startMs: 0,
      endMs: 2000,
      text: "前半です後半です",
      styleId: "fact_yellow",
      typeId: "default",
      videoEffectOverride,
    }],
  });
}

test("映像演出カタログは自動・なし・引き締め・ズーム・W24 Phase C 3種を安定順で公開する", () => {
  assert.deepEqual(
    VIDEO_EFFECT_CATALOG.map((item) => item.id),
    [null, "none", "pinch", "zoom", "dim", "face_zoom", "slow_push"],
  );
  assert.equal(videoEffectOverrideLabel(undefined), "自動");
  assert.equal(videoEffectOverrideLabel("pinch"), "引き締め");
  assert.equal(videoEffectOverrideLabel("dim"), "暗転強調");
  assert.equal(videoEffectOverrideLabel("face_zoom"), "顔ズーム");
  assert.equal(videoEffectOverrideLabel("slow_push"), "ゆっくり寄り");
});

test("初期化・setter・deriveDirectedSlotsで手動映像演出を往復する", () => {
  const restored = buildScenes("zoom");
  assert.equal(restored[0].videoEffectOverride, "zoom");
  const updated = setSceneVideoEffectOverride(restored, restored[0].id, "none");
  assert.equal(deriveDirectedSlots(updated)[0].videoEffectOverride, "none");
  const automatic = setSceneVideoEffectOverride(updated, updated[0].id, null);
  assert.equal(deriveDirectedSlots(automatic)[0].videoEffectOverride, undefined);
});

test("splitは両方へ継承し、mergeは先頭シーンの指定を優先する", () => {
  const split = splitSceneAtWord(buildScenes("pinch"), "scene_0001", "w2");
  assert.deepEqual(split.map((scene) => scene.videoEffectOverride), ["pinch", "pinch"]);

  const firstAuto = setSceneVideoEffectOverride(split, split[0].id, null);
  const secondZoom = setSceneVideoEffectOverride(firstAuto, firstAuto[1].id, "zoom");
  const merged = mergeSceneWithNext(secondZoom, secondZoom[0].id);
  assert.equal(merged[0].videoEffectOverride, null, "先頭が自動なら後半の手動指定へ切り替えない");
});
