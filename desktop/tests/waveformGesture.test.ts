import test from "node:test";
import assert from "node:assert/strict";
import { beginWaveformGesture, moveWaveformGesture, waveformGesturePosition, waveformSnapToleranceMs, formatWaveformTime, sameWaveformEditScene } from "../src/lib/waveformGesture.ts";
import { cutSceneRangeMs } from "../src/lib/rangeCut.ts";
import { createEditHistory, setHistoryPresent, undoEditHistory } from "../src/lib/editHistory.ts";
import type { Scene } from "../src/lib/scenes.ts";

const scene: Scene = {
  id: "sample", sourceStartMs: 1000, sourceEndMs: 5000,
  words: [{ id: "w", text: "長い言葉", startMs: 1000, endMs: 5000, deleted: false }],
  telopText: "長い言葉", telopEdited: false, cutMarks: [],
};
const pointer = { pointerId: 4, clientX: 300, clientY: 200, altKey: false };

test("waveform gesture: clicks and hand jitter cannot activate a trim or range cut", () => {
  for (const kind of ["range", "start", "end"] as const) {
    const gesture = beginWaveformGesture(kind, scene, 400, 100, pointer);
    assert.equal(moveWaveformGesture(gesture, { ...pointer, clientX: 302 }).activated, false);
  }
});

test("waveform gesture: vertical movement does not start a destructive horizontal edit", () => {
  const gesture = beginWaveformGesture("range", scene, 400, 100, pointer);
  assert.equal(moveWaveformGesture(gesture, { ...pointer, clientX: 310, clientY: 225 }).activated, false);
});

test("waveform gesture: a second pointer cannot replace the active pointer or target", () => {
  const gesture = beginWaveformGesture("range", scene, 400, 100, pointer);
  assert.equal(moveWaveformGesture(gesture, { ...pointer, pointerId: 7, clientX: 480 }), gesture);
});

test("waveform gesture: release coordinates work even if the final move event was skipped", () => {
  const gesture = beginWaveformGesture("range", scene, 400, 100, pointer);
  const released = moveWaveformGesture(gesture, { ...pointer, clientX: 500 });
  assert.equal(released.activated, true);
  assert.deepEqual(waveformGesturePosition(released).range, { startPx: 100, endPx: 300, startMs: 2000, endMs: 4000 });
});

test("waveform gesture: dragging out of the last few pixels reaches the exact ending", () => {
  const gesture = beginWaveformGesture("range", scene, 400, 390, pointer);
  const moved = moveWaveformGesture(gesture, { ...pointer, clientX: 400 });
  assert.deepEqual(waveformGesturePosition(moved).range, { startPx: 390, endPx: 400, startMs: 4900, endMs: 5000 });
});

test("waveform gesture: scale remains anchored to the press while the preview bounds change", () => {
  const original = beginWaveformGesture("end", scene, 400, 400, pointer);
  const moved = moveWaveformGesture(original, { ...pointer, clientX: 350 });
  assert.equal(waveformGesturePosition(moved).rawTargetMs, 5500);
  assert.equal(original.scene.sourceEndMs, 5000);
  assert.equal(original.widthPx, 400);
});

test("waveform gesture: returning to the press cancels an already activated trim", () => {
  const original = beginWaveformGesture("end", scene, 400, 400, pointer);
  const moved = moveWaveformGesture(original, { ...pointer, clientX: 250 });
  const returned = moveWaveformGesture(moved, pointer);
  assert.equal(returned.activated, true);
  assert.equal(waveformGesturePosition(returned).moved, false);
});

test("waveform snap: long scenes cannot pull the cut by hundreds of milliseconds", () => {
  assert.equal(waveformSnapToleranceMs(200), 80);
  assert.equal(waveformSnapToleranceMs(2), 16);
  assert.equal(waveformSnapToleranceMs(200, true), 0);
});

test("waveform cut: many preview updates produce one committed Undo operation", () => {
  const original = [scene];
  let history = createEditHistory(original);
  let gesture = beginWaveformGesture("range", scene, 400, 100, pointer);
  for (let x = 310; x <= 450; x += 10) {
    gesture = moveWaveformGesture(gesture, { ...pointer, clientX: x });
    const position = waveformGesturePosition(gesture);
    cutSceneRangeMs(original, scene.id, position.range.startMs, position.range.endMs, { chipSnapToleranceMs: position.chipSnapToleranceMs });
  }
  assert.equal(history.past.length, 0);
  const position = waveformGesturePosition(gesture);
  history = setHistoryPresent(history, cutSceneRangeMs(original, scene.id, position.range.startMs, position.range.endMs).scenes);
  assert.equal(history.past.length, 1);
  assert.equal(undoEditHistory(history).present, original);
});

test("waveform time: millisecond labels are stable across minute rollover", () => {
  assert.equal(formatWaveformTime(59_999.6), "1:00.000");
  assert.equal(formatWaveformTime(1_234), "0:01.234");
  assert.equal(formatWaveformTime(-10), "0:00.000");
});

test("waveform stale guard: metadata-only replacements preserve a held selection and pending incision", () => {
  assert.equal(sameWaveformEditScene(scene, { ...scene, words: scene.words.map(word => ({ ...word })), cutMarks: [...scene.cutMarks] }), true);
});

test("waveform stale guard: source masks, Undo, word edits and scene boundaries invalidate selection", () => {
  for (const changed of [
    { ...scene, sourceStartMs: 1200 }, { ...scene, sourceEndMs: 4800 },
    { ...scene, sourceKeepRanges: [{ startMs: 2000, endMs: 5000 }] },
    { ...scene, telopText: "変更" }, { ...scene, cutMarks: [2500] },
    { ...scene, words: [{ ...scene.words[0], deleted: true }] },
    { ...scene, words: [{ ...scene.words[0], startMs: 1200 }] },
  ]) assert.equal(sameWaveformEditScene(scene, changed), false);
  const masked = { ...scene, sourceKeepRanges: [{ startMs: 1000, endMs: 2000 }, { startMs: 3000, endMs: 5000 }] };
  assert.equal(sameWaveformEditScene(masked, { ...masked, sourceKeepRanges: [{ startMs: 1000, endMs: 5000 }] }), false);
});
