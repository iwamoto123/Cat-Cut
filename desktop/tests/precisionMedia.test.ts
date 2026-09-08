import test from "node:test";
import assert from "node:assert/strict";
import { formatPrecisionTime, parsePrecisionTime, setPrecisionBgmTime, setPrecisionImageTime, snapMediaDelta, stepPrecisionFrame } from "../src/lib/precisionMedia.ts";

const bgm = { id: "bgm", file: "music.mp3", url: "http://fixture/music.mp3", audioDurationMs: 8000, start_ms: 1000, end_ms: 5000, volume: .015, fade_in_ms: 1000, fade_out_ms: 1500 };
const image = { id: "image", file: "image.png", url: "http://fixture/image.png", start_ms: 1000, end_ms: 5000, x: .5, y: .35, scale: .55, opacity: 1 };

test("precision clocks accept seconds, minutes, hours and keep millisecond precision", () => {
  assert.equal(parsePrecisionTime("1.033"), 1033);
  assert.equal(parsePrecisionTime("01:02.345"), 62345);
  assert.equal(parsePrecisionTime("1:02:03.004"), 3723004);
  assert.equal(parsePrecisionTime("90:00"), 5400000);
  assert.equal(formatPrecisionTime(62345), "01:02.345");
  assert.equal(formatPrecisionTime(59999.9), "01:00.000");
});

test("invalid clock drafts are rejected instead of silently becoming a destructive zero", () => {
  for (const value of ["", " ", "1:", "-1", "1:60", "1:2:99", "1.2345", "abc", "Infinity", "1e4", "1:2:3:4"])
    assert.equal(parsePrecisionTime(value), null, value);
});

test("frame arrow adjustments do not drift after repeated 30fps steps", () => {
  let value = 0;
  for (let i = 0; i < 30; i++) value = stepPrecisionFrame(value, 1, 30);
  assert.equal(value, 1000);
  assert.equal(stepPrecisionFrame(1000, -1, 30, 10), 667);
  assert.equal(stepPrecisionFrame(0, -1, 30), 0);
  assert.equal(stepPrecisionFrame(0, 1, 0), 33);
});

test("precision BGM start moves the whole clip without snapping a nearby endpoint", () => {
  const edited = setPrecisionBgmTime(bgm, "start", 6033, 12000);
  assert.equal(edited.start_ms, 6033);
  assert.equal(edited.end_ms, 10033);
  assert.equal(edited.url, bgm.url);
  assert.equal(edited.volume, .015);
  assert.equal(setPrecisionBgmTime(bgm, "start", 9950, 12000).end_ms, 12000);
});

test("precision BGM end preserves the exact requested time and clamps length to the audio", () => {
  assert.equal(setPrecisionBgmTime(bgm, "end", 8933, 12000).end_ms, 8933);
  assert.equal(setPrecisionBgmTime(bgm, "end", 11990, 12000).end_ms, 9000);
});

test("shortening BGM duration keeps fades valid and never creates a zero clip", () => {
  const edited = setPrecisionBgmTime(bgm, "duration", 0, 12000);
  assert.equal(edited.end_ms, 1500);
  assert.equal(edited.fade_in_ms, 500);
  assert.equal(edited.fade_out_ms, 500);
  assert.equal(setPrecisionBgmTime(bgm, "duration", NaN, 12000), bgm);
});

test("image numeric edits keep placement and opacity while changing one timing value", () => {
  const moved = setPrecisionImageTime(image, "start", 33, 12000);
  assert.equal(moved.start_ms, 33);
  assert.equal(moved.end_ms, 4033);
  assert.equal(moved.scale, image.scale);
  assert.equal(moved.url, image.url);
  assert.equal(setPrecisionImageTime(image, "end", 11967, 12000).end_ms, 11967);
  assert.equal(setPrecisionImageTime(image, "duration", 0, 12000).end_ms, 1500);
});

test("media snap chooses the nearest clip edge and target rather than the first one", () => {
  assert.equal(snapMediaDelta(image, 1950, "move", [2950, 6955], .1, true), 1950);
  assert.equal(snapMediaDelta(image, 1900, "move", [3000, 6933], .1, true), 1933);
});

test("trim snapping changes only the dragged edge", () => {
  assert.equal(snapMediaDelta(image, 1950, "resize-start", [7000], .1, true), 1950);
  assert.equal(snapMediaDelta(image, 1950, "resize-end", [7000], .1, true), 2000);
});

test("Alt or disabled snap leaves the exact drag delta and zoomed-out magnetism is bounded", () => {
  assert.equal(snapMediaDelta(image, 1950, "move", [7000], .1, false), 1950);
  assert.equal(snapMediaDelta(image, 1000, "move", [2200], .001, true), 1000);
  assert.equal(snapMediaDelta(image, 1000, "move", [2100], .001, true), 1100);
});
