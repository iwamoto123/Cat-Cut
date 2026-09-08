import test from "node:test";
import assert from "node:assert/strict";
import {
  computeSceneKeptSubRanges,
  deriveKeepSegments,
  isSceneFullyDeleted,
  isSceneWordCutLocked,
  mergeSceneWithNext,
  normalizeSceneSourceKeepRanges,
  setChipDeleted,
  setChipsDeleted,
  setSceneStyleOverride,
  setSceneTelopText,
  splitSceneAtMs,
  splitSceneAtWord,
  type Scene,
  type SceneWord,
} from "../src/lib/scenes.ts";
import { applyEdgeTrim } from "../src/lib/edgeTrim.ts";
import { cutSceneRangeMs } from "../src/lib/rangeCut.ts";

function word(id: string, startMs: number, endMs: number, deleted = false): SceneWord {
  return { id, text: id, startMs, endMs, deleted };
}
function scene(id: string, startMs: number, endMs: number, words: SceneWord[]): Scene {
  return { id, sourceStartMs: startMs, sourceEndMs: endMs, words, telopText: words.filter((item) => !item.deleted).map((item) => item.text).join(""), telopEdited: false, cutMarks: [] };
}
const range = (startMs: number, endMs: number) => ({ startMs, endMs });
function speech(): Scene {
  return scene("speech", 0, 6000, [word("first", 300, 1000), word("middle", 2000, 3000), word("last", 4200, 5400)]);
}

test("waveform cut then text merge preserves the complete removed silence interval", () => {
  const cut = cutSceneRangeMs([speech()], "speech", 1200, 1800).scenes;
  const before = deriveKeepSegments(cut);
  assert.deepEqual(before, [range(0, 1200), range(1800, 6000)]);
  const merged = mergeSceneWithNext(cut, cut[0].id);
  assert.equal(merged.length, 1);
  assert.deepEqual(deriveKeepSegments(merged), before);
  assert.deepEqual(deriveKeepSegments(setSceneStyleOverride(setSceneTelopText(merged, merged[0].id, "修正本文"), merged[0].id, "bold")), before);
});

test("cuts through word midpoints remain millisecond-exact after merge in either direction", () => {
  for (const [start, end] of [[500, 2700], [2500, 4500], [500, 4800]]) {
    const cut = cutSceneRangeMs([speech()], "speech", start, end).scenes;
    const before = deriveKeepSegments(cut);
    for (const selected of cut) {
      const merged = mergeSceneWithNext(cut, selected.id);
      assert.deepEqual(deriveKeepSegments(merged), before);
    }
  }
});

test("merging legacy scenes keeps gaps including leading and trailing deleted-word padding", () => {
  const first = scene("a", 0, 1500, [word("a1", 200, 600), word("a2", 900, 1000, true)]);
  const second = scene("b", 2000, 4000, [word("b1", 2300, 2700, true), word("b2", 3000, 3700)]);
  const before = deriveKeepSegments([first, second]);
  assert.deepEqual(before, [range(0, 900), range(2700, 4000)]);
  assert.deepEqual(deriveKeepSegments(mergeSceneWithNext([first, second], "a")), before);
});

test("merging over a deleted scene never restores its silence padding", () => {
  const first = scene("a", 0, 1000, [word("a", 200, 700)]);
  const deleted = scene("gone", 1000, 3000, [word("gone", 1700, 2300, true)]);
  const last = scene("b", 3000, 5000, [word("b", 3600, 4200)]);
  const original = [first, deleted, last];
  for (const selected of original) {
    assert.deepEqual(deriveKeepSegments(mergeSceneWithNext(original, selected.id)), [range(0, 1000), range(3000, 5000)]);
  }
});

test("concatenating deleted-word runs during merge cannot silently cut additional retained video", () => {
  const first = scene("a", 0, 2000, [word("a1", 0, 300), word("a2", 400, 900, true), word("a3", 1000, 1300)]);
  const second = scene("b", 2000, 4000, [word("b1", 2300, 2700, true), word("b2", 3000, 3500)]);
  const before = deriveKeepSegments([first, second]);
  assert.deepEqual(deriveKeepSegments(mergeSceneWithNext([first, second], "a")), before);
});

