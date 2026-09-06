import test from "node:test";
import assert from "node:assert/strict";
import {
  FRAMING_CROP_MAX,
  FRAMING_SCALE_MAX,
  FRAMING_SCALE_MIN,
  IDENTITY_VIDEO_FRAMING,
  isIdentityFraming,
  normalizeVideoFraming,
  videoFramingLayout,
} from "../src/lib/videoFraming.ts";

/**
 * フェーズW9(映像フレーミング): timeline.video_framing / video_framing.json の正規化と
 * videoFramingLayout(プレビューと書き出しMP4が共有するcropRect/videoRect計算)のテスト。
 */

const near = (actual: number, expected: number, eps = 1e-9) => {
  assert.ok(Math.abs(actual - expected) < eps, `expected ${actual} ≈ ${expected}`);
};

test("normalizeVideoFraming: 省略・不正はidentity(後方互換)", () => {
  assert.deepEqual(normalizeVideoFraming(undefined), IDENTITY_VIDEO_FRAMING);
  assert.deepEqual(normalizeVideoFraming(null), IDENTITY_VIDEO_FRAMING);
  assert.deepEqual(normalizeVideoFraming("bad"), IDENTITY_VIDEO_FRAMING);
  assert.deepEqual(normalizeVideoFraming({}), IDENTITY_VIDEO_FRAMING);
  assert.deepEqual(normalizeVideoFraming({ transform: "x", crop: 3 }), IDENTITY_VIDEO_FRAMING);
});

test("normalizeVideoFraming: 数値は許容範囲へクランプ、欠損は既定値", () => {
  const framing = normalizeVideoFraming({
    transform: { scale: 99, x: -5, y: "0.25" },
    crop: { left: 0.9, top: -1, right: 0.1 },
  });
  assert.equal(framing.transform.scale, FRAMING_SCALE_MAX);
  assert.equal(framing.transform.x, -1);
  assert.equal(framing.transform.y, 0.25);
  assert.equal(framing.crop.left, FRAMING_CROP_MAX);
  assert.equal(framing.crop.top, 0);
  assert.equal(framing.crop.right, 0.1);
  assert.equal(framing.crop.bottom, 0);
  assert.equal(normalizeVideoFraming({ transform: { scale: 0 } }).transform.scale, FRAMING_SCALE_MIN);
  // NaN・非数は既定値
  assert.equal(normalizeVideoFraming({ transform: { scale: Number.NaN } }).transform.scale, 1);
  assert.equal(normalizeVideoFraming({ crop: { left: "abc" } }).crop.left, 0);
});

test("isIdentityFraming: 既定値と浮動小数の実質identityを判定", () => {
  assert.equal(isIdentityFraming(IDENTITY_VIDEO_FRAMING), true);
  assert.equal(
    isIdentityFraming({
      transform: { scale: 1 + 1e-9, x: 0, y: -1e-9 },
      crop: { left: 0, top: 1e-9, right: 0, bottom: 0 },
    }),
    true,
  );
  assert.equal(
    isIdentityFraming({ transform: { scale: 1.2, x: 0, y: 0 }, crop: { left: 0, top: 0, right: 0, bottom: 0 } }),
    false,
  );
  assert.equal(
    isIdentityFraming({ transform: { scale: 1, x: 0, y: 0 }, crop: { left: 0.1, top: 0, right: 0, bottom: 0 } }),
    false,
  );
});

test("videoFramingLayout: identity=同アスペクトはキャンバス全面(従来cover一致)", () => {
  const layout = videoFramingLayout({
    canvasWidth: 1920,
    canvasHeight: 1080,
    sourceWidth: 1920,
    sourceHeight: 1080,
    framing: IDENTITY_VIDEO_FRAMING,
  });
  assert.deepEqual(layout.cropRect, { left: 0, top: 0, width: 1920, height: 1080 });
  assert.deepEqual(layout.videoRect, { left: 0, top: 0, width: 1920, height: 1080 });
});

test("videoFramingLayout: identity・縦キャンバス×横素材=coverフィット(中央はみ出し)", () => {
  // 1080x1920キャンバスに1920x1080素材: cover は高さフィット(scale=1920/1080)
  const layout = videoFramingLayout({
    canvasWidth: 1080,
    canvasHeight: 1920,
    sourceWidth: 1920,
    sourceHeight: 1080,
    framing: IDENTITY_VIDEO_FRAMING,
  });
  const coverScale = 1920 / 1080;
  near(layout.videoRect.width, 1920 * coverScale);
  near(layout.videoRect.height, 1080 * coverScale);
  // 中央配置(左右対称にはみ出し)
  near(layout.videoRect.left, (1080 - 1920 * coverScale) / 2);
  near(layout.videoRect.top, 0);
  // identityではcropRect=videoRect(切り落としなし)
  assert.deepEqual(layout.cropRect, layout.videoRect);
});

