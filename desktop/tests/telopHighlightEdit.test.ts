import test from "node:test";
import assert from "node:assert/strict";
import { isRangeHighlighted, setHighlightRange } from "../src/lib/telopHighlightEdit.ts";

test("setHighlightRange: 選択範囲を黄色にするとその部分文字列が highlight_words になる", () => {
  const words = setHighlightRange("今月は3万円です", [], 3, 6, true);
  assert.deepEqual(words, ["3万円"]);
  assert.equal(isRangeHighlighted("今月は3万円です", words, 3, 6), true);
  assert.equal(isRangeHighlighted("今月は3万円です", words, 0, 3), false);
});

test("setHighlightRange: 黄色の一部だけ白に戻すと残りだけが残る", () => {
  const yellow = setHighlightRange("ABCDEF", [], 1, 5, true);
  assert.deepEqual(yellow, ["BCDE"]);
  const mixed = setHighlightRange("ABCDEF", yellow, 2, 4, false);
  assert.deepEqual(mixed, ["B", "E"]);
});

test("setHighlightRange: 空選択は何も変えない", () => {
  const words = setHighlightRange("こんにちは", ["こん"], 2, 2, true);
  assert.deepEqual(words, ["こん"]);
});
