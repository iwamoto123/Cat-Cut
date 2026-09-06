import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHighlightMask,
  computeCharKinds,
  DEFAULT_LATIN_FONT_FAMILY,
  DEFAULT_PARTICLE_SCALE,
  splitStyledRuns,
  splitTypographyRuns,
} from "../src/lib/telopTypography.ts";

/**
 * タイポグラフィ(助詞縮小・和欧混植)の分割ロジックのテスト。
 * 決定的ルールのみで判定する(AI・形態素解析なし = 実行ごとのトークン消費ゼロ)。
 */

test("既定値: 助詞縮小80% / 欧文フォントはシステムフォント(SF Pro系)", () => {
  assert.equal(DEFAULT_PARTICLE_SCALE, 0.8);
  assert.ok(DEFAULT_LATIN_FONT_FAMILY.includes("-apple-system"));
  assert.ok(DEFAULT_LATIN_FONT_FAMILY.includes("Helvetica Neue"));
});

test("助詞縮小: 漢字に挟まれた「の」「が」は particle になる", () => {
  const runs = splitTypographyRuns("昨年の平均点が下落");
  assert.deepEqual(runs, [
    { text: "昨年", kind: "normal" },
    { text: "の", kind: "particle" },
    { text: "平均点", kind: "normal" },
    { text: "が", kind: "particle" },
    { text: "下落", kind: "normal" },
  ]);
});

test("助詞縮小: 前がひらがなの「の」は縮小しない(準体助詞の誤縮小防止)", () => {
  // 「下がったの知ってますか」の「の」は前が「た」(ひらがな)なので normal のまま
  const kinds = computeCharKinds("下がったの知ってますか");
  const chars = Array.from("下がったの知ってますか");
  const noIdx = chars.indexOf("の");
  assert.equal(kinds[noIdx], "normal");
});

test("助詞縮小: 行頭・行末の助詞は縮小しない", () => {
  assert.deepEqual(computeCharKinds("が優勝"), ["normal", "normal", "normal"]);
  assert.deepEqual(computeCharKinds("優勝が"), ["normal", "normal", "normal"]);
});

test("助詞縮小: カタカナ・英数字に挟まれた助詞も縮小する", () => {
  const runs = splitTypographyRuns("データの分析");
  assert.deepEqual(runs[1], { text: "の", kind: "particle" });
  const runsLatin = splitTypographyRuns("AIが進化");
  assert.deepEqual(runsLatin, [
    { text: "AI", kind: "latin" },
    { text: "が", kind: "particle" },
    { text: "進化", kind: "normal" },
  ]);
});

test("和欧混植: 半角英数字の連続は latin になる", () => {
  assert.deepEqual(splitTypographyRuns("TOEIC900点"), [
    { text: "TOEIC900", kind: "latin" },
    { text: "点", kind: "normal" },
  ]);
});

test("和欧混植: 数値内の記号(小数点・カンマ・%)は欧文ランに含める", () => {
  assert.deepEqual(splitTypographyRuns("3.5万円"), [
    { text: "3.5", kind: "latin" },
    { text: "万円", kind: "normal" },
  ]);
  assert.deepEqual(splitTypographyRuns("1,000人"), [
    { text: "1,000", kind: "latin" },
    { text: "人", kind: "normal" },
  ]);
  assert.deepEqual(splitTypographyRuns("合格率50%です"), [
    { text: "合格率", kind: "normal" },
    { text: "50%", kind: "latin" },
    { text: "です", kind: "normal" },
  ]);
});

test("和欧混植: 全角数字は対象外(和文のまま)", () => {
  assert.deepEqual(splitTypographyRuns("３年後"), [{ text: "３年後", kind: "normal" }]);
});

test("分割結果を結合すると元のテキストに戻る(欠落・重複なし)", () => {
  const texts = ["昨年の平均点が3.5点下がったの知ってますか", "TOEIC900点の壁", "50%が不合格"];
  for (const text of texts) {
    assert.equal(
      splitTypographyRuns(text)
        .map((run) => run.text)
        .join(""),
      text,
    );
  }
});

test("空文字は空配列", () => {
  assert.deepEqual(splitTypographyRuns(""), []);
});

test("splitStyledRuns: タイポグラフィとハイライトの境界を合成する", () => {
  const text = "昨年の平均点が下落";
  const mask = buildHighlightMask(text, ["平均点"]);
  assert.deepEqual(splitStyledRuns(text, mask), [
    { text: "昨年", kind: "normal", highlight: false },
    { text: "の", kind: "particle", highlight: false },
    { text: "平均点", kind: "normal", highlight: true },
    { text: "が", kind: "particle", highlight: false },
    { text: "下落", kind: "normal", highlight: false },
  ]);
});

test("splitStyledRuns: ハイライト境界が latin ランの途中にあっても分割される", () => {
  const text = "TOEIC900点";
  const mask = buildHighlightMask(text, ["900点"]);
  assert.deepEqual(splitStyledRuns(text, mask), [
    { text: "TOEIC", kind: "latin", highlight: false },
    { text: "900", kind: "latin", highlight: true },
    { text: "点", kind: "normal", highlight: true },
  ]);
});

test("buildHighlightMask: 複数語・複数出現をすべてマークする", () => {
  const mask = buildHighlightMask("底辺から底辺へ", ["底辺"]);
  assert.deepEqual(mask, [true, true, false, false, true, true, false]);
});
