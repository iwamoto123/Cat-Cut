import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAiReviewSuspicions,
  buildBoundaryOverrunSuspicions,
  buildFillerSuspicions,
  buildLowConfidenceSuspicions,
  buildProperNounSuspicions,
  buildShortCutSuspicions,
  buildSuspicionQueue,
  buildTelopReviewSuspicions,
  hasMeaningfulConfidenceVariance,
  type AiReviewInput,
  type SuspicionTelopFinding,
} from "../src/lib/suspicionQueue.ts";
import type { KeepSegment, TranscriptWord } from "../src/lib/keepSegments.ts";

const words: TranscriptWord[] = [
  { id: "w1", text: "こ", startMs: 0, endMs: 120, confidence: 0.9 },
  { id: "w2", text: "ん", startMs: 130, endMs: 240, confidence: 0.3 },
  { id: "w3", text: "に", startMs: 250, endMs: 340, confidence: 0.5 },
  { id: "w4", text: "ち", startMs: 350, endMs: 460, confidence: 0.98 },
];

test("buildLowConfidenceSuspicions は閾値未満の単語のみ検出し重要度を分ける", () => {
  const items = buildLowConfidenceSuspicions(words);
  assert.equal(items.length, 2);
  assert.equal(items[0].wordIds[0], "w2");
  assert.equal(items[0].severity, "high");
  assert.equal(items[1].wordIds[0], "w3");
  assert.equal(items[1].severity, "medium");
});

test("buildLowConfidenceSuspicions は confidence が null/undefined の単語を無視する", () => {
  const items = buildLowConfidenceSuspicions([{ id: "w5", text: "あ", startMs: 0, endMs: 100, confidence: null }]);
  assert.equal(items.length, 0);
});

// --- 改善2: 低confidence検出の既定オフ化(実機STTでconfidence=0が全件になる問題への対応) ---

test("hasMeaningfulConfidenceVariance: 全単語confidence=0(実機ElevenLabs STT相当)ではfalseになる", () => {
  const allZero: TranscriptWord[] = [
    { id: "w1", text: "あ", startMs: 0, endMs: 100, confidence: 0 },
    { id: "w2", text: "い", startMs: 100, endMs: 200, confidence: 0 },
    { id: "w3", text: "う", startMs: 200, endMs: 300, confidence: 0 },
  ];
  assert.equal(hasMeaningfulConfidenceVariance(allZero), false);
});

test("hasMeaningfulConfidenceVariance: 非ゼロ値が30%以上あればtrueになる", () => {
  const mixed: TranscriptWord[] = [
    { id: "w1", text: "あ", startMs: 0, endMs: 100, confidence: 0 },
    { id: "w2", text: "い", startMs: 100, endMs: 200, confidence: 0 },
    { id: "w3", text: "う", startMs: 200, endMs: 300, confidence: 0.4 },
  ];
  assert.equal(hasMeaningfulConfidenceVariance(mixed), true);
});

test("buildLowConfidenceSuspicions: confidenceが全件0の場合は既定で無効化され0件になる", () => {
  const allZero: TranscriptWord[] = [
    { id: "w1", text: "あ", startMs: 0, endMs: 100, confidence: 0 },
    { id: "w2", text: "い", startMs: 100, endMs: 200, confidence: 0 },
  ];
  assert.equal(buildLowConfidenceSuspicions(allZero).length, 0);
});

test("buildLowConfidenceSuspicions: options.enabled=trueを明示すれば分散が無くても検出する", () => {
  const allZero: TranscriptWord[] = [
    { id: "w1", text: "あ", startMs: 0, endMs: 100, confidence: 0 },
    { id: "w2", text: "い", startMs: 100, endMs: 200, confidence: 0 },
  ];
  const items = buildLowConfidenceSuspicions(allZero, { enabled: true });
  assert.equal(items.length, 2);
});

// --- 改善2: フィラー検出 ---

