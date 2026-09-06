import test from "node:test";
import assert from "node:assert/strict";
import {
  cutSceneRangeMs,
  isRangeDragActivated,
  rangeSelectionFromPx,
  snapRangeCutBounds,
  MIN_RANGE_CUT_MS,
  RANGE_CUT_ACTIVATE_PX,
} from "../src/lib/rangeCut.ts";
import { deriveKeepSegments, isSceneFullyDeleted, type Scene, type SceneWord } from "../src/lib/scenes.ts";

function word(id: string, text: string, startMs: number, endMs: number, deleted = false): SceneWord {
  return { id, text, startMs, endMs, deleted };
}

function scene(id: string, sourceStartMs: number, sourceEndMs: number, words: SceneWord[]): Scene {
  return {
    id,
    sourceStartMs,
    sourceEndMs,
    words,
    telopText: words.filter((w) => !w.deleted).map((w) => w.text).join(""),
    telopEdited: false,
    cutMarks: [],
  };
}

/** 標準の1シーン(0〜2000ms、500ms刻みの4単語)。 */
function fourWordScene(): Scene {
  return scene("s1", 0, 2000, [
    word("w1", "あ", 0, 500),
    word("w2", "い", 500, 1000),
    word("w3", "う", 1000, 1500),
    word("w4", "え", 1500, 2000),
  ]);
}

// --- cutSceneRangeMs: 通常ケース(分割+両端トリム) ---

test("cutSceneRangeMs: 途中区間のカットで分割され、両側が範囲端へ独立トリムされる", () => {
  const result = cutSceneRangeMs([fourWordScene()], "s1", 500, 1500);
  assert.equal(result.mode, "split");
  assert.equal(result.appliedStartMs, 500);
  assert.equal(result.appliedEndMs, 1500);
  assert.equal(result.scenes.length, 2);

  const [first, second] = result.scenes;
  assert.equal(first.id, "s1L");
  assert.equal(first.sourceStartMs, 0);
  assert.equal(first.sourceEndMs, 500, "前半のendが範囲始端になる");
  assert.equal(second.id, "s1R");
  assert.equal(second.sourceStartMs, 1500, "後半のstartが範囲終端になる");
  assert.equal(second.sourceEndMs, 2000);

  const w2 = first.words.find((w) => w.id === "w2")!;
  assert.equal(w2.deleted, true, "範囲内に落ちた単語はdeleted化される");
  assert.equal(w2.autoTrimmed, true, "トリムアウト扱い(範囲に戻れば復活できる)");
  const w3 = second.words.find((w) => w.id === "w3")!;
  assert.equal(w3.deleted, true);
  assert.equal(w3.autoTrimmed, true);
  assert.equal(first.telopText, "あ", "未編集telopTextは自動再生成される");
  assert.equal(second.telopText, "え");

  assert.deepEqual(deriveKeepSegments(result.scenes), [
    { startMs: 0, endMs: 500 },
    { startMs: 1500, endMs: 2000 },
  ]);
});

test("cutSceneRangeMs: 時間的に連続する隣接シーンがあっても連動ロールしない(隣接は同一参照のまま)", () => {
  const neighbor = scene("s2", 2000, 3000, [word("w5", "お", 2000, 3000)]);
  const scenes = [fourWordScene(), neighbor];
  const result = cutSceneRangeMs(scenes, "s1", 500, 1500);
  assert.equal(result.scenes.length, 3);
  assert.equal(result.scenes[1].sourceEndMs, 2000, "後半シーンの外側境界は動かない");
  assert.equal(result.scenes[2], neighbor, "隣接シーンは一切変更されない(連動なし)");
});

