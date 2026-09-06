import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_BLOCK_HEIGHT_RATIO,
  FACE_TELOP_MARGIN,
  LOWER_BAND_BOTTOM,
  LOWER_BAND_TOP,
  TELOP_BAND_BOTTOM,
  TELOP_BAND_TOP,
  UPPER_BAND_BOTTOM,
  UPPER_BAND_TOP,
  VERTICAL_DEFAULT_TELOP_Y,
  VERTICAL_UPPER_DEFAULT_TELOP_Y,
  effectiveCutTelopY,
  resolveCutTelopY,
} from "../src/lib/adSafeZone.ts";

/**
 * フェーズW24 Phase A-2: 縦型セーフゾーン配置(顔回避)のTS/Python二重実装同期テスト。
 * ケース表 adSafeZoneCases.json は python/tools/generate_ad_safe_zone_cases.py が
 * Python実装(shared/telop_placement.py)の実出力で生成する。ここでTS実装が
 * 同じ期待値を返すことを確認し、pytest(test_telop_placement.py)側も同じ表を検証する
 * (= 定数・判定・丸めの両言語同期を1つのケース表で担保する)。
 */

type CaseInput = {
  orientation: string;
  base_telop_y: number;
  face_box?: { x: number; y: number; w: number; h: number } | null;
  block_height_ratio?: number;
  style_offset?: number;
};

const casesData = JSON.parse(
  readFileSync(join(import.meta.dirname, "adSafeZoneCases.json"), "utf-8"),
) as {
  constants: Record<string, number>;
  cases: Array<{ name: string; input: CaseInput; expected: number }>;
};

test("adSafeZone: 定数がケース表(=Python側)と一致している", () => {
  assert.deepEqual(
    {
      TELOP_BAND_TOP,
      TELOP_BAND_BOTTOM,
      VERTICAL_DEFAULT_TELOP_Y,
      LOWER_BAND_TOP,
      LOWER_BAND_BOTTOM,
      UPPER_BAND_TOP,
      UPPER_BAND_BOTTOM,
      VERTICAL_UPPER_DEFAULT_TELOP_Y,
      FACE_TELOP_MARGIN,
      DEFAULT_BLOCK_HEIGHT_RATIO,
    },
    casesData.constants,
  );
});

for (const testCase of casesData.cases) {
  test(`resolveCutTelopY: ${testCase.name}`, () => {
    const input = testCase.input;
    const actual = resolveCutTelopY({
      orientation: input.orientation,
      baseTelopY: input.base_telop_y,
      faceBox: input.face_box ?? null,
      blockHeightRatio: input.block_height_ratio ?? DEFAULT_BLOCK_HEIGHT_RATIO,
      styleOffset: input.style_offset ?? 0,
    });
    assert.equal(actual, testCase.expected);
  });
}

test("effectiveCutTelopY: cut単位の有効値(0〜1)はグローバルより優先される", () => {
  assert.equal(effectiveCutTelopY(0.64, 0.75), 0.64);
  assert.equal(effectiveCutTelopY(0, 0.75), 0);
  assert.equal(effectiveCutTelopY(1, 0.75), 1);
});

test("effectiveCutTelopY: 無し・不正値はグローバル値へフォールバック(後方互換)", () => {
  assert.equal(effectiveCutTelopY(undefined, 0.75), 0.75);
  assert.equal(effectiveCutTelopY(null, 0.75), 0.75);
  assert.equal(effectiveCutTelopY(Number.NaN, 0.75), 0.75);
  assert.equal(effectiveCutTelopY(-0.1, 0.75), 0.75);
  assert.equal(effectiveCutTelopY(1.5, 0.75), 0.75);
  assert.equal(effectiveCutTelopY("0.6", 0.75), 0.75);
});
