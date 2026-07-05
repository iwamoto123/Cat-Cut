import test from "node:test";
import assert from "node:assert/strict";
import {
  applyDeterministicTextCleaning,
  cleanTelopCommas,
  cleanTelopLine,
  normalizeFullwidthDigits,
  normalizeTelopDisplayText,
  removeTelopPeriods,
  stripLeadingTelopPunctuation,
} from "../src/lib/telopTextNormalize.ts";

test("removeTelopPeriods: 句点「。」を全除去する", () => {
  assert.equal(removeTelopPeriods("今回はこちら見てください。"), "今回はこちら見てください");
  assert.equal(removeTelopPeriods("A。B。C。"), "ABC");
});

test("stripLeadingTelopPunctuation: 先頭の禁止句読点を除去する", () => {
  assert.equal(stripLeadingTelopPunctuation("、先頭禁止"), "先頭禁止");
  assert.equal(stripLeadingTelopPunctuation("…驚き"), "驚き");
});

test("normalizeTelopDisplayText: 句点除去と先頭句読点禁止を両方適用する", () => {
  assert.equal(normalizeTelopDisplayText("。今回はテスト。"), "今回はテスト");
});

test("applyDeterministicTextCleaning: 末尾読点・連続読点・全角数字", () => {
  assert.equal(applyDeterministicTextCleaning("志望大学は、"), "志望大学は");
  assert.equal(applyDeterministicTextCleaning("質問が、、"), "質問が");
  assert.equal(applyDeterministicTextCleaning("６月"), "6月");
});

test("cleanTelopCommas: 末尾読点を除去する", () => {
  assert.equal(cleanTelopCommas("で細かい質問が、"), "で細かい質問が");
});

test("normalizeFullwidthDigits: 全角数字を半角にする", () => {
  assert.equal(normalizeFullwidthDigits("１２３"), "123");
});

test("cleanTelopLine: 行末読点を除去する", () => {
  assert.equal(cleanTelopLine("それでは奉仕インタビューということで、"), "それでは奉仕インタビューということで");
});

test("cleanTelopLine: 行末フィラー「、ね」「、ま」を除去する", () => {
  assert.equal(cleanTelopLine("お疲れ様でしたということで、ね"), "お疲れ様でしたということで");
  assert.equal(cleanTelopLine("動画撮ってるんですが、ま"), "動画撮ってるんですが");
});

test("cleanTelopLine: 読点なしの「ね」や行頭の「ね」は残す", () => {
  assert.equal(cleanTelopLine("大学ってすごいからね"), "大学ってすごいからね");
  assert.equal(cleanTelopLine("ね、まだ逆転できるよ"), "ね、まだ逆転できるよ");
});

test("cleanTelopLine: 「？、」を「？」に正規化する", () => {
  assert.equal(cleanTelopLine("正社員だったんですか？、"), "正社員だったんですか？");
});

test("normalizeTelopDisplayText: 行末読点・「？、」も除去する", () => {
  assert.equal(normalizeTelopDisplayText("正社員だったんですか？、"), "正社員だったんですか？");
});