test("cutSceneRangeMs: 範囲の始端/終端をまたぐ単語は残る(全体が範囲内の単語だけdeleted化)", () => {
  // 700〜1300をカット: い(500-1000)とう(1000-1500)は境界をまたぐため、
  // 中点で振り分けられた側の新しいシーン範囲と部分的に重なり残留する(エッジトリムと同じ規則)。
  const result = cutSceneRangeMs([fourWordScene()], "s1", 700, 1300);
  assert.equal(result.mode, "split");
  const [first, second] = result.scenes;
  assert.equal(first.words.find((w) => w.id === "w2")!.deleted, false);
  assert.equal(second.words.find((w) => w.id === "w3")!.deleted, false);
});

test("cutSceneRangeMs: keepSingleSceneでは中央範囲を分割せず範囲内単語だけdeleted化する", () => {
  const result = cutSceneRangeMs([fourWordScene()], "s1", 500, 1500, { keepSingleScene: true });
  assert.equal(result.mode, "deleteWords");
  assert.equal(result.scenes.length, 1);
  assert.equal(result.scenes[0].sourceStartMs, 0, "元のsource開始位置を維持する");
  assert.equal(result.scenes[0].sourceEndMs, 2000, "元のsource終了位置を維持する");
  assert.equal(result.scenes[0].words.find((w) => w.id === "w1")!.deleted, false);
  assert.equal(result.scenes[0].words.find((w) => w.id === "w2")!.deleted, true);
  assert.equal(result.scenes[0].words.find((w) => w.id === "w2")!.autoTrimmed, false);
  assert.equal(result.scenes[0].words.find((w) => w.id === "w3")!.deleted, true);
  assert.equal(result.scenes[0].words.find((w) => w.id === "w4")!.deleted, false);
  assert.equal(result.scenes[0].telopText, "あえ");
  assert.deepEqual(deriveKeepSegments(result.scenes), [
    { startMs: 0, endMs: 500 },
    { startMs: 1500, endMs: 2000 },
  ]);
});

test("cutSceneRangeMs: keepSingleSceneでも先頭に接する範囲はstartトリムする", () => {
  const result = cutSceneRangeMs([fourWordScene()], "s1", 0, 600, { keepSingleScene: true });
  assert.equal(result.mode, "trimStart");
  assert.equal(result.scenes.length, 1);
  assert.equal(result.scenes[0].sourceStartMs, 600);
  assert.equal(result.scenes[0].sourceEndMs, 2000);
});

// --- cutSceneRangeMs: 縮退ケース ---

test("cutSceneRangeMs: 範囲がシーン先頭に接する場合はstartエッジトリム相当に縮退する", () => {
  const result = cutSceneRangeMs([fourWordScene()], "s1", 0, 600);
  assert.equal(result.mode, "trimStart");
  assert.equal(result.scenes.length, 1);
  assert.equal(result.scenes[0].sourceStartMs, 600);
  assert.equal(result.scenes[0].sourceEndMs, 2000);
  const w1 = result.scenes[0].words.find((w) => w.id === "w1")!;
  assert.equal(w1.deleted, true);
  assert.equal(w1.autoTrimmed, true);
  assert.equal(result.appliedStartMs, 0, "実際のカット範囲はシーン先頭から");
  assert.equal(result.appliedEndMs, 600);
});

test("cutSceneRangeMs: 範囲がシーン末尾に接する場合はendエッジトリム相当に縮退する", () => {
  const result = cutSceneRangeMs([fourWordScene()], "s1", 1400, 2000);
  assert.equal(result.mode, "trimEnd");
  assert.equal(result.scenes.length, 1);
  assert.equal(result.scenes[0].sourceEndMs, 1400);
  const w4 = result.scenes[0].words.find((w) => w.id === "w4")!;
  assert.equal(w4.deleted, true);
  assert.equal(w4.autoTrimmed, true);
  assert.equal(result.appliedEndMs, 2000, "実際のカット範囲はシーン末尾まで");
});

