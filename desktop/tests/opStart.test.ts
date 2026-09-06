// フェーズW23(改善1): 解析開始前OP選択 → run正本op_config初期値(main/opStart.cjs)のテスト。
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { resolveStartOpConfig } = require("../main/opStart.cjs");

const themeOpNone = {
  pattern: "none",
  decoration: "cinema_bars",
  text_animation: "slide_up",
  title: "テーマタイトル",
  title_enabled: true,
  catch_copy: "キャッチ",
};

const themeOpTeaser = { ...themeOpNone, pattern: "highlight_teaser" };

test("opEnabled=false はテーマ設定を保持しつつ pattern=none / clips=null", () => {
  const result = resolveStartOpConfig(themeOpTeaser, false);
  assert.ok(result);
  assert.equal(result.pattern, "none");
  assert.equal(result.clips, null);
  // 検品後にOpEditorでONへ戻したときのため装飾・文言は保持する
  assert.equal(result.decoration, "cinema_bars");
  assert.equal(result.title, "テーマタイトル");
});

test("opEnabled=true でテーマが none なら highlight_teaser へ昇格", () => {
  const result = resolveStartOpConfig(themeOpNone, true);
  assert.ok(result);
  assert.equal(result.pattern, "highlight_teaser");
  assert.equal(result.clips, null);
  assert.equal(result.text_animation, "slide_up");
});

test("opEnabled=true でテーマが none 以外ならテーマのパターンを維持", () => {
  const result = resolveStartOpConfig(themeOpTeaser, true);
  assert.ok(result);
  assert.equal(result.pattern, "highlight_teaser");
  assert.equal(result.clips, null);
});

test("opEnabled 未指定(旧UI・後方互換)は null(従来の ensureRunOpConfig 経路)", () => {
  assert.equal(resolveStartOpConfig(themeOpTeaser, undefined), null);
  // boolean 以外の不正値も後方互換経路へ落とす
  assert.equal(resolveStartOpConfig(themeOpTeaser, "true"), null);
  assert.equal(resolveStartOpConfig(themeOpTeaser, 1), null);
  assert.equal(resolveStartOpConfig(themeOpTeaser, null), null);
});

test("baseOp が不正でも安全な既定で返す", () => {
  const off = resolveStartOpConfig(null, false);
  assert.ok(off);
  assert.equal(off.pattern, "none");
  const on = resolveStartOpConfig(undefined, true);
  assert.ok(on);
  assert.equal(on.pattern, "highlight_teaser");
  assert.equal(on.clips, null);
});
