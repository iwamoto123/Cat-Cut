import test from "node:test";
import assert from "node:assert/strict";
import {
  applyEdgeTrim,
  collectChipSnapCandidatesMs,
  formatEdgeTrimDelta,
  isEdgeLinked,
  snapEdgeTargetMs,
  EDGE_SNAP_MS,
  MIN_SCENE_DURATION_MS,
} from "../src/lib/edgeTrim.ts";
import { deriveKeepSegments, type Scene, type SceneWord } from "../src/lib/scenes.ts";

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

// --- isEdgeLinked ---

test("isEdgeLinked: 前のendと次のstartが一致していれば連動と判定する", () => {
  const scenes = [
    scene("s1", 0, 1000, [word("w1", "あ", 0, 1000)]),
    scene("s2", 1000, 2000, [word("w2", "い", 1000, 2000)]),
  ];
  assert.equal(isEdgeLinked(scenes, 0, "end"), true);
  assert.equal(isEdgeLinked(scenes, 1, "start"), true);
});

test("isEdgeLinked: 間に隙間があれば独立トリム扱い(false)", () => {
  const scenes = [
    scene("s1", 0, 1000, [word("w1", "あ", 0, 1000)]),
    scene("s2", 1200, 2000, [word("w2", "い", 1200, 2000)]),
  ];
  assert.equal(isEdgeLinked(scenes, 0, "end"), false);
  assert.equal(isEdgeLinked(scenes, 1, "start"), false);
});

test("isEdgeLinked: 隣接シーンが無い外側の端はfalse", () => {
  const scenes = [scene("s1", 0, 1000, [word("w1", "あ", 0, 1000)])];
  assert.equal(isEdgeLinked(scenes, 0, "start"), false);
  assert.equal(isEdgeLinked(scenes, 0, "end"), false);
});

// --- snapEdgeTargetMs ---

test("snapEdgeTargetMs: 候補が無ければ20msグリッドにスナップする", () => {
  assert.equal(snapEdgeTargetMs(1234, []), 1240);
  assert.equal(snapEdgeTargetMs(1234, [], { snapMs: 100 }), 1200);
});

test("snapEdgeTargetMs: 許容範囲内にチップ境界があれば最優先で吸着する", () => {
  const candidates = [980, 1500];
  // 1234msから980msまでは254ms離れているのでtolerance=15msでは吸着しない -> グリッドスナップ
  assert.equal(snapEdgeTargetMs(1234, candidates, { chipSnapToleranceMs: 15 }), 1240);
  // 1005msは1000msのグリッド案(スナップ後1000)より、990ms候補のほうが近ければそちらを採用
  assert.equal(snapEdgeTargetMs(990, [985], { chipSnapToleranceMs: 15 }), 985);
});

test("snapEdgeTargetMs: 複数候補があれば最も近いものを選ぶ", () => {
  assert.equal(snapEdgeTargetMs(1000, [990, 1008], { chipSnapToleranceMs: 15 }), 1008);
});

// --- collectChipSnapCandidatesMs ---

test("collectChipSnapCandidatesMs: 連動時は隣接シーンの単語境界も候補に含める", () => {
  const scenes = [
    scene("s1", 0, 1000, [word("w1", "あ", 0, 1000)]),
    scene("s2", 1000, 2000, [word("w2", "い", 1000, 1400), word("w3", "う", 1400, 2000)]),
  ];
  const candidates = collectChipSnapCandidatesMs(scenes, 0, "end");
  assert.ok(candidates.includes(1400));
  assert.ok(candidates.includes(0));
  assert.ok(candidates.includes(1000));
});

test("collectChipSnapCandidatesMs: 独立トリムなら自シーンの単語境界のみ", () => {
  const scenes = [
    scene("s1", 0, 1000, [word("w1", "あ", 0, 1000)]),
    scene("s2", 1200, 2000, [word("w2", "い", 1200, 2000)]),
  ];
  const candidates = collectChipSnapCandidatesMs(scenes, 0, "end");
  assert.deepEqual(candidates, [0, 1000]);
});

// --- applyEdgeTrim: 連動ロール ---

