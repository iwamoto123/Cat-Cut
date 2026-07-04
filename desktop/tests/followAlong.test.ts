import test from "node:test";
import assert from "node:assert/strict";
import {
  computeReadThroughProgressPercent,
  findAdjacentWordIndex,
  findPreviousReadWordIndex,
  findWordIndexAtOrBefore,
} from "../src/lib/followAlong.ts";
import type { TranscriptWord } from "../src/lib/keepSegments.ts";

const words: TranscriptWord[] = [
  { id: "w1", text: "こんにちは", startMs: 0, endMs: 300 },
  { id: "w2", text: "今日は", startMs: 350, endMs: 650 },
  { id: "w3", text: "良い", startMs: 700, endMs: 900 },
  { id: "w4", text: "天気", startMs: 950, endMs: 1200 },
  { id: "w5", text: "ですね", startMs: 1250, endMs: 1500 },
];

test("findWordIndexAtOrBefore はヒットする単語のインデックスを返す", () => {
  assert.equal(findWordIndexAtOrBefore(words, 100), 0);
  assert.equal(findWordIndexAtOrBefore(words, 1000), 3);
});

test("findWordIndexAtOrBefore は無音区間で直前の単語にフォールバックする", () => {
  assert.equal(findWordIndexAtOrBefore(words, 320), 0);
  assert.equal(findWordIndexAtOrBefore(words, 690), 1);
});

test("findWordIndexAtOrBefore は先頭単語より前では -1 を返す", () => {
  assert.equal(findWordIndexAtOrBefore(words, -50), -1);
});

test("findWordIndexAtOrBefore は空配列で -1 を返す", () => {
  assert.equal(findWordIndexAtOrBefore([], 100), -1);
});

test("findPreviousReadWordIndex は現在時刻より300ms前の単語を選ぶ", () => {
  // 現在時刻1000ms -> 300ms前=700ms時点でアクティブなのはw3
  assert.equal(findPreviousReadWordIndex(words, 1000), 2);
});

test("findPreviousReadWordIndex はlookbackMsを指定できる", () => {
  assert.equal(findPreviousReadWordIndex(words, 1000, 0), 3);
});

test("findPreviousReadWordIndex は序盤で負の時刻にならないようクランプする", () => {
  // 100ms - 300ms は負になるため 0ms にクランプされ、w1(0-300ms)がヒットする
  assert.equal(findPreviousReadWordIndex(words, 100, 300), 0);
});

test("findPreviousReadWordIndex は先頭に無音があり全単語より前の時刻では -1 を返す", () => {
  const wordsWithLeadingSilence: TranscriptWord[] = [{ id: "w1", text: "はい", startMs: 500, endMs: 700 }];
  assert.equal(findPreviousReadWordIndex(wordsWithLeadingSilence, 600, 300), -1);
});

test("findAdjacentWordIndex は次/前の単語インデックスを返す", () => {
  assert.equal(findAdjacentWordIndex(words, 100, 1), 1);
  assert.equal(findAdjacentWordIndex(words, 1000, -1), 2);
});

test("findAdjacentWordIndex は範囲外に出ないようクランプする", () => {
  assert.equal(findAdjacentWordIndex(words, 100, -1), 0);
  assert.equal(findAdjacentWordIndex(words, 1400, 1), 4);
});

test("findAdjacentWordIndex は無音区間でも直前単語基準で移動する", () => {
  assert.equal(findAdjacentWordIndex(words, 320, 1), 1);
  assert.equal(findAdjacentWordIndex(words, 320, -1), 0);
});

test("findAdjacentWordIndex は先頭より前の時刻から次へ進める", () => {
  assert.equal(findAdjacentWordIndex(words, -50, 1), 0);
  assert.equal(findAdjacentWordIndex(words, -50, -1), -1);
});

test("computeReadThroughProgressPercent は割合を0-100にクランプする", () => {
  assert.equal(computeReadThroughProgressPercent(0, 1500), 0);
  assert.equal(computeReadThroughProgressPercent(750, 1500), 50);
  assert.equal(computeReadThroughProgressPercent(1500, 1500), 100);
  assert.equal(computeReadThroughProgressPercent(2000, 1500), 100);
  assert.equal(computeReadThroughProgressPercent(-100, 1500), 0);
});

test("computeReadThroughProgressPercent は全体長0以下で0を返す", () => {
  assert.equal(computeReadThroughProgressPercent(500, 0), 0);
});
