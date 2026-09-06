import test from "node:test";
import assert from "node:assert/strict";
import {
  arrayIndexForLaneIndex,
  laneIndexForArrayIndex,
  laneIndexForOffsetY,
  laneTrackHeightPx,
  moveClipToLane,
} from "../src/lib/clipLanes.ts";

// フェーズV6-5(レーン段組み): 配列順⇔レーン順の変換とレーン入替えのテスト。
// 規則: 配列末尾(画像なら最前面)=一番上のレーン(laneIndex=0)。

test("laneIndexForArrayIndex: 配列末尾が一番上のレーン", () => {
  assert.equal(laneIndexForArrayIndex(3, 2), 0); // 末尾=最前面=一番上
  assert.equal(laneIndexForArrayIndex(3, 1), 1);
  assert.equal(laneIndexForArrayIndex(3, 0), 2); // 先頭=最背面=一番下
  assert.equal(laneIndexForArrayIndex(1, 0), 0);
});

test("arrayIndexForLaneIndex: laneIndexForArrayIndexの逆変換", () => {
  for (let index = 0; index < 4; index += 1) {
    assert.equal(arrayIndexForLaneIndex(4, laneIndexForArrayIndex(4, index)), index);
  }
});

test("laneIndexForOffsetY: Y座標→レーンindex(範囲外は最寄りへクランプ)", () => {
  assert.equal(laneIndexForOffsetY(0, 40, 3), 0);
  assert.equal(laneIndexForOffsetY(39, 40, 3), 0);
  assert.equal(laneIndexForOffsetY(40, 40, 3), 1);
  assert.equal(laneIndexForOffsetY(999, 40, 3), 2); // 下へはみ出し→最下レーン
  assert.equal(laneIndexForOffsetY(-10, 40, 3), 0); // 上へはみ出し→最上レーン
  assert.equal(laneIndexForOffsetY(50, 40, 0), 0); // クリップゼロは0固定
});

test("laneTrackHeightPx: クリップ数×レーン高。0件でも1レーン分は確保", () => {
  assert.equal(laneTrackHeightPx(3, 40), 120);
  assert.equal(laneTrackHeightPx(0, 40), 40);
});

const CLIPS = [{ id: "a" }, { id: "b" }, { id: "c" }]; // レーン順(上から): c, b, a

test("moveClipToLane: 一番下のクリップを一番上へ(配列では先頭→末尾)", () => {
  const next = moveClipToLane(CLIPS, "a", 0);
  assert.deepEqual(
    next.map((clip) => clip.id),
    ["b", "c", "a"],
  );
});

test("moveClipToLane: 一番上のクリップを一番下へ(配列では末尾→先頭)", () => {
  const next = moveClipToLane(CLIPS, "c", 2);
  assert.deepEqual(
    next.map((clip) => clip.id),
    ["c", "a", "b"],
  );
});

test("moveClipToLane: 同一レーン・対象なしは元の配列をそのまま返す", () => {
  assert.equal(moveClipToLane(CLIPS, "c", 0), CLIPS);
  assert.equal(moveClipToLane(CLIPS, "missing", 0), CLIPS);
});

test("moveClipToLane: 範囲外レーンは端へクランプする", () => {
  const next = moveClipToLane(CLIPS, "a", 99); // 下へはみ出し→最下レーン(=配列先頭)のまま
  assert.equal(next, CLIPS);
  const top = moveClipToLane(CLIPS, "b", -5); // 上へはみ出し→最上レーン(=配列末尾)
  assert.deepEqual(
    top.map((clip) => clip.id),
    ["a", "c", "b"],
  );
});
