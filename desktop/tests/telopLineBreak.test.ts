import test from "node:test";
import assert from "node:assert/strict";
import {
  dependentHeadLength,
  isBadLineBreak,
  isDependentLineHead,
  isPhraseEndBreak,
} from "../src/lib/telopLineBreak.ts";

/**
 * 実機FB「名詞＋助詞が続くときに名詞までで改行される」対応の付属語ルールのテスト。
 * python/shared/line_break_rules.py と同じ判定になっていることを担保する。
 */

test("isDependentLineHead: 1文字助詞で始まるテキストは付属語始まり", () => {
  for (const text of ["を受けられると思う", "が出てくるので", "でキャプテンをしてて", "の動画を上げています"]) {
    assert.ok(isDependentLineHead(text), text);
  }
});

test("isDependentLineHead: 助詞と同じ文字で始まる自立語は付属語扱いしない", () => {
  for (const text of ["がんばって続ける", "はい、わかりました", "もう9月です", "かなり厳しい"]) {
    assert.ok(!isDependentLineHead(text), text);
  }
});

test("isDependentLineHead: 助動詞・補助動詞・形式名詞も付属語扱い", () => {
  for (const text of ["していまして", "っていうところを", "という話です", "ので、あとは", "とかも出してる", "ところで枠を"]) {
    assert.ok(isDependentLineHead(text), text);
  }
});

test("dependentHeadLength: 最長一致で付属語の長さを返す", () => {
  assert.equal(dependentHeadLength("っていうところを"), 4);
  assert.equal(dependentHeadLength("共通テスト"), 0);
});

test("isBadLineBreak: 直前が句読点なら行頭が付属語でも不自然でない", () => {
  assert.ok(!isBadLineBreak("こんにちは。", "でも今日は"));
  assert.ok(isBadLineBreak("こんにちは", "でも今日は"));
});

test("isPhraseEndBreak: 助詞・句読点で終わる位置は文節末", () => {
  assert.ok(isPhraseEndBreak("共通テスト対策の"));
  assert.ok(isPhraseEndBreak("大体の学校は、"));
  assert.ok(!isPhraseEndBreak("いろんな共通テスト"));
});
