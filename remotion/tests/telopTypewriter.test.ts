import test from "node:test";
import assert from "node:assert/strict";
import {
  splitGraphemes,
  typewriterCharDelayMs,
  typewriterLineOffsets,
  typewriterRevealRatio,
  typewriterVisibleCount,
} from "../src/lib/telopTypewriter.ts";

/**
 * フェーズW24 Phase B-1(typewriter)の共有ロジックのテスト。
 * Remotion本描画(フレーム進捗→表示文字数)とプレビューCSS近似(文字ごとのdelay)が
 * 同じ出現規則になることを検証する。
 */

test("splitGraphemes: 日本語・サロゲートペア・絵文字をgrapheme単位で分割する", () => {
  assert.deepEqual(splitGraphemes("こんにちは"), ["こ", "ん", "に", "ち", "は"]);
  // サロゲートペア(𩸽 = U+29E3D)がコードポイント単位で壊れない
  assert.deepEqual(splitGraphemes("𩸽です"), ["𩸽", "で", "す"]);
  // 結合絵文字(ZWJシーケンス)も1graphemeとして扱う(Intl.Segmenterのある環境)
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    assert.deepEqual(splitGraphemes("👨‍👩‍👧OK"), ["👨‍👩‍👧", "O", "K"]);
  }
  assert.deepEqual(splitGraphemes(""), []);
});

test("typewriterVisibleCount: 進捗0で1文字・進捗1で全文字・単調増加", () => {
  const total = 10;
  assert.equal(typewriterVisibleCount(total, 0), 1, "開始と同時に1文字目を打つ");
  assert.equal(typewriterVisibleCount(total, 1), total);
  assert.equal(typewriterVisibleCount(total, 2), total, "進捗1超は全文字のまま");
  assert.equal(typewriterVisibleCount(total, -0.5), 0, "開始前は0文字");
  assert.equal(typewriterVisibleCount(0, 0.5), 0, "空テキストは0");
  let prev = 0;
  for (let step = 0; step <= 100; step += 1) {
    const count = typewriterVisibleCount(total, step / 100);
    assert.ok(count >= prev, `進捗${step / 100}で表示数が減らない`);
    prev = count;
  }
});

test("typewriterVisibleCount と typewriterRevealRatio の整合: 文字iは progress >= i/total で表示", () => {
  const total = 7;
  for (let index = 0; index < total; index += 1) {
    const ratio = typewriterRevealRatio(index, total);
    // 出現タイミングちょうどでは表示される
    assert.ok(
      typewriterVisibleCount(total, ratio) >= index + 1,
      `progress=${ratio} で文字${index}が表示される`,
    );
    // 出現タイミングの直前では表示されない(先頭文字を除く)
    if (index > 0) {
      assert.ok(
        typewriterVisibleCount(total, ratio - 0.001) <= index,
        `progress=${ratio - 0.001} で文字${index}はまだ隠れている`,
      );
    }
  }
});

test("typewriterCharDelayMs: CSS近似のdelayがRemotionの出現規則と同値(delay = i/total × duration)", () => {
  const total = 5;
  const durationMs = 400;
  assert.equal(typewriterCharDelayMs(0, total, durationMs), 0);
  assert.equal(typewriterCharDelayMs(1, total, durationMs), 80);
  assert.equal(typewriterCharDelayMs(4, total, durationMs), 320);
  // Remotion側: progress = delay/duration の時点でその文字が表示されている
  for (let index = 0; index < total; index += 1) {
    const delay = typewriterCharDelayMs(index, total, durationMs);
    assert.ok(typewriterVisibleCount(total, delay / durationMs) >= index + 1);
  }
});

test("typewriterLineOffsets: 行またぎの通し番号(2行目は1行目の文字数から始まる)", () => {
  const { offsets, total } = typewriterLineOffsets(["こんにちは", "世界🌍"]);
  assert.deepEqual(offsets, [0, 5]);
  assert.equal(total, 8);
  assert.deepEqual(typewriterLineOffsets([]), { offsets: [], total: 0 });
});
