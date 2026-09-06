import test from "node:test";
import assert from "node:assert/strict";
import {
  TELOP_FIT_WIDTH_RATIO,
  TELOP_MAX_LINES,
  TELOP_MIN_FONT_SCALE,
  VERTICAL_TELOP_FIT_WIDTH_RATIO,
  clampTelopYPercent,
  computeTelopBlockLayout,
  fitFontSizeForLines,
  telopFitWidth,
  wrapSegmentsWithMaxLines,
} from "../src/lib/telopLayout.ts";
import { weightedTelopLineLength, wrapTelopLine } from "../src/lib/wrapTelopLine.ts";

/**
 * フェーズT2.5-1(はみ出し根絶・多層縁の行ズレ根絶)のレイアウト計算テスト。
 * computeTelopBlockLayout が「折返し(最大2行)→最長行への幅フィット」を1回だけ
 * 確定し、全レイヤーが同じ行配列・フォントサイズを共有できることを検証する。
 */

// --- wrapTelopLine の maxLines 制約(remotion側コピー) ---

test("wrapTelopLine maxLines: 長文もmaxLines=2以内へ再折返しする(remotion側)", () => {
  const text = "チャンネル登録者数がたった3ヶ月で10万人を突破した本当の理由を全部話します";
  assert.ok(wrapTelopLine(text, 12).length >= 3, "前提: 制約なしでは3行以上");
  const limited = wrapTelopLine(text, 12, 2);
  assert.ok(limited.length <= 2, `2行以内: ${JSON.stringify(limited)}`);
  assert.equal(limited.join(""), text);
});

// --- セグメント(ページの行)への合計行数配分 ---

test("wrapSegmentsWithMaxLines: 1セグメントは最大2行まで折り返す", () => {
  const lines = wrapSegmentsWithMaxLines(["インスタなのかYouTubeなのかXなのかいろいろ"], 16, TELOP_MAX_LINES);
  assert.equal(lines.length, 2);
});

test("wrapSegmentsWithMaxLines: 2セグメント(AIの明示改行)は各1行で確定する", () => {
  const lines = wrapSegmentsWithMaxLines(
    ["何がビジネスYouTuberとしてハマりかけているのか", "その答えを今から話します"],
    16,
    TELOP_MAX_LINES,
  );
  assert.equal(lines.length, 2, "合計2行の予算では各セグメント1行(幅フィットに任せる)");
  assert.equal(lines[0], "何がビジネスYouTuberとしてハマりかけているのか");
});

test("wrapSegmentsWithMaxLines: maxCharsPerLine未指定なら折返しせずそのまま返す", () => {
  const texts = ["とても長いテキストですが折返しされずそのまま返されます"];
  assert.deepEqual(wrapSegmentsWithMaxLines(texts, undefined, TELOP_MAX_LINES), texts);
});

// --- 幅フィット ---

test("fitFontSizeForLines: 収まる行はbaseFontSizeのまま、長い行は縮小する", () => {
  const base = { baseFontSize: 72, letterSpacingEm: 0.02, fitWidth: 1080 * 0.92 };
  const short = fitFontSizeForLines(["こんにちは"], base);
  assert.equal(short, 72, "短い行は縮小しない");
  const long = fitFontSizeForLines(["チャンネル登録者数がたった3ヶ月で10万人を突破した"], base);
  assert.ok(long < 72, `長い行は縮小される: ${long}`);
  // 縮小後は最長行が fitWidth に収まる(重み付き文字幅での概算検証)
  const maxLineEm = weightedTelopLineLength("チャンネル登録者数がたった3ヶ月で10万人を突破した");
  assert.ok(long * maxLineEm * 1.02 <= base.fitWidth + 1, "縮小後の行幅がfitWidth以内");
});

// --- 統合レイアウト ---

test("computeTelopBlockLayout: 2行折返し+最長行への幅フィットを同時に確定する", () => {
  const layout = computeTelopBlockLayout({
    segmentTexts: ["チャンネル登録者数がたった3ヶ月で10万人を突破した本当の理由"],
    maxCharsPerLine: 16,
    baseFontSize: 72,
    letterSpacingEm: 0.02,
    fitWidth: 1080 * 0.92,
  });
  assert.ok(layout.lineTexts.length <= 2, `最大2行: ${JSON.stringify(layout.lineTexts)}`);
  assert.ok(layout.fontSize <= 72);
  assert.ok(
    layout.fontSize >= 72 * TELOP_MIN_FONT_SCALE,
    `通常ケースは縮小下限(${TELOP_MIN_FONT_SCALE})以上: ${layout.fontSize}`,
  );
});