test("applyEdgeTrim: 連動シーンの境界を伸ばすと両シーンが連動して伸縮する(欠落・重複なし)", () => {
  const scenes = [
    scene("s1", 0, 1000, [word("w1", "あ", 0, 1000)]),
    scene("s2", 1000, 2000, [word("w2", "い", 1000, 1500), word("w3", "う", 1500, 2000)]),
  ];
  const result = applyEdgeTrim(scenes, 0, "end", 1240);
  assert.equal(result.linked, true);
  assert.equal(result.neighborIndex, 1);
  assert.equal(result.appliedMs, 1240);
  assert.equal(result.scenes[0].sourceEndMs, 1240);
  assert.equal(result.scenes[1].sourceStartMs, 1240, "共有境界がぴったり一致する(隙間・重複なし)");
  assert.equal(result.scenes[1].sourceEndMs, 2000, "動かしていない側の外側境界は変化しない");
});

test("applyEdgeTrim: 連動時にstart側から動かしても同じ共有境界に揃う", () => {
  const scenes = [
    scene("s1", 0, 1000, [word("w1", "あ", 0, 1000)]),
    scene("s2", 1000, 2000, [word("w2", "い", 1000, 2000)]),
  ];
  const result = applyEdgeTrim(scenes, 1, "start", 860);
  assert.equal(result.linked, true);
  assert.equal(result.neighborIndex, 0);
  assert.equal(result.scenes[0].sourceEndMs, 860);
  assert.equal(result.scenes[1].sourceStartMs, 860);
});

// --- applyEdgeTrim: 独立トリム ---

test("applyEdgeTrim: 隙間がある場合は動かした側だけ伸縮しカット幅が変わる", () => {
  const scenes = [
    scene("s1", 0, 1000, [word("w1", "あ", 0, 1000)]),
    scene("s2", 1200, 2000, [word("w2", "い", 1200, 2000)]),
  ];
  const result = applyEdgeTrim(scenes, 0, "end", 1100);
  assert.equal(result.linked, false);
  assert.equal(result.neighborIndex, null);
  assert.equal(result.scenes[0].sourceEndMs, 1100);
  assert.equal(result.scenes[1].sourceStartMs, 1200, "隣接シーンは変化しない(独立トリム)");
});

test("applyEdgeTrim: 独立トリムでも隣接シーンの開始位置を超えて伸ばせない(重複防止)", () => {
  const scenes = [
    scene("s1", 0, 1000, [word("w1", "あ", 0, 1000)]),
    scene("s2", 1200, 2000, [word("w2", "い", 1200, 2000)]),
  ];
  const result = applyEdgeTrim(scenes, 0, "end", 5000);
  assert.equal(result.appliedMs, 1200);
});

// --- applyEdgeTrim: クランプ(最小長・元動画範囲) ---

test("applyEdgeTrim: 連動時、隣接シーンが最小長を下回らないようクランプする", () => {
  const scenes = [
    scene("s1", 0, 1000, [word("w1", "あ", 0, 1000)]),
    scene("s2", 1000, 1100, [word("w2", "い", 1000, 1100)]),
  ];
  // s2の最小長200msを守るには境界は900msまでしか動かせない
  const result = applyEdgeTrim(scenes, 0, "end", 5000, { minDurationMs: 200 });
  assert.equal(result.appliedMs, 900);
  assert.equal(result.scenes[1].sourceEndMs - result.scenes[1].sourceStartMs, MIN_SCENE_DURATION_MS);
});

test("applyEdgeTrim: 自シーンも最小長を下回らないようクランプする", () => {
  const scenes = [scene("s1", 0, 300, [word("w1", "あ", 0, 300)])];
  const result = applyEdgeTrim(scenes, 0, "end", -5000, { minDurationMs: 200 });
  assert.equal(result.appliedMs, 200);
});

test("applyEdgeTrim: 先頭シーンのstartは0未満に動かせない", () => {
  const scenes = [scene("s1", 500, 1000, [word("w1", "あ", 500, 1000)])];
  const result = applyEdgeTrim(scenes, 0, "start", -5000);
  assert.equal(result.appliedMs, 0);
});