test("split at a deleted word retains the original removed run on both sides", () => {
  const original = scene("a", 0, 4000, [word("first", 0, 1000), word("deleted", 1200, 2800, true), word("last", 3000, 4000)]);
  const before = deriveKeepSegments([original]);
  const split = splitSceneAtMs([original], "a", 2000);
  assert.equal(split.length, 2);
  assert.deepEqual(deriveKeepSegments(split), before);
  assert.deepEqual(deriveKeepSegments(mergeSceneWithNext(split, split[0].id)), before);
});

test("repeated split/merge and word-boundary split preserve all retained source intervals", () => {
  let current = cutSceneRangeMs([speech()], "speech", 1300, 1700).scenes;
  current = mergeSceneWithNext(current, current[0].id);
  current = cutSceneRangeMs(current, current[0].id, 3100, 3900, { keepSingleScene: true }).scenes;
  const before = deriveKeepSegments(current);
  for (const ms of [800, 1500, 2600, 3500, 5000]) {
    const split = splitSceneAtMs(current, current[0].id, ms, { allowEmptySpeechSide: true });
    assert.deepEqual(deriveKeepSegments(split), before);
    current = mergeSceneWithNext(split, split[0].id);
    assert.deepEqual(deriveKeepSegments(current), before);
  }
  const wordSplit = splitSceneAtWord(current, current[0].id, "middle");
  assert.equal(wordSplit.length, 2);
  assert.deepEqual(deriveKeepSegments(wordSplit), before);
});

test("single-scene cuts remove silence and partial words exactly, independent of transcript midpoint", () => {
  for (const [start, end] of [[1200, 1800], [2300, 2500]]) {
    const result = cutSceneRangeMs([speech()], "speech", start, end, { keepSingleScene: true });
    assert.equal(result.scenes.length, 1);
    assert.deepEqual(deriveKeepSegments(result.scenes), [range(0, start), range(end, 6000)]);
  }
});

test("a cut covering only an existing hole creates no extra edit", () => {
  const original = { ...speech(), sourceKeepRanges: [range(0, 1000), range(3000, 6000)] };
  const scenes = [original];
  const result = cutSceneRangeMs(scenes, original.id, 1300, 2700);
  assert.equal(result.mode, "none");
  assert.equal(result.scenes, scenes);
});

test("edge expansion after merge restores only the expanded region and leaves interior cuts and chips deleted", () => {
  const original = scene("a", 1000, 5000, [word("first", 1000, 2000), word("cut", 2200, 2800), word("last", 3000, 5000)]);
  const cut = cutSceneRangeMs([original], "a", 2000, 3000).scenes;
  let merged = mergeSceneWithNext(cut, cut[0].id);
  merged = applyEdgeTrim(merged, 0, "start", 500).scenes;
  merged = applyEdgeTrim(merged, 0, "end", 5500, { sourceDurationMs: 6000 }).scenes;
  assert.deepEqual(deriveKeepSegments(merged), [range(500, 2000), range(3000, 5500)]);
  assert.equal(merged[0].words.find((item) => item.id === "cut")?.deleted, true);
});

test("stretching a cut fragment edge explicitly recovers only the requested part of the cut", () => {
  const cut = cutSceneRangeMs([speech()], "speech", 1200, 3800).scenes;
  const expanded = applyEdgeTrim(cut, 0, "end", 2000).scenes;
  assert.deepEqual(deriveKeepSegments(expanded), [range(0, 2000), range(3800, 6000)]);
  const shrunk = applyEdgeTrim(expanded, 0, "end", 800).scenes;
  const restored = applyEdgeTrim(shrunk, 0, "end", 2000).scenes;
  assert.deepEqual(deriveKeepSegments(restored), deriveKeepSegments(expanded));
});

