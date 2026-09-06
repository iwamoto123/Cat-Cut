import test from "node:test";
import assert from "node:assert/strict";
import type { ImageClipData } from "../src/lib/imageOverlay.ts";
import {
  activeImageClipsAtTimelineMs,
  dragImagePosition,
  dragImageScale,
  IMAGE_MIN_CLIP_MS,
  moveImageClip,
  removeImageClip,
  replaceImageClip,
  resizeImageClip,
} from "../src/lib/imageClips.ts";

// フェーズV4(画像挿入トラック): クリップドラッグ(移動・伸縮)とプレビュー上の
// 位置・scaleドラッグの純関数テスト。

const CLIP: ImageClipData = {
  id: "image_1",
  file: "shot.png",
  start_ms: 5000,
  end_ms: 9000,
  x: 0.5,
  y: 0.35,
  scale: 0.55,
  opacity: 1,
};

const BOUNDS = { timelineDurationMs: 60000, snapMs: 150 };

// ---------------------------------------------------------------------------
// moveImageClip
// ---------------------------------------------------------------------------

test("moveImageClip: 長さを保ったまま平行移動する", () => {
  const moved = moveImageClip(CLIP, 2000, BOUNDS);
  assert.equal(moved.start_ms, 7000);
  assert.equal(moved.end_ms, 11000);
});

test("moveImageClip: 左端0ms・右端総尺でクランプされる", () => {
  assert.equal(moveImageClip(CLIP, -99999, BOUNDS).start_ms, 0);
  const right = moveImageClip(CLIP, 99999, BOUNDS);
  assert.equal(right.end_ms, 60000);
  assert.equal(right.start_ms, 56000);
});

test("moveImageClip: 0ms/総尺端へスナップする(しきい値内)", () => {
  assert.equal(moveImageClip(CLIP, -4900, BOUNDS).start_ms, 0); // start=100 → 0へ吸着
  const nearEnd = moveImageClip(CLIP, 50900, BOUNDS); // end=59900 → 60000へ吸着
  assert.equal(nearEnd.end_ms, 60000);
});

test("moveImageClip: 総尺不明(0)は右端制約なし", () => {
  const moved = moveImageClip(CLIP, 999999, { timelineDurationMs: 0 });
  assert.equal(moved.end_ms - moved.start_ms, 4000);
  assert.ok(moved.start_ms > 60000);
});

// ---------------------------------------------------------------------------
// resizeImageClip
// ---------------------------------------------------------------------------

test("resizeImageClip: 開始端の伸縮と最小尺ガード", () => {
  assert.equal(resizeImageClip(CLIP, "start", -2000, BOUNDS).start_ms, 3000);
  // 最小尺500msを下回らない
  assert.equal(resizeImageClip(CLIP, "start", 99999, BOUNDS).start_ms, 9000 - IMAGE_MIN_CLIP_MS);
});

test("resizeImageClip: 終了端の伸縮は総尺へクランプ・スナップする", () => {
  assert.equal(resizeImageClip(CLIP, "end", 3000, BOUNDS).end_ms, 12000);
  assert.equal(resizeImageClip(CLIP, "end", 99999, BOUNDS).end_ms, 60000);
  // 総尺-100msまで伸ばすとスナップで総尺ぴったりへ
  assert.equal(resizeImageClip(CLIP, "end", 50900, BOUNDS).end_ms, 60000);
  // 最小尺ガード
  assert.equal(resizeImageClip(CLIP, "end", -99999, BOUNDS).end_ms, 5000 + IMAGE_MIN_CLIP_MS);
});

test("resizeImageClip: 開始端は0msへスナップする", () => {
  const clip = { ...CLIP, start_ms: 100, end_ms: 4000 };
  assert.equal(resizeImageClip(clip, "start", -50, BOUNDS).start_ms, 0); // 50ms → 0へ吸着
});

// ---------------------------------------------------------------------------
// dragImagePosition / dragImageScale (プレビュー上の直接操作)
// ---------------------------------------------------------------------------

test("dragImagePosition: px差分をcontain矩形比率へ換算して加算する", () => {
  const moved = dragImagePosition(CLIP, 0.5, 0.35, 96, -54, 960, 540);
  assert.ok(Math.abs(moved.x - 0.6) < 1e-9);
  assert.ok(Math.abs(moved.y - 0.25) < 1e-9);
});

