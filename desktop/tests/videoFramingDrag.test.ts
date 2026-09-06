import test from "node:test";
import assert from "node:assert/strict";
import { IDENTITY_VIDEO_FRAMING, type VideoFraming } from "../src/lib/videoFraming.ts";
import {
  cropHandleEdges,
  dragFramingCrop,
  dragFramingMove,
  dragFramingScale,
  framingEditView,
  transformCornerSigns,
} from "../src/lib/videoFramingDrag.ts";

/**
 * フェーズW9(映像フレーミング): プレビュー上のドラッグ操作(px)→ framing 値(比率)への
 * 換算純関数(videoFramingDrag.ts)のテスト。
 */

const near = (actual: number, expected: number, eps = 1e-9) => {
  assert.ok(Math.abs(actual - expected) < eps, `expected ${actual} ≈ ${expected}`);
};

const baseFraming: VideoFraming = {
  transform: { scale: 1, x: 0, y: 0 },
  crop: { left: 0, top: 0, right: 0, bottom: 0 },
};

test("dragFramingMove: px移動量をキャンバス表示px比の増分に換算する", () => {
  const moved = dragFramingMove(baseFraming, 96, -54, 960, 540);
  near(moved.transform.x, 0.1);
  near(moved.transform.y, -0.1);
  // crop・scaleは変えない
  assert.deepEqual(moved.crop, baseFraming.crop);
  assert.equal(moved.transform.scale, 1);
});

test("dragFramingMove: -1〜1へクランプ・寸法0は無変化", () => {
  const snapshot: VideoFraming = { ...baseFraming, transform: { scale: 1, x: 0.95, y: -0.95 } };
  const moved = dragFramingMove(snapshot, 500, -500, 960, 540);
  assert.equal(moved.transform.x, 1);
  assert.equal(moved.transform.y, -1);
  assert.deepEqual(dragFramingMove(baseFraming, 100, 100, 0, 540), baseFraming);
});

test("transformCornerSigns: 外向き成分が正=拡大", () => {
  assert.deepEqual(transformCornerSigns("se"), { signX: 1, signY: 1 });
  assert.deepEqual(transformCornerSigns("nw"), { signX: -1, signY: -1 });
  assert.deepEqual(transformCornerSigns("ne"), { signX: 1, signY: -1 });
  assert.deepEqual(transformCornerSigns("sw"), { signX: -1, signY: 1 });
});

test("dragFramingScale: 外向きドラッグで拡大(中心固定scale)", () => {
  // cropRect表示幅800px、seを外向きに(+40,+40) → 外向き平均40px → 幅800+80 → factor=1.1
  const scaled = dragFramingScale(baseFraming, 40, 40, "se", 800);
  near(scaled.transform.scale, 1.1);
  // nwへ同量の内向き(+40,+40はnwでは内向き) → 縮小
  const shrunk = dragFramingScale(baseFraming, 40, 40, "nw", 800);
  near(shrunk.transform.scale, 0.9);
  // x/y・cropは変えない
  assert.deepEqual(scaled.crop, baseFraming.crop);
  near(scaled.transform.x, 0);
});

test("dragFramingScale: 0.2〜4.0へクランプ・反転はscale下限", () => {
  const max = dragFramingScale(baseFraming, 4000, 4000, "se", 800);
  assert.equal(max.transform.scale, 4.0);
  const min = dragFramingScale(baseFraming, -350, -350, "se", 800);
  assert.equal(min.transform.scale, 0.2);
  // 幅が負になるほど内向き → scale下限へ
  const inverted = dragFramingScale(baseFraming, -900, -900, "se", 800);
  assert.equal(inverted.transform.scale, 0.2);
});

test("W13-7 dragFramingScale: 1.0を跨いで拡大できオフセットは保持される", () => {
  // scale1.0のままオフセットあり → seを外向きに(+200,+200) → 幅800+400 → factor=1.5
  const snapshot: VideoFraming = { ...baseFraming, transform: { scale: 1, x: 0.3, y: -0.2 } };
  const scaled = dragFramingScale(snapshot, 200, 200, "se", 800);
  near(scaled.transform.scale, 1.5);
  near(scaled.transform.x, 0.3);
  near(scaled.transform.y, -0.2);
  // 連続操作: 1.5からさらに拡大 → 2.25(1.0や描画都合の上限で止まらない)
  const again = dragFramingScale(scaled, 200, 200, "se", 800);
  near(again.transform.scale, 2.25);
});

test("W13-7 dragFramingMove: scale>1でも±1クランプまで動かせる(ほぼ全部画面外)", () => {
  const snapshot: VideoFraming = { ...baseFraming, transform: { scale: 1.5, x: 0, y: 0 } };
  const moved = dragFramingMove(snapshot, 960, 540, 960, 540);
  // x=+1(中心がキャンバス右端から幅1つ分外) → scale1.5でも大半が画面外に出る
  assert.equal(moved.transform.x, 1);
  assert.equal(moved.transform.y, 1);
  assert.equal(moved.transform.scale, 1.5);
});

