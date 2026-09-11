import test from "node:test";
import assert from "node:assert/strict";
import { cutFrameRanges } from "../src/lib/cutTimeline.ts";

function cut(id: string, startMs: number, endMs: number, sourceStartMs = startMs) {
  return {
    cut_id: id,
    timeline: { start_ms: startMs, end_ms: endMs },
    video: { start_ms: sourceStartMs, end_ms: sourceStartMs + endMs - startMs },
  };
}

test("書き出しを停止させていた先頭・途中・末尾の1ms残片は0フレームのSequenceを作らない", () => {
  const cases = [
    [cut("tiny", 0, 1), cut("body", 1, 1000)],
    [cut("left", 0, 1000), cut("tiny", 1000, 1001), cut("right", 1001, 2000)],
    [cut("body", 0, 999), cut("tiny", 999, 1000)],
  ];
  for (const cuts of cases) {
    const totalMs = cuts.at(-1)!.timeline.end_ms;
    const ranges = cutFrameRanges(cuts, totalMs, 30);
    assert.ok(ranges.every((range) => range.durationInFrames > 0));
    assert.ok(ranges.every((range) => range.cut.cut_id !== "tiny"));
    assert.equal(ranges[0].from, 0);
    assert.equal(ranges.reduce((sum, range) => sum + range.durationInFrames, 0), totalMs / 1000 * 30);
  }
});

test("残片を省いても隣接カットを延長せず、素材側のカット済み区間を保持する", () => {
  const cuts = [cut("left", 0, 1000, 500), cut("tiny", 1000, 1001, 3000), cut("right", 1001, 2000, 6000)];
  const before = structuredClone(cuts);
  const ranges = cutFrameRanges(cuts, 2000, 30);
  assert.deepEqual(ranges.map(({ cut, from, durationInFrames }) => [cut.cut_id, from, durationInFrames]), [
    ["left", 0, 30],
    ["right", 30, 30],
  ]);
  assert.equal(ranges[0].cut, cuts[0]);
  assert.equal(ranges[1].cut, cuts[2]);
  assert.deepEqual(cuts, before, "編集データの時間や素材位置を変更しない");
});

test("短い区間でも出力フレームに乗るものは保持し、長時間編集でも丸め誤差を蓄積しない", () => {
  for (const fps of [24, 25, 29.97, 30, 60]) {
    const cuts = Array.from({ length: 5000 }, (_, i) => cut(String(i), i * 17, (i + 1) * 17));
    const ranges = cutFrameRanges(cuts, 85000, fps);
    let cursor = 0;
    for (const range of ranges) {
      assert.equal(range.from, cursor, `${fps}fps: 隙間や重なりがない`);
      cursor += range.durationInFrames;
    }
    assert.equal(cursor, Math.ceil(85 * fps));
    assert.ok(ranges.length > 0);
  }
});

test("OPのオフセットと明示的な空白を保ち、次の開始位置まで勝手に延長しない", () => {
  const ranges = cutFrameRanges([cut("a", 3500, 4000), cut("b", 4500, 5000)], 5000, 30);
  assert.deepEqual(ranges.map(({ from, durationInFrames }) => [from, durationInFrames]), [[105, 15], [135, 15]]);
});

test("素材終端がフレームの途中でもmetadataで確保された最終フレームまで描画する", () => {
  const ranges = cutFrameRanges([cut("body", 0, 1010)], 1010, 30);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].durationInFrames, 31);
  assert.equal(ranges[0].from + ranges[0].durationInFrames, Math.ceil(1.01 * 30));
});

test("総尺1001msの最後の1msは出力フレームに乗るため保持する", () => {
  const cuts = [cut("body", 0, 1000), cut("tiny", 1000, 1001, 6000)];
  const ranges = cutFrameRanges(cuts, 1001, 30);
  assert.deepEqual(ranges.map(({ cut, from, durationInFrames }) => [cut.cut_id, from, durationInFrames]), [
    ["body", 0, 30], ["tiny", 30, 1],
  ]);
  assert.equal(ranges[1].cut, cuts[1]);
});

test("0ms・逆転・非有限・出力範囲外の区間から不正なSequenceを生成しない", () => {
  const cuts = [
    cut("empty", 100, 100), cut("reversed", 200, 100), cut("negative", -10, 50),
    cut("nan", NaN, 500), cut("infinite", 0, Infinity), cut("outside", 1000, 1100),
    cut("valid", 500, 1500),
  ];
  assert.deepEqual(cutFrameRanges(cuts, 1000, 30).map(({ cut, from, durationInFrames }) => [cut.cut_id, from, durationInFrames]), [["valid", 15, 15]]);
  for (const totalMs of [0, -1, NaN, Infinity]) assert.deepEqual(cutFrameRanges(cuts, totalMs, 30), []);
  for (const fps of [0, -1, NaN, Infinity]) assert.deepEqual(cutFrameRanges(cuts, 1000, fps), []);
});
