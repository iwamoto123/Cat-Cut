import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_OVERLAY_POSITION,
  isOverlayActive,
  normalizeOverlays,
  overlayLines,
  type OverlayItem,
} from "../src/lib/overlayItems.ts";

/**
 * フェーズT1-3(オーバーレイトラック)の正規化・表示区間判定のテスト。
 */

test("normalizeOverlays: 未定義・非配列は空扱い(overlays無しの既存compositionは描画なし)", () => {
  assert.deepEqual(normalizeOverlays(undefined), []);
  assert.deepEqual(normalizeOverlays(null), []);
  assert.deepEqual(normalizeOverlays({}), []);
  assert.deepEqual(normalizeOverlays([]), []);
});

test("normalizeOverlays: 正常な項目はそのまま通る", () => {
  const items = normalizeOverlays([
    {
      id: "ov_001",
      type: "chapter_title",
      start_ms: 0,
      end_ms: 15000,
      text: "底辺YouTuber卒業!?",
      position: "top_left",
    },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "ov_001");
  assert.equal(items[0].type, "chapter_title");
  assert.equal(items[0].position, "top_left");
});

test("normalizeOverlays: position 省略時は type 既定へ補完する", () => {
  const items = normalizeOverlays([
    { id: "a", type: "chapter_title", start_ms: 0, end_ms: 1000 },
    { id: "b", type: "profile_card", start_ms: 0, end_ms: 1000 },
    { id: "c", type: "list_stack", start_ms: 0, end_ms: 1000 },
    { id: "d", type: "cta_banner", start_ms: 0, end_ms: 1000 },
    { id: "e", type: "caption", start_ms: 0, end_ms: 1000 },
  ]);
  assert.deepEqual(
    items.map((item) => item.position),
    ["top_left", "bottom_left", "center", "bottom", "bottom"],
  );
  assert.equal(DEFAULT_OVERLAY_POSITION.chapter_title, "top_left");
});

test("normalizeOverlays: type不正・区間不正の項目は除外される", () => {
  const items = normalizeOverlays([
    { id: "bad_type", type: "unknown_type", start_ms: 0, end_ms: 1000 },
    { id: "bad_span", type: "caption", start_ms: 2000, end_ms: 1000 },
    { id: "zero_span", type: "caption", start_ms: 1000, end_ms: 1000 },
    { id: "no_ms", type: "caption" },
    null,
    "not_an_object",
    { id: "ok", type: "caption", start_ms: 0, end_ms: 1000 },
  ]);
  assert.deepEqual(
    items.map((item) => item.id),
    ["ok"],
  );
});

test("normalizeOverlays: id 省略時は添字から補完する", () => {
  const items = normalizeOverlays([{ type: "caption", start_ms: 0, end_ms: 1000 }]);
  assert.equal(items[0].id, "overlay_0");
});

test("isOverlayActive: [start_ms, end_ms) の半開区間で判定する", () => {
  const item: OverlayItem = {
    id: "x",
    type: "chapter_title",
    start_ms: 1000,
    end_ms: 2000,
    position: "top_left",
  };
  assert.equal(isOverlayActive(item, 999), false);
  assert.equal(isOverlayActive(item, 1000), true);
  assert.equal(isOverlayActive(item, 1999), true);
  assert.equal(isOverlayActive(item, 2000), false);
});

test("overlayLines: lines 優先、無ければ text を1行として返す", () => {
  const base = { id: "x", start_ms: 0, end_ms: 1000, position: "center" as const };
  assert.deepEqual(
    overlayLines({ ...base, type: "list_stack", lines: ["社長", "役員"], text: "無視される" }),
    ["社長", "役員"],
  );
  assert.deepEqual(overlayLines({ ...base, type: "cta_banner", text: "1行だけ" }), ["1行だけ"]);
  assert.deepEqual(overlayLines({ ...base, type: "caption" }), []);
});
