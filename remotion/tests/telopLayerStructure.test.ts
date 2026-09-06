import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * フェーズT2.5-1(多層縁の行ズレ根絶)の構造リグレッションテスト。
 *
 * Telop.tsx はコンポーネントのためNode単体では実行できないが、
 * 「折返しはレイヤーの外(computeTelopBlockLayout)で1回だけ確定し、
 * 全レイヤーがCSS再折返し禁止(nowrap)で同じ行配列を描く」という構造が
 * 崩れると行ズレが再発するため、ソース構造をリントとして固定する。
 */

const TELOP_SOURCE = readFileSync(join(import.meta.dirname, "../src/components/Telop.tsx"), "utf-8");

test("Telop.tsx: 行div内のCSS再折返しを禁止している(whiteSpace: nowrap)", () => {
  assert.ok(TELOP_SOURCE.includes('whiteSpace: "nowrap"'), "nowrap指定が存在する");
  assert.ok(!TELOP_SOURCE.includes('"pre-wrap"'), "pre-wrap(レイヤーごとの再折返し)を使っていない");
});

test("Telop.tsx: 折返しと幅フィットはtelopLayoutの統合計算を使う", () => {
  assert.ok(TELOP_SOURCE.includes("computeTelopBlockLayout"), "統合レイアウト計算を使う");
  assert.ok(TELOP_SOURCE.includes("clampTelopYPercent"), "縦クランプを使う");
});

test("Telop.tsx: TelopLayerは確定済みのlineTexts(単一の行配列)を受け取る", () => {
  // TelopLayer が text/segments を受け取って独自に折り返す構造へ戻っていないこと
  assert.ok(TELOP_SOURCE.includes("lineTexts={layout.lineTexts}"), "確定済み行配列を渡す");
  assert.ok(TELOP_SOURCE.includes("fontSize={layout.fontSize}"), "確定済みフォントサイズを渡す");
});

test("Telop.tsx: オフセット影(shadow_offset)レイヤーを縁レイヤーの下に描画する", () => {
  assert.ok(TELOP_SOURCE.includes("shadow_offset"), "shadow_offsetを参照する");
  const shadowIndex = TELOP_SOURCE.indexOf("{shadowOffset && (");
  const outerIndex = TELOP_SOURCE.indexOf("{style.outer_stroke && (");
  assert.ok(shadowIndex >= 0 && outerIndex >= 0, "影レイヤーと縁レイヤーが存在する");
  assert.ok(shadowIndex < outerIndex, "影レイヤーは縁レイヤーより先(下)に描画される");
});

test("Telop.tsx: 第3縁(outer_stroke2)は outer_stroke より先(最背面)に描画される", () => {
  const stroke2Index = TELOP_SOURCE.indexOf("{style.outer_stroke2 && (");
  const outerIndex = TELOP_SOURCE.indexOf("{style.outer_stroke && (");
  const innerIndex = TELOP_SOURCE.indexOf("{style.inner_stroke && (");
  assert.ok(stroke2Index >= 0, "第3縁レイヤーが存在する");
  assert.ok(stroke2Index < outerIndex, "第3縁は第2縁(outer)より先(下)に描画される");
  assert.ok(outerIndex < innerIndex, "第2縁は第1縁(inner)より先(下)に描画される");
});

test("Telop.tsx: 第3縁もオフセット影のシルエット幅(shadowStrokeWidth)に含まれる", () => {
  assert.ok(
    TELOP_SOURCE.includes("Math.max(outerStroke2Width, outerStrokeWidth, innerStrokeWidth)"),
    "影のstroke幅は3縁の最大値",
  );
});

test("Telop.tsx: 光彩(glow)はbuildGlowFilterでdrop_shadowとfilter結合される", () => {
  assert.ok(TELOP_SOURCE.includes("buildGlowFilter"), "光彩の生成関数を使う");
  assert.ok(TELOP_SOURCE.includes("combineTelopFilters"), "drop_shadowとの結合関数を使う");
  // W24 Phase B-1: 登場アニメのfilter(blur_in)はblockFilter(グロウ・影)の前段に結合して
  // ブロックのfilterへ適用する(アニメなしのときは従来どおりblockFilterのみ)
  assert.ok(TELOP_SOURCE.includes("filter: combinedFilter"), "ブロックのfilterに結合結果を使う");
  assert.ok(TELOP_SOURCE.includes("(animFilter ?? blockFilter)"), "アニメfilterとglow/影filterを結合する");
});
