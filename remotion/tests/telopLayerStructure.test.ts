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
