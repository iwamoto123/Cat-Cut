import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_HIGHLIGHT_COLOR,
  splitHighlightRuns,
} from "../src/lib/telopHighlight.ts";

/**
 * フェーズT1-2(部分ハイライト A-emph)の分割ロジックのテスト。
 * splitHighlightRuns は描画(Telop.tsx)から独立した純関数。
 */

test("splitHighlightRuns: highlight_words 無しなら全体1区間(highlight=false)", () => {
  assert.deepEqual(splitHighlightRuns("2〜3,000円が相場です", undefined), [
    { text: "2〜3,000円が相場です", highlight: false },
  ]);
  assert.deepEqual(splitHighlightRuns("テスト", []), [{ text: "テスト", highlight: false }]);
});

test("splitHighlightRuns: 空文字は空配列", () => {
  assert.deepEqual(splitHighlightRuns("", ["a"]), []);
});

test("splitHighlightRuns: 文中の数字だけハイライトされる(参考画像14)", () => {
  assert.deepEqual(splitHighlightRuns("2〜3,000円が相場です", ["3,000円"]), [
    { text: "2〜", highlight: false },
    { text: "3,000円", highlight: true },
    { text: "が相場です", highlight: false },
  ]);
});

test("splitHighlightRuns: 複数語に対応する", () => {
  assert.deepEqual(splitHighlightRuns("90本上げて月5万円です", ["90本", "5万円"]), [
    { text: "90本", highlight: true },
    { text: "上げて月", highlight: false },
    { text: "5万円", highlight: true },
    { text: "です", highlight: false },
  ]);
});

test("splitHighlightRuns: 同じ語の複数出現をすべてハイライトする", () => {
  assert.deepEqual(splitHighlightRuns("底辺から底辺へ", ["底辺"]), [
    { text: "底辺", highlight: true },
    { text: "から", highlight: false },
    { text: "底辺", highlight: true },
    { text: "へ", highlight: false },
  ]);
});

test("splitHighlightRuns: 重なる語はマージして1区間になる", () => {
  assert.deepEqual(splitHighlightRuns("300回再生から", ["300回", "回再生"]), [
    { text: "300回再生", highlight: true },
    { text: "から", highlight: false },
  ]);
});

test("splitHighlightRuns: マッチしない語はハイライトなし", () => {
  assert.deepEqual(splitHighlightRuns("こんにちは", ["さようなら"]), [
    { text: "こんにちは", highlight: false },
  ]);
});

test("splitHighlightRuns: 分割結果を結合すると元のテキストに戻る(欠落・重複なし)", () => {
  const text = "300回再生から8,000回再生へ跳ね上がった";
  const runs = splitHighlightRuns(text, ["300回", "8,000回", "再生"]);
  assert.equal(runs.map((r) => r.text).join(""), text);
});

test("splitHighlightRuns: 空文字列の語は無視する", () => {
  assert.deepEqual(splitHighlightRuns("テスト", [""]), [{ text: "テスト", highlight: false }]);
});

test("DEFAULT_HIGHLIGHT_COLOR: 既定は赤(#E7305B)", () => {
  assert.equal(DEFAULT_HIGHLIGHT_COLOR, "#E7305B");
});
