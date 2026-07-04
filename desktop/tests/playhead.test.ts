import test from "node:test";
import assert from "node:assert/strict";
import {
  cyclePlaybackRate,
  findAdjacentChipBoundaryMs,
  findAdjacentGroupBoundaryMs,
  findAdjacentSceneId,
  findBoundaryWordIndex,
  isCaretAtLineStart,
  isChipCursorAtLineStart,
  isGroupCursorAtLineStart,
  msFromScrubPosition,
  resolveCaretDeleteLeftTarget,
  resolveCaretSplitTarget,
  resolveChipCursor,
  resolveDeleteLeftTarget,
  resolveDeleteRightTarget,
  resolveGroupCursor,
  resolveGroupDeleteLeftTarget,
  resolveGroupDeleteRightTarget,
  resolveGroupSplitTarget,
  resolveMatchingCutMark,
  resolveScissorsChipSplitTarget,
  resolveSplitWordTarget,
  SCENE_PLAYBACK_RATES,
} from "../src/lib/playhead.ts";
import { buildWordGroups } from "../src/lib/wordGroups.ts";
import { addCutMark, initializeScenes, resetSceneIdCounterForTests, type SourceWord } from "../src/lib/scenes.ts";

function words(...specs: Array<[string, string, number, number]>): SourceWord[] {
  return specs.map(([id, text, startMs, endMs]) => ({ id, text, startMs, endMs }));
}

test.beforeEach(() => {
  resetSceneIdCounterForTests();
});

// 2シーン構成: scene0 = w1(0-100)/w2(100-200), scene1 = w3(300-400)/w4(400-500)
function buildTwoSceneFixture() {
  return initializeScenes({
    words: words(["w1", "あ", 0, 100], ["w2", "い", 100, 200], ["w3", "う", 300, 400], ["w4", "え", 400, 500]),
    keepSegments: [
      { startMs: 0, endMs: 200 },
      { startMs: 300, endMs: 500 },
    ],
  });
}

test("findBoundaryWordIndex: 単語の開始msちょうどではその単語が右隣になる", () => {
  const scenes = buildTwoSceneFixture();
  const w = scenes[0].words;
  assert.equal(findBoundaryWordIndex(w, 0), 0);
  assert.equal(findBoundaryWordIndex(w, 100), 1);
  assert.equal(findBoundaryWordIndex(w, 200), 2);
});

test("findBoundaryWordIndex: 単語の途中ではその単語自身が左隣(右隣は次の単語)になる", () => {
  const scenes = buildTwoSceneFixture();
  const w = scenes[0].words;
  assert.equal(findBoundaryWordIndex(w, 50), 1, "w1(0-100)の途中は右隣がw2になる");
});

test("resolveChipCursor: 現在ms位置からシーンindexとチップ境界を求める", () => {
  const scenes = buildTwoSceneFixture();
  assert.deepEqual(resolveChipCursor(scenes, 50), { sceneIndex: 0, wordIndex: 1 });
  assert.deepEqual(resolveChipCursor(scenes, 350), { sceneIndex: 1, wordIndex: 1 });
  assert.equal(resolveChipCursor(scenes, 250), null, "シーン間のカット区間ではnull");
});

test("findAdjacentChipBoundaryMs: 右移動はシーンをまたいで次のチップ開始msへ", () => {
  const scenes = buildTwoSceneFixture();
  assert.equal(findAdjacentChipBoundaryMs(scenes, 0, 1), 100);
  assert.equal(findAdjacentChipBoundaryMs(scenes, 100, 1), 300, "scene0の末尾からscene1の先頭へ移動する");
  assert.equal(findAdjacentChipBoundaryMs(scenes, 400, 1), null, "最後の単語からはこれ以上進めない");
});

test("findAdjacentChipBoundaryMs: 左移動はシーンをまたいで前のチップ開始msへ", () => {
  const scenes = buildTwoSceneFixture();
  assert.equal(findAdjacentChipBoundaryMs(scenes, 300, -1), 100, "scene1の先頭からscene0の末尾チップへ移動する");
  assert.equal(findAdjacentChipBoundaryMs(scenes, 100, -1), 0);
  assert.equal(findAdjacentChipBoundaryMs(scenes, 0, -1), null, "先頭からはこれ以上戻れない");
});

