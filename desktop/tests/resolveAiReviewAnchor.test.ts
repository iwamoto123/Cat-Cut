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
    reason: "「監視カメラ」に関する発話が不自然に繰り返されており意味が取りづらい",
    suggestion: "文脈確認のうえ再検討",
  };
  const anchor = resolveAiReviewAnchor(entry, dougaWords, dougaKeepSegments);
  assert.equal(anchor.wordIds[0], "w-kanshi");
  assert.equal(anchor.segmentIndex, 2);
  assert.ok(anchor.timestampMs >= 1294000 && anchor.timestampMs < 1296000);
});

/** IMG_5250 run 実データから抜粋 (改善17-C cut_040_p03 行ズレ修正)。 */
const img5250KeepSegments: KeepSegment[] = [
  { startMs: 281080, endMs: 285670 },
  { startMs: 285670, endMs: 293580 },
  { startMs: 293860, endMs: 298470 },
  { startMs: 298470, endMs: 314100 },
  { startMs: 382000, endMs: 390000 },
];

const img5250Words: TranscriptWord[] = [
  { id: "w-1970", text: "機", startMs: 292500, endMs: 292580 },
  { id: "w-1971", text: "会", startMs: 292580, endMs: 292640 },
  { id: "w-1972", text: "を", startMs: 292640, endMs: 292660 },
  { id: "w-1973", text: "取", startMs: 292660, endMs: 292820 },
  { id: "w-1974", text: "ろ", startMs: 292820, endMs: 293020 },
  { id: "w-1975", text: "う", startMs: 293020, endMs: 293080 },
  { id: "w-1976", text: "と", startMs: 293080, endMs: 293140 },
  { id: "w-1977", text: "思", startMs: 293140, endMs: 293200 },
  { id: "w-1978", text: "っ", startMs: 293200, endMs: 293280 },
  { id: "w-1979", text: "て", startMs: 293280, endMs: 293460 },
  { id: "w-1980", text: "い", startMs: 293460, endMs: 293580 },
  { id: "w-1981", text: "ま", startMs: 293560, endMs: 293750 },
  { id: "w-1982", text: "す", startMs: 294060, endMs: 294070 },
  { id: "w-wrong", text: "思", startMs: 385000, endMs: 385100 },
  { id: "w-wrong2", text: "っ", startMs: 385100, endMs: 385200 },
  { id: "w-wrong3", text: "て", startMs: 385200, endMs: 385300 },
];

test("resolveAiReviewAnchor: IMG_5250 cut_040_p03 は reason 引用「思っていま」で 04:53 付近へ解決", () => {
  const entry: AiReviewTelopNeedsReview = {
    page_id: "cut_040_p03",
    reason: "前のカットと語が分断されています。シーンの結合を検討してください（「思っていま」/次カット「す」）",
  };
  const anchor = resolveAiReviewAnchor(entry, img5250Words, img5250KeepSegments);
  assert.equal(anchor.wordIds[0], "w-1977");
  assert.equal(anchor.segmentIndex, 1);
  assert.ok(anchor.timestampMs >= 285000 && anchor.timestampMs <= 295000);
});

/** IMG_5902 run 実データ (改善19-A: フィラーのみ×6・page_id別々)。 */
function buildImg5902KeepSegments(): KeepSegment[] {
  // cut_001=index0 … の順序と startMs 昇順が一致する配列 (本番 cut_proposal と同型)
  return Array.from({ length: 133 }, (_, index) => ({
    startMs: (index + 1) * 100000,
    endMs: (index + 1) * 100000 + 5000,
  }));
}

const img5902Words: TranscriptWord[] = [
  { id: "w-cut067", text: "こ", startMs: 6700000, endMs: 6700100 },
  { id: "w-cut069", text: "こ", startMs: 6900000, endMs: 6900100 },
  { id: "w-cut090", text: "な", startMs: 9000000, endMs: 9000100 },
  { id: "w-cut113", text: "で", startMs: 11300000, endMs: 11300100 },
  { id: "w-cut132", text: "じ", startMs: 13200000, endMs: 13200100 },
  { id: "w-cut133", text: "気", startMs: 13300000, endMs: 13300100 },
  { id: "w-wrong", text: "点", startMs: 500000, endMs: 500100 },
  { id: "w-wrong2", text: "き", startMs: 500100, endMs: 500200 },
  { id: "w-wrong3", text: "ま", startMs: 500200, endMs: 500300 },
  { id: "w-wrong4", text: "せ", startMs: 500300, endMs: 500400 },
  { id: "w-wrong5", text: "ん", startMs: 500400, endMs: 500500 },
];

const img5902FillerEntries: AiReviewTelopNeedsReview[] = [
  {
    page_id: "cut_067_p02",
    reason: "フィラーのみのテロップです。文脈が提供範囲外のため削除の妥当性を確認できません",
    suggestion: "削除候補",
  },
  {
    page_id: "cut_069_p03",
    reason: "フィラーのみのテロップです。文脈が提供範囲外のため削除の妥当性を確認できません",
    suggestion: "削除候補",
  },
  {
    page_id: "cut_090_p01",
    reason: "フィラーのみのテロップです。文脈が提供範囲外のため削除の妥当性を確認できません",
    suggestion: "削除候補",
  },
  {
    page_id: "cut_113_p02",
    reason: "フィラーのみのテロップです。文脈が提供範囲外のため削除の妥当性を確認できません",
    suggestion: "削除候補",
  },
  {
    page_id: "cut_132_p04",
    reason: "フィラーのみのテロップです。文脈が提供範囲外のため削除の妥当性を確認できません",
    suggestion: "削除候補",
  },
  {
    page_id: "cut_133_p01",
    reason: "フィラーのみのテロップです。文脈が提供範囲外のため削除の妥当性を確認できません",
    suggestion: "削除候補",
  },
];

test("resolveAiReviewAnchor: IMG_5902 フィラーのみ6件は page_id で別々の時間帯へ解決", () => {
  const img5902KeepSegments = buildImg5902KeepSegments();
  const expectedWordIds = ["w-cut067", "w-cut069", "w-cut090", "w-cut113", "w-cut132", "w-cut133"];
  const expectedMinMs = [6700000, 6900000, 9000000, 11300000, 13200000, 13300000];

  for (const [index, entry] of img5902FillerEntries.entries()) {
    const anchor = resolveAiReviewAnchor(entry, img5902Words, img5902KeepSegments);
    assert.equal(anchor.wordIds[0], expectedWordIds[index], `entry ${index} page_id=${entry.page_id}`);
    assert.ok(anchor.timestampMs >= expectedMinMs[index], `entry ${index} timestamp too early`);
    assert.notEqual(anchor.wordIds[0], "w-wrong", "地の文誤マッチ「きません」に解決してはいけない");
  }

  const timestamps = img5902FillerEntries.map((entry) =>
    resolveAiReviewAnchor(entry, img5902Words, buildImg5902KeepSegments()).timestampMs,
  );
  assert.equal(new Set(timestamps).size, 6, "6件はすべて異なる timestampMs に解決される");
});
