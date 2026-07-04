import test from "node:test";
import assert from "node:assert/strict";
import { detectTelopWordReplacement } from "../src/lib/telopReplace.ts";

// --- 改善5-7(一括置換ポップアップ): 編集前後のテロップテキストから単語置換(A→B)を検出する ---

test("detectTelopWordReplacement: 単一の連続した単語置換を検出する", () => {
  assert.deepEqual(
    detectTelopWordReplacement("谷内さんに相談する", "谷内さんに谷内する"),
    { from: "相談", to: "谷内" },
  );
});

test("detectTelopWordReplacement: 変更が無ければnull", () => {
  assert.equal(detectTelopWordReplacement("同じ文章", "同じ文章"), null);
});

test("detectTelopWordReplacement: 純粋な挿入(fromが空)はnull", () => {
  assert.equal(detectTelopWordReplacement("あいう", "あいうえお"), null);
});

test("detectTelopWordReplacement: 純粋な削除(toが空)はnull", () => {
  assert.equal(detectTelopWordReplacement("あいうえお", "あいう"), null);
});

test("detectTelopWordReplacement: 差分区間が長すぎる(20文字超)場合は文章の書き換えとみなしnull", () => {
  const before = "これは短い文章です";
  const longReplacement = "あ".repeat(25);
  assert.equal(detectTelopWordReplacement(before, longReplacement), null);
});

test("detectTelopWordReplacement: 差分区間に改行を含む場合はnull(複数行にまたがる編集)", () => {
  assert.equal(detectTelopWordReplacement("あいう", "あ\nいう"), null);
});

test("detectTelopWordReplacement: 先頭・末尾が同じ短いテキストでも単語置換として検出できる", () => {
  assert.deepEqual(detectTelopWordReplacement("今日は晴れです", "今日は雨です"), { from: "晴れ", to: "雨" });
});
