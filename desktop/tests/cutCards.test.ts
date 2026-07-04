import test from "node:test";
import assert from "node:assert/strict";
import { buildCutCards, computeBoundaryOverrunHighlights, findBoundaryHighlightByWordId } from "../src/lib/cutCards.ts";
import type { KeepSegment, TranscriptWord } from "../src/lib/keepSegments.ts";

const words: TranscriptWord[] = [
  { id: "w1", text: "こん", startMs: 0, endMs: 300 },
  { id: "w2", text: "にちは", startMs: 300, endMs: 700 },
  { id: "w3", text: "の", startMs: 1719, endMs: 2819 },
  { id: "w4", text: "です", startMs: 5000, endMs: 5100 },
];

const keepSegments: KeepSegment[] = [
  { startMs: 0, endMs: 1000 },
  { startMs: 1719 + 100, endMs: 5230 }, // -> {1819, 5230}: w3をまたぐ
];

test("buildCutCards は keep_segment ごとに重なる単語を集めてカード化する", () => {
  const cards = buildCutCards(words, keepSegments);
  assert.equal(cards.length, 2);
  assert.deepEqual(cards[0].wordIds, ["w1", "w2"]);
  assert.equal(cards[0].text, "こんにちは");
  assert.ok(cards[1].wordIds.includes("w3"));
  assert.ok(cards[1].wordIds.includes("w4"));
});

test("buildCutCards は startMs 順にソートしてindexを振る", () => {
  const reversed = [...keepSegments].reverse();
  const cards = buildCutCards(words, reversed);
  assert.equal(cards[0].index, 0);
  assert.equal(cards[0].startMs, 0);
  assert.equal(cards[1].index, 1);
});

test("computeBoundaryOverrunHighlights は80ms超のはみ出しを検出しセグメント番号と範囲を返す", () => {
  const highlights = computeBoundaryOverrunHighlights(words, keepSegments);
  assert.equal(highlights.length, 1);
  const highlight = highlights[0];
  assert.equal(highlight.segmentIndex, 1);
  assert.equal(highlight.edge, "start");
  assert.equal(highlight.wordId, "w3");
  assert.equal(highlight.rangeStartMs, 1719);
  assert.equal(highlight.rangeEndMs, 1819);
  assert.ok(highlight.overrunMs > 80);
});

test("computeBoundaryOverrunHighlights は閾値以下なら何も返さない", () => {
  const noOverrunSegments: KeepSegment[] = [{ startMs: 0, endMs: 1000 }];
  const highlights = computeBoundaryOverrunHighlights(words.slice(0, 2), noOverrunSegments);
  assert.equal(highlights.length, 0);
});

test("findBoundaryHighlightByWordId は該当wordIdのハイライトを返す(疑義キューの修正するボタン用)", () => {
  const highlights = computeBoundaryOverrunHighlights(words, keepSegments);
  const found = findBoundaryHighlightByWordId(highlights, "w3");
  assert.ok(found);
  assert.equal(found?.segmentIndex, 1);
  assert.equal(findBoundaryHighlightByWordId(highlights, "unknown"), null);
});
