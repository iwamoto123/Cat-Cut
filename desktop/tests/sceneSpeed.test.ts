import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveKeepSegments,
  normalizeSceneSpeed,
  setAllSceneSpeeds,
  setSceneSpeed,
  type Scene,
} from "../src/lib/scenes.ts";

function scene(id: string, startMs: number, endMs: number, speed?: number): Scene {
  return {
    id,
    sourceStartMs: startMs,
    sourceEndMs: endMs,
    words: [{ id: `${id}_w`, text: id, startMs, endMs, deleted: false }],
    telopText: id,
    telopEdited: false,
    cutMarks: [],
    ...(speed === undefined ? {} : { speed }),
  };
}

test("normalizeSceneSpeed: 許可値以外は1へ丸める", () => {
  assert.equal(normalizeSceneSpeed(1.25), 1.25);
  assert.equal(normalizeSceneSpeed(2), 2);
  assert.equal(normalizeSceneSpeed(1.75), 1);
  assert.equal(normalizeSceneSpeed(undefined), 1);
});

test("deriveKeepSegments: 等速の隣接シーンは従来どおり結合する", () => {
  assert.deepEqual(deriveKeepSegments([scene("a", 0, 1000), scene("b", 1000, 2000, 1)]), [
    { startMs: 0, endMs: 2000 },
  ]);
});

test("deriveKeepSegments: 速度違いの隣接シーンは結合せずspeedを保持する", () => {
  const segments = deriveKeepSegments([scene("a", 0, 1000), scene("b", 1000, 3000, 2)]);
  assert.deepEqual(segments, [
    { startMs: 0, endMs: 1000 },
    { startMs: 1000, endMs: 3000, speed: 2 },
  ]);
  assert.equal((segments[1].endMs - segments[1].startMs) / (segments[1].speed || 1), 1000);
});

test("速度変更は対象または全体を1操作分の不変更新で変更する", () => {
  const scenes = [scene("a", 0, 1000), scene("b", 1000, 2000)];
  const one = setSceneSpeed(scenes, "b", 1.5);
  assert.equal(one[0], scenes[0]);
  assert.equal(one[1].speed, 1.5);
  const all = setAllSceneSpeeds(one, 2);
  assert.deepEqual(all.map((item) => item.speed), [2, 2]);
});