test("cropHandleEdges: 辺は1辺・隅は2辺", () => {
  assert.deepEqual(cropHandleEdges("left"), { left: true, right: false, top: false, bottom: false });
  assert.deepEqual(cropHandleEdges("bottom"), { left: false, right: false, top: false, bottom: true });
  assert.deepEqual(cropHandleEdges("nw"), { left: true, right: false, top: true, bottom: false });
  assert.deepEqual(cropHandleEdges("se"), { left: false, right: true, top: false, bottom: true });
});

test("dragFramingCrop: px移動量をフル映像表示px比の増分に換算する", () => {
  // フル映像表示 1600x900px。左ハンドルを+160px(内向き) → crop.left +0.1
  const left = dragFramingCrop(baseFraming, 160, 0, "left", 1600, 900);
  near(left.crop.left, 0.1);
  // 右ハンドルを-160px(内向き) → crop.right +0.1
  const right = dragFramingCrop(baseFraming, -160, 0, "right", 1600, 900);
  near(right.crop.right, 0.1);
  // 下ハンドルを-90px(内向き) → crop.bottom +0.1
  const bottom = dragFramingCrop(baseFraming, 0, -90, "bottom", 1600, 900);
  near(bottom.crop.bottom, 0.1);
  // 隅(nw)は2辺同時
  const corner = dragFramingCrop(baseFraming, 160, 90, "nw", 1600, 900);
  near(corner.crop.left, 0.1);
  near(corner.crop.top, 0.1);
  near(corner.crop.right, 0);
  // transformは変えない
  assert.deepEqual(corner.transform, baseFraming.transform);
});

test("dragFramingCrop: 0〜0.45へクランプ・寸法0は無変化", () => {
  const clamped = dragFramingCrop(baseFraming, 5000, 0, "left", 1600, 900);
  assert.equal(clamped.crop.left, 0.45);
  const negative = dragFramingCrop(baseFraming, -5000, 0, "left", 1600, 900);
  assert.equal(negative.crop.left, 0);
  assert.deepEqual(dragFramingCrop(baseFraming, 100, 0, "left", 0, 900), baseFraming);
});

test("framingEditView: 全体が収まっていれば等倍・はみ出しはズームアウト", () => {
  // 全体がキャンバス内 → scale=1・移動なし
  const fit = framingEditView(960, 540, { left: 0, top: 0, width: 960, height: 540 }, 0);
  assert.equal(fit.scale, 1);
  near(fit.translateX, 0);
  near(fit.translateY, 0);
  // フル映像が左へ大きくはみ出す → 縮小率<1、合併境界の中央がキャンバス中央へ来る
  const out = framingEditView(960, 540, { left: -960, top: 0, width: 1920, height: 540 }, 0);
  near(out.scale, 0.5);
  // 合併境界: left=-960, right=960 → 中心x=0 → translateX=480
  near(out.translateX, 480);
});

test("W13-7 framingEditView: scale>1のはみ出し構図でも合併境界が収まる(破綻しない)", () => {
  // scale1.5相当: フル映像がキャンバス(960x540)を四方にはみ出す
  const videoRect = { left: -240, top: -135, width: 1440, height: 810 };
  const view = framingEditView(960, 540, videoRect, 0);
  near(view.scale, 960 / 1440);
  // 写像後のフル映像・キャンバスがどちらも表示領域(960x540)内に収まる
  const mapLeft = videoRect.left * view.scale + view.translateX;
  const mapTop = videoRect.top * view.scale + view.translateY;
  assert.ok(mapLeft >= 0 && mapTop >= 0);
  assert.ok(mapLeft + videoRect.width * view.scale <= 960 + 1e-6);
  assert.ok(mapTop + videoRect.height * view.scale <= 540 + 1e-6);
  const canvasLeft = 0 * view.scale + view.translateX;
  const canvasTop = 0 * view.scale + view.translateY;
  assert.ok(canvasLeft >= 0 && canvasTop >= 0);
  assert.ok(canvasLeft + 960 * view.scale <= 960 + 1e-6);
  assert.ok(canvasTop + 540 * view.scale <= 540 + 1e-6);
});

test("framingEditView: 寸法0はidentity表示", () => {
  assert.deepEqual(framingEditView(0, 540, { left: 0, top: 0, width: 1, height: 1 }), {
    scale: 1,
    translateX: 0,
    translateY: 0,
  });
});

test("IDENTITY_VIDEO_FRAMINGを直接変更しない(スナップショット不変性)", () => {
  const before = JSON.stringify(IDENTITY_VIDEO_FRAMING);
  dragFramingMove(IDENTITY_VIDEO_FRAMING, 100, 100, 960, 540);
  dragFramingScale(IDENTITY_VIDEO_FRAMING, 40, 40, "se", 800);
  dragFramingCrop(IDENTITY_VIDEO_FRAMING, 160, 0, "left", 1600, 900);
  assert.equal(JSON.stringify(IDENTITY_VIDEO_FRAMING), before);
});