test("applyEdgeTrim: 末尾シーンのendはsourceDurationMsを超えて動かせない", () => {
  const scenes = [scene("s1", 0, 1000, [word("w1", "あ", 0, 1000)])];
  const result = applyEdgeTrim(scenes, 0, "end", 999999, { sourceDurationMs: 5000 });
  assert.equal(result.appliedMs, 5000);
});

// --- applyEdgeTrim: スナップ ---

test("applyEdgeTrim: 20msグリッドへスナップされる", () => {
  const scenes = [
    scene("s1", 0, 1000, [word("w1", "あ", 0, 1000)]),
    scene("s2", 1200, 2000, [word("w2", "い", 1200, 2000)]),
  ];
  const result = applyEdgeTrim(scenes, 0, "end", 1111);
  assert.equal(result.appliedMs, 1120, "1111msは1120msにスナップされる(20ms刻み)");
});

test("applyEdgeTrim: chipSnapToleranceMsを指定すると単語チップ境界に優先して吸着する", () => {
  const scenes = [
    scene("s1", 0, 1000, [word("w1", "あ", 0, 1000)]),
    scene("s2", 1000, 2000, [word("w2", "い", 1000, 1508), word("w3", "う", 1508, 2000)]),
  ];
  const result = applyEdgeTrim(scenes, 0, "end", 1500, { chipSnapToleranceMs: 15 });
  assert.equal(result.appliedMs, 1508, "1500msは近傍15ms以内のチップ境界1508msに吸着する");
});

// --- applyEdgeTrim: トリムアウトの単語処理 ---

test("applyEdgeTrim: トリムでシーン外に出た単語は自動deleted化される", () => {
  const scenes = [
    scene("s1", 0, 1000, [word("w1", "あ", 0, 500), word("w2", "い", 500, 1000)]),
    scene("s2", 1200, 2000, [word("w3", "う", 1200, 2000)]),
  ];
  const result = applyEdgeTrim(scenes, 0, "end", 400);
  const w2 = result.scenes[0].words.find((w) => w.id === "w2")!;
  assert.equal(w2.deleted, true);
  assert.equal(w2.autoTrimmed, true);
  assert.equal(result.scenes[0].telopText, "あ", "telopTextが未編集なら自動再生成される");
});

test("applyEdgeTrim: 縮めて戻すと自動deleted化された単語は復活する", () => {
  const scenes = [
    scene("s1", 0, 1000, [word("w1", "あ", 0, 500), word("w2", "い", 500, 1000)]),
    scene("s2", 1200, 2000, [word("w3", "う", 1200, 2000)]),
  ];
  const shrunk = applyEdgeTrim(scenes, 0, "end", 400).scenes;
  const restored = applyEdgeTrim(shrunk, 0, "end", 1000).scenes;
  const w2 = restored[0].words.find((w) => w.id === "w2")!;
  assert.equal(w2.deleted, false);
  assert.equal(w2.autoTrimmed, false);
  assert.equal(restored[0].telopText, "あい");
});

test("applyEdgeTrim: 手動削除済みの単語はトリムで範囲に戻っても復活しない", () => {
  const manuallyDeleted = word("w2", "い", 500, 1000, true); // autoTrimmedは付いていない=手動削除
  const scenes = [
    scene("s1", 0, 1000, [word("w1", "あ", 0, 500), manuallyDeleted]),
    scene("s2", 1200, 2000, [word("w3", "う", 1200, 2000)]),
  ];
  const shrunk = applyEdgeTrim(scenes, 0, "end", 400).scenes;
  const restored = applyEdgeTrim(shrunk, 0, "end", 1000).scenes;
  const w2 = restored[0].words.find((w) => w.id === "w2")!;
  assert.equal(w2.deleted, true, "手動削除は範囲に戻っても復活しない");
});

test("applyEdgeTrim: 連動している隣接シーンでもトリムアウトの単語が自動deleted化される", () => {
  const scenes = [
    scene("s1", 0, 1000, [word("w1", "あ", 0, 1000)]),
    scene("s2", 1000, 2000, [word("w2", "い", 1000, 1300), word("w3", "う", 1300, 2000)]),
  ];
  // s1のendを1500msへ伸ばす -> s2のstartも1500msになり、w2(1000-1300)がs2の範囲外になる
  const result = applyEdgeTrim(scenes, 0, "end", 1500);
  const w2 = result.scenes[1].words.find((w) => w.id === "w2")!;
  assert.equal(w2.deleted, true);
  assert.equal(w2.autoTrimmed, true);
  assert.equal(result.scenes[1].telopText, "う");
});

