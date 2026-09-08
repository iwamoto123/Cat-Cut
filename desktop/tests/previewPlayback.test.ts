import test from "node:test";
import assert from "node:assert/strict";
import { resolveKeepPlaybackAction } from "../src/lib/previewPlayback.ts";

test("本編全カット後は再生を止め、削除した素材へシークしない", () => {
  for (const currentMs of [0, 1000, 5000]) {
    assert.deepEqual(resolveKeepPlaybackAction([], currentMs, true, { keepSegmentsReady: true }), { seekMs: null, stop: true });
  }
});

test("初期化待ちの空配列と停止中の編集シークはそのまま保持する", () => {
  assert.deepEqual(resolveKeepPlaybackAction([], 1000, true), { seekMs: null, stop: false });
  assert.deepEqual(resolveKeepPlaybackAction([], 1000, true, { keepSegmentsReady: false }), { seekMs: null, stop: false });
  assert.deepEqual(resolveKeepPlaybackAction([], 1000, false, { keepSegmentsReady: true }), { seekMs: null, stop: false });
});

test("全カットをUndoして残存区間が戻ったら通常のカット再生へ復帰する", () => {
  const restored = [{ startMs: 2000, endMs: 4000 }];
  assert.deepEqual(resolveKeepPlaybackAction(restored, 1000, true, { keepSegmentsReady: true }), { seekMs: 2000, stop: false });
  assert.deepEqual(resolveKeepPlaybackAction(restored, 2500, true, { keepSegmentsReady: true }), { seekMs: null, stop: false });
  assert.deepEqual(resolveKeepPlaybackAction(restored, 4500, true, { keepSegmentsReady: true }), { seekMs: 4000, stop: true });
});