test("resolveDeleteLeftTarget: 行頭(シーン先頭)ではnull(呼び出し側で行結合に切り替える)", () => {
  const scenes = buildTwoSceneFixture();
  assert.equal(resolveDeleteLeftTarget(scenes, 0), null);
  assert.equal(resolveDeleteLeftTarget(scenes, 300), null);
});

test("resolveDeleteLeftTarget: 行の途中では左隣のチップを返す", () => {
  const scenes = buildTwoSceneFixture();
  assert.deepEqual(resolveDeleteLeftTarget(scenes, 100), { sceneId: scenes[0].id, wordId: "w1" });
  assert.deepEqual(
    resolveDeleteLeftTarget(scenes, 150),
    { sceneId: scenes[0].id, wordId: "w2" },
    "再生中のチップ(w2)自身が左隣として扱われる",
  );
});

test("resolveDeleteRightTarget: シーン末尾ではnull、それ以外は右隣のチップを返す", () => {
  const scenes = buildTwoSceneFixture();
  assert.equal(resolveDeleteRightTarget(scenes, 150), null, "scene0最後の単語(w2)の途中では右隣が無い");
  assert.deepEqual(resolveDeleteRightTarget(scenes, 0), { sceneId: scenes[0].id, wordId: "w1" });
  assert.deepEqual(resolveDeleteRightTarget(scenes, 100), { sceneId: scenes[0].id, wordId: "w2" });
});

test("isChipCursorAtLineStart: シーン先頭かどうかを判定する", () => {
  const scenes = buildTwoSceneFixture();
  assert.equal(isChipCursorAtLineStart(scenes, 0), true);
  assert.equal(isChipCursorAtLineStart(scenes, 300), true);
  assert.equal(isChipCursorAtLineStart(scenes, 100), false);
});

test("resolveSplitWordTarget: チップ境界(行の内部)でのみ分割対象を返す", () => {
  const scenes = buildTwoSceneFixture();
  assert.deepEqual(resolveSplitWordTarget(scenes, 100), { sceneId: scenes[0].id, wordId: "w2" });
  assert.equal(resolveSplitWordTarget(scenes, 0), null, "行頭では分割できない");
  assert.equal(resolveSplitWordTarget(scenes, 150), null, "行末(最後の単語の途中)では分割できない(splitSceneAtWordは末尾を扱えない)");
});

test("resolveMatchingCutMark: 許容誤差内の切り込み位置を検出する", () => {
  const scenes = buildTwoSceneFixture();
  const withMark = addCutMark(scenes, scenes[0].id, 60);
  assert.deepEqual(resolveMatchingCutMark(withMark, 60), { sceneId: withMark[0].id, ms: 60 });
  assert.deepEqual(resolveMatchingCutMark(withMark, 75, 20), { sceneId: withMark[0].id, ms: 60 });
  assert.equal(resolveMatchingCutMark(withMark, 90, 20), null);
});

test("findAdjacentSceneId: 表示中シーン一覧の中で前後の行を返す", () => {
  const scenes = buildTwoSceneFixture();
  assert.equal(findAdjacentSceneId(scenes, scenes[0].id, 1), scenes[1].id);
  assert.equal(findAdjacentSceneId(scenes, scenes[1].id, 1), null);
  assert.equal(findAdjacentSceneId(scenes, scenes[1].id, -1), scenes[0].id);
  assert.equal(findAdjacentSceneId(scenes, null, 1), scenes[0].id);
});

test("cyclePlaybackRate: 1.0x→1.5x→2.0xを巡回する", () => {
  assert.equal(cyclePlaybackRate(1, SCENE_PLAYBACK_RATES), 1.5);
  assert.equal(cyclePlaybackRate(1.5, SCENE_PLAYBACK_RATES), 2);
  assert.equal(cyclePlaybackRate(2, SCENE_PLAYBACK_RATES), 1);
  assert.equal(cyclePlaybackRate(1.25, SCENE_PLAYBACK_RATES), 1, "配列に無い値からは先頭に戻る");
});