test("cutSceneRangeMs: 先頭側に単語が残っても最小シーン長(200ms)未満なら先頭側ごとカットされる(縮退)", () => {
  const scenes = [
    scene("s1", 0, 2000, [word("w1", "あ", 0, 150), word("w2", "い", 150, 1000), word("w3", "う", 1000, 2000)]),
  ];
  // 先頭側に単語あ(中点75ms)は残るが、先頭側の長さ160msが最小長200ms未満のため縮退する。
  const result = cutSceneRangeMs(scenes, "s1", 160, 1000);
  assert.equal(result.mode, "trimStart");
  assert.equal(result.scenes[0].sourceStartMs, 1000, "先頭0〜160msの断片も残さない");
});

test("cutSceneRangeMs: 末尾側に単語が残っても最小シーン長未満なら末尾側ごとカットされる(縮退)", () => {
  const scenes = [
    scene("s1", 0, 2000, [word("w1", "あ", 0, 1000), word("w2", "い", 1000, 1850), word("w3", "う", 1850, 2000)]),
  ];
  // 末尾側に単語う(中点1925ms)は残るが、末尾側の長さ100msが最小長200ms未満のため縮退する。
  const result = cutSceneRangeMs(scenes, "s1", 1000, 1900);
  assert.equal(result.mode, "trimEnd");
  assert.equal(result.scenes[0].sourceEndMs, 1000);
});

test("cutSceneRangeMs: 先頭側に中点を持つ単語が無ければ分割せずstartトリムに縮退する", () => {
  const scenes = [
    scene("s1", 0, 2000, [word("w1", "い", 1000, 1500), word("w2", "え", 1500, 2000)]),
  ];
  const result = cutSceneRangeMs(scenes, "s1", 400, 1000);
  assert.equal(result.mode, "trimStart");
  assert.equal(result.scenes[0].sourceStartMs, 1000);
});

test("cutSceneRangeMs: 範囲がシーン全域を覆うと全単語deleted化(スタブ行+復元と同じ状態)", () => {
  const result = cutSceneRangeMs([fourWordScene()], "s1", 0, 2000);
  assert.equal(result.mode, "deleteAll");
  assert.equal(result.scenes.length, 1);
  assert.equal(isSceneFullyDeleted(result.scenes[0]), true);
  assert.equal(result.scenes[0].sourceStartMs, 0, "シーン範囲自体は変えない(復元でそのまま戻る)");
  assert.equal(result.scenes[0].sourceEndMs, 2000);
  for (const w of result.scenes[0].words) {
    assert.equal(w.deleted, true);
    assert.equal(w.autoTrimmed, false, "手動のシーン丸ごと削除と同じ扱い(トリムで自動復活しない)");
  }
  assert.equal(result.scenes[0].telopText, "");
  assert.deepEqual(deriveKeepSegments(result.scenes), []);
});

test("cutSceneRangeMs: 両側とも最小長を確保できない短いシーンは全削除に縮退する", () => {
  const scenes = [scene("s1", 0, 400, [word("w1", "あ", 0, 200), word("w2", "い", 200, 400)])];
  const result = cutSceneRangeMs(scenes, "s1", 100, 300);
  assert.equal(result.mode, "deleteAll");
  assert.equal(isSceneFullyDeleted(result.scenes[0]), true);
});

test("cutSceneRangeMs: 既に全単語deleted済みのシーンへの全域カットは変更なし", () => {
  const deletedScene = scene("s1", 0, 2000, [word("w1", "あ", 0, 2000, true)]);
  const scenes = [deletedScene];
  const result = cutSceneRangeMs(scenes, "s1", 0, 2000);
  assert.equal(result.mode, "none");
  assert.equal(result.scenes, scenes, "元の配列をそのまま返す(履歴が積まれない)");
});

// --- cutSceneRangeMs: スナップ・ガード ---

