import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DIRECTED_STYLE_ID,
  DIRECTED_STYLE_OPTIONS,
  deriveDirectedSlots,
  directedStyleColor,
  directedStyleLabel,
  effectiveDirectedStyleId,
} from "../src/lib/directedTelop.ts";
import {
  initializeScenes,
  mergeSceneWithNext,
  resetSceneIdCounterForTests,
  setSceneDirectedStyle,
  splitSceneAtWord,
  type SourceWord,
} from "../src/lib/scenes.ts";

// フェーズT2(シーン演出決定エンジン / directedモード)のUI側テスト。

function words(...specs: Array<[string, string, number, number]>): SourceWord[] {
  return specs.map(([id, text, startMs, endMs]) => ({ id, text, startMs, endMs }));
}

test.beforeEach(() => {
  resetSceneIdCounterForTests();
});

// --- スタイルバッジのラベル/色 ---

test("directedStyleLabel: 既知のスタイルIDは日本語ラベルになる", () => {
  assert.equal(directedStyleLabel("fact_yellow"), "事実");
  assert.equal(directedStyleLabel("emotion_red"), "感情");
  assert.equal(directedStyleLabel("cta_yellow"), "CTA");
});

test("directedStyleLabel: 未設定は既定(fact_yellow=事実)、未知のIDはIDをそのまま表示する", () => {
  assert.equal(directedStyleLabel(null), "事実");
  assert.equal(directedStyleLabel(undefined), "事実");
  assert.equal(directedStyleLabel("unknown_style"), "unknown_style");
});

test("directedStyleColor: 全スタイルIDに色見本がある(未知のIDは既定色)", () => {
  for (const option of DIRECTED_STYLE_OPTIONS) {
    assert.match(directedStyleColor(option.id), /^#/);
  }
  assert.equal(directedStyleColor("unknown_style"), directedStyleColor(DEFAULT_DIRECTED_STYLE_ID));
});

test("effectiveDirectedStyleId: 未設定は既定fact_yellowへ解決する", () => {
  assert.equal(effectiveDirectedStyleId({ directedStyleId: null }), "fact_yellow");
  assert.equal(effectiveDirectedStyleId({ directedStyleId: "question_blue" }), "question_blue");
});

// --- directedページ境界からのシーン初期化 ---

test("initializeScenes: directedページ境界のstyleId/highlightWordsがシーンへ引き継がれる", () => {
  const scenes = initializeScenes({
    words: words(
      ["w1", "月額は", 0, 1000],
      ["w2", "3万円です", 1000, 2000],
      ["w3", "どう思いますか", 2500, 4000],
    ),
    keepSegments: [{ startMs: 0, endMs: 4000 }],
    telopPageBoundaries: [
      { startMs: 0, endMs: 2000, text: "月額3万円です", styleId: "fact_yellow", highlightWords: ["3万円"] },
      { startMs: 2000, endMs: 4000, text: "どう思いますか", styleId: "question_blue", highlightWords: [] },
    ],
  });
  assert.equal(scenes.length, 2);
  assert.equal(scenes[0].telopText, "月額3万円です");
  assert.equal(scenes[0].directedStyleId, "fact_yellow");
  assert.deepEqual(scenes[0].directedHighlightWords, ["3万円"]);
  assert.equal(scenes[1].directedStyleId, "question_blue");
  assert.deepEqual(scenes[1].directedHighlightWords, []);
});

test("initializeScenes: fullモード(styleIdなし)のシーンにはdirectedフィールドが付かない", () => {
  const scenes = initializeScenes({
    words: words(["w1", "こんにちは", 0, 1000]),
    keepSegments: [{ startMs: 0, endMs: 1000 }],
    telopPageBoundaries: [{ startMs: 0, endMs: 1000, text: "こんにちは" }],
  });
  assert.equal(scenes[0].directedStyleId, undefined);
  assert.equal(scenes[0].directedHighlightWords, undefined);
});

// --- スタイルバッジからの変更 ---

test("setSceneDirectedStyle: 対象シーンのみdirectedスタイルIDが変わる", () => {
  const scenes = initializeScenes({
    words: words(["w1", "こんにちは", 0, 1000], ["w2", "ありがとう", 1500, 2500]),
    keepSegments: [
      { startMs: 0, endMs: 1000 },
      { startMs: 1500, endMs: 2500 },
    ],
    telopPageBoundaries: [
      { startMs: 0, endMs: 1000, text: "こんにちは", styleId: "neutral_white" },
      { startMs: 1500, endMs: 2500, text: "ありがとう", styleId: "reply_cyan" },
    ],
  });
  const updated = setSceneDirectedStyle(scenes, scenes[0].id, "emotion_red");
  assert.equal(updated[0].directedStyleId, "emotion_red");
  assert.equal(updated[1].directedStyleId, "reply_cyan", "他シーンは変化しない");
});

// --- 分割/結合でのdirectedフィールドの引き継ぎ ---

test("splitSceneAtWord: directedスタイル/強調語は両半分へ引き継がれる", () => {
  const scenes = initializeScenes({
    words: words(["w1", "月額3万円で", 0, 1000], ["w2", "始められます", 1000, 2000]),
    keepSegments: [{ startMs: 0, endMs: 2000 }],
    telopPageBoundaries: [
      { startMs: 0, endMs: 2000, text: "月額3万円で始められます", styleId: "box_yellow", highlightWords: ["3万円"] },
    ],
  });
  const split = splitSceneAtWord(scenes, scenes[0].id, "w2");
  assert.equal(split.length, 2);
  assert.equal(split[0].directedStyleId, "box_yellow");
  assert.equal(split[1].directedStyleId, "box_yellow");
  assert.deepEqual(split[0].directedHighlightWords, ["3万円"]);
});

test("mergeSceneWithNext: directedスタイルは前半優先・強調語は結合される", () => {
  const scenes = initializeScenes({
    words: words(["w1", "月額3万円", 0, 1000], ["w2", "先着10名です", 1000, 2000]),
    keepSegments: [{ startMs: 0, endMs: 2000 }],
    telopPageBoundaries: [
      { startMs: 0, endMs: 1000, text: "月額3万円", styleId: "fact_yellow", highlightWords: ["3万円"] },
      { startMs: 1000, endMs: 2000, text: "先着10名です", styleId: "special_purple", highlightWords: ["10名"] },
    ],
  });
  const merged = mergeSceneWithNext(scenes, scenes[0].id);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].directedStyleId, "fact_yellow", "前半のスタイルを優先する");
  assert.deepEqual(merged[0].directedHighlightWords, ["3万円", "10名"]);
});

