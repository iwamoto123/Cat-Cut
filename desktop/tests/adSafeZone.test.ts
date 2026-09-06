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
 * フェーズW24 Phase A-2: 縦型セーフゾーン配置(顔回避)のdesktop側テスト。
 * remotion/tests/adSafeZone.test.ts と同じケース表(adSafeZoneCases.json。
 * Python実装の実出力から生成)をdesktopコピーの adSafeZone.ts でも検証する
 * (バイト一致は sharedRemotionCopies.test.ts、計算一致はここで担保する)。
 */

type CaseInput = {
  orientation: string;
  base_telop_y: number;
  face_box?: { x: number; y: number; w: number; h: number } | null;
  block_height_ratio?: number;
  style_offset?: number;
};

const casesData = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../remotion/tests/adSafeZoneCases.json"), "utf-8"),
) as {
  constants: Record<string, number>;
  cases: Array<{ name: string; input: CaseInput; expected: number }>;
};

test("adSafeZone(desktop): 定数がケース表(=Python側)と一致している", () => {
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
  test(`resolveCutTelopY(desktop): ${testCase.name}`, () => {
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

test("effectiveCutTelopY(desktop): cut単位のtelop_y優先とフォールバック", () => {
  assert.equal(effectiveCutTelopY(0.36, 0.75), 0.36);
  assert.equal(effectiveCutTelopY(undefined, 0.75), 0.75);
  assert.equal(effectiveCutTelopY(1.5, 0.75), 0.75);
});