test("cutSceneRangeMs: 両端がエッジトリムと同一規則でスナップされる(チップ境界吸着→20msグリッド)", () => {
  const result = cutSceneRangeMs([fourWordScene()], "s1", 493, 1211, { chipSnapToleranceMs: 15 });
  assert.equal(result.appliedStartMs, 500, "493msは15ms以内のチップ境界500msに吸着する");
  assert.equal(result.appliedEndMs, 1220, "1211msは近傍にチップ境界が無いので20msグリッドへ");
  assert.equal(result.mode, "split");
  assert.equal(result.scenes[0].sourceEndMs, 500);
  assert.equal(result.scenes[1].sourceStartMs, 1220);
});

test("cutSceneRangeMs: スナップ後の範囲が80ms未満なら何もしない(元の配列をそのまま返す)", () => {
  const scenes = [fourWordScene()];
  const result = cutSceneRangeMs(scenes, "s1", 1000, 1049);
  assert.equal(result.mode, "none");
  assert.equal(result.scenes, scenes);
  assert.equal(result.appliedStartMs, 1000);
  assert.equal(result.appliedEndMs, 1040, "1049msはグリッドスナップで1040msになり幅40ms<80ms");
  assert.equal(MIN_RANGE_CUT_MS, 80);
});

test("cutSceneRangeMs: 存在しないsceneIdは変更なし", () => {
  const scenes = [fourWordScene()];
  const result = cutSceneRangeMs(scenes, "missing", 500, 1500);
  assert.equal(result.mode, "none");
  assert.equal(result.scenes, scenes);
});

test("cutSceneRangeMs: 逆順の範囲指定(end<start)でも正規化して同じ結果になる", () => {
  const forward = cutSceneRangeMs([fourWordScene()], "s1", 500, 1500);
  const backward = cutSceneRangeMs([fourWordScene()], "s1", 1500, 500);
  assert.deepEqual(backward.scenes, forward.scenes);
  assert.equal(backward.appliedStartMs, 500);
  assert.equal(backward.appliedEndMs, 1500);
});

// --- snapRangeCutBounds ---

test("snapRangeCutBounds: シーン範囲外の指定はシーン内へクランプされる", () => {
  const bounds = snapRangeCutBounds(scene("s1", 1000, 3000, [word("w1", "あ", 1000, 3000)]), -500, 9999);
  assert.deepEqual(bounds, { startMs: 1000, endMs: 3000 });
});

test("snapRangeCutBounds: sourceDurationMsが終端の上限になる", () => {
  const bounds = snapRangeCutBounds(scene("s1", 0, 3000, [word("w1", "あ", 0, 3000)]), 100, 9999, {
    sourceDurationMs: 2500,
  });
  assert.deepEqual(bounds, { startMs: 100, endMs: 2500 });
});

// --- ドラッグ判定・px→ms換算の純関数 ---

test("isRangeDragActivated: 横8px超で発動する(左右どちら向きでも)", () => {
  assert.equal(RANGE_CUT_ACTIVATE_PX, 8);
  assert.equal(isRangeDragActivated(8), false);
  assert.equal(isRangeDragActivated(9), true);
  assert.equal(isRangeDragActivated(-8), false);
  assert.equal(isRangeDragActivated(-9), true);
  assert.equal(isRangeDragActivated(3, 2), true, "しきい値は上書きできる");
});

test("rangeSelectionFromPx: px座標ペアを正規化(順序整列+クランプ)してmsへ変換する", () => {
  const target = scene("s1", 1000, 3000, []);
  const range = rangeSelectionFromPx(target, 250, 50, 200);
  assert.equal(range.startPx, 50, "順序が入れ替わっていても整列される");
  assert.equal(range.endPx, 200, "波形の右端を超えた位置はクランプされる");
  assert.equal(range.startMs, 1500);
  assert.equal(range.endMs, 3000);
});

test("rangeSelectionFromPx: 左端より外はシーン先頭msにクランプされる", () => {
  const target = scene("s1", 1000, 3000, []);
  const range = rangeSelectionFromPx(target, -30, 100, 200);
  assert.equal(range.startPx, 0);
  assert.equal(range.startMs, 1000);
  assert.equal(range.endMs, 2000);
});
