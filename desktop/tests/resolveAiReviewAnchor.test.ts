import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveAiReviewAnchor,
  type AiReviewTelopNeedsReview,
} from "../src/lib/suspicionQueue.ts";
import type { KeepSegment, TranscriptWord } from "../src/lib/keepSegments.ts";

/** douga run 実データから抜粋 (改善16-B 行ズレ修正の検証用)。 */
const dougaKeepSegments: KeepSegment[] = [
  { startMs: 677795, endMs: 682776 },
  { startMs: 958596, endMs: 963926 },
  { startMs: 1287368, endMs: 1302307 },
];

const dougaWords: TranscriptWord[] = [
  { id: "w-miyazaki", text: "宮", startMs: 678176, endMs: 678415 },
  { id: "w-miyazaki2", text: "崎", startMs: 678415, endMs: 678655 },
  { id: "w-miyazaki3", text: "の", startMs: 678655, endMs: 678775 },
  { id: "w-miyazaki4", text: "サ", startMs: 678775, endMs: 678895 },
  { id: "w-miyazaki5", text: "ウ", startMs: 678895, endMs: 679015 },
  { id: "w-miyazaki6", text: "ナ", startMs: 679015, endMs: 679135 },
  { id: "w-wrong1", text: "孔", startMs: 959000, endMs: 959120 },
  { id: "w-wrong2", text: "明", startMs: 959120, endMs: 959240 },
  { id: "w-kanshi", text: "監", startMs: 1294847, endMs: 1294967 },
  { id: "w-kanshi2", text: "視", startMs: 1294967, endMs: 1295087 },
  { id: "w-kanshi3", text: "カ", startMs: 1295087, endMs: 1295207 },
  { id: "w-kanshi4", text: "メ", startMs: 1295207, endMs: 1295327 },
  { id: "w-kanshi5", text: "ラ", startMs: 1295327, endMs: 1295447 },
];

test("resolveAiReviewAnchor: page_id が誤っていても引用「宮崎のサウナ」で正しい行へ解決", () => {
  const entry: AiReviewTelopNeedsReview = {
    page_id: "cut_197",
    reason: "「宮崎のサウナ」という固有名詞について、文脈上正しい表記か確認できず",
    suggestion: "文脈からは判断できないためそのまま保持",
  };
  const anchor = resolveAiReviewAnchor(entry, dougaWords, dougaKeepSegments);
  assert.equal(anchor.wordIds[0], "w-miyazaki");
  assert.equal(anchor.segmentIndex, 0);
  assert.ok(anchor.timestampMs >= 678000 && anchor.timestampMs < 680000);
});

test("resolveAiReviewAnchor: 監視カメラ指摘は該当発話の時間帯へ解決", () => {
  const entry: AiReviewTelopNeedsReview = {
    page_id: "cut_271_p00",
    reason: "監視カメラに関する発話が不自然に繰り返されており意味が取りづらい",
    suggestion: "文脈確認のうえ再検討",
  };
  const anchor = resolveAiReviewAnchor(entry, dougaWords, dougaKeepSegments);
  assert.equal(anchor.wordIds[0], "w-kanshi");
  assert.equal(anchor.segmentIndex, 2);
  assert.ok(anchor.timestampMs >= 1294000 && anchor.timestampMs < 1296000);
});
