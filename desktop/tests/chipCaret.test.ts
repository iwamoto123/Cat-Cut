import { strict as assert } from "node:assert";
import test from "node:test";
import { chipCaretPositionChanged } from "../src/lib/chipCaret.ts";

test("chipCaretPositionChanged: 前回なし(null)は常に更新が必要", () => {
  assert.equal(chipCaretPositionChanged(null, { groupIndex: 0, leftPx: 0 }), true);
  assert.equal(chipCaretPositionChanged(null, { groupIndex: 3, leftPx: 120 }), true);
});

test("chipCaretPositionChanged: 同じ境界インデックス・同じx位置なら更新しない", () => {
  assert.equal(
    chipCaretPositionChanged({ groupIndex: 2, leftPx: 84 }, { groupIndex: 2, leftPx: 84 }),
    false,
  );
});

test("chipCaretPositionChanged: 境界インデックスが変わったら更新する", () => {
  assert.equal(
    chipCaretPositionChanged({ groupIndex: 2, leftPx: 84 }, { groupIndex: 3, leftPx: 84 }),
    true,
  );
});

test("chipCaretPositionChanged: 描画x位置が変わったら更新する(同一境界でも折返し等でxは変わり得る)", () => {
  assert.equal(
    chipCaretPositionChanged({ groupIndex: 2, leftPx: 84 }, { groupIndex: 2, leftPx: 90 }),
    true,
  );
});
