import test from "node:test";
import assert from "node:assert/strict";
import { buildGlowFilter, combineTelopFilters } from "../src/lib/telopGlow.ts";

/**
 * フェーズU6(光彩=グロウ)のCSS filter生成テスト。
 */

test("buildGlowFilter: 3層(0.5r/r/2r)のdrop-shadowを生成する", () => {
  const filter = buildGlowFilter({ color: "#00E5FF", radius: 10 }, 1);
  assert.equal(
    filter,
    "drop-shadow(0px 0px 5px #00E5FF) drop-shadow(0px 0px 10px #00E5FF) drop-shadow(0px 0px 20px #00E5FF)",
  );
});

test("buildGlowFilter: radiusはスケール係数に比例する(shadow_offsetと同じ規則)", () => {
  const filter = buildGlowFilter({ color: "#FF2ED2", radius: 12 }, 0.5);
  assert.ok(filter);
  assert.ok(filter.includes("3px"), "0.5r×scale0.5 = 3px");
  assert.ok(filter.includes("6px"), "r×scale0.5 = 6px");
  assert.ok(filter.includes("12px"), "2r×scale0.5 = 12px");
});

test("buildGlowFilter: 無効な入力はnull(filter無指定)", () => {
  assert.equal(buildGlowFilter(null, 1), null);
  assert.equal(buildGlowFilter(undefined, 1), null);
  assert.equal(buildGlowFilter({ color: "", radius: 10 }, 1), null);
  assert.equal(buildGlowFilter({ color: "#FFF", radius: 0 }, 1), null);
  assert.equal(buildGlowFilter({ color: "#FFF", radius: Number.NaN }, 1), null);
});

test("buildGlowFilter: scaleが不正でも1として扱う", () => {
  const filter = buildGlowFilter({ color: "#FFF", radius: 8 }, Number.NaN);
  assert.ok(filter?.includes("8px"));
});

test("combineTelopFilters: グロウとdrop_shadowを空白結合し、全て空ならundefined", () => {
  assert.equal(
    combineTelopFilters("drop-shadow(0px 0px 5px #0FF)", "drop-shadow(0px 4px 6px rgba(0,0,0,0.4))"),
    "drop-shadow(0px 0px 5px #0FF) drop-shadow(0px 4px 6px rgba(0,0,0,0.4))",
  );
  assert.equal(combineTelopFilters(null, "drop-shadow(0px 1px 2px #000)"), "drop-shadow(0px 1px 2px #000)");
  assert.equal(combineTelopFilters(null, undefined), undefined);
});