test("buildFillerSuspicions: fillerWordIdsに該当しkeep_segmentに残っている単語をmediumでフラグする", () => {
  const testWords: TranscriptWord[] = [
    { id: "w1", text: "あ", startMs: 0, endMs: 100 },
    { id: "w2", text: "えっと", startMs: 100, endMs: 300 },
    { id: "w3", text: "う", startMs: 300, endMs: 400 },
  ];
  const items = buildFillerSuspicions(testWords, ["w2"], [{ startMs: 0, endMs: 400 }]);
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "filler");
  assert.equal(items[0].severity, "medium");
  assert.deepEqual(items[0].wordIds, ["w2"]);
});

test("buildFillerSuspicions: AIが既にカット済み(keep_segments外)のフィラーはフラグしない", () => {
  const testWords: TranscriptWord[] = [
    { id: "w1", text: "あ", startMs: 0, endMs: 100 },
    { id: "w2", text: "えっと", startMs: 100, endMs: 300 },
    { id: "w3", text: "う", startMs: 400, endMs: 500 },
  ];
  // w2(フィラー)はkeep_segmentsのどこにも含まれない=AIが既にカット提案済み。
  const items = buildFillerSuspicions(testWords, ["w2"], [
    { startMs: 0, endMs: 100 },
    { startMs: 400, endMs: 500 },
  ]);
  assert.equal(items.length, 0);
});

// --- 改善2: 不安な固有名詞・辞書指摘の検出 ---

test("buildProperNounSuspicions: telop_reviewのdictionary/proper_noun_check/number_check指摘はhighでフラグする", () => {
  const testWords: TranscriptWord[] = [
    { id: "w1", text: "田", startMs: 0, endMs: 100 },
    { id: "w2", text: "中", startMs: 100, endMs: 200 },
  ];
  const findings: SuspicionTelopFinding[] = [
    {
      id: "f1",
      type: "proper_noun_check",
      severity: "low",
      page_id: "cut_001_p00",
      message: "固有名詞の可能性があります",
      source: "田中",
    },
  ];
  const keepSegments = [{ startMs: 0, endMs: 200 }];
  const items = buildProperNounSuspicions(testWords, findings, keepSegments);
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "proper_noun");
  assert.equal(items[0].severity, "high", "findings由来は元のseverityに関わらずhighにする");
});

test("buildProperNounSuspicions: telop_reviewの対象外type(filler_only等)は無視する", () => {
  const testWords: TranscriptWord[] = [{ id: "w1", text: "あ", startMs: 0, endMs: 100 }];
  const findings: SuspicionTelopFinding[] = [
    { id: "f1", type: "filler_only", severity: "low", page_id: "cut_001_p00", message: "フィラーのみ" },
  ];
  const items = buildProperNounSuspicions(testWords, findings, [{ startMs: 0, endMs: 100 }]);
  assert.equal(items.length, 0);
});

test("buildProperNounSuspicions: カタカナ3文字以上の連続を辞書未登録ならmediumでフラグする", () => {
  const testWords: TranscriptWord[] = [
    { id: "w1", text: "コ", startMs: 0, endMs: 100 },
    { id: "w2", text: "ン", startMs: 100, endMs: 200 },
    { id: "w3", text: "サ", startMs: 200, endMs: 300 },
    { id: "w4", text: "ル", startMs: 300, endMs: 400 },
  ];
  const items = buildProperNounSuspicions(testWords, [], [{ startMs: 0, endMs: 400 }]);
  assert.equal(items.length, 1);
  assert.equal(items[0].severity, "medium");
  assert.equal(items[0].text, "コンサル");
});

