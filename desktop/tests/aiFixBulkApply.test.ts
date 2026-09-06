// W19-B3: 「AI修正を一括適用」(aiFixBulkApply.ts)のテスト。
// suggestion付き項目の対象抽出と、シーンごとの逐次適用計画(残件・重複surface)を担保する。
import test from "node:test";
import assert from "node:assert/strict";
import { planBulkApplyAiFixes } from "../src/lib/aiFixBulkApply.ts";
import type { ReviewHotspot } from "../src/lib/reviewHotspots.ts";
import type { Scene } from "../src/lib/scenes.ts";
import type { SuspicionItem, SuspicionType } from "../src/lib/suspicionQueue.ts";

function makeScene(id: string, telopText: string): Scene {
  return {
    id,
    sourceStartMs: 0,
    sourceEndMs: 1000,
    words: [],
    telopText,
    telopEdited: false,
    cutMarks: [],
  };
}

let itemSeq = 0;
function makeItem(type: SuspicionType, text: string, suggestion?: string): SuspicionItem {
  itemSeq += 1;
  return {
    id: `${type}:${itemSeq}`,
    type,
    severity: "medium",
    label: type,
    text,
    timestampMs: 0,
    wordIds: [],
    detail: "テスト",
    ...(suggestion !== undefined ? { suggestion } : {}),
  };
}

function makeHotspot(scene: Scene, items: SuspicionItem[]): ReviewHotspot {
  return { scene, sceneOrdinal: 1, items, flaggedWordIds: new Set() };
}

test("planBulkApplyAiFixes: suggestion付き対象種別だけを適用計画に入れる", () => {
  const scene = makeScene("s1", "小学館です。新学校に行きます");
  const plan = planBulkApplyAiFixes([
    makeHotspot(scene, [
      makeItem("suspect_word", "小学館", "松山まで"),
      makeItem("final_check", "新学校", "進学校"),
      // suggestion無し・対象外種別は適用しない
      makeItem("suspect_word", "行きます"),
      makeItem("telop_review", "です", "だ"),
    ]),
  ]);
  assert.equal(plan.appliedCount, 2);
  assert.equal(plan.sceneEdits.length, 1);
  assert.equal(plan.sceneEdits[0].afterText, "松山までです。進学校に行きます");
  assert.equal(plan.sceneEdits[0].beforeText, "小学館です。新学校に行きます");
  assert.equal(plan.sceneEdits[0].appliedItems.length, 2);
});

test("planBulkApplyAiFixes: retranscribe・correction_historyも対象になる", () => {
  const scene = makeScene("s1", "医師薬科専門の話。むずいの談員");
  const plan = planBulkApplyAiFixes([
    makeHotspot(scene, [
      makeItem("retranscribe", "医師薬科専門", "医歯薬科専門"),
      makeItem("correction_history", "談員", "断然"),
    ]),
  ]);
  assert.equal(plan.appliedCount, 2);
  assert.equal(plan.sceneEdits[0].afterText, "医歯薬科専門の話。むずいの断然");
});

test("planBulkApplyAiFixes: surfaceが本文に無い項目はスキップして残件になる", () => {
  const scene = makeScene("s1", "もう直した後の本文");
  const plan = planBulkApplyAiFixes([
    makeHotspot(scene, [makeItem("final_check", "存在しない表記", "候補")]),
  ]);
  assert.equal(plan.appliedCount, 0);
  assert.equal(plan.sceneEdits.length, 0);
});

test("planBulkApplyAiFixes: 同一surfaceの重複項目は1回だけ適用される(先行置換で消えるため)", () => {
  const scene = makeScene("s1", "小学館です");
  const plan = planBulkApplyAiFixes([
    makeHotspot(scene, [
      makeItem("suspect_word", "小学館", "松山まで"),
      makeItem("retranscribe", "小学館", "小学館前"),
    ]),
  ]);
  assert.equal(plan.appliedCount, 1);
  assert.equal(plan.sceneEdits[0].afterText, "松山までです");
});

test("planBulkApplyAiFixes: 同一シーン内の逐次適用(前の置換結果に次の置換がかかる)", () => {
  const scene = makeScene("s1", "AAとBBの話");
  const plan = planBulkApplyAiFixes([
    makeHotspot(scene, [
      makeItem("suspect_word", "AA", "CC"),
      makeItem("final_check", "CCとBB", "CCとDD"),
    ]),
  ]);
  assert.equal(plan.appliedCount, 2);
  assert.equal(plan.sceneEdits[0].afterText, "CCとDDの話");
});

test("planBulkApplyAiFixes: 複数シーンの計画をまとめて返す", () => {
  const plan = planBulkApplyAiFixes([
    makeHotspot(makeScene("s1", "小学館です"), [makeItem("suspect_word", "小学館", "松山まで")]),
    makeHotspot(makeScene("s2", "適用対象なし"), [makeItem("suspect_word", "無い表記", "候補")]),
    makeHotspot(makeScene("s3", "新学校です"), [makeItem("final_check", "新学校", "進学校")]),
  ]);
  assert.equal(plan.appliedCount, 2);
  assert.deepEqual(
    plan.sceneEdits.map((edit) => edit.sceneId),
    ["s1", "s3"],
  );
});

test("planBulkApplyAiFixes: surfaceと候補が同一の項目は適用しない(無限の空振り防止)", () => {
  const scene = makeScene("s1", "同じ表記です");
  const plan = planBulkApplyAiFixes([
    makeHotspot(scene, [makeItem("final_check", "同じ表記", "同じ表記")]),
  ]);
  assert.equal(plan.appliedCount, 0);
});

test("planBulkApplyAiFixes: 空のhotspotsは空計画", () => {
  const plan = planBulkApplyAiFixes([]);
  assert.equal(plan.appliedCount, 0);
  assert.deepEqual(plan.sceneEdits, []);
});