// --- 改善1(単語グループチップ): グループ境界単位のキーボード操作系のテスト ---
// scene0 = 「相談」(相0-100/談100-200) + 「できる」(で200-300/き300-400/る400-500)
// scene1 = 「相手」(相700-800/手800-900) + 「も」(も900-1000)
function buildTwoSceneGroupFixture() {
  return initializeScenes({
    words: words(
      ["w1", "相", 0, 100],
      ["w2", "談", 100, 200],
      ["w3", "で", 200, 300],
      ["w4", "き", 300, 400],
      ["w5", "る", 400, 500],
      ["w6", "相", 700, 800],
      ["w7", "手", 800, 900],
      ["w8", "も", 900, 1000],
    ),
    keepSegments: [
      { startMs: 0, endMs: 500 },
      { startMs: 700, endMs: 1000 },
    ],
  });
}

test("buildTwoSceneGroupFixture: フィクスチャ自体が想定通りグループ化されること(前提確認)", () => {
  const scenes = buildTwoSceneGroupFixture();
  assert.deepEqual(
    buildWordGroups(scenes[0]).map((g) => g.text),
    ["相談", "できる"],
  );
  assert.deepEqual(
    buildWordGroups(scenes[1]).map((g) => g.text),
    ["相手", "も"],
  );
});

test("resolveGroupCursor: 現在ms位置からシーンindexとグループ境界を求める", () => {
  const scenes = buildTwoSceneGroupFixture();
  assert.deepEqual(resolveGroupCursor(scenes, 50), { sceneIndex: 0, groupIndex: 1 }, "「相談」の途中は右隣が「できる」");
  assert.deepEqual(resolveGroupCursor(scenes, 750), { sceneIndex: 1, groupIndex: 1 }, "「相手」の途中は右隣が「も」");
  assert.equal(resolveGroupCursor(scenes, 550), null, "シーン間のカット区間ではnull");
});

test("findAdjacentGroupBoundaryMs: ←/→はグループ境界単位でシーンをまたいで移動する", () => {
  const scenes = buildTwoSceneGroupFixture();
  assert.equal(findAdjacentGroupBoundaryMs(scenes, 0, 1), 200, "「相談」の先頭から「できる」の先頭へ");
  assert.equal(findAdjacentGroupBoundaryMs(scenes, 200, 1), 700, "scene0最後のグループからscene1先頭グループへ");
  assert.equal(findAdjacentGroupBoundaryMs(scenes, 900, 1), null, "最後のグループからはこれ以上進めない");

  assert.equal(findAdjacentGroupBoundaryMs(scenes, 700, -1), 200, "scene1先頭グループからscene0最後のグループへ");
  assert.equal(findAdjacentGroupBoundaryMs(scenes, 200, -1), 0);
  assert.equal(findAdjacentGroupBoundaryMs(scenes, 0, -1), null, "先頭からはこれ以上戻れない");
});

test("resolveGroupDeleteLeftTarget: 行頭ではnull、それ以外は左隣のグループの全wordIdを返す", () => {
  const scenes = buildTwoSceneGroupFixture();
  assert.equal(resolveGroupDeleteLeftTarget(scenes, 0), null);
  assert.equal(resolveGroupDeleteLeftTarget(scenes, 700), null);

  assert.deepEqual(resolveGroupDeleteLeftTarget(scenes, 300), {
    sceneId: scenes[0].id,
    wordIds: ["w3", "w4", "w5"],
  });
  assert.deepEqual(
    resolveGroupDeleteLeftTarget(scenes, 200),
    { sceneId: scenes[0].id, wordIds: ["w1", "w2"] },
    "ちょうどグループ境界(できるの先頭)では「相談」が左隣になる",
  );
});

test("resolveGroupDeleteRightTarget: シーン末尾ではnull、それ以外は右隣のグループの全wordIdを返す", () => {
  const scenes = buildTwoSceneGroupFixture();
  assert.equal(resolveGroupDeleteRightTarget(scenes, 450), null, "scene0最後のグループの途中では右隣が無い");
  assert.deepEqual(resolveGroupDeleteRightTarget(scenes, 0), { sceneId: scenes[0].id, wordIds: ["w1", "w2"] });
  assert.deepEqual(resolveGroupDeleteRightTarget(scenes, 150), { sceneId: scenes[0].id, wordIds: ["w3", "w4", "w5"] });
});

test("isGroupCursorAtLineStart: シーン先頭(グループ境界の先頭)かどうかを判定する", () => {
  const scenes = buildTwoSceneGroupFixture();
  assert.equal(isGroupCursorAtLineStart(scenes, 0), true);
  assert.equal(isGroupCursorAtLineStart(scenes, 700), true);
  assert.equal(isGroupCursorAtLineStart(scenes, 300), false);
});

