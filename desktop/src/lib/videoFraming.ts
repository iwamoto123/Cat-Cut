/**
 * フェーズW9(映像フレーミング): runs/<run>/video_framing.json(全カット共通のグローバル設定)の
 * 正規化と、キャンバス座標系での描画レイアウト計算(純関数)。
 *
 * Remotion(CatCutComposition/OpSequence)とdesktopプレビュー(PreviewPlayer)が同一の
 * この計算で「クロップラッパー(cropRect, overflow hidden) > 映像要素(videoRect, 絶対配置)」を
 * 描画することで、プレビューと書き出しMP4の構図を一致させる。
 * remotion側が正、desktop/src/lib/videoFraming.ts はコピー(sharedRemotionCopies.test.tsで一致担保)。
 *
 * 意味論(仕様書W9-1):
 * - crop: ソース映像の各辺から切り落とす割合(各辺0〜0.45)。クロップ後の領域=「有効映像」。
 * - 基準配置: 有効映像をキャンバスへ cover フィットし中央配置
 *   (crop/transform がすべて既定値なら従来の objectFit: cover と厳密一致する)。
 * - transform.scale: cover フィット寸法への倍率(0.2〜4.0)。
 * - transform.x / y: 有効映像の中心オフセット(キャンバス幅/高さ比、-1〜1)。
 *
 * python shared/video_framing.py の正規化規則もこのファイルと同一に保つこと。
 */

export const FRAMING_CROP_MAX = 0.45;
export const FRAMING_SCALE_MIN = 0.2;
export const FRAMING_SCALE_MAX = 4.0;
export const FRAMING_OFFSET_MAX = 1.0;

/** 既定値との一致判定に使う許容誤差(ドラッグ由来の浮動小数を「実質identity」とみなす)。 */
export const FRAMING_IDENTITY_EPSILON = 1e-6;

export type VideoFramingTransform = { scale: number; x: number; y: number };
export type VideoFramingCrop = { left: number; top: number; right: number; bottom: number };

export type VideoFraming = {
  transform: VideoFramingTransform;
  crop: VideoFramingCrop;
};

export const IDENTITY_VIDEO_FRAMING: VideoFraming = {
  transform: { scale: 1, x: 0, y: 0 },
  crop: { left: 0, top: 0, right: 0, bottom: 0 },
};

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

const clampedNumber = (raw: unknown, low: number, high: number, fallback: number): number => {
  const value = Number(raw);
  return Number.isFinite(value) ? clamp(value, low, high) : fallback;
};

/**
 * video_framing.json / timeline.video_framing(未検証JSON)を正規化する。
 * 不正・欠損フィールドは既定値(identity)で補完し、数値は許容範囲へクランプする。
 */
export function normalizeVideoFraming(raw: unknown): VideoFraming {
  if (!raw || typeof raw !== "object") {
    return {
      transform: { ...IDENTITY_VIDEO_FRAMING.transform },
      crop: { ...IDENTITY_VIDEO_FRAMING.crop },
    };
  }
  const entry = raw as Record<string, unknown>;
  const transform = (entry.transform && typeof entry.transform === "object" ? entry.transform : {}) as Record<
    string,
    unknown
  >;
  const crop = (entry.crop && typeof entry.crop === "object" ? entry.crop : {}) as Record<string, unknown>;
  return {
    transform: {
      scale: clampedNumber(transform.scale, FRAMING_SCALE_MIN, FRAMING_SCALE_MAX, 1),
      x: clampedNumber(transform.x, -FRAMING_OFFSET_MAX, FRAMING_OFFSET_MAX, 0),
      y: clampedNumber(transform.y, -FRAMING_OFFSET_MAX, FRAMING_OFFSET_MAX, 0),
    },
    crop: {
      left: clampedNumber(crop.left, 0, FRAMING_CROP_MAX, 0),
      top: clampedNumber(crop.top, 0, FRAMING_CROP_MAX, 0),
      right: clampedNumber(crop.right, 0, FRAMING_CROP_MAX, 0),
      bottom: clampedNumber(crop.bottom, 0, FRAMING_CROP_MAX, 0),
    },
  };
}