test("buildProperNounSuspicions: ユーザー辞書に登録済みのカタカナ語はフラグしない", () => {
  const testWords: TranscriptWord[] = [
    { id: "w1", text: "コ", startMs: 0, endMs: 100 },
    { id: "w2", text: "ン", startMs: 100, endMs: 200 },
    { id: "w3", text: "サ", startMs: 200, endMs: 300 },
    { id: "w4", text: "ル", startMs: 300, endMs: 400 },
  ];
  const items = buildProperNounSuspicions(testWords, [], [{ startMs: 0, endMs: 400 }], {
    knownDictionary: [{ wrong: "コンサル", correct: "コンサル" }],
  });
  assert.equal(items.length, 0);
});

test("buildProperNounSuspicions: 数字を含む語は辞書未登録ならmediumでフラグする", () => {
  const testWords: TranscriptWord[] = [
    { id: "w1", text: "3", startMs: 0, endMs: 100 },
    { id: "w2", text: "回", startMs: 100, endMs: 200 },
  ];
  const items = buildProperNounSuspicions(testWords, [], [{ startMs: 0, endMs: 200 }]);
  assert.equal(items.length, 1);
  assert.equal(items[0].detail.includes("数字"), true);
});

test("buildProperNounSuspicions: カタカナでも数字でもない普通の語はフラグしない", () => {
  const testWords: TranscriptWord[] = [
    { id: "w1", text: "こ", startMs: 0, endMs: 100 },
    { id: "w2", text: "ん", startMs: 100, endMs: 200 },
    { id: "w3", text: "に", startMs: 200, endMs: 300 },
    { id: "w4", text: "ち", startMs: 300, endMs: 400 },
    { id: "w5", text: "は", startMs: 400, endMs: 500 },
  ];
  const items = buildProperNounSuspicions(testWords, [], [{ startMs: 0, endMs: 500 }]);
  assert.equal(items.length, 0);
});

test("buildBoundaryOverrunSuspicions は境界を80ms超えてまたぐ単語を検出する", () => {
  const straddlingWords: TranscriptWord[] = [
    { id: "w1", text: "の", startMs: 1719, endMs: 2819 },
    { id: "w2", text: "です", startMs: 5000, endMs: 5100 },
  ];
  const keepSegments: KeepSegment[] = [
    { startMs: 9, endMs: 2030 },
    { startMs: 2809, endMs: 5230 },
  ];
  const items = buildBoundaryOverrunSuspicions(straddlingWords, keepSegments);
  assert.equal(items.length, 2);
  assert.ok(items.every((item) => item.type === "boundary_overrun"));
  assert.ok(items.some((item) => item.detail.includes("789ms") || item.detail.includes("790ms")));
});

test("buildBoundaryOverrunSuspicions は閾値以下のはみ出しを無視する", () => {
  const items = buildBoundaryOverrunSuspicions(
    [{ id: "w1", text: "の", startMs: 990, endMs: 1050 }],
    [{ startMs: 0, endMs: 1000 }],
    { thresholdMs: 80 },
  );
  assert.equal(items.length, 0);
});

test("buildShortCutSuspicions は700ms未満のkeep_segmentを検出する", () => {
  const items = buildShortCutSuspicions(
    [
      { startMs: 0, endMs: 500 },
      { startMs: 1000, endMs: 3000 },
    ],
    words,
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "short_cut");
  assert.equal(items[0].severity, "medium");
});

test("buildTelopReviewSuspicions は page_id からcutを特定し単語へマッピングする", () => {
  const findings: SuspicionTelopFinding[] = [
    {
      id: "f1",
      type: "dictionary",
      severity: "medium",
      page_id: "cut_002_p00",
      message: "誤認識の可能性があります",
      source: "ん",
      suggestion: "ン",
    },
  ];
  const keepSegments: KeepSegment[] = [
    { startMs: 0, endMs: 100 },
    { startMs: 130, endMs: 240 },
  ];
  const items = buildTelopReviewSuspicions(findings, words, keepSegments);
  assert.equal(items.length, 1);
  assert.equal(items[0].wordIds[0], "w2");
  assert.equal(items[0].timestampMs, 130);
});

