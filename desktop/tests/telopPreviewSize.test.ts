import test from "node:test";
import assert from "node:assert/strict";
import {
  computeContainedVideoBox,
  computeRelativeTelopFontPx,
  fitTelopTextToWidth,
  measureTelopTextWidthPx,
} from "../src/lib/telopPreviewSize.ts";

/**
 * 改善8-B-4(プレビューのテロップ描画をプリセット忠実に)向けのテスト。
 * node --experimental-strip-types 環境には document/Canvas が無いため、
 * measureTelopTextWidthPx は weightedGlyphLength() による概算(全角1文字 ≈ 1em)にフォールバックする。
 * このフォールバック値を前提にfitTelopTextToWidthの挙動を検証する。
 */

test("computeContainedVideoBox: コンテナと同じアスペクト比なら全面表示でオフセット0", () => {
  const box = computeContainedVideoBox(1000, 562.5, 1920, 1080);
  assert.equal(Math.round(box.width), 1000);
  assert.equal(Math.round(box.height), 563);
  assert.equal(box.offsetX, 0);
  assert.equal(Math.round(box.offsetY), 0);
});

test("computeContainedVideoBox: 動画が縦長(9:16)でコンテナが横長の場合は左右に余白ができる", () => {
  const box = computeContainedVideoBox(1000, 1000, 1080, 1920);
  assert.ok(box.width < 1000, "左右に余白ができるぶん幅は縮む");
  assert.equal(box.height, 1000);
  assert.ok(box.offsetX > 0);
  assert.equal(box.offsetY, 0);
});

test("computeContainedVideoBox: intrinsicサイズ未取得(0)の場合はコンテナをそのまま返す", () => {
  const box = computeContainedVideoBox(800, 450, 0, 0);
  assert.deepEqual(box, { width: 800, height: 450, offsetX: 0, offsetY: 0 });
});

test("computeRelativeTelopFontPx: 基準解像度幅に対するtelopFontSizeの比率を表示幅にそのまま乗じる", () => {
  // 例: 1920px幅の動画でtelop_font_size=72のとき、表示幅960pxのプレビューでは36px相当になる。
  assert.equal(computeRelativeTelopFontPx(960, 72, 1920), 36);
  assert.equal(computeRelativeTelopFontPx(0, 72, 1920), 0, "表示幅0は0を返す(未計測時の安全策)");
});

test("measureTelopTextWidthPx: document未定義環境ではweightedGlyphLength概算にフォールバックする(全角1文字≈1em)", () => {
  const width = measureTelopTextWidthPx("あいう", 100, "sans-serif", 900, 0);
  assert.equal(width, 300, "全角3文字×fontSizePx(100)の概算");
});

test("measureTelopTextWidthPx: letter_spacingは(文字数-1)ぶんを追加で加算する", () => {
  const withoutSpacing = measureTelopTextWidthPx("あいう", 100, "sans-serif", 900, 0);
  const withSpacing = measureTelopTextWidthPx("あいう", 100, "sans-serif", 900, 0.02);
  assert.equal(withSpacing - withoutSpacing, 2 * 0.02 * 100, "3文字なので間隔は2箇所ぶん");
});

test("fitTelopTextToWidth: 1行が目標幅(90%)に収まるならフォントサイズはそのまま", () => {
  // 概算値: 5文字×72px=360px。videoDisplayWidthPx=500の90%=450pxに収まる。
  const result = fitTelopTextToWidth("あいうえお", {
    videoDisplayWidthPx: 500,
    preferredFontSizePx: 72,
    fontFamily: "sans-serif",
    fontWeight: 900,
  });
  assert.equal(result.fontSizePx, 72);
  assert.deepEqual(result.lines, ["あいうえお"]);
});

test("fitTelopTextToWidth: 収まらない場合は目標幅ちょうどに収まるサイズへ比例縮小し1行のまま表示する", () => {
  // 概算値: 10文字×90px=900px。videoDisplayWidthPx=500の90%=450px。
  // 450/900=0.5倍まで縮小すればよく、90*0.5=45px。preferredの50%(45px)がちょうど下限と一致する境界ケース。
  const result = fitTelopTextToWidth("あいうえおかきくけこ", {
    videoDisplayWidthPx: 500,
    preferredFontSizePx: 90,
    fontFamily: "sans-serif",
    fontWeight: 900,
  });
  assert.equal(result.fontSizePx, 45);
  assert.deepEqual(result.lines, ["あいうえおかきくけこ"]);
});

test("fitTelopTextToWidth: 縮小しても下限(minFontSizePx)を割り込む場合は2行に折り返す", () => {
  // 概算値: 20文字×90px=1800px。目標幅450pxに収めるには90*450/1800=22.5px必要だが、
  // minFontSizePxを明示的に40pxに指定しているため、下限(40px)のまま2行へ折り返す。
  const longText = "あいうえおかきくけこさしすせそたちつてと";
  const result = fitTelopTextToWidth(longText, {
    videoDisplayWidthPx: 500,
    preferredFontSizePx: 90,
    fontFamily: "sans-serif",
    fontWeight: 900,
    minFontSizePx: 40,
  });
  assert.equal(result.fontSizePx, 40);
  assert.equal(result.lines.length, 2, "1行に収まらないため2行に折り返す");
  assert.equal(result.lines.join(""), longText, "折り返しても文字の欠落・重複が起きない");
});

test("fitTelopTextToWidth: 空文字は何もせずlines:[]を返す", () => {
  const result = fitTelopTextToWidth("", { videoDisplayWidthPx: 500, preferredFontSizePx: 72, fontFamily: "sans-serif", fontWeight: 900 });
  assert.deepEqual(result, { fontSizePx: 72, lines: [] });
});

test("fitTelopTextToWidth: videoDisplayWidthPxが未計測(0)の場合はクランプせず1行のまま返す(安全策)", () => {
  const result = fitTelopTextToWidth("あいうえお", {
    videoDisplayWidthPx: 0,
    preferredFontSizePx: 72,
    fontFamily: "sans-serif",
    fontWeight: 900,
  });
  assert.deepEqual(result, { fontSizePx: 72, lines: ["あいうえお"] });
});
