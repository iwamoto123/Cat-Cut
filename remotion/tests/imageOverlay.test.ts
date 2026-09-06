import test from "node:test";
import assert from "node:assert/strict";
import {
  clampImageScale,
  IMAGE_DEFAULT_OPACITY,
  IMAGE_DEFAULT_SCALE,
  IMAGE_DEFAULT_X,
  IMAGE_DEFAULT_Y,
  IMAGE_LAYER_Z,
  imageClipZIndex,
  imageOverlayStyle,
  normalizeImageTrack,
  OVERLAY_LAYER_Z,
  TELOP_LAYER_Z,
  type ImageClipData,
} from "../src/lib/imageOverlay.ts";

// フェーズV4(画像挿入トラック): timeline.images 正規化と配置スタイル計算のテスト。

const CLIP: ImageClipData = {
  id: "image_1",
  file: "/tmp/shot.png",
  start_ms: 2000,
  end_ms: 6000,
  x: 0.5,
  y: 0.35,
  scale: 0.55,
  opacity: 1,
};

test("normalizeImageTrack: imagesキーなし・非配列・空配列は空(後方互換)", () => {
  assert.deepEqual(normalizeImageTrack(undefined), []);
  assert.deepEqual(normalizeImageTrack(null), []);
  assert.deepEqual(normalizeImageTrack("garbage"), []);
  assert.deepEqual(normalizeImageTrack([]), []);
});

test("normalizeImageTrack: 不正エントリを除外し有効なものだけ残す", () => {
  const clips = normalizeImageTrack([
    null,
    "garbage",
    { file: "", start_ms: 0, end_ms: 1000 }, // fileなし
    { file: "a.png", start_ms: 1000, end_ms: 1000 }, // 区間ゼロ
    { file: "a.png", start_ms: "x", end_ms: 1000 }, // 数値でない
    { file: "a.png", start_ms: 0, end_ms: 4000, x: 0.2, y: 0.8, scale: 0.4, opacity: 0.7 },
  ]);
  assert.equal(clips.length, 1);
  assert.equal(clips[0].x, 0.2);
  assert.equal(clips[0].y, 0.8);
  assert.equal(clips[0].scale, 0.4);
  assert.equal(clips[0].opacity, 0.7);
});

test("normalizeImageTrack: 欠落フィールドは既定値・範囲外はクランプ", () => {
  const clips = normalizeImageTrack([
    { file: "a.png", start_ms: -100, end_ms: 3000 },
    { file: "b.png", start_ms: 0, end_ms: 3000, x: 9, y: -2, scale: 5, opacity: 12 },
    { file: "c.png", start_ms: 0, end_ms: 3000, scale: 0.01 },
  ]);
  assert.equal(clips[0].start_ms, 0); // 負のstartは0へ
  assert.equal(clips[0].x, IMAGE_DEFAULT_X);
  assert.equal(clips[0].y, IMAGE_DEFAULT_Y);
  assert.equal(clips[0].scale, IMAGE_DEFAULT_SCALE);
  assert.equal(clips[0].opacity, IMAGE_DEFAULT_OPACITY);
  const clamped = clips.find((clip) => clip.file === "b.png")!;
  assert.equal(clamped.x, 1);
  assert.equal(clamped.y, 0);
  assert.equal(clamped.scale, 1);
  assert.equal(clamped.opacity, 1);
  assert.equal(clips.find((clip) => clip.file === "c.png")!.scale, 0.1); // 下限クランプ
});

test("normalizeImageTrack: V6-5 入力順を保ち(ソートしない)id欠落は連番補完", () => {
  // 配列順=前後関係(レーン順)の正本のため、start_msでの並べ替えはしない
  const clips = normalizeImageTrack([
    { file: "late.png", start_ms: 5000, end_ms: 8000 },
    { id: "keep", file: "early.png", start_ms: 0, end_ms: 2000 },
  ]);
  assert.deepEqual(
    clips.map((clip) => clip.id),
    ["image_1", "keep"],
  );
});

test("clampImageScale: 0.1〜1.0へ丸める", () => {
  assert.equal(clampImageScale(0.05), 0.1);
  assert.equal(clampImageScale(0.55), 0.55);
  assert.equal(clampImageScale(1.4), 1);
});

test("imageOverlayStyle: 中心座標+幅を%で返す(解像度非依存)", () => {
  const style = imageOverlayStyle(CLIP);
  assert.equal(style.left, "50%");
  assert.equal(style.top, "35%");
  assert.equal(style.width, "55%"); // 浮動小数誤差(55.00000000000001)は丸められる
  assert.equal(style.height, "auto");
  assert.equal(style.transform, "translate(-50%, -50%)");
  assert.equal(style.opacity, 1);
});

test("imageOverlayStyle: opacityは0〜1へクランプ", () => {
  assert.equal(imageOverlayStyle({ ...CLIP, opacity: 5 }).opacity, 1);
  assert.equal(imageOverlayStyle({ ...CLIP, opacity: -1 }).opacity, 0);
});

test("レイヤーz: 映像(0) < 画像 < テロップ < オーバーレイの順序を保つ", () => {
  assert.ok(IMAGE_LAYER_Z > 0);
  assert.ok(TELOP_LAYER_Z > IMAGE_LAYER_Z);
  assert.ok(OVERLAY_LAYER_Z > TELOP_LAYER_Z);
});

test("imageClipZIndex: V6-5 配列順=前後関係(後ろの要素ほど手前=大きいzIndex)", () => {
  assert.equal(imageClipZIndex(0), IMAGE_LAYER_Z);
  assert.equal(imageClipZIndex(2), IMAGE_LAYER_Z + 2);
  assert.ok(imageClipZIndex(1) > imageClipZIndex(0));
  // 実運用の画像枚数(数百枚)でもテロップ層(TELOP_LAYER_Z)に食い込まない
  assert.ok(imageClipZIndex(500) < TELOP_LAYER_Z);
  // 負のindex(呼び出し側のバグ)でも基準未満へは落ちない
  assert.equal(imageClipZIndex(-1), IMAGE_LAYER_Z);
});
