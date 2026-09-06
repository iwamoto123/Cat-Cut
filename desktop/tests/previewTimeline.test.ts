import test from "node:test";
import assert from "node:assert/strict";
import {
  activeOverlaysAtSourceMs,
  mergeOverlayEdits,
  sanitizeTimelineCutRanges,
  sourceMsToTimelineMs,
  timelineMsToSourceMs,
  type TimelineCutRange,
} from "../src/lib/previewTimeline.ts";
import type { OverlayItem } from "../src/lib/overlayItems.ts";

/**
 * フェーズU1-5(プレビュー忠実化): タイムラインms(書き出し後)⇔元動画msの写像と、
 * プレビュー再生位置でのオーバーレイ表示判定・UI編集の重ね合わせのテスト。
 */

// カット2つ(元動画 1000-3000ms / 5000-6000ms がタイムライン 0-2000ms / 2000-3000ms へ詰められる)
const RANGES: TimelineCutRange[] = [
  { sourceStartMs: 1000, sourceEndMs: 3000, timelineStartMs: 0, timelineEndMs: 2000 },
  { sourceStartMs: 5000, sourceEndMs: 6000, timelineStartMs: 2000, timelineEndMs: 3000 },
];

test("sanitizeTimelineCutRanges: 非配列・不正項目は除外し、sourceStartMs昇順に整列する", () => {
  assert.deepEqual(sanitizeTimelineCutRanges(undefined), []);
  assert.deepEqual(sanitizeTimelineCutRanges(null), []);
  assert.deepEqual(sanitizeTimelineCutRanges("x"), []);
  const ranges = sanitizeTimelineCutRanges([
    // 順序が逆でも昇順に直る
    { sourceStartMs: 5000, sourceEndMs: 6000, timelineStartMs: 2000, timelineEndMs: 3000 },
    { sourceStartMs: 1000, sourceEndMs: 3000, timelineStartMs: 0, timelineEndMs: 2000 },
    // 区間ゼロ・数値でない・欠落は除外
    { sourceStartMs: 7000, sourceEndMs: 7000, timelineStartMs: 3000, timelineEndMs: 3500 },
    { sourceStartMs: "a", sourceEndMs: 8000, timelineStartMs: 3000, timelineEndMs: 3500 },
    null,
    {},
  ]);
  assert.deepEqual(ranges, RANGES);
});

test("sanitizeTimelineCutRanges: cut単位telop_y(W24 Phase A-2)は0〜1の有効値のみ通す", () => {
  const ranges = sanitizeTimelineCutRanges([
    { sourceStartMs: 0, sourceEndMs: 1000, timelineStartMs: 0, timelineEndMs: 1000, telopY: 0.64 },
    { sourceStartMs: 1000, sourceEndMs: 2000, timelineStartMs: 1000, timelineEndMs: 2000 },
    { sourceStartMs: 2000, sourceEndMs: 3000, timelineStartMs: 2000, timelineEndMs: 3000, telopY: 1.5 },
    { sourceStartMs: 3000, sourceEndMs: 4000, timelineStartMs: 3000, timelineEndMs: 4000, telopY: "x" },
  ]);
  assert.equal(ranges[0].telopY, 0.64);
  // 無し・不正値はキー自体を持たない(グローバルtelop_yへのフォールバック扱い)
  assert.ok(!("telopY" in ranges[1]));
  assert.ok(!("telopY" in ranges[2]));
  assert.ok(!("telopY" in ranges[3]));
});

test("sourceMsToTimelineMs: カット内はオフセット写像、カット外(除去区間)はnull", () => {
  assert.equal(sourceMsToTimelineMs(RANGES, 1000), 0);
  assert.equal(sourceMsToTimelineMs(RANGES, 2500), 1500);
  assert.equal(sourceMsToTimelineMs(RANGES, 5500), 2500);
  // 半開区間: カット末尾ちょうどは次カット扱い(=カット外)
  assert.equal(sourceMsToTimelineMs(RANGES, 3000), null);
  assert.equal(sourceMsToTimelineMs(RANGES, 500), null); // 先頭カットより前
  assert.equal(sourceMsToTimelineMs(RANGES, 4000), null); // カット間の除去区間
});

test("timelineMsToSourceMs: 逆写像は往復で一致する", () => {
  assert.equal(timelineMsToSourceMs(RANGES, 0), 1000);
  assert.equal(timelineMsToSourceMs(RANGES, 1500), 2500);
  assert.equal(timelineMsToSourceMs(RANGES, 2500), 5500);
  assert.equal(timelineMsToSourceMs(RANGES, 3000), null); // タイムライン末尾以降
  for (const ms of [1000, 1999, 2001, 5000, 5999]) {
    const timelineMs = sourceMsToTimelineMs(RANGES, ms);
    assert.notEqual(timelineMs, null);
    assert.equal(timelineMsToSourceMs(RANGES, timelineMs!), ms);
  }
});

const OVERLAYS: OverlayItem[] = [
  {
    id: "chapter_01",
    type: "chapter_title",
    start_ms: 0,
    end_ms: 2000,
    text: "第1章",
    position: "top_left",
  },
  {
    id: "ov_cta",
    type: "cta_banner",
    start_ms: 1500,
    end_ms: 3000,
    text: "チャンネル登録",
    lines: ["チャンネル登録", "お願いします"],
    position: "bottom",
  },
];

test("activeOverlaysAtSourceMs: タイムライン写像後の表示区間判定(区間はタイムラインms基準)", () => {
  // 元動画1000ms = タイムライン0ms → chapter_01のみ
  assert.deepEqual(
    activeOverlaysAtSourceMs(OVERLAYS, RANGES, 1000).map((item) => item.id),
    ["chapter_01"],
  );
  // 元動画2800ms = タイムライン1800ms → 両方表示中(重なり区間)
  assert.deepEqual(
    activeOverlaysAtSourceMs(OVERLAYS, RANGES, 2800).map((item) => item.id),
    ["chapter_01", "ov_cta"],
  );
  // 元動画5500ms = タイムライン2500ms → chapter_01は終了済み
  assert.deepEqual(
    activeOverlaysAtSourceMs(OVERLAYS, RANGES, 5500).map((item) => item.id),
    ["ov_cta"],
  );
  // カット外(除去区間)は写像不能 → 非表示
  assert.deepEqual(activeOverlaysAtSourceMs(OVERLAYS, RANGES, 4000), []);
});

test("mergeOverlayEdits: text編集はlinesも改行splitで更新し、未編集項目はそのまま返す", () => {
  const merged = mergeOverlayEdits(OVERLAYS, {
    ov_cta: { text: "今すぐ登録\n通知もON" },
  });
  assert.equal(merged[0], OVERLAYS[0]); // 未編集は同一参照
  assert.equal(merged[1].text, "今すぐ登録\n通知もON");
  assert.deepEqual(merged[1].lines, ["今すぐ登録", "通知もON"]);
});

test("mergeOverlayEdits: subtitle編集(profile_card)と存在しないidの編集は安全", () => {
  const profile: OverlayItem = {
    id: "ov_profile",
    type: "profile_card",
    start_ms: 0,
    end_ms: 5000,
    text: "笠井俊哉",
    subtitle: "山口県立大学",
    position: "bottom_left",
  };
  const merged = mergeOverlayEdits([profile], {
    ov_profile: { subtitle: "山口県立大学\n社会福祉学部" },
    unknown_id: { text: "無視される" },
  });
  assert.equal(merged[0].text, "笠井俊哉");
  assert.equal(merged[0].subtitle, "山口県立大学\n社会福祉学部");
});