// --- 適用ペイロード(deriveDirectedSlots)の導出 ---

test("deriveDirectedSlots: scenesから絶対ms範囲付きのスロット編集リストを導出する", () => {
  const scenes = initializeScenes({
    words: words(["w1", "月額3万円です", 1000, 3000], ["w2", "どう思いますか", 3000, 5500]),
    keepSegments: [{ startMs: 1000, endMs: 5500 }],
    telopPageBoundaries: [
      { startMs: 1000, endMs: 3000, text: "月額3万円です", styleId: "fact_yellow", highlightWords: ["3万円"] },
      { startMs: 3000, endMs: 5500, text: "どう思いますか", styleId: "question_blue", highlightWords: [] },
    ],
  });
  const slots = deriveDirectedSlots(scenes);
  assert.equal(slots.length, 2);
  assert.deepEqual(slots[0], {
    startMs: 1000,
    endMs: 3000,
    text: "月額3万円です",
    styleId: "fact_yellow",
    highlightWords: ["3万円"],
    typeId: null,
    styleOverridden: true,
    animationIn: null,
  });
  assert.equal(slots[1].styleId, "question_blue");
});

test("deriveDirectedSlots: 文言編集後、テキストに残っていない強調語は落とす", () => {
  const scenes = initializeScenes({
    words: words(["w1", "月額3万円です", 0, 2000]),
    keepSegments: [{ startMs: 0, endMs: 2000 }],
    telopPageBoundaries: [
      { startMs: 0, endMs: 2000, text: "月額3万円です", styleId: "fact_yellow", highlightWords: ["3万円"] },
    ],
  });
  const edited = scenes.map((scene) => ({ ...scene, telopText: "月額は据え置きです" }));
  const slots = deriveDirectedSlots(edited);
  assert.deepEqual(slots[0].highlightWords, [], "編集後テキストに無い強調語は送らない");
});

test("deriveDirectedSlots: スタイル未設定のシーンは既定fact_yellowとして送る", () => {
  const scenes = initializeScenes({
    words: words(["w1", "こんにちは", 0, 1000]),
    keepSegments: [{ startMs: 0, endMs: 1000 }],
    telopPageBoundaries: [
      { startMs: 0, endMs: 1000, text: "こんにちは", styleId: "neutral_white" },
    ],
  });
  const withoutStyle = scenes.map((scene) => ({ ...scene, directedStyleId: undefined }));
  const slots = deriveDirectedSlots(withoutStyle);
  assert.equal(slots[0].styleId, "fact_yellow");
});