test("computeTelopBlockLayout: 短文は1行・縮小なしで返る", () => {
  const layout = computeTelopBlockLayout({
    segmentTexts: ["その秘策とは!?"],
    maxCharsPerLine: 16,
    baseFontSize: 72,
    letterSpacingEm: 0.02,
    fitWidth: 1080 * 0.92,
  });
  assert.deepEqual(layout.lineTexts, ["その秘策とは!?"]);
  assert.equal(layout.fontSize, 72);
});

test("computeTelopBlockLayout: 極長文言は3行を許可して縮小を緩和する(保険パス)", () => {
  const text =
    "動画編集も企画もサムネイルも全部ひとりでやっていた頃には想像もできなかった景色がそこには広がっていました";
  const narrow = computeTelopBlockLayout({
    segmentTexts: [text],
    maxCharsPerLine: 16,
    baseFontSize: 72,
    letterSpacingEm: 0.02,
    // 極端に狭い幅で2行では縮小下限を割るケースを再現する
    fitWidth: 500,
  });
  assert.ok(narrow.lineTexts.length <= 3, `3行以内: ${narrow.lineTexts.length}行`);
  assert.equal(narrow.lineTexts.join(""), text, "文字の欠落・追加がない");
  // 3行時のフォントサイズは2行時より大きい(縮小の緩和になっている)
  const twoLineFit = fitFontSizeForLines(wrapTelopLine(text, 16, 2), {
    baseFontSize: 72,
    letterSpacingEm: 0.02,
    fitWidth: 500,
  });
  assert.ok(
    narrow.fontSize >= twoLineFit,
    `3行化でフォントが大きくなる: ${narrow.fontSize} >= ${twoLineFit}`,
  );
});

// --- 縦クランプ ---

test("clampTelopYPercent: セーフエリア内はそのまま、下端超過はクランプされる", () => {
  const base = { lineHeight: 1.4, fontSize: 72, videoHeight: 1920 };
  const centered = clampTelopYPercent({ telopY: 0.5, yOffset: 0, lineCount: 1, ...base });
  assert.equal(centered, 50, "中央はそのまま");
  const bottom = clampTelopYPercent({ telopY: 0.85, yOffset: 0.2, lineCount: 2, ...base });
  // ブロック高さ 2*1.4*72+8=209.6px → 半分 ≈ 5.46% → 上限 ≈ 100-4-5.46 ≈ 90.5%
  assert.ok(bottom < 105 - 4, `下端セーフエリアへクランプ: ${bottom}`);
  const blockHalfRatio = (2 * 1.4 * 72 + 8) / 1920 / 2;
  assert.ok(Math.abs(bottom / 100 - (1 - 0.04 - blockHalfRatio)) < 1e-9, "クランプ位置が計算通り");
});

test("clampTelopYPercent: 上端も同様にクランプされる", () => {
  const y = clampTelopYPercent({
    telopY: 0.02,
    yOffset: -0.1,
    lineCount: 2,
    lineHeight: 1.4,
    fontSize: 72,
    videoHeight: 1920,
  });
  const blockHalfRatio = (2 * 1.4 * 72 + 8) / 1920 / 2;
  assert.ok(Math.abs(y / 100 - (0.04 + blockHalfRatio)) < 1e-9, `上端クランプ: ${y}`);
});

test("clampTelopYPercent: ブロックがセーフエリアより高い場合は中央(50%)へ置く", () => {
  const y = clampTelopYPercent({
    telopY: 0.9,
    yOffset: 0,
    lineCount: 3,
    lineHeight: 1.5,
    fontSize: 300,
    videoHeight: 1080,
  });
  assert.equal(y, 50);
});

// --- W24 Phase A-2: 縦型の幅フィット上限(右端セーフゾーン) ---

test("telopFitWidth: 横型キャンバスは従来どおり92%", () => {
  assert.equal(telopFitWidth(1920, 1080), 1920 * TELOP_FIT_WIDTH_RATIO);
  assert.equal(TELOP_FIT_WIDTH_RATIO, 0.92);
});

test("telopFitWidth: 縦型キャンバス(高さ>幅)は右端セーフゾーン分だけ86%へ絞る", () => {
  assert.equal(telopFitWidth(1080, 1920), 1080 * VERTICAL_TELOP_FIT_WIDTH_RATIO);
  assert.equal(VERTICAL_TELOP_FIT_WIDTH_RATIO, 0.86);
});
