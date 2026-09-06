import test from "node:test";
import assert from "node:assert/strict";
import {
  applyStyleOverrideToEmotionGroup,
  deriveTelopStyleIds,
  initializeScenes,
  mergeSceneWithNext,
  resetSceneIdCounterForTests,
  setSceneEmotionTag,
  setSceneStyleOverride,
  splitSceneAtWord,
  type SourceWord,
} from "../src/lib/scenes.ts";
import { resolveEffectiveStyleId } from "../src/lib/telopThemes.ts";

function words(...specs: Array<[string, string, number, number]>): SourceWord[] {
  return specs.map(([id, text, startMs, endMs]) => ({ id, text, startMs, endMs }));
}

test.beforeEach(() => {
  resetSceneIdCounterForTests();
});

test("initializeScenes: T-2 各シーンにルールベースの感情タグを自動付与する", () => {
  const scenes = initializeScenes({
    words: words(["w1", "本当にこれでいいですか", 0, 500]),
    keepSegments: [{ startMs: 0, endMs: 500 }],
  });
  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].emotionTag, "question");
  assert.equal(scenes[0].styleOverrideId, null, "初期状態は個別オーバーライドなし");
});

test("setSceneEmotionTag: バッジクリックで感情タグを手動変更できる(他シーンは変化しない)", () => {
  const scenes = initializeScenes({
    words: words(["w1", "こんにちは", 0, 300], ["w2", "ありがとう", 400, 700]),
    keepSegments: [
      { startMs: 0, endMs: 300 },
      { startMs: 400, endMs: 700 },
    ],
  });
  const targetId = scenes[0].id;
  const otherTag = scenes[1].emotionTag;
  const updated = setSceneEmotionTag(scenes, targetId, "surprise");
  assert.equal(updated.find((s) => s.id === targetId)?.emotionTag, "surprise");
  assert.equal(updated.find((s) => s.id !== targetId)?.emotionTag, otherTag, "他シーンは変化しない");
});

test("setSceneStyleOverride: 個別スタイルオーバーライドの設定/解除ができる", () => {
  const scenes = initializeScenes({
    words: words(["w1", "こんにちは", 0, 300]),
    keepSegments: [{ startMs: 0, endMs: 300 }],
  });
  const sceneId = scenes[0].id;
  const withOverride = setSceneStyleOverride(scenes, sceneId, "extra_green");
  assert.equal(withOverride[0].styleOverrideId, "extra_green");
  const cleared = setSceneStyleOverride(withOverride, sceneId, null);
  assert.equal(cleared[0].styleOverrideId, null);
});

test("applyStyleOverrideToEmotionGroup: 同じ感情タグを持つ全シーン(対象自身含む)にスタイルを一括適用する", () => {
  const scenes = initializeScenes({
    words: words(["w1", "こんにちは", 0, 300], ["w2", "ありがとう", 400, 700], ["w3", "衝撃の結末", 800, 1100]),
    keepSegments: [
      { startMs: 0, endMs: 300 },
      { startMs: 400, endMs: 700 },
      { startMs: 800, endMs: 1100 },
    ],
  });
  // w3の「衝撃の結末」は体言止めでemphasisになる想定。他2つはnormal想定。
  const emphasisScene = scenes.find((s) => s.emotionTag === "emphasis");
  assert.ok(emphasisScene, "少なくとも1シーンはemphasisと判定される");
  const normalScenes = scenes.filter((s) => (s.emotionTag ?? "normal") === "normal");
  assert.ok(normalScenes.length >= 1);

  const targetId = normalScenes[0].id;
  const updated = applyStyleOverrideToEmotionGroup(scenes, targetId, "extra_purple");
  for (const scene of updated) {
    if ((scene.emotionTag ?? "normal") === "normal") {
      assert.equal(scene.styleOverrideId, "extra_purple", `normalグループの ${scene.id} に適用される`);
    }
  }
  if (emphasisScene) {
    const stillEmphasis = updated.find((s) => s.id === emphasisScene.id);
    assert.notEqual(stillEmphasis?.styleOverrideId, "extra_purple", "他の感情グループには適用されない");
  }
});

test("deriveTelopStyleIds: スタイル優先順位(オーバーライド>感情>テーマ既定)に従いcut単位でIDを導出する", () => {
  const scenes = initializeScenes({
    words: words(["w1", "こんにちは", 0, 300], ["w2", "本当ですか", 400, 700]),
    keepSegments: [
      { startMs: 0, endMs: 300 },
      { startMs: 400, endMs: 700 },
    ],
  });
  const withOverride = setSceneStyleOverride(scenes, scenes[0].id, "extra_green");
  const styleIds = deriveTelopStyleIds(withOverride, "simple", resolveEffectiveStyleId);
  assert.equal(styleIds.length, 2);
  assert.equal(styleIds[0], "extra_green", "オーバーライドが最優先");
  assert.equal(styleIds[1], "simple_question", "オーバーライドなしなら感情タグ(疑問)に従う");
});

test("splitSceneAtWord: 分割後の各半分で感情タグを本文から再判定し、styleOverrideIdは両半分に引き継ぐ", () => {
  const scenes = initializeScenes({
    words: words(["w1", "こんにちは", 0, 300], ["w2", "本当ですか", 400, 700]),
    keepSegments: [{ startMs: 0, endMs: 700 }],
  });
  const withOverride = setSceneStyleOverride(scenes, scenes[0].id, "extra_green");
  const split = splitSceneAtWord(withOverride, scenes[0].id, "w2");
  assert.equal(split.length, 2);
  assert.equal(split[0].telopText, "こんにちは");
  assert.equal(split[1].telopText, "本当ですか");
  assert.equal(split[1].emotionTag, "question");
  assert.equal(split[0].styleOverrideId, "extra_green");
  assert.equal(split[1].styleOverrideId, "extra_green", "構造操作である分割ではオーバーライドを両半分に引き継ぐ");
});

test("W28 mergeSceneWithNext: 結合後の本文で感情タグを再判定し、styleOverrideIdは前半のものだけを使う", () => {
  const scenes = initializeScenes({
    words: words(["w1", "こんにちは", 0, 300], ["w2", "本当ですか", 400, 700]),
    keepSegments: [
      { startMs: 0, endMs: 300 },
      { startMs: 400, endMs: 700 },
    ],
  });
  const withOverride = setSceneStyleOverride(scenes, scenes[1].id, "extra_purple");
  const merged = mergeSceneWithNext(withOverride, scenes[0].id);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].telopText, "こんにちは本当ですか");
  assert.equal(merged[0].emotionTag, "question");
  // 2026-08-22 実機フィードバック: 上のテロップとくっつけたら上の見た目を優先する
  // (旧仕様の「前半に無ければ後半を引き継ぐ」は下のエフェクトが残ってしまうため廃止)
  assert.equal(merged[0].styleOverrideId, null, "前半にオーバーライドが無ければ後半のものも引き継がない");
});
