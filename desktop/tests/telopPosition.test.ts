import test from "node:test";
import assert from "node:assert/strict";
import { clampTelopPosition, moveTelopPosition, normalizeTelopPosition, resolveTelopPositionAt, telopPositionBounds, type TelopPositionGeometry } from "../src/lib/telopPosition.ts";
import { deriveKeepSegments, initializeScenes, mergeSceneWithNext, setSceneTelopPosition, splitSceneAtMs, splitSceneAtWord, type Scene } from "../src/lib/scenes.ts";
import { deriveDirectedSlots } from "../src/lib/directedTelop.ts";

const geometry: TelopPositionGeometry = { lineTexts: ["配置を確認"], fontSize: 72, lineHeight: 1.4, letterSpacingEm: 0.02, videoWidth: 1920, videoHeight: 1080 };
const scene: Scene = { id: "s1", sourceStartMs: 0, sourceEndMs: 2000, words: [{ id: "w1", text: "前半です", startMs: 0, endMs: 900, deleted: false }, { id: "w2", text: "後半です", startMs: 1100, endMs: 2000, deleted: false }], sourceKeepRanges: [{ startMs: 0, endMs: 600 }, { startMs: 1400, endMs: 2000 }], telopText: "前半です後半です", telopEdited: true, cutMarks: [] };

test("positions reject malformed values and normalize finite ratios", () => {
  for (const raw of [undefined, null, {}, { x: "0.3", y: 0.4 }, { x: NaN, y: 0 }, { x: 0.5, y: Infinity }]) assert.equal(normalizeTelopPosition(raw), undefined);
  assert.deepEqual(normalizeTelopPosition({ x: -4, y: 1.5 }), { x: 0, y: 1 });
});
test("shorter text has more horizontal travel; multiline and rotation retain margins", () => {
  const shortBounds = telopPositionBounds(geometry);
  const longBounds = telopPositionBounds({ ...geometry, lineTexts: ["配置を確認するための長い文章です"] });
  assert.ok(shortBounds.minX < longBounds.minX);
  const multiline = telopPositionBounds({ ...geometry, lineTexts: ["配置を確認", "二行目です"], rotateDeg: -12, paddingX: 24, paddingY: 15, strokePx: 10 });
  assert.ok(multiline.minY > shortBounds.minY);
  const pos = clampTelopPosition({ x: 0, y: 1 }, geometry);
  assert.equal(pos.x, shortBounds.minX); assert.equal(pos.y, shortBounds.maxY);
});
test("portrait and landscape drag uses the displayed canvas scale and remains inside bounds", () => {
  for (const g of [geometry, { ...geometry, videoWidth: 1080, videoHeight: 1920 }]) {
    const pos = moveTelopPosition({ x: 0.5, y: 0.5 }, 40, -25, 400, 500, g);
    assert.equal(pos.x, 0.6); assert.equal(pos.y, 0.45);
    const edge = moveTelopPosition(pos, 2000, -2000, 400, 500, g);
    const bounds = telopPositionBounds(g);
    assert.equal(edge.x, bounds.maxX); assert.equal(edge.y, bounds.minY);
  }
});
test("explicit range/reset applies at exact boundaries and gaps keep individual fallback", () => {
  const ranges = [{ start: 0, end: 1, position: { x: 0.2, y: 0.3 } }, { start: 1, end: 2, position: null }];
  const fallback = { x: 0.7, y: 0.8 };
  assert.deepEqual(resolveTelopPositionAt(ranges, 0.999, fallback), ranges[0].position);
  assert.equal(resolveTelopPositionAt(ranges, 1, fallback), undefined);
  assert.deepEqual(resolveTelopPositionAt(ranges, 2, fallback), fallback);
  assert.deepEqual(resolveTelopPositionAt(undefined, 0, fallback), fallback);
  const many = Array.from({ length: 10000 }, (_, i) => ({ start: i, end: i + 1, position: { x: 0.5, y: i / 10000 } }));
  assert.deepEqual(resolveTelopPositionAt(many, 9000.5, fallback), many[9000].position);
});
test("one/all position changes are immutable, no-op safe, serializable and preserve cuts", () => {
  const old = [scene, { ...scene, id: "s2", telopPosition: { x: 0.3, y: 0.4 } }];
  const keep = deriveKeepSegments(old);
  const edited = setSceneTelopPosition(old, "s1", { x: 0.6, y: 0.7 });
  assert.equal(edited[1], old[1]); assert.equal(old[0].telopPosition, undefined);
  assert.deepEqual(deriveKeepSegments(edited), keep);
  assert.equal(setSceneTelopPosition(edited, "s1", { x: 0.6, y: 0.7 }), edited);
  const saved = JSON.parse(JSON.stringify(edited));
  assert.deepEqual(saved[0].telopPosition, { x: 0.6, y: 0.7 });
  const all = setSceneTelopPosition(saved, null, { x: 0.5, y: 0.8 });
  assert.ok(all.every((s) => s.telopPosition?.y === 0.8));
  const reset = setSceneTelopPosition(all, null, null);
  assert.ok(reset.every((s) => !("telopPosition" in s)));
  assert.equal(setSceneTelopPosition(reset, null, null), reset);
});
test("split inherits manual position; merge uses first position without restoring cut media", () => {
  const positioned = { ...scene, telopPosition: { x: 0.6, y: 0.7 } };
  for (const split of [splitSceneAtMs([positioned], "s1", 1000), splitSceneAtWord([positioned], "s1", "w2")]) {
    assert.equal(split.length, 2); assert.ok(split.every((s) => s.telopPosition?.x === 0.6));
    const merged = mergeSceneWithNext(split, split[0].id);
    assert.deepEqual(merged[0].telopPosition, positioned.telopPosition);
    assert.deepEqual(deriveKeepSegments(merged), deriveKeepSegments([positioned]));
  }
});
test("legacy stays automatic and pipeline position restores independent of style metadata", () => {
  const input = { words: scene.words, keepSegments: [{ startMs: 0, endMs: 2000 }] };
  const legacy = initializeScenes(input);
  assert.ok(legacy.every((s) => !s.telopPosition));
  const scenes = initializeScenes({ ...input, telopPageBoundaries: [{ startMs: 0, endMs: 2000, text: scene.telopText, telopPosition: { x: 0.25, y: 0.7 } }] });
  assert.deepEqual(scenes[0].telopPosition, { x: 0.25, y: 0.7 });
  assert.deepEqual(deriveDirectedSlots(scenes)[0].telopPosition, scenes[0].telopPosition);
});
