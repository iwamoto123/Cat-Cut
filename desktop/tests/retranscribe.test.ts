// W19-B1: 弱い区間の再文字起こし(retranscribe.ts)のテスト。
// retranscribe.json items の正規化と、word_ids→シーン解決による要確認パネル項目変換を担保する。
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRetranscribeSuspicions,
  normalizeRetranscribeItems,
  retranscribeItemId,
  type RetranscribeItem,
} from "../src/lib/retranscribe.ts";
import { initializeScenes, resetSceneIdCounterForTests, setChipsDeleted, type SourceWord } from "../src/lib/scenes.ts";
import { buildReviewHotspots } from "../src/lib/reviewHotspots.ts";
import type { SuspicionItem } from "../src/lib/suspicionQueue.ts";

function sourceWords(...specs: Array<[string, string, number, number]>): SourceWord[] {
  return specs.map(([id, text, startMs, endMs]) => ({ id, text, startMs, endMs }));
}

test.beforeEach(() => {
  resetSceneIdCounterForTests();
});

/** 2シーン(「小学館です」「明日は晴れです」)を作る。 */
function buildTwoScenes() {
  const scenes = initializeScenes({
    words: sourceWords(
      ["w1", "小学館", 0, 300],
      ["w2", "です", 300, 600],
      ["w3", "明日は", 1000, 1300],
      ["w4", "晴れです", 1300, 1600],
    ),
    keepSegments: [{ startMs: 0, endMs: 1600 }],
    telopPageBoundaries: [
      { startMs: 0, endMs: 600 },
      { startMs: 1000, endMs: 1600 },
    ],
  });
  assert.equal(scenes.length, 2);
  return scenes;
}

function makeItem(overrides: Partial<RetranscribeItem> = {}): RetranscribeItem {
  return {
    startMs: 0,
    endMs: 600,
    wordIds: ["w1", "w2"],
    oldText: "小学館です",
    newText: "松山までです",
    suggestion: "松山までです",
    reason: "再STTが文脈と一致",
    ...overrides,
  };
}

test("normalizeRetranscribeItems: snake_caseのitemsを正規化し、不正エントリは捨てる", () => {
  const items = normalizeRetranscribeItems([
    {
      start_ms: 100,
      end_ms: 900,
      word_ids: ["w1", "w2"],
      old_text: "小学館です",
      new_text: "松山までです",
      suggestion: "松山までです",
      reason: "再STTが正しい",
    },
    // word_ids無し・old_text無し・suggestion無しは捨てる
    { start_ms: 0, end_ms: 1, word_ids: [], old_text: "a", suggestion: "b" },
    { start_ms: 0, end_ms: 1, word_ids: ["w1"], old_text: "", suggestion: "b" },
    { start_ms: 0, end_ms: 1, word_ids: ["w1"], old_text: "a", suggestion: "" },
    "broken",
  ]);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    startMs: 100,
    endMs: 900,
    wordIds: ["w1", "w2"],
    oldText: "小学館です",
    newText: "松山までです",
    suggestion: "松山までです",
    reason: "再STTが正しい",
  });
});

test("normalizeRetranscribeItems: 配列以外は空を返す(旧run互換)", () => {
  assert.deepEqual(normalizeRetranscribeItems(undefined), []);
  assert.deepEqual(normalizeRetranscribeItems(null), []);
  assert.deepEqual(normalizeRetranscribeItems("broken"), []);
});

test("buildRetranscribeSuspicions: word_idsからシーンを解決してSuspicionItemにする", () => {
  const scenes = buildTwoScenes();
  const map = buildRetranscribeSuspicions([makeItem()], scenes, new Set());
  assert.equal(map.size, 1);
  const items = map.get(scenes[0].id);
  assert.ok(items);
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "retranscribe");
  assert.equal(items[0].label, "再文字起こしで差分");
  assert.equal(items[0].text, "小学館です");
  assert.equal(items[0].suggestion, "松山までです");
  assert.deepEqual(items[0].wordIds, ["w1", "w2"]);
});

test("buildRetranscribeSuspicions: 複数シーンにまたがる場合は最多一致のシーンへ解決する", () => {
  const scenes = buildTwoScenes();
  // パディングで隣シーンのw3も含んだ区間(w1,w2がシーン1・w3がシーン2)
  const item = makeItem({ wordIds: ["w1", "w2", "w3"] });
  const map = buildRetranscribeSuspicions([item], scenes, new Set());
  assert.equal(map.size, 1);
  assert.ok(map.get(scenes[0].id));
});

test("buildRetranscribeSuspicions: どのシーンにも解決できない項目は破棄する", () => {
  const scenes = buildTwoScenes();
  const item = makeItem({ wordIds: ["w-unknown-1", "w-unknown-2"] });
  const map = buildRetranscribeSuspicions([item], scenes, new Set());
  assert.equal(map.size, 0);
});

test("buildRetranscribeSuspicions: 丸ごと削除済みシーンの項目は出さない", () => {
  const scenes = buildTwoScenes();
  const deleted = setChipsDeleted(scenes, scenes[0].id, scenes[0].words.map((word) => word.id), true);
  const map = buildRetranscribeSuspicions([makeItem()], deleted, new Set());
  assert.equal(map.size, 0);
});

test("buildRetranscribeSuspicions: 「無視」済みの項目は出さない", () => {
  const scenes = buildTwoScenes();
  const item = makeItem();
  const ignored = new Set([retranscribeItemId(item)]);
  const map = buildRetranscribeSuspicions([item], scenes, ignored);
  assert.equal(map.size, 0);
});

test("retranscribeItemId: word_ids由来の安定ID(runロード間で不変)", () => {
  assert.equal(retranscribeItemId(makeItem()), "retranscribe:w1_w2");
});

test("buildReviewHotspots: retranscribeの項目がパネルに載る", () => {
  const scenes = buildTwoScenes();
  const retranscribeItemsBySceneId = buildRetranscribeSuspicions([makeItem()], scenes, new Set());
  const hotspots = buildReviewHotspots(scenes, new Map<string, SuspicionItem[]>(), {
    retranscribeItemsBySceneId,
  });
  assert.equal(hotspots.length, 1);
  assert.equal(hotspots[0].scene.id, scenes[0].id);
  assert.equal(hotspots[0].items[0].type, "retranscribe");
});

test("buildReviewHotspots: 編集済みシーンのretranscribe項目は出さない(元STTテキスト基準のため)", () => {
  const scenes = buildTwoScenes();
  const retranscribeItemsBySceneId = buildRetranscribeSuspicions([makeItem()], scenes, new Set());
  const hotspots = buildReviewHotspots(scenes, new Map<string, SuspicionItem[]>(), {
    editedSceneIds: new Set([scenes[0].id]),
    retranscribeItemsBySceneId,
  });
  assert.equal(hotspots.length, 0);
});
