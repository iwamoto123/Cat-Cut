import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiFailureMessage,
  buildAiFailureSuspicion,
  buildAiReviewSuspicions,
  buildBoundaryOverrunSuspicions,
  buildFillerSuspicions,
  buildLowConfidenceSuspicions,
  buildProperNounSuspicions,
  buildShortCutSuspicions,
  buildSuspectWordSuspicions,
  buildSuspicionQueue,
  buildTelopReviewSuspicions,
  buildWordSplitSuspicions,
  COMMON_KATAKANA_WORDS,
  hasMeaningfulConfidenceVariance,
  normalizeAiFailureErrorKind,
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
  // 改善21-C: 一般語除外リストに載っていない固有名詞らしき語(シラタニ)を使う。
  const testWords: TranscriptWord[] = [
    { id: "w1", text: "シ", startMs: 0, endMs: 100 },
    { id: "w2", text: "ラ", startMs: 100, endMs: 200 },
    { id: "w3", text: "タ", startMs: 200, endMs: 300 },
    { id: "w4", text: "ニ", startMs: 300, endMs: 400 },
  ];
  const items = buildProperNounSuspicions(testWords, [], [{ startMs: 0, endMs: 400 }]);
  assert.equal(items.length, 1);
  assert.equal(items[0].severity, "medium");
  assert.equal(items[0].text, "シラタニ");
});

