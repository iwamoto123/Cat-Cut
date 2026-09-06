// W16-1: 無音チップ([...])のテスト。
// 単語間の長いギャップが無音wordとして挿入され、チップ削除だけで書き出しから
// 無音区間がカットされる(既存のcomputeSceneKeptSubRanges規則に乗る)ことを担保する。
import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveKeepSegments,
  initializeScenes,
  insertSilenceChipWords,
  resetSceneIdCounterForTests,
  setChipsDeleted,
  splitSceneAtMs,
  SILENCE_CHIP_MIN_MS,
  type SceneWord,
  type SourceWord,
} from "../src/lib/scenes.ts";
import {
  buildWordGroupsUncached,
  findSilenceGroupIndexAtMs,
  SILENCE_GROUP_LABEL,
} from "../src/lib/wordGroups.ts";

function sceneWord(id: string, text: string, startMs: number, endMs: number): SceneWord {
  return { id, text, startMs, endMs, deleted: false };
}

function sourceWords(...specs: Array<[string, string, number, number]>): SourceWord[] {
  return specs.map(([id, text, startMs, endMs]) => ({ id, text, startMs, endMs }));
}

test.beforeEach(() => {
  resetSceneIdCounterForTests();
});

/** 1ページ=全区間のテロップページ境界でシーン初期化する(ページ経路はポーズで行分割しないため、
 *  シーン内に長いギャップ=無音チップが残る)。相槌判定(W10-7の2文字以下空欄化)を避けるため
 *  3文字以上のテキストにする。 */
function buildSceneWithSilence() {
  const scenes = initializeScenes({
    words: sourceWords(["w1", "今日は", 0, 100], ["w2", "晴れです", 700, 800]),
    keepSegments: [{ startMs: 0, endMs: 800 }],
    telopPageBoundaries: [{ startMs: 0, endMs: 800 }],
  });
  assert.equal(scenes.length, 1);
  return scenes;
}

test("insertSilenceChipWords: 500ms以上のギャップに無音word(text空)を挿入する", () => {
  const words = [sceneWord("w1", "あ", 0, 100), sceneWord("w2", "い", 700, 800)];
  const result = insertSilenceChipWords(words);
  assert.equal(result.length, 3);
  const silence = result[1];
  assert.equal(silence.silence, true);
  assert.equal(silence.text, "");
  assert.equal(silence.startMs, 100);
  assert.equal(silence.endMs, 700);
  assert.equal(silence.deleted, false);
});

test("insertSilenceChipWords: 500ms未満のギャップ・ギャップ無しは挿入しない(後方互換)", () => {
  const words = [
    sceneWord("w1", "あ", 0, 100),
    sceneWord("w2", "い", 100 + SILENCE_CHIP_MIN_MS - 1, 700),
    sceneWord("w3", "う", 700, 800),
  ];
  const result = insertSilenceChipWords(words);
  assert.equal(result.length, 3);
  assert.ok(result.every((word) => !word.silence));
});

test("無音チップは単独グループになりラベルは[...]、telopTextへは混入しない", () => {
  const scenes = buildSceneWithSilence();
  const scene = scenes[0];
  const groups = buildWordGroupsUncached(scene);
  assert.equal(groups.length, 3);
  assert.equal(groups[1].silence, true);
  assert.equal(groups[1].text, SILENCE_GROUP_LABEL);
  assert.deepEqual(groups[1].wordIds, ["sil_w1"]);
  // テロップ・表示テキストに [...] が混入しない
  assert.equal(scene.telopText.includes(SILENCE_GROUP_LABEL), false);
  assert.equal(scene.telopText, "今日は晴れです");
});

test("無音チップの削除だけで書き出しkeep_segmentsから無音区間が除外される", () => {
  const scenes = buildSceneWithSilence();
  const scene = scenes[0];
  const next = setChipsDeleted(scenes, scene.id, ["sil_w1"], true);
  assert.deepEqual(deriveKeepSegments(next), [
    { startMs: 0, endMs: 100 },
    { startMs: 700, endMs: 800 },
  ]);
  // 復元すれば元のkeep_segmentsへ戻る
  const restored = setChipsDeleted(next, scene.id, ["sil_w1"], false);
  assert.deepEqual(deriveKeepSegments(restored), [{ startMs: 0, endMs: 800 }]);
});

test("findSilenceGroupIndexAtMs: 無音区間内はそのindex、区間外・削除済みは-1", () => {
  const scenes = buildSceneWithSilence();
  const scene = scenes[0];
  const groups = buildWordGroupsUncached(scene);
  assert.equal(findSilenceGroupIndexAtMs(groups, 400), 1);
  assert.equal(findSilenceGroupIndexAtMs(groups, 50), -1);
  assert.equal(findSilenceGroupIndexAtMs(groups, 750), -1);
  const deleted = setChipsDeleted(scenes, scene.id, ["sil_w1"], true);
  assert.equal(findSilenceGroupIndexAtMs(buildWordGroupsUncached(deleted[0]), 400), -1);
});

test("silenceフラグの無い既存シーンは従来どおり(無音グループなし)", () => {
  const scenes = initializeScenes({
    words: sourceWords(["w1", "あ", 0, 100], ["w2", "い", 100, 200]),
    keepSegments: [{ startMs: 0, endMs: 200 }],
  });
  const groups = buildWordGroupsUncached(scenes[0]);
  assert.ok(groups.every((group) => !group.silence));
  assert.ok(groups.every((group) => group.text !== SILENCE_GROUP_LABEL));
});

test("W28 splitSceneAtMs: 無音word内部での分割はチップを2つに割って分割位置を正確に守る", () => {
  const scenes = buildSceneWithSilence();
  const scene = scenes[0];
  // 無音word(100-700)の内部ms=300で分割 → 無音チップは300msで前後へ割れる
  // (旧仕様の中点分配では分割位置が無音チップの端へずれていた)
  const split = splitSceneAtMs(scenes, scene.id, 300);
  assert.equal(split.length, 2);
  assert.deepEqual(
    split[0].words.map((word) => word.id),
    ["w1", "sil_w1L"],
  );
  assert.equal(split[0].words[1].endMs, 300);
  assert.deepEqual(
    split[1].words.map((word) => word.id),
    ["sil_w1R", "w2"],
  );
  assert.equal(split[1].words[0].startMs, 300);
  // 分割してもテロップに [...] は混入しない
  assert.equal(split[0].telopText.includes(SILENCE_GROUP_LABEL), false);
  assert.equal(split[1].telopText.includes(SILENCE_GROUP_LABEL), false);
});