/** 既定値(identity)かどうか。identityなら composition にキーを出さない=完全後方互換。 */
export function isIdentityFraming(framing: VideoFraming): boolean {
  const near = (value: number, target: number) => Math.abs(value - target) < FRAMING_IDENTITY_EPSILON;
  return (
    near(framing.transform.scale, 1) &&
    near(framing.transform.x, 0) &&
    near(framing.transform.y, 0) &&
    near(framing.crop.left, 0) &&
    near(framing.crop.top, 0) &&
    near(framing.crop.right, 0) &&
    near(framing.crop.bottom, 0)
  );
}

export type VideoFramingRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type VideoFramingLayout = {
  /**
   * キャンバス座標系での有効映像(クロップ後の映像)の矩形。
   * この矩形の要素で overflow: hidden クリップする(クロップラッパー)。
   */
  cropRect: VideoFramingRect;
  /**
   * キャンバス座標系でのフル映像要素の矩形(crop分を含めて外側へ逆算)。
   * video / OffthreadVideo をこの矩形に絶対配置(object-fitなし=矩形で寸法指定)すると、
   * cropRect 内に有効映像が正しく見える。
   */
  videoRect: VideoFramingRect;
};

/**
 * フレーミングの描画レイアウトを計算する。
 * 1. ソースをcropで切り落とした「有効映像」をキャンバスへ cover フィット(中央配置)
 * 2. transform.scale を掛け、中心を (x*canvasWidth, y*canvasHeight) だけオフセット → cropRect
 * 3. videoRect = cropRect を crop 比率ぶん外側へ拡張(フル映像の描画矩形)
 *
 * identity framing のとき cropRect=キャンバス全面・videoRect=従来の cover と厳密一致する。
 * 寸法が不明(0以下)の場合はキャンバス全面(従来のwidth/height 100%相当)へフォールバックする。
 */
export function videoFramingLayout({
  canvasWidth,
  canvasHeight,
  sourceWidth,
  sourceHeight,
  framing,
}: {
  canvasWidth: number;
  canvasHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  framing: VideoFraming;
}): VideoFramingLayout {
  const fullCanvas: VideoFramingRect = { left: 0, top: 0, width: canvasWidth || 0, height: canvasHeight || 0 };
  if (!(canvasWidth > 0) || !(canvasHeight > 0) || !(sourceWidth > 0) || !(sourceHeight > 0)) {
    return { cropRect: fullCanvas, videoRect: { ...fullCanvas } };
  }

  const { crop, transform } = framing;
  // 有効映像(クロップ後)のソースpx寸法。cropは各辺0.45までなので常に正になる
  const effectiveWidth = sourceWidth * (1 - crop.left - crop.right);
  const effectiveHeight = sourceHeight * (1 - crop.top - crop.bottom);
  if (!(effectiveWidth > 0) || !(effectiveHeight > 0)) {
    return { cropRect: fullCanvas, videoRect: { ...fullCanvas } };
  }

  // 有効映像をキャンバスへ cover フィット × transform.scale
  const coverScale = Math.max(canvasWidth / effectiveWidth, canvasHeight / effectiveHeight);
  const scale = coverScale * transform.scale;

  // 有効映像の中心(キャンバス中央 + オフセット)
  const centerX = canvasWidth / 2 + transform.x * canvasWidth;
  const centerY = canvasHeight / 2 + transform.y * canvasHeight;

  const cropRect: VideoFramingRect = {
    left: centerX - (effectiveWidth * scale) / 2,
    top: centerY - (effectiveHeight * scale) / 2,
    width: effectiveWidth * scale,
    height: effectiveHeight * scale,
  };

  const videoRect: VideoFramingRect = {
    left: cropRect.left - crop.left * sourceWidth * scale,
    top: cropRect.top - crop.top * sourceHeight * scale,
    width: sourceWidth * scale,
    height: sourceHeight * scale,
  };

  return { cropRect, videoRect };
}