test("buildProperNounSuspicions: ユーザー辞書に登録済みのカタカナ語はフラグしない", () => {
  const testWords: TranscriptWord[] = [
    { id: "w1", text: "シ", startMs: 0, endMs: 100 },
    { id: "w2", text: "ラ", startMs: 100, endMs: 200 },
    { id: "w3", text: "タ", startMs: 200, endMs: 300 },
    { id: "w4", text: "ニ", startMs: 300, endMs: 400 },
  ];
  const items = buildProperNounSuspicions(testWords, [], [{ startMs: 0, endMs: 400 }], {
    knownDictionary: [{ wrong: "シラタニ", correct: "シラタニ" }],
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
  // 含まれる。改善21-Cで「テスト」は一般語除外リスト入りしたため、「カット」の2件のみヒットする。
  assert.equal(properNounItems.length, 2);
  assert.deepEqual(
    properNounItems.map((item) => item.text),
    ["カット", "カット"],
  );
  // 境界はみ出し(>80ms)が3件存在することを確認済み(手動検算、改善2でも維持)。
  assert.equal(boundaryOverrunItems.length, 3);
  // keep_segmentsは全て700ms以上のため短いカットは検出されない。
  assert.equal(shortCutItems.length, 0);

  // 受け入れ条件: 全52単語ヒットのような実用性のない状態にはならない(52件 -> 5件)。
  assert.equal(items.length, 5, "要確認件数が実用的な少数になっているはず");
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

test("buildWordSplitSuspicions: word_split_flags を high 疑義として生成", () => {
  const words: TranscriptWord[] = [
    { id: "w-head", text: "ト", startMs: 1377148, endMs: 1377200 },
  ];
  const items = buildWordSplitSuspicions(
    [
      {
        prev_end_ms: 1372737,
        next_start_ms: 1377148,
        tail_text: "この部分をボル",
        head_text: "トマン定数と",
        gap_ms: 4411,
      },
    ],
    words,
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "word_split");
  assert.equal(items[0].severity, "high");
  assert.equal(items[0].label, "カット境界の単語分断の疑い");
  assert.equal(items[0].wordIds[0], "w-head");
});

test("buildSuspicionQueue: wordSplitFlags 未指定でも壊れない", () => {
  const items = buildSuspicionQueue({
    words: [{ id: "w1", text: "あ", startMs: 0, endMs: 100 }],
    keepSegments: [{ startMs: 0, endMs: 200 }],
  });
  assert.equal(items.some((item) => item.type === "word_split"), false);
});

// --- W5-3: AI疑義ワード(suspect_word) ---

test("buildSuspectWordSuspicions: suspect_words を high / suspect_word で返す", () => {
  const items = buildSuspectWordSuspicions(
    {
      enabled: true,
      suspectWords: [
        {
          word_ids: ["w2", "w3"],
          start_ms: 130,
          end_ms: 340,
          text: "んに",
          reason: "文脈と合わない可能性",
          suggestion: "ンニ",
        },
      ],
    },
    words,
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "suspect_word");
  assert.equal(items[0].severity, "high");
  assert.equal(items[0].label, "文脈上あやしい語");
  assert.equal(items[0].text, "んに");
  assert.deepEqual(items[0].wordIds, ["w2", "w3"]);
  assert.equal(items[0].timestampMs, 130);
  assert.equal(items[0].detail, "文脈と合わない可能性（候補: ンニ）");
});

test("buildSuspectWordSuspicions: suggestion無しはreasonのみ、start_ms無しは先頭wordのstartMsを使う", () => {
  const items = buildSuspectWordSuspicions(
    { enabled: true, suspectWords: [{ word_ids: ["w2"], text: "ん", reason: "誤変換の疑い" }] },
    words,
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].detail, "誤変換の疑い");
  assert.equal(items[0].timestampMs, 130);
});

test("buildSuspectWordSuspicions: 実在しないword_idのみの項目は捨てる・enabled=falseは空", () => {
  const missing = buildSuspectWordSuspicions(
    { enabled: true, suspectWords: [{ word_ids: ["w-missing"], text: "x", reason: "r" }] },
    words,
  );
  assert.equal(missing.length, 0);
  const disabled = buildSuspectWordSuspicions(
    { enabled: false, suspectWords: [{ word_ids: ["w2"], text: "ん", reason: "r" }] },
    words,
  );
  assert.equal(disabled.length, 0);
  assert.equal(buildSuspectWordSuspicions(undefined, words).length, 0);
});

test("buildSuspicionQueue: suspectWords が suspect_word 項目としてキューに統合される", () => {
  const items = buildSuspicionQueue({
    words,
    keepSegments: [{ startMs: 0, endMs: 500 }],
    aiReview: {
      enabled: true,
      suspectWords: [
        { word_ids: ["w2"], start_ms: 130, text: "ん", reason: "誤変換の疑い", suggestion: "ン" },
      ],
    },
  });
  const suspectItems = items.filter((item) => item.type === "suspect_word");
  assert.equal(suspectItems.length, 1);
  assert.equal(suspectItems[0].severity, "high");
});

// --- 改善21-B: AI校正失敗を要確認キューの先頭項目に統合 ---

test("normalizeAiFailureErrorKind: 既知の分類はそのまま、未知・空はotherにフォールバック", () => {
  assert.equal(normalizeAiFailureErrorKind("billing"), "billing");
  assert.equal(normalizeAiFailureErrorKind("auth"), "auth");
  assert.equal(normalizeAiFailureErrorKind("rate_limit"), "rate_limit");
  assert.equal(normalizeAiFailureErrorKind("overloaded"), "overloaded");
  assert.equal(normalizeAiFailureErrorKind("timeout"), "timeout");
  assert.equal(normalizeAiFailureErrorKind(""), "other");
  assert.equal(normalizeAiFailureErrorKind(undefined), "other");
  assert.equal(normalizeAiFailureErrorKind("unknown_kind"), "other");
});

test("aiFailureMessage: billingはプロバイダ名入りのチャージ・切替案内", () => {
  const message = aiFailureMessage("billing", "anthropic", "");
  assert.match(message.action, /Anthropic/);
  assert.match(message.action, /クレジット残高が不足/);
  assert.match(message.action, /⚙API設定/);
  assert.match(message.action, /Geminiは無料枠あり/);
  assert.match(message.action, /再解析/);
});

test("aiFailureMessage: authはAPIキー確認の案内", () => {
  const message = aiFailureMessage("auth", "openai", "");
  assert.match(message.action, /APIキーが無効/);
  assert.match(message.action, /⚙API設定/);
});

test("aiFailureMessage: rate_limit/overloadedは待って再解析の案内", () => {
  for (const kind of ["rate_limit", "overloaded"] as const) {
    const message = aiFailureMessage(kind, "anthropic", "");
    assert.match(message.action, /混雑・制限中/);
    assert.match(message.action, /しばらく待ってから再解析/);
  }
});

test("aiFailureMessage: timeout/otherは再試行案内+error_detail要約", () => {
  const message = aiFailureMessage("other", "anthropic", "HTTPStatusError: boom " + "x".repeat(300));
  assert.match(message.action, /再解析で再試行/);
  assert.match(message.action, /詳細: HTTPStatusError: boom/);
  assert.ok(message.action.length < 260, "error_detailは要約される");
});

test("buildAiFailureSuspicion: 失敗が無ければnull", () => {
  assert.equal(buildAiFailureSuspicion(undefined), null);
  assert.equal(buildAiFailureSuspicion({ enabled: true }), null);
});

test("buildAiFailureSuspicion: billing失敗は行アンカーなしのhigh項目になる", () => {
  const item = buildAiFailureSuspicion({
    enabled: false,
    transcriptRefineFailed: true,
    telopRefineFailed: true,
    transcriptErrorKind: "billing",
    transcriptProvider: "anthropic",
    transcriptErrorDetail: "Your credit balance is too low",
  });
  assert.ok(item);
  assert.equal(item?.type, "ai_failure");
  assert.equal(item?.severity, "high");
  assert.equal(item?.label, "AI校正が実行されていません");
  assert.deepEqual(item?.wordIds, [], "特定行にアンカーしない");
  assert.equal(item?.timestampMs, 0);
  assert.match(item?.detail || "", /クレジット残高が不足/);
  assert.match(item?.text || "", /パス1・パス2/);
});

test("buildAiFailureSuspicion: パス2のみ失敗時はtelop側のerror_kindを使う", () => {
  const item = buildAiFailureSuspicion({
    enabled: true,
    telopRefineFailed: true,
    telopErrorKind: "auth",
    telopProvider: "gemini",
  });
  assert.ok(item);
  assert.match(item?.detail || "", /APIキーが無効/);
  assert.match(item?.text || "", /パス2/);
});

test("buildSuspicionQueue: AI校正失敗項目がキューの先頭に固定される", () => {
  // high の word_split・低confidence等が存在しても ai_failure が先頭。
  const testWords: TranscriptWord[] = [
    { id: "w1", text: "こ", startMs: 0, endMs: 120, confidence: 0.9 },
    { id: "w2", text: "ん", startMs: 130, endMs: 240, confidence: 0.3 },
    { id: "w3", text: "に", startMs: 250, endMs: 340, confidence: 0.5 },
  ];
  const items = buildSuspicionQueue({
    words: testWords,
    keepSegments: [{ startMs: 0, endMs: 400 }],
    wordSplitFlags: [
      { prev_end_ms: 100, next_start_ms: 130, tail_text: "こ", head_text: "ん", gap_ms: 30 },
    ],
    aiReview: {
      enabled: false,
      transcriptRefineFailed: true,
      telopRefineFailed: true,
      transcriptErrorKind: "billing",
      transcriptProvider: "anthropic",
    },
  });
  assert.ok(items.length > 1);
  assert.equal(items[0].type, "ai_failure");
  assert.match(items[0].detail, /クレジット残高が不足/);
});

test("buildSuspicionQueue: 失敗が無ければai_failure項目は追加されない", () => {
  const items = buildSuspicionQueue({
    words: [{ id: "w1", text: "あ", startMs: 0, endMs: 100 }],
    keepSegments: [{ startMs: 0, endMs: 200 }],
    aiReview: { enabled: true },
  });
  assert.equal(items.some((item) => item.type === "ai_failure"), false);
});

// --- 改善21-C: カタカナ「辞書未登録」フラグの洪水抑制 ---

test("21-C: 一般ビジネスカタカナ語(テレアポ/インバウンド等)は既定で除外される", () => {
  // カタカナ語同士が連結して1ランにならないよう、間にひらがなを挟む(実際の会話と同じ)。
  const words: TranscriptWord[] = [];
  let ms = 0;
  const append = (text: string) => {
    for (const ch of text) {
      words.push({ id: `w${words.length}`, text: ch, startMs: ms, endMs: ms + 100 });
      ms += 100;
    }
  };
  append("テレアポ");
  append("と");
  append("インバウンド");
  append("の");
  append("コンサルタント");
  append("が");
  append("ミーティング");
  const items = buildProperNounSuspicions(words, [], [{ startMs: 0, endMs: ms }]);
  assert.equal(items.length, 0);
});

test("21-C: 同一表記のカタカナ語が3回以上出現する場合はフラグしない(頻度ベース抑制)", () => {
  const words: TranscriptWord[] = [];
  // 「シラタニ」を3回、「カサハラ」を1回出現させる(ひらがなで区切って別ランにする)。
  let ms = 0;
  const append = (text: string) => {
    for (const ch of text) {
      words.push({ id: `w${words.length}`, text: ch, startMs: ms, endMs: ms + 100 });
      ms += 100;
    }
  };
  append("シラタニ");
  append("の");
  append("シラタニ");
  append("の");
  append("シラタニ");
  append("の");
  append("カサハラ");
  const items = buildProperNounSuspicions(words, [], [{ startMs: 0, endMs: ms }]);
  assert.equal(items.length, 1, "3回出現するシラタニは抑制、1回のカサハラのみ残る");
  assert.equal(items[0].text, "カサハラ");
});

test("21-C: 2回以下の出現はこれまで通りフラグされる", () => {
  const words: TranscriptWord[] = [];
  let ms = 0;
  const append = (text: string) => {
    for (const ch of text) {
      words.push({ id: `w${words.length}`, text: ch, startMs: ms, endMs: ms + 100 });
      ms += 100;
    }
  };
  append("シラタニ");
  append("の");
  append("シラタニ");
  const items = buildProperNounSuspicions(words, [], [{ startMs: 0, endMs: ms }]);
  assert.equal(items.length, 2);
});

test("21-C: 数字の辞書未登録フラグは頻度・一般語除外の影響を受けない", () => {
  const words: TranscriptWord[] = [
    { id: "w1", text: "3", startMs: 0, endMs: 100 },
    { id: "w2", text: "回", startMs: 100, endMs: 200 },
    { id: "w3", text: "3", startMs: 300, endMs: 400 },
    { id: "w4", text: "回", startMs: 400, endMs: 500 },
    { id: "w5", text: "3", startMs: 600, endMs: 700 },
    { id: "w6", text: "回", startMs: 700, endMs: 800 },
  ];
  const items = buildProperNounSuspicions(words, [], [{ startMs: 0, endMs: 800 }]);
  assert.equal(items.filter((item) => item.detail.includes("数字")).length, 3);
});

test("21-C: AIが明示的に出したneeds_review(ai_review)は一般語でも抑制されない", () => {
  const words: TranscriptWord[] = [..."テレアポ"].map((ch, j) => ({
    id: `w${j}`,
    text: ch,
    startMs: j * 100,
    endMs: (j + 1) * 100,
  }));
  const items = buildAiReviewSuspicions(
    {
      enabled: true,
      transcriptNeedsReview: [
        { word_ids: ["w0"], start_ms: 0, text: "テレアポ", reason: "文脈から復元できない" },
      ],
    },
    words,
    [{ startMs: 0, endMs: 1000 }],
  );
  assert.equal(items.length, 1);
});

test("21-C: COMMON_KATAKANA_WORDSは50語以上の一般語リストである", () => {
  assert.ok(COMMON_KATAKANA_WORDS.size >= 50);
  assert.ok(COMMON_KATAKANA_WORDS.has("テレアポ"));
  assert.ok(COMMON_KATAKANA_WORDS.has("ノウハウ"));
});