test("buildSuspicionQueue は重要度→時刻の順にソートして統合する", () => {
  const items = buildSuspicionQueue({
    words,
    keepSegments: [{ startMs: 0, endMs: 500 }],
  });
  assert.ok(items.length > 0);
  for (let i = 1; i < items.length; i += 1) {
    const severityRank = (severity: string) => (severity === "high" ? 0 : severity === "medium" ? 1 : 2);
    assert.ok(severityRank(items[i - 1].severity) <= severityRank(items[i].severity));
  }
});

// --- runs/20260428_test の実データを使った統合確認 ---
// (main プロセスの loadTranscriptEditorState と同じロジックでJSONを読み、疑義キューが生成されることを確認する)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runDir = path.resolve(__dirname, "../../runs/20260428_test");

function readJson(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

test("runs/20260428_test の実データから疑義キューが生成される(改善2: 実用的な件数になる)", () => {
  const sttPath = path.join(runDir, "step02_stt", "stt_result.json");
  const proposalPath = path.join(runDir, "step07_cut_proposal", "cut_proposal.json");
  const fillersPath = path.join(runDir, "step04_filler_detect", "fillers.json");
  assert.ok(fs.existsSync(sttPath), "stt_result.json が見つかりません");
  assert.ok(fs.existsSync(proposalPath), "cut_proposal.json が見つかりません");

  const stt = readJson(sttPath);
  const proposal = readJson(proposalPath);
  const fillers = fs.existsSync(fillersPath) ? readJson(fillersPath) : { fillers: [] };

  const testWords: TranscriptWord[] = stt.words.map((word: any) => ({
    id: String(word.id),
    text: String(word.text || ""),
    startMs: Number(word.start_ms || 0),
    endMs: Number(word.end_ms || 0),
    // runs/20260428_test は実機ElevenLabs STT相当で全単語confidence=0.0。
    confidence: word.confidence == null ? 1 : Number(word.confidence),
  }));
  const keepSegments: KeepSegment[] = proposal.keep_segments.map((segment: any) => ({
    startMs: Number(segment.start_ms || 0),
    endMs: Number(segment.end_ms || 0),
  }));
  const fillerWordIds: string[] = (fillers.fillers || []).map((filler: any) => String(filler.word_id || ""));

  const items = buildSuspicionQueue({ words: testWords, keepSegments, telopFindings: [], fillerWordIds });

  const boundaryOverrunItems = items.filter((item) => item.type === "boundary_overrun");
  const lowConfidenceItems = items.filter((item) => item.type === "low_confidence");
  const shortCutItems = items.filter((item) => item.type === "short_cut");
  const fillerItems = items.filter((item) => item.type === "filler");
  const properNounItems = items.filter((item) => item.type === "proper_noun");

  // confidence=0.0が全単語一律のため、改善2により低confidence検出は既定で無効化され0件になる
  // (旧: 全52単語がヒットしていた)。
  assert.equal(lowConfidenceItems.length, 0);
  // このrunのfillers.jsonは空(total_fillers:0)のため、フィラー検出も0件。
  assert.equal(fillerItems.length, 0);
  // このrunのテキストには「カット」(2箇所)「テスト」(1箇所)というカタカナ語(いずれも3文字)が
  // 含まれ、ユーザー辞書に未登録のため固有名詞ヒューリスティックが3件ヒットする(実用的な検出例)。
  assert.equal(properNounItems.length, 3);
  assert.deepEqual(
    properNounItems.map((item) => item.text),
    ["カット", "カット", "テスト"],
  );
  // 境界はみ出し(>80ms)が3件存在することを確認済み(手動検算、改善2でも維持)。
  assert.equal(boundaryOverrunItems.length, 3);
  // keep_segmentsは全て700ms以上のため短いカットは検出されない。
  assert.equal(shortCutItems.length, 0);

  // 受け入れ条件: 全52単語ヒットのような実用性のない状態にはならない(52件 -> 6件)。
  assert.equal(items.length, 6, "要確認件数が実用的な少数になっているはず");
});

// --- 改善13: AIモード ---

const aiReviewBase: AiReviewInput = {
  enabled: true,
  transcriptNeedsReview: [
    {
      word_ids: ["w2"],
      start_ms: 130,
      text: "ん",
      reason: "文字起こしが崩れて復元できない",
    },
  ],
  telopNeedsReview: [{ page_id: "cut_002_p00", reason: "数字確認", suggestion: "100" }],
  dismissedFindingIds: ["f-dismissed"],
};

test("buildAiReviewSuspicions: transcript/telop needs_review を high / ai_review で返す", () => {
  const keepSegments = [
    { startMs: 0, endMs: 100 },
    { startMs: 130, endMs: 240 },
  ];
  const items = buildAiReviewSuspicions(aiReviewBase, words, keepSegments);
  assert.equal(items.length, 2);
  assert.ok(items.every((item) => item.type === "ai_review" && item.severity === "high"));
  assert.equal(items[0].label, "AIが復元できなかった箇所");
});

test("buildSuspicionQueue AIモード: ai_review を最優先し dismissed findings とヒューリスティックを抑制", () => {
  const keepSegments = [{ startMs: 0, endMs: 500 }];
  const katakanaWords: TranscriptWord[] = [
    { id: "w10", text: "カ", startMs: 0, endMs: 100 },
    { id: "w11", text: "ッ", startMs: 100, endMs: 200 },
    { id: "w12", text: "ト", startMs: 200, endMs: 300 },
  ];
  const items = buildSuspicionQueue({
    words: katakanaWords,
    keepSegments,
    telopFindings: [
      {
        id: "f-dismissed",
        type: "dictionary",
        severity: "high",
        page_id: "cut_001_p00",
        message: "dismissed",
        source: "カ",
      },
      {
        id: "f-keep",
        type: "proper_noun_check",
        severity: "high",
        page_id: "cut_001_p00",
        message: "keep",
        source: "カ",
      },
    ],
    fillerWordIds: ["w10"],
    aiReview: aiReviewBase,
  });
  assert.ok(items.some((item) => item.type === "ai_review"));
  assert.equal(items.some((item) => item.id.includes("f-dismissed")), false);
  assert.equal(items.some((item) => item.type === "filler"), false);
  assert.equal(items.some((item) => item.id.startsWith("proper_noun_heuristic:")), false);
  assert.ok(items.some((item) => item.type === "proper_noun" && item.id.includes("f-keep")));
});

test("buildSuspicionQueue AIモード: boundary/short_cut は high のみ残す", () => {
  const keepSegments = [
    { startMs: 0, endMs: 500 },
    { startMs: 1000, endMs: 1300 },
  ];
  const straddlingWords: TranscriptWord[] = [
    { id: "w1", text: "の", startMs: 450, endMs: 550 },
    { id: "w2", text: "です", startMs: 1000, endMs: 1100 },
  ];
  const items = buildSuspicionQueue({
    words: straddlingWords,
    keepSegments,
    aiReview: { enabled: true, dismissedFindingIds: [] },
  });
  const boundaryItems = items.filter((item) => item.type === "boundary_overrun");
  assert.ok(boundaryItems.every((item) => item.severity === "high"));
  const shortItems = items.filter((item) => item.type === "short_cut");
  assert.ok(shortItems.every((item) => item.severity === "high"));
});

test("buildSuspicionQueue: aiReview.enabled=false の場合は従来どおり", () => {
  const testWords: TranscriptWord[] = [
    { id: "w1", text: "えっと", startMs: 0, endMs: 300 },
  ];
  const items = buildSuspicionQueue({
    words: testWords,
    keepSegments: [{ startMs: 0, endMs: 400 }],
    fillerWordIds: ["w1"],
    aiReview: { enabled: false },
  });
  assert.equal(items.some((item) => item.type === "filler"), true);
  assert.equal(items.some((item) => item.type === "ai_review"), false);
});
