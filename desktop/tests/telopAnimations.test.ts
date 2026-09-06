import test from "node:test";
import assert from "node:assert/strict";
import {
  ANIMATION_IN_IDS,
  ANIMATION_PICKER_OPTIONS,
  SFX_IDS,
  SFX_PICKER_OPTIONS,
  animationInLabel,
  sanitizeAnimationInId,
  sanitizeSfxChoice,
} from "../src/lib/telopAnimations.ts";
import {
  initializeScenes,
  mergeSceneWithNext,
  resetSceneIdCounterForTests,
  setSceneDirectedAnimation,
  splitSceneAtWord,
  type SourceWord,
} from "../src/lib/scenes.ts";
import { deriveDirectedSlots } from "../src/lib/directedTelop.ts";

// フェーズT3(テロップアニメーション+効果音)のUI側テスト。

function words(...specs: Array<[string, string, number, number]>): SourceWord[] {
  return specs.map(([id, text, startMs, endMs]) => ({ id, text, startMs, endMs }));
}

test.beforeEach(() => {
  resetSceneIdCounterForTests();
});

// --- アニメID・ピッカー選択肢の定義 ---

test("ANIMATION_IN_IDS: remotion/pythonと同じ15種+none(W26でショート向け5種を追加)", () => {
  assert.deepEqual(
    [...ANIMATION_IN_IDS],
    [
      "pop_big",
      "slide_left",
      "slide_up",
      "zoom",
      "stamp",
      "fade",
      "blur_in",
      "typewriter",
      "wipe_up",
      "drop_settle",
      "slam",
      "bounce_left",
      "bounce_right",
      "rise_bounce",
      "drop_bounce",
      "none",
    ],
  );
});

test("ANIMATION_PICKER_OPTIONS: 先頭は「プリセット既定」(空ID)+全IDで全てに日本語ラベル", () => {
  assert.equal(ANIMATION_PICKER_OPTIONS.length, ANIMATION_IN_IDS.length + 1);
  assert.deepEqual(ANIMATION_PICKER_OPTIONS[0], { id: "", label: "プリセット既定" });
  for (const option of ANIMATION_PICKER_OPTIONS) {
    assert.ok(option.label, `${option.id || "(既定)"} にラベルがある`);
  }
});

test("sanitizeAnimationInId: 未知・欠落はnull(=上書きなし)へ正規化する", () => {
  assert.equal(sanitizeAnimationInId("pop_big"), "pop_big");
  assert.equal(sanitizeAnimationInId("none"), "none");
  assert.equal(sanitizeAnimationInId("explode"), null);
  assert.equal(sanitizeAnimationInId(""), null);
  assert.equal(sanitizeAnimationInId(undefined), null);
  assert.equal(sanitizeAnimationInId(42), null);
});

test("animationInLabel: 有効IDは日本語ラベル・null/未知は「プリセット既定」", () => {
  assert.equal(animationInLabel("pop_big"), "中央からドン");
  assert.equal(animationInLabel("slide_left"), "左からスライド");
  // W24 Phase B-1: 広告向け4種の日本語表示名
  assert.equal(animationInLabel("blur_in"), "ブラー登場");
  assert.equal(animationInLabel("typewriter"), "タイプライター");
  assert.equal(animationInLabel("wipe_up"), "ワイプ");
  assert.equal(animationInLabel("drop_settle"), "ストン");
  // W26: ショート向け5種の日本語表示名
  assert.equal(animationInLabel("slam"), "叩きつけ+シェイク");
  assert.equal(animationInLabel("bounce_left"), "左からバウンド");
  assert.equal(animationInLabel("rise_bounce"), "下からバウンド");
  assert.equal(animationInLabel(null), "プリセット既定");
  assert.equal(animationInLabel("explode"), "プリセット既定");
});

// --- 効果音の選択肢 ---

test("SFX_PICKER_OPTIONS: プリセット既定+5種+鳴らさない", () => {
  assert.equal(SFX_PICKER_OPTIONS.length, SFX_IDS.length + 2);
  assert.deepEqual(SFX_PICKER_OPTIONS[0], { id: "", label: "プリセット既定" });
  assert.deepEqual(SFX_PICKER_OPTIONS[SFX_PICKER_OPTIONS.length - 1], { id: "none", label: "鳴らさない" });
});