test("videoFramingLayout: cropで有効映像が変わりcoverフィットし直す", () => {
  // 右30%クロップ → 有効映像1344x1080。横キャンバス1920x1080へのcover=幅フィット(1920/1344)
  const layout = videoFramingLayout({
    canvasWidth: 1920,
    canvasHeight: 1080,
    sourceWidth: 1920,
    sourceHeight: 1080,
    framing: { transform: { scale: 1, x: 0, y: 0 }, crop: { left: 0, top: 0, right: 0.3, bottom: 0 } },
  });
  const scale = 1920 / 1344;
  near(layout.cropRect.width, 1920);
  near(layout.cropRect.height, 1080 * scale);
  near(layout.cropRect.left, 0);
  near(layout.cropRect.top, (1080 - 1080 * scale) / 2);
  // videoRect=フル映像(cropRectの左端から crop.left=0 なので同じ左端、幅はフル)
  near(layout.videoRect.left, layout.cropRect.left);
  near(layout.videoRect.width, 1920 * scale);
  near(layout.videoRect.height, 1080 * scale);
});

test("videoFramingLayout: scaleとオフセットは中心基準で掛かる", () => {
  const layout = videoFramingLayout({
    canvasWidth: 1920,
    canvasHeight: 1080,
    sourceWidth: 1920,
    sourceHeight: 1080,
    framing: { transform: { scale: 1.2, x: -0.1, y: 0.05 }, crop: { left: 0, top: 0, right: 0, bottom: 0 } },
  });
  near(layout.cropRect.width, 1920 * 1.2);
  near(layout.cropRect.height, 1080 * 1.2);
  // 中心 = キャンバス中央 + (x*幅, y*高さ)
  const centerX = layout.cropRect.left + layout.cropRect.width / 2;
  const centerY = layout.cropRect.top + layout.cropRect.height / 2;
  near(centerX, 1920 / 2 - 0.1 * 1920);
  near(centerY, 1080 / 2 + 0.05 * 1080);
  assert.deepEqual(layout.videoRect, layout.cropRect);
});

test("videoFramingLayout: crop+scale+offset複合(videoRectはcrop分外側へ拡張)", () => {
  const framing = {
    transform: { scale: 1.2, x: -0.1, y: 0 },
    crop: { left: 0.1, top: 0.05, right: 0.3, bottom: 0 },
  };
  const layout = videoFramingLayout({
    canvasWidth: 1080,
    canvasHeight: 1920,
    sourceWidth: 1920,
    sourceHeight: 1080,
    framing,
  });
  const effectiveWidth = 1920 * (1 - 0.1 - 0.3);
  const effectiveHeight = 1080 * (1 - 0.05);
  const scale = Math.max(1080 / effectiveWidth, 1920 / effectiveHeight) * 1.2;
  near(layout.cropRect.width, effectiveWidth * scale);
  near(layout.cropRect.height, effectiveHeight * scale);
  near(layout.videoRect.width, 1920 * scale);
  near(layout.videoRect.height, 1080 * scale);
  near(layout.videoRect.left, layout.cropRect.left - 0.1 * 1920 * scale);
  near(layout.videoRect.top, layout.cropRect.top - 0.05 * 1080 * scale);
});

test("W13-7 videoFramingLayout: scale>1+オフセットでキャンバス外へはみ出す(クランプしない)", () => {
  const layout = videoFramingLayout({
    canvasWidth: 1920,
    canvasHeight: 1080,
    sourceWidth: 1920,
    sourceHeight: 1080,
    framing: { transform: { scale: 1.5, x: 0.15, y: -0.1 }, crop: { left: 0, top: 0, right: 0, bottom: 0 } },
  });
  // 1.5倍の映像はキャンバスを四方に超える。レイアウトはキャンバス境界でクランプせず、
  // 描画側(コンポジション境界/プレビューのoverflow:hidden)がキャンバス内だけを残す
  assert.ok(layout.cropRect.left < 0);
  assert.ok(layout.cropRect.top < 0);
  assert.ok(layout.cropRect.left + layout.cropRect.width > 1920);
  near(layout.cropRect.width, 1920 * 1.5);
  // 中心はオフセット分ずれる
  near(layout.cropRect.left + layout.cropRect.width / 2, 1920 / 2 + 0.15 * 1920);
  near(layout.cropRect.top + layout.cropRect.height / 2, 1080 / 2 - 0.1 * 1080);
});

test("videoFramingLayout: 寸法不明(0)はキャンバス全面へフォールバック", () => {
  const layout = videoFramingLayout({
    canvasWidth: 1920,
    canvasHeight: 1080,
    sourceWidth: 0,
    sourceHeight: 0,
    framing: IDENTITY_VIDEO_FRAMING,
  });
  assert.deepEqual(layout.cropRect, { left: 0, top: 0, width: 1920, height: 1080 });
  assert.deepEqual(layout.videoRect, { left: 0, top: 0, width: 1920, height: 1080 });
});