test("deleting more chips after merge removes new audio and chip restore cannot revive established cuts", () => {
  const cut = cutSceneRangeMs([speech()], "speech", 1800, 3200).scenes;
  const merged = mergeSceneWithNext(cut, cut[0].id);
  const restoredChip = setChipDeleted(merged, merged[0].id, "middle", false);
  assert.equal(restoredChip, merged, "復元できない切り込みに空のUndoを積まない");
  assert.equal(isSceneWordCutLocked(merged[0], merged[0].words.find((item) => item.id === "middle")!), true);
  assert.equal(restoredChip[0].words.find((item) => item.id === "middle")?.deleted, true);
  assert.deepEqual(deriveKeepSegments(restoredChip), deriveKeepSegments(merged));
  const deleted = setChipDeleted(merged, merged[0].id, "last", true);
  assert.deepEqual(deriveKeepSegments(deleted), [range(0, 1800)]);
  assert.deepEqual(deriveKeepSegments(setChipDeleted(deleted, deleted[0].id, "last", false)), [range(0, 1800)]);
});

test("silent retained video stays alive even when every transcript word is deleted, and whole-scene delete works", () => {
  const original = scene("tail", 0, 5000, [word("first", 0, 1000), word("last", 2500, 3500)]);
  const cut = cutSceneRangeMs([original], "tail", 1000, 4000).scenes;
  const tail = cut[1];
  assert.ok(tail.words.every((item) => item.deleted));
  assert.equal(isSceneFullyDeleted(tail), false);
  assert.deepEqual(computeSceneKeptSubRanges(tail), [range(4000, 5000)]);
  const deleted = setChipsDeleted(cut, tail.id, tail.words.map((item) => item.id), true);
  assert.equal(isSceneFullyDeleted(deleted[1]), true);
  assert.deepEqual(deriveKeepSegments(deleted), [range(0, 1000)]);
});

test("new scene field survives a JSON save/load, [] means cut, and old or unknown optional shape remains legacy", () => {
  const cut = cutSceneRangeMs([speech()], "speech", 1300, 1700).scenes;
  const merged = mergeSceneWithNext(cut, cut[0].id);
  assert.deepEqual(deriveKeepSegments(JSON.parse(JSON.stringify(merged))), deriveKeepSegments(merged));
  assert.deepEqual(computeSceneKeptSubRanges({ ...speech(), sourceKeepRanges: [] }), []);
  for (const value of [undefined, null, { future: true }]) {
    const legacy = { ...speech(), sourceKeepRanges: value } as unknown as Scene;
    assert.deepEqual(computeSceneKeptSubRanges(legacy), [range(0, 6000)]);
  }
});

test("persistent intervals are clipped, merged and sanitized without mutating input", () => {
  const value = [range(2800, 9000), range(-100, 400), range(200, 700), range(1800, 1600), range(NaN, 2000), null];
  const before = structuredClone(value);
  assert.deepEqual(normalizeSceneSourceKeepRanges(value, 0, 4000), [range(0, 700), range(2800, 4000)]);
  assert.deepEqual(value, before);
});

test("partially retained word can restore its text without restoring the cut audio", () => {
  const original = scene("a", 0, 4000, [word("first", 0, 1000), word("middle", 1000, 3000), word("last", 3000, 4000)]);
  const cut = cutSceneRangeMs([original], "a", 1500, 2500, { keepSingleScene: true }).scenes;
  const middle = cut[0].words.find((item) => item.id === "middle")!;
  assert.equal(middle.deleted, true);
  assert.equal(isSceneWordCutLocked(cut[0], middle), false);
  const restored = setChipDeleted(cut, "a", "middle", false);
  assert.equal(restored[0].words.find((item) => item.id === "middle")?.deleted, false);
  assert.deepEqual(deriveKeepSegments(restored), [range(0, 1500), range(2500, 4000)]);
});

test("word boundaries outside an edge-trimmed scene cannot create invalid fragments", () => {
  const original = scene("a", 3000, 5000, [word("old-first", 0, 1000, true), word("old-last", 1000, 2000, true)]);
  original.sourceKeepRanges = [range(3000, 5000)];
  const scenes = [original];
  assert.equal(splitSceneAtWord(scenes, "a", "old-last"), scenes);
});