test("sanitizeSfxChoice: 有効ID/noneは残し、未知・欠落はnull(=プリセット既定)", () => {
  assert.equal(sanitizeSfxChoice("don"), "don");
  assert.equal(sanitizeSfxChoice("none"), "none");
  assert.equal(sanitizeSfxChoice("boom"), null);
  assert.equal(sanitizeSfxChoice(""), null);
  assert.equal(sanitizeSfxChoice(undefined), null);
});

// --- シーンのアニメ上書き(初期化・変更・継承) ---

function buildDirectedScenes() {
  return initializeScenes({
    words: words(["w1", "絶対に", 0, 800], ["w2", "やめてください", 800, 2000]),
    keepSegments: [{ startMs: 0, endMs: 2000 }],
    telopPageBoundaries: [
      {
        startMs: 0,
        endMs: 2000,
        text: "絶対にやめてください",
        styleId: "emotion_red",
        typeId: "emphasis",
        animationIn: "slide_up",
      },
    ],
  });
}

test("initializeScenes: ページ境界のanimationIn(上書き由来)がdirectedAnimationInへ復元される", () => {
  const scenes = buildDirectedScenes();
  assert.equal(scenes[0].directedAnimationIn, "slide_up");
});

test("initializeScenes: animationIn無しのページはdirectedAnimationIn未設定(マッピング/プリセット既定)", () => {
  const scenes = initializeScenes({
    words: words(["w1", "こんにちは", 0, 1000]),
    keepSegments: [{ startMs: 0, endMs: 1000 }],
    telopPageBoundaries: [{ startMs: 0, endMs: 1000, text: "こんにちは", styleId: "fact_yellow", typeId: "default" }],
  });
  assert.equal(scenes[0].directedAnimationIn, undefined);
});

test("setSceneDirectedAnimation: ピッカーからの上書き設定と解除(null)", () => {
  const scenes = buildDirectedScenes();
  const updated = setSceneDirectedAnimation(scenes, scenes[0].id, "zoom");
  assert.equal(updated[0].directedAnimationIn, "zoom");
  const cleared = setSceneDirectedAnimation(updated, scenes[0].id, null);
  assert.equal(cleared[0].directedAnimationIn, null);
});

test("splitSceneAtWord: 分割後もdirectedAnimationInを両半分に引き継ぐ", () => {
  const scenes = buildDirectedScenes();
  const split = splitSceneAtWord(scenes, scenes[0].id, "w2");
  assert.equal(split.length, 2);
  assert.equal(split[0].directedAnimationIn, "slide_up");
  assert.equal(split[1].directedAnimationIn, "slide_up");
});

test("W28 mergeSceneWithNext: 結合は前半のdirectedAnimationInだけを使う(前半が未設定なら後半を引き継がない)", () => {
  const scenes = buildDirectedScenes();
  const split = splitSceneAtWord(scenes, scenes[0].id, "w2");
  // 前半の上書きを解除 → 結合しても後半の slide_up は引き継がず、上のシーンの見た目を維持する
  // (2026-08-22 実機フィードバック: エフェクト付きテロップを上とくっつけたら上を優先)
  const clearedFirst = setSceneDirectedAnimation(split, split[0].id, null);
  const merged = mergeSceneWithNext(clearedFirst, clearedFirst[0].id);
  assert.equal(merged[0].directedAnimationIn, null);
});

// --- 適用ペイロード(deriveDirectedSlots)への伝搬 ---

test("deriveDirectedSlots: directedAnimationInをanimationInとして送る(未設定はnull)", () => {
  const scenes = buildDirectedScenes();
  assert.equal(deriveDirectedSlots(scenes)[0].animationIn, "slide_up");
  const cleared = setSceneDirectedAnimation(scenes, scenes[0].id, null);
  assert.equal(deriveDirectedSlots(cleared)[0].animationIn, null);
});
