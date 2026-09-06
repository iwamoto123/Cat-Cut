import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_OVERLAY_POSITION,
  isOverlayActive,
  normalizeOverlays,
  overlayLines,
} from "../src/lib/overlayItems.ts";

/**
 * U1-5(オーバーレイのDOM版): overlayItems のデスクトップ側コピーのテスト。
 * ロジック本体のテストは remotion/tests/overlayItems.test.ts、Remotionとのファイル一致は
 * sharedRemotionCopies.test.ts が担保する。ここではdesktop側から使う代表経路のスモークのみ。
 */

test("normalizeOverlays: type不正・区間不正を除外し、position省略はtype既定へ補完する(desktop側スモーク)", () => {
  const items = normalizeOverlays([
    { id: "a", type: "chapter_title", start_ms: 0, end_ms: 1000, text: "章" },
    { id: "b", type: "unknown_type", start_ms: 0, end_ms: 1000 },
    { id: "c", type: "cta_banner", start_ms: 1000, end_ms: 1000 },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].position, DEFAULT_OVERLAY_POSITION.chapter_title);
  assert.ok(isOverlayActive(items[0], 500));
  assert.ok(!isOverlayActive(items[0], 1000)); // 半開区間
  assert.deepEqual(overlayLines(items[0]), ["章"]);
});
