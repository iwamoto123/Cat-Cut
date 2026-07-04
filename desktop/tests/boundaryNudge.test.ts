import test from "node:test";
import assert from "node:assert/strict";
import {
  nudgeKeepSegmentBoundary,
  setKeepSegmentBoundaryMs,
  snapMsToGrid,
} from "../src/lib/boundaryNudge.ts";
import type { KeepSegment } from "../src/lib/keepSegments.ts";

test("snapMsToGrid は指定グリッド(既定20ms)に丸める", () => {
  assert.equal(snapMsToGrid(1234), 1240);
  assert.equal(snapMsToGrid(1220), 1220);
  assert.equal(snapMsToGrid(9), 0);
  assert.equal(snapMsToGrid(1234, 100), 1200);
});

test("nudgeKeepSegmentBoundary は開始境界を相対移動しスナップする(Shift+[ ] = 20ms相当)", () => {
  const segments: KeepSegment[] = [{ startMs: 1000, endMs: 5000 }];
  const result = nudgeKeepSegmentBoundary(segments, 0, "start", -20, { snapMs: 20 });
  assert.equal(result[0].startMs, 980);
  assert.equal(result[0].endMs, 5000);
});

test("nudgeKeepSegmentBoundary は終了境界を相対移動できる([ ] = 100ms相当)", () => {
  const segments: KeepSegment[] = [{ startMs: 1000, endMs: 5000 }];
  const result = nudgeKeepSegmentBoundary(segments, 0, "end", 100, { snapMs: 20 });
  assert.equal(result[0].endMs, 5100);
});

test("nudgeKeepSegmentBoundary は端数msを20msグリッドにスナップする", () => {
  const segments: KeepSegment[] = [{ startMs: 1000, endMs: 5000 }];
  // 1000 - 103 = 897 -> 900にスナップ
  const result = nudgeKeepSegmentBoundary(segments, 0, "start", -103, { snapMs: 20 });
  assert.equal(result[0].startMs, 900);
});

test("開始境界は前セグメントの終了より前へは移動できない", () => {
  const segments: KeepSegment[] = [
    { startMs: 0, endMs: 1000 },
    { startMs: 1200, endMs: 3000 },
  ];
  const result = nudgeKeepSegmentBoundary(segments, 1, "start", -5000, { snapMs: 20 });
  assert.equal(result[1].startMs, 1000);
  assert.equal(result[0].endMs, 1000, "他セグメントは変更されない");
});

test("終了境界は次セグメントの開始を超えて移動できない", () => {
  const segments: KeepSegment[] = [
    { startMs: 0, endMs: 1000 },
    { startMs: 1200, endMs: 3000 },
  ];
  const result = nudgeKeepSegmentBoundary(segments, 0, "end", 5000, { snapMs: 20 });
  assert.equal(result[0].endMs, 1200);
});

test("終了境界は次セグメントが無ければmaxMsまでしか移動できない", () => {
  const segments: KeepSegment[] = [{ startMs: 0, endMs: 1000 }];
  const result = nudgeKeepSegmentBoundary(segments, 0, "end", 5000, { snapMs: 20, maxMs: 2000 });
  assert.equal(result[0].endMs, 2000);
});

test("nudgeKeepSegmentBoundary は最小長を下回らないようクランプする", () => {
  const segments: KeepSegment[] = [{ startMs: 1000, endMs: 1030 }];
  const result = nudgeKeepSegmentBoundary(segments, 0, "start", 500, { snapMs: 20, minDurationMs: 20 });
  assert.equal(result[0].startMs, 1010);
});

test("存在しないsegmentIndexを指定した場合は元の配列をそのまま返す", () => {
  const segments: KeepSegment[] = [{ startMs: 0, endMs: 1000 }];
  const result = nudgeKeepSegmentBoundary(segments, 5, "start", -100, {});
  assert.deepEqual(result, segments);
});

test("setKeepSegmentBoundaryMs は絶対値指定でスナップ・クランプする(ドラッグ操作用)", () => {
  const segments: KeepSegment[] = [{ startMs: 1000, endMs: 5000 }];
  const result = setKeepSegmentBoundaryMs(segments, 0, "start", 1234, { snapMs: 20 });
  assert.equal(result[0].startMs, 1240);
});

test("setKeepSegmentBoundaryMs は他のセグメントを変更せずコピーを返す", () => {
  const segments: KeepSegment[] = [
    { startMs: 0, endMs: 1000 },
    { startMs: 1200, endMs: 3000 },
  ];
  const result = setKeepSegmentBoundaryMs(segments, 0, "end", 900, { snapMs: 20 });
  assert.notEqual(result, segments);
  assert.equal(result[1].startMs, 1200);
  assert.equal(result[1].endMs, 3000);
});
