/**
 * 改善21: runs/20260704_200955_videoplayback_6 (AI校正全チャンク失敗の実データ) を使った
 * UI側キュー生成ロジックの統合確認。実APIは呼ばない。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildProperNounSuspicions,
  buildSuspicionQueue,
  type AiReviewInput,
} from "../src/lib/suspicionQueue.ts";
import type { KeepSegment, TranscriptWord } from "../src/lib/keepSegments.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runDir = path.resolve(__dirname, "../../runs/20260704_200955_videoplayback_6");

function readJson(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function loadRunData(): { words: TranscriptWord[]; keepSegments: KeepSegment[] } {
  const stt = readJson(path.join(runDir, "step02b_transcript_correct", "stt_corrected.json"));
  const proposal = readJson(path.join(runDir, "step07_cut_proposal", "cut_proposal.json"));
  const words: TranscriptWord[] = stt.words.map((word: any) => ({
    id: String(word.id),
    text: String(word.text || ""),
    startMs: Number(word.start_ms || 0),
    endMs: Number(word.end_ms || 0),
    confidence: word.confidence == null ? null : Number(word.confidence),
  }));
  const keepSegments: KeepSegment[] = proposal.keep_segments.map((segment: any) => ({
    startMs: Number(segment.start_ms || 0),
    endMs: Number(segment.end_ms || 0),
  }));
  return { words, keepSegments };
}

/** main/index.cjs の loadTranscriptEditorState と同じ変換で aiReview 入力を作る。 */
function buildAiReviewInput(aiReviewRaw: any, refineRaw: any): AiReviewInput {
  const transcriptRefineFailed =
    aiReviewRaw && aiReviewRaw.enabled === false && String(aiReviewRaw.reason || "") !== "no AI provider key set";
  const telopRefineFailed =
    refineRaw && refineRaw.enabled === false && String(refineRaw.reason || "") !== "no AI provider key set";
  return {
    enabled: Boolean(aiReviewRaw?.enabled || refineRaw?.enabled),
    transcriptNeedsReview: Array.isArray(aiReviewRaw?.needs_review) ? aiReviewRaw.needs_review : [],
    telopNeedsReview: Array.isArray(refineRaw?.needs_review) ? refineRaw.needs_review : [],
    dismissedFindingIds: [],
    transcriptRefineFailed,
    telopRefineFailed,
    transcriptErrorKind: transcriptRefineFailed ? String(aiReviewRaw?.error_kind || "") : "",
    telopErrorKind: telopRefineFailed ? String(refineRaw?.error_kind || "") : "",
    transcriptErrorDetail: transcriptRefineFailed
      ? String(aiReviewRaw?.error_detail || aiReviewRaw?.reason || "")
      : "",
    telopErrorDetail: telopRefineFailed ? String(refineRaw?.error_detail || refineRaw?.reason || "") : "",
    transcriptProvider: String(aiReviewRaw?.provider || ""),
    telopProvider: String(refineRaw?.provider || ""),
  };
}

test("実データ(videoplayback_6): 失敗状態のai_review.json/refine.jsonからai_failure項目が先頭に出る", () => {
  const { words, keepSegments } = loadRunData();
  const aiReviewRaw = readJson(path.join(runDir, "step05_ai_retake", "ai_review.json"));
  const refineRaw = readJson(path.join(runDir, "step06b_ai_refine", "refine.json"));

  const items = buildSuspicionQueue({
    words,
    keepSegments,
    aiReview: buildAiReviewInput(aiReviewRaw, refineRaw),
  });

  assert.ok(items.length > 0);
  assert.equal(items[0].type, "ai_failure");
  assert.equal(items[0].label, "AI校正が実行されていません");
  assert.deepEqual(items[0].wordIds, []);
});

test("実データ(videoplayback_6): 既存JSONにerror_kindが無い場合はother扱いにフォールバックする", () => {
  const aiReviewRaw = readJson(path.join(runDir, "step05_ai_retake", "ai_review.json"));
  const refineRaw = readJson(path.join(runDir, "step06b_ai_refine", "refine.json"));
  assert.equal(aiReviewRaw.error_kind, undefined, "既存runのJSONにはerror_kindが無い前提");

  const { words, keepSegments } = loadRunData();
  const items = buildSuspicionQueue({
    words,
    keepSegments,
    aiReview: buildAiReviewInput(aiReviewRaw, refineRaw),
  });
  // error_kind不明 → other のメッセージ(再解析で再試行)になる。
  assert.match(items[0].detail, /AI校正が失敗しました。再解析で再試行できます/);
});

test("実データ(videoplayback_6): 新パイプライン形式(error_kind=billing)ならbilling項目が先頭に出る", () => {
  const aiReviewRaw = readJson(path.join(runDir, "step05_ai_retake", "ai_review.json"));
  const refineRaw = readJson(path.join(runDir, "step06b_ai_refine", "refine.json"));
  // 改善21-A後のstep05/step06bが書き出す形式(実際のAnthropic 400本文)をシミュレートする。
  const billingDetail =
    'HTTPStatusError: Client error \'400 Bad Request\' | response body: {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';
  const aiReviewNew = { ...aiReviewRaw, error_kind: "billing", error_detail: billingDetail };
  const refineNew = { ...refineRaw, error_kind: "billing", error_detail: billingDetail };

  const { words, keepSegments } = loadRunData();
  const items = buildSuspicionQueue({
    words,
    keepSegments,
    aiReview: buildAiReviewInput(aiReviewNew, refineNew),
  });
  assert.equal(items[0].type, "ai_failure");
  assert.match(items[0].text, /クレジット残高不足（Anthropic）/);
  assert.match(items[0].detail, /チャージするか、⚙API設定で別のプロバイダ（Geminiは無料枠あり）/);
});

test("実データ(videoplayback_6) 21-C: カタカナ辞書未登録フラグが大幅に減る", () => {
  const { words, keepSegments } = loadRunData();

  const countKatakanaFlags = (items: ReturnType<typeof buildProperNounSuspicions>) =>
    items.filter((item) => item.detail === "カタカナ語で辞書未登録です").length;

  // before: 改善21-C前の挙動(頻度抑制なし・一般語除外なし)を再現。
  const before = countKatakanaFlags(
    buildProperNounSuspicions(words, [], keepSegments, {
      katakanaFrequencySuppressMin: Number.POSITIVE_INFINITY,
      commonKatakanaWords: new Set(),
    }),
  );
  // after: 既定(頻度抑制3回・一般語除外リスト)。
  const after = countKatakanaFlags(buildProperNounSuspicions(words, [], keepSegments));

  console.log(`[21-C] カタカナ辞書未登録フラグ: before=${before} after=${after}`);
  assert.ok(before >= 100, `beforeは洪水状態(実測${before}件)`);
  assert.ok(after <= 40, `afterは固有名詞らしきもののみの検品可能な件数(実測${after}件)`);
});
