import test from "node:test";
import assert from "node:assert/strict";
import { timelineBladePoint } from "../src/lib/timelineBladeCut.ts";
const block = { sceneId: "merged", sceneIndex: 0, timelineStartMs: 1000, timelineEndMs: 4000, sourceStartMs: 0, speed: 1, telopText: "前後" };
const ranges = [
  { sourceStartMs: 0, sourceEndMs: 1000, timelineStartMs: 1000, timelineEndMs: 2000 },
  { sourceStartMs: 3000, sourceEndMs: 7000, timelineStartMs: 2000, timelineEndMs: 4000, speed: 2 },
];
test("timeline blade: maps merged cut gaps and playback speed without restoring skipped source", () => {
  assert.deepEqual(timelineBladePoint(block, 50, .1, ranges), { timelineMs: 1500, sourceMs: 500 });
  assert.deepEqual(timelineBladePoint(block, 150, .1, ranges), { timelineMs: 2500, sourceMs: 4000 });
  assert.deepEqual(timelineBladePoint(block, 100, .1, ranges), { timelineMs: 2000, sourceMs: 3000 });
});
test("timeline blade: existing edges and outside coordinates never split neighboring clips", () => {
  for (const offset of [-100, 0, 300, 350, NaN]) assert.equal(timelineBladePoint(block, offset, .1, ranges), null);
});
test("timeline blade: preview and click use one output frame boundary with zoom invariant source timing", () => {
  assert.deepEqual(timelineBladePoint(block, 51.2, .1, ranges), { timelineMs: 1500, sourceMs: 500 });
  assert.deepEqual(timelineBladePoint(block, 102.4, .2, ranges), { timelineMs: 1500, sourceMs: 500 });
  assert.deepEqual(timelineBladePoint(block, 53, .1, ranges, 25), { timelineMs: 1520, sourceMs: 520 });
});
test("timeline blade: unavailable timeline mappings and invalid scales do nothing", () => {
  assert.equal(timelineBladePoint(block, 100, 0, ranges), null);
  assert.equal(timelineBladePoint(block, 100, .1, []), null);
});
