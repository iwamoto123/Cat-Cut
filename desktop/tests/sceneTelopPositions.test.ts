import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { projectSceneTelopPositions, telopPositionForTime } = require("../main/sceneTelopPositions.cjs");

test("scene position ranges cross caption pages without splitting text or restarting animation", () => {
  const caption = { id: "c_p1", text: "表示を保ったまま位置を変えます", animation_in: "pop_big", sfx: "pop", start: 0, end: 4 };
  const composition = { voice_data: { cuts: [{ id: "c", telops: [caption] }] } };
  const keep = [{ start_ms: 1000, end_ms: 9000, speed: 2 }];
  const positions = [{ startMs: 0, endMs: 5000, telopPosition: { x: .3, y: .2 } }, { startMs: 5000, endMs: 10000 }];
  assert.equal(projectSceneTelopPositions(composition, keep, positions), true);
  const cut: any = composition.voice_data.cuts[0];
  assert.deepEqual(cut.telops, [caption]);
  assert.deepEqual(cut.telop_position_ranges, [{ start: 0, end: 2, position: { x: .3, y: .2 } }, { start: 2, end: 4, position: null }]);
  assert.deepEqual(telopPositionForTime(cut.telop_position_ranges, 1.999, { x: .9, y: .9 }), { x: .3, y: .2 });
  assert.equal(telopPositionForTime(cut.telop_position_ranges, 2, { x: .9, y: .9 }), undefined);
  assert.equal(projectSceneTelopPositions(composition, keep, positions), false);
});

test("cut gaps disappear from position timing; reset and adjacent equal ranges stay compact", () => {
  const composition: any = { voice_data: { cuts: [{ id: "a", telops: [] }, { id: "b", telops: [] }] } };
  const keep = [{ start_ms: 0, end_ms: 2000 }, { start_ms: 5000, end_ms: 8000 }];
  const positions = [{ startMs: 0, endMs: 6000, telopPosition: { x: .5, y: .7 } }, { startMs: 6000, endMs: 8000, telopPosition: { x: .5, y: .7 } }];
  projectSceneTelopPositions(composition, keep, positions);
  assert.deepEqual(composition.voice_data.cuts[1].telop_position_ranges, [{ start: 0, end: 3, position: { x: .5, y: .7 } }]);
  projectSceneTelopPositions(composition, keep, [{ startMs: 0, endMs: 8000 }]);
  assert.deepEqual(composition.voice_data.cuts[1].telop_position_ranges, [{ start: 0, end: 3, position: null }]);
  assert.deepEqual(keep, [{ start_ms: 0, end_ms: 2000 }, { start_ms: 5000, end_ms: 8000 }]);
});

test("legacy run without a positions snapshot is unchanged", () => {
  const composition = { voice_data: { cuts: [{ id: "a", telops: [] }] } };
  const before = JSON.stringify(composition);
  assert.equal(projectSceneTelopPositions(composition, [{ start_ms: 0, end_ms: 1000 }], undefined), false);
  assert.equal(JSON.stringify(composition), before);
});