test("resolveGroupSplitTarget: グループ境界(行の内部)でのみ分割対象(グループ先頭の文字wordId)を返す", () => {
  const scenes = buildTwoSceneGroupFixture();
  assert.deepEqual(resolveGroupSplitTarget(scenes, 200), { sceneId: scenes[0].id, wordId: "w3" }, "「できる」の先頭文字wordで割る");
  assert.equal(resolveGroupSplitTarget(scenes, 0), null, "行頭では分割できない");
  assert.equal(resolveGroupSplitTarget(scenes, 450), null, "行末(最後のグループの途中)では分割できない");
});

// --- 改善3(チップ間ホバーキャレット): scene + groupIndexから直接削除/分割対象を求める関数群 ---
// resolveGroupDeleteLeftTarget/resolveGroupSplitTargetは「scenes配列 + ms」から対象シーンを
// 逆引きするのに対し、こちらはホバーキャレットの性質上「対象シーンが既知」なのでscene単体を渡す。

test("resolveCaretDeleteLeftTarget: 行頭(groupIndex<=0)はnull、それ以外は左隣グループの全wordIdを返す", () => {
  const scenes = buildTwoSceneGroupFixture();
  assert.equal(resolveCaretDeleteLeftTarget(scenes[0], 0), null, "行頭では削除対象なし");
  assert.deepEqual(resolveCaretDeleteLeftTarget(scenes[0], 1), { sceneId: scenes[0].id, wordIds: ["w1", "w2"] });
  assert.deepEqual(resolveCaretDeleteLeftTarget(scenes[0], 2), { sceneId: scenes[0].id, wordIds: ["w3", "w4", "w5"] });
  assert.equal(resolveCaretDeleteLeftTarget(scenes[0], 99), null, "範囲外のgroupIndexはnull(該当グループなし)");
});

test("resolveCaretSplitTarget: 行の内部境界でのみ分割対象(境界右隣グループの先頭文字wordId)を返す", () => {
  const scenes = buildTwoSceneGroupFixture();
  assert.deepEqual(resolveCaretSplitTarget(scenes[0], 1), { sceneId: scenes[0].id, wordId: "w3" }, "「相談」と「できる」の間");
  assert.equal(resolveCaretSplitTarget(scenes[0], 0), null, "行頭では分割できない");
  assert.equal(resolveCaretSplitTarget(scenes[0], 2), null, "行末(グループ数と同じ)では分割できない");
});

test("isCaretAtLineStart: groupIndexが0以下かどうかだけを見る単純な判定", () => {
  assert.equal(isCaretAtLineStart(0), true);
  assert.equal(isCaretAtLineStart(-1), true);
  assert.equal(isCaretAtLineStart(1), false);
});

// --- 改善5-6(ハサミモード): チップ列上のクリックはグループ境界にスナップして分割する ---

test("resolveScissorsChipSplitTarget: グループ境界(行の内部)にスナップして分割対象を返す", () => {
  const scenes = buildTwoSceneGroupFixture();
  assert.deepEqual(
    resolveScissorsChipSplitTarget(scenes[0], 1),
    { sceneId: scenes[0].id, wordId: "w3" },
    "「相談」と「できる」の間でハサミクリックするとresolveCaretSplitTargetと同じ規則でスナップする",
  );
  assert.equal(resolveScissorsChipSplitTarget(scenes[0], 0), null, "行頭では分割できない");
  assert.equal(resolveScissorsChipSplitTarget(scenes[0], 2), null, "行末(グループ数と同じ)では分割できない");
});

test("msFromScrubPosition: マウスX位置をシーン範囲内のmsに変換しクランプする", () => {
  const scenes = buildTwoSceneFixture();
  assert.equal(msFromScrubPosition(scenes[0], 0, 200), 0);
  assert.equal(msFromScrubPosition(scenes[0], 100, 200), 100);
  assert.equal(msFromScrubPosition(scenes[0], 200, 200), 200);
  assert.equal(msFromScrubPosition(scenes[0], -50, 200), 0, "範囲外は左端にクランプする");
  assert.equal(msFromScrubPosition(scenes[0], 999, 200), 200, "範囲外は右端にクランプする");
});
