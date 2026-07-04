import test from "node:test";
import assert from "node:assert/strict";
import { detectEmotionTag } from "../src/lib/emotionTag.ts";

test("detectEmotionTag: 疑問形の語尾(ですか/ますか/でしょうか/かな/？)は疑問と判定する", () => {
  assert.equal(detectEmotionTag("これで合っていますか"), "question");
  assert.equal(detectEmotionTag("本当に大丈夫でしょうか"), "question");
  assert.equal(detectEmotionTag("うまくいくかな"), "question");
  assert.equal(detectEmotionTag("これでいいの？"), "question");
});

test("detectEmotionTag: 比較語・強調語(ぐっと/一番/実は/なんと等)を含む文は強調と判定する", () => {
  assert.equal(detectEmotionTag("実は最近、電気代がぐっと下がっているんです"), "emphasis");
  assert.equal(detectEmotionTag("これが一番のポイントです"), "emphasis");
  assert.equal(detectEmotionTag("なんと今なら半額です"), "emphasis");
});

test("detectEmotionTag: 数字・金額・割合を含む文は強調と判定する", () => {
  assert.equal(detectEmotionTag("平均点は566点でした"), "emphasis");
  assert.equal(detectEmotionTag("今なら30%オフです"), "emphasis");
});

test("detectEmotionTag: 体言止め(ひらがな以外で終わる)は強調と判定する", () => {
  assert.equal(detectEmotionTag("衝撃の展開"), "emphasis");
  assert.equal(detectEmotionTag("第1問の解説"), "emphasis");
});

test("detectEmotionTag: 感嘆符・驚き語を含む文は驚きと判定する(強調語を含まない場合)", () => {
  assert.equal(detectEmotionTag("すごい結果でした"), "surprise");
  assert.equal(detectEmotionTag("えっ、本当ですか"), "question", "疑問形が優先される");
  assert.equal(detectEmotionTag("まさかの展開でしたね"), "surprise");
});

test("detectEmotionTag: 上記いずれにも該当しない文は通常と判定する", () => {
  assert.equal(detectEmotionTag("その理由にはいくつかポイントがあります"), "normal");
  assert.equal(detectEmotionTag("今日は天気がいいですね"), "normal");
});

test("detectEmotionTag: 空文字は通常として扱う", () => {
  assert.equal(detectEmotionTag(""), "normal");
  assert.equal(detectEmotionTag("   "), "normal");
});