// --- 書き出し(keep_segments)への反映 ---

test("applyEdgeTrim: 独立トリムの結果がkeep_segments導出に反映される(カット幅が変わる)", () => {
  const scenes = [
    scene("s1", 0, 1000, [word("w1", "あ", 0, 1000)]),
    scene("s2", 1200, 2000, [word("w2", "い", 1200, 2000)]),
  ];
  const before = deriveKeepSegments(scenes);
  assert.deepEqual(before, [
    { startMs: 0, endMs: 1000 },
    { startMs: 1200, endMs: 2000 },
  ]);
  const result = applyEdgeTrim(scenes, 0, "end", 1100);
  assert.deepEqual(deriveKeepSegments(result.scenes), [
    { startMs: 0, endMs: 1100 },
    { startMs: 1200, endMs: 2000 },
  ]);
});

test("applyEdgeTrim: 連動ロールの結果、keep_segmentsは1本のまま境界だけ動く", () => {
  const scenes = [
    scene("s1", 0, 1000, [word("w1", "あ", 0, 1000)]),
    scene("s2", 1000, 2000, [word("w2", "い", 1000, 2000)]),
  ];
  const result = applyEdgeTrim(scenes, 0, "end", 1240);
  assert.deepEqual(deriveKeepSegments(result.scenes), [{ startMs: 0, endMs: 2000 }]);
});

test("applyEdgeTrim: トリムアウトによるdeleted化がkeep_segmentsの隙間として反映される", () => {
  const scenes = [scene("s1", 0, 1000, [word("w1", "あ", 0, 500), word("w2", "い", 500, 1000)])];
  const result = applyEdgeTrim(scenes, 0, "end", 400);
  assert.deepEqual(deriveKeepSegments(result.scenes), [{ startMs: 0, endMs: 400 }]);
});

test("applyEdgeTrim: 存在しないsceneIndexを指定した場合は元の配列をそのまま返す", () => {
  const scenes = [scene("s1", 0, 1000, [word("w1", "あ", 0, 1000)])];
  const result = applyEdgeTrim(scenes, 5, "end", 500);
  assert.equal(result.scenes, scenes);
});

// --- formatEdgeTrimDelta ---

test("formatEdgeTrimDelta: +0.24s形式でフォーマットする", () => {
  assert.equal(formatEdgeTrimDelta(240), "+0.24s");
  assert.equal(formatEdgeTrimDelta(-240), "-0.24s");
  assert.equal(formatEdgeTrimDelta(0), "±0.00s");
});

test("EDGE_SNAP_MS/MIN_SCENE_DURATION_MSは仕様書通りの既定値", () => {
  assert.equal(EDGE_SNAP_MS, 20);
  assert.equal(MIN_SCENE_DURATION_MS, 200);
});


test("applyEdgeTrim: 同じ境界に吸着/クランプされた操作はUndo履歴を増やさない", () => {
  const words = [{ id: "w", text: "声", startMs: 0, endMs: 1000, deleted: false }];
  const first: Scene = { id: "a", sourceStartMs: 0, sourceEndMs: 1000, words, telopText: "声", telopEdited: false, cutMarks: [] };
  const second: Scene = { ...first, id: "b", sourceStartMs: 1000, sourceEndMs: 2000, words: [{ ...words[0], id: "w2", startMs: 1000, endMs: 2000 }] };
  const linked = [first, second];
  assert.equal(applyEdgeTrim(linked, 0, "end", 1005).scenes, linked);
  assert.equal(applyEdgeTrim(linked, 1, "start", 995).scenes, linked);
  const independent = [first];
  assert.equal(applyEdgeTrim(independent, 0, "start", -100).scenes, independent);
  assert.equal(applyEdgeTrim(independent, 0, "end", 2000, { sourceDurationMs: 1000 }).scenes, independent);
});
