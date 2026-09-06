// W16-4: Delete/Backspaceの削除アンカー解決のテスト。
// 「ホバー由来の位置では削除されない」ことを純関数レベルで担保する。
import test from "node:test";
import assert from "node:assert/strict";
import { resolveDeleteAnchor, type ResolveDeleteAnchorInput } from "../src/lib/deleteAnchor.ts";
import { resolveCaretDeleteRightTarget } from "../src/lib/playhead.ts";
import { initializeScenes, resetSceneIdCounterForTests, type SourceWord } from "../src/lib/scenes.ts";

function baseInput(overrides: Partial<ResolveDeleteAnchorInput> = {}): ResolveDeleteAnchorInput {
  return {
    chipSelection: null,
    selectedSceneId: null,
    confirmedCaret: null,
    playbackActive: false,
    playheadMs: 1234,
    anchorMs: null,
    ...overrides,
  };
}

test("resolveDeleteAnchor: 何も明示指定が無ければnull(ホバーだけでは削除されない)", () => {
  assert.equal(resolveDeleteAnchor(baseInput()), null);
});

test("resolveDeleteAnchor: chipSelectionが最優先", () => {
  const anchor = resolveDeleteAnchor(
    baseInput({
      chipSelection: { sceneId: "scene_0001", start: 1, end: 3 },
      selectedSceneId: "scene_0002",
      confirmedCaret: { sceneId: "scene_0003", groupIndex: 2 },
      playbackActive: true,
      anchorMs: 500,
    }),
  );
  assert.deepEqual(anchor, { kind: "selection", sceneId: "scene_0001", start: 1, end: 3 });
});

test("resolveDeleteAnchor: 選択が無ければ確定キャレット、次にシーン選択(W17: キャレット優先)", () => {
  assert.deepEqual(
    resolveDeleteAnchor(
      baseInput({ selectedSceneId: "scene_0002", confirmedCaret: { sceneId: "scene_0003", groupIndex: 2 } }),
    ),
    { kind: "caret", sceneId: "scene_0003", groupIndex: 2 },
  );
  assert.deepEqual(
    resolveDeleteAnchor(baseInput({ selectedSceneId: "scene_0002" })),
    { kind: "scene", sceneId: "scene_0002" },
  );
  assert.deepEqual(
    resolveDeleteAnchor(baseInput({ confirmedCaret: { sceneId: "scene_0003", groupIndex: 2 } })),
    { kind: "caret", sceneId: "scene_0003", groupIndex: 2 },
  );
});

test("resolveDeleteAnchor: クリック確定後(anchorMs)はその位置の再生ヘッド削除になる", () => {
  assert.deepEqual(resolveDeleteAnchor(baseInput({ anchorMs: 800 })), { kind: "playhead", ms: 800 });
});

test("resolveDeleteAnchor: 再生中は現在の再生位置が対象(anchorMsより優先)", () => {
  assert.deepEqual(
    resolveDeleteAnchor(baseInput({ playbackActive: true, playheadMs: 2000, anchorMs: 800 })),
    { kind: "playhead", ms: 2000 },
  );
});

test("resolveDeleteAnchor: ホバースクラブ後(anchorMs=null・停止中)はキャレットが無ければnull", () => {
  // ホバースクラブで再生ヘッドが動くとApp側がanchorMsをnullへ無効化する。
  // その状態でDeleteを押しても何も消えないことを保証する(誤削除の根本対策)。
  assert.equal(resolveDeleteAnchor(baseInput({ playheadMs: 9999, anchorMs: null })), null);
});

function words(...specs: Array<[string, string, number, number]>): SourceWord[] {
  return specs.map(([id, text, startMs, endMs]) => ({ id, text, startMs, endMs }));
}

test.beforeEach(() => {
  resetSceneIdCounterForTests();
});

test("resolveCaretDeleteRightTarget: キャレット右隣のグループを返す(行末はnull)", () => {
  const scenes = initializeScenes({
    words: words(["w1", "あ", 0, 100], ["w2", "い", 100, 200]),
    keepSegments: [{ startMs: 0, endMs: 200 }],
  });
  const scene = scenes[0];
  const target = resolveCaretDeleteRightTarget(scene, 0);
  assert.ok(target);
  assert.equal(target.sceneId, scene.id);
  assert.ok(target.wordIds.includes("w1"));
  assert.equal(resolveCaretDeleteRightTarget(scene, 99), null);
});
