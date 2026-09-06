import test from "node:test";
import assert from "node:assert/strict";
import { overlayTimeRangeLabel, overlayTypeLabel } from "../src/lib/overlayLabels.ts";

/**
 * V8-5: オーバーレイのUI用語(種類別の日本語名)と表示時間帯ラベル。
 */

test("overlayTypeLabel: 種類別のユーザー向け名称(仕様書V8-5の語彙)", () => {
  assert.equal(overlayTypeLabel("chapter_title"), "左上タイトル");
  assert.equal(overlayTypeLabel("profile_card"), "プロフィールカード");
  assert.equal(overlayTypeLabel("cta_banner"), "CTAバナー");
  assert.equal(overlayTypeLabel("list_stack"), "箇条書き");
  assert.equal(overlayTypeLabel("caption"), "キャプション");
  // 未知typeはそのまま返す(保険)
  assert.equal(overlayTypeLabel("unknown_type"), "unknown_type");
});

test("overlayTimeRangeLabel: m:ss〜m:ss 形式", () => {
  assert.equal(overlayTimeRangeLabel(0, 5000), "0:00〜0:05");
  assert.equal(overlayTimeRangeLabel(59000, 61000), "0:59〜1:01");
  assert.equal(overlayTimeRangeLabel(125400, 130900), "2:05〜2:10");
});
