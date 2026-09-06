import test from "node:test";
import assert from "node:assert/strict";
import { MAX_PUNCH_SCALE, normalizePunchIn, punchInStyle } from "../src/lib/punchIn.ts";

/**
 * フェーズW26(シーン切替改善): カット単位パンチイン(交互ズーム)の正規化と
 * transform計算のテスト。step08(python/shared/punch_in.py)が書き込む
 * cuts[].punch_scale / punch_origin を Remotion / プレビューが同一規則で解釈する。
 */

test("normalizePunchIn: 有効なscaleとoriginを受け付ける", () => {
  const punch = normalizePunchIn(1.07, { x: 0.48, y: 0.31 });
  assert.ok(punch);
  assert.equal(punch.scale, 1.07);
  assert.equal(punch.originX, 0.48);
  assert.equal(punch.originY, 0.31);
});

test("normalizePunchIn: 等倍・不正値・上限超えは null(=変形なし)", () => {
  assert.equal(normalizePunchIn(1.0, null), null);
  assert.equal(normalizePunchIn(0.9, null), null);
  assert.equal(normalizePunchIn(undefined, null), null);
  assert.equal(normalizePunchIn("abc", null), null);
  assert.equal(normalizePunchIn(MAX_PUNCH_SCALE + 0.01, null), null);
});

test("normalizePunchIn: origin欠落・不正は既定(0.5, 0.42)へフォールバック", () => {
  const punch = normalizePunchIn(1.07, null);
  assert.ok(punch);
  assert.equal(punch.originX, 0.5);
  assert.equal(punch.originY, 0.42);

  const partial = normalizePunchIn(1.07, { x: "bad", y: 2.5 });
  assert.ok(partial);
  assert.equal(partial.originX, 0.5);
  assert.equal(partial.originY, 1); // 範囲外は0〜1へクランプ
});

test("punchInStyle: scaleとtransform-origin(%)を生成する", () => {
  const style = punchInStyle({ scale: 1.07, originX: 0.5, originY: 0.42 });
  assert.equal(style.transform, "scale(1.07)");
  assert.equal(style.transformOrigin, "50.00% 42.00%");
});
