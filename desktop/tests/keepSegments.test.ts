import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRemoveRanges,
  isWordInKeepSegments,
  recomputeKeepSegmentsFromWords,
  type TranscriptWord,
} from "../src/lib/keepSegments.ts";

const words: TranscriptWord[] = [
  { id: "w1", text: "こ", startMs: 0, endMs: 120 },
  { id: "w2", text: "ん", startMs: 130, endMs: 240 },
  { id: "w3", text: "に", startMs: 1600, endMs: 1700 },
  { id: "w4", text: "ち", startMs: 1710, endMs: 1820 },
];

test("recomputeKeepSegmentsFromWords clusters by gap", () => {
  const segments = recomputeKeepSegmentsFromWords(words, new Set(), {
    maxGapMs: 300,
    segmentPaddingMs: 20,
    originalDurationMs: 2000,
  });
  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0], { startMs: 0, endMs: 260 });
  assert.deepEqual(segments[1], { startMs: 1580, endMs: 1840 });
});

test("recomputeKeepSegmentsFromWords excludes removed words", () => {
  const segments = recomputeKeepSegmentsFromWords(words, new Set(["w2", "w3"]), {
    maxGapMs: 300,
    segmentPaddingMs: 10,
    originalDurationMs: 2000,
  });
  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0], { startMs: 0, endMs: 130 });
  assert.deepEqual(segments[1], { startMs: 1700, endMs: 1830 });
});

test("buildRemoveRanges creates gaps and trailing range", () => {
  const ranges = buildRemoveRanges(
    [
      { startMs: 50, endMs: 150 },
      { startMs: 200, endMs: 300 },
    ],
    420,
  );
  assert.deepEqual(ranges, [
    { startMs: 0, endMs: 50, durationMs: 50, reason: "gap" },
    { startMs: 150, endMs: 200, durationMs: 50, reason: "gap" },
    { startMs: 300, endMs: 420, durationMs: 120, reason: "trailing_silence" },
  ]);
});

test("isWordInKeepSegments checks overlap", () => {
  assert.equal(isWordInKeepSegments(words[0], [{ startMs: 100, endMs: 200 }]), true);
  assert.equal(isWordInKeepSegments(words[0], [{ startMs: 140, endMs: 200 }]), false);
});