test("dragImagePosition: 中心座標は0〜1へクランプされる", () => {
  const moved = dragImagePosition(CLIP, 0.5, 0.35, 99999, -99999, 960, 540);
  assert.equal(moved.x, 1);
  assert.equal(moved.y, 0);
});

test("dragImagePosition: 矩形未計測(0px)は何もしない", () => {
  assert.deepEqual(dragImagePosition(CLIP, 0.5, 0.35, 100, 100, 0, 0), CLIP);
});

test("dragImageScale: 外向きドラッグ=拡大(中心固定で両側に広がる=差分×2)", () => {
  // 右下(se)ハンドルを右へ48px → 幅+96px = 960pxの10% → scale +0.1
  const grown = dragImageScale(CLIP, 0.55, 48, 0, 1, 1, 960);
  assert.ok(Math.abs(grown.scale - 0.65) < 1e-9);
  // 左上(nw)ハンドルを左へ48px(deltaX=-48, hSign=-1)も同じく拡大
  const grownLeft = dragImageScale(CLIP, 0.55, -48, 0, -1, -1, 960);
  assert.ok(Math.abs(grownLeft.scale - 0.65) < 1e-9);
});

test("dragImageScale: 縦・斜めのドラッグでも効く(外向き成分の大きい方を採用)", () => {
  // 右下(se)ハンドルを下へ48px(deltaY=48, vSign=1) → 横48px相当の拡大
  const grownDown = dragImageScale(CLIP, 0.55, 0, 48, 1, 1, 960);
  assert.ok(Math.abs(grownDown.scale - 0.65) < 1e-9);
  // 右上(ne)ハンドルを上へ48px(deltaY=-48, vSign=-1)も拡大
  const grownUp = dragImageScale(CLIP, 0.55, 0, -48, 1, -1, 960);
  assert.ok(Math.abs(grownUp.scale - 0.65) < 1e-9);
  // 斜めドラッグは大きい方の成分が採用される(横24px・縦48px → 縦48pxが勝つ)
  const diagonal = dragImageScale(CLIP, 0.55, 24, 48, 1, 1, 960);
  assert.ok(Math.abs(diagonal.scale - 0.65) < 1e-9);
  // 内向き(縮小)も縦方向で効く
  const shrunk = dragImageScale(CLIP, 0.55, 0, -48, 1, 1, 960);
  assert.ok(Math.abs(shrunk.scale - 0.45) < 1e-9);
});

test("dragImageScale: 0.1〜1.0へクランプされる", () => {
  assert.equal(dragImageScale(CLIP, 0.55, 99999, 0, 1, 1, 960).scale, 1);
  assert.equal(dragImageScale(CLIP, 0.55, -99999, 0, 1, 1, 960).scale, 0.1);
});

// ---------------------------------------------------------------------------
// 配列操作・表示判定
// ---------------------------------------------------------------------------

test("replaceImageClip / removeImageClip", () => {
  const other: ImageClipData = { ...CLIP, id: "image_2", start_ms: 20000, end_ms: 24000 };
  const replaced = replaceImageClip([CLIP, other], { ...CLIP, x: 0.1 });
  assert.equal(replaced[0].x, 0.1);
  assert.equal(replaced[1], other);
  assert.deepEqual(removeImageClip([CLIP, other], "image_2"), [CLIP]);
});

test("activeImageClipsAtTimelineMs: start以上end未満のみ表示・null=非表示", () => {
  const other: ImageClipData = { ...CLIP, id: "image_2", start_ms: 8000, end_ms: 12000 };
  const clips = [CLIP, other];
  assert.deepEqual(activeImageClipsAtTimelineMs(clips, 4999), []);
  assert.deepEqual(activeImageClipsAtTimelineMs(clips, 5000), [CLIP]);
  // 重なり区間は複数表示を許容する
  assert.deepEqual(activeImageClipsAtTimelineMs(clips, 8500), [CLIP, other]);
  assert.deepEqual(activeImageClipsAtTimelineMs(clips, 9000), [other]);
  assert.deepEqual(activeImageClipsAtTimelineMs(clips, null), []);
});
