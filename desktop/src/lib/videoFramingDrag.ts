// フェーズW9(映像フレーミング): プレビュー上のドラッグ操作(px)→ framing 値(比率)への換算純関数。
//
// PreviewImageLayer の「pointer capture + ドラッグ開始スナップショット + px→比率換算」パターンを
// フレーミング編集(変形=move/scale、クロップ=辺4+隅4ハンドル)へ一般化したもの。
// 換算はすべて「ドラッグ開始時点のスナップショット(framing+表示px寸法)」基準で行い、
// ライブ更新でレイアウトが再計算されてもドラッグが発散しないようにする。
//
// 実行時(値)importのため、node --experimental-strip-types でテストを直接実行できるよう拡張子を明示する。
import {
  FRAMING_CROP_MAX,
  FRAMING_OFFSET_MAX,
  FRAMING_SCALE_MAX,
  FRAMING_SCALE_MIN,
  type VideoFraming,
} from "./videoFraming.ts";

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** 変形モードの四隅ハンドル。 */
export type TransformCorner = "nw" | "ne" | "sw" | "se";

/** クロップモードのハンドル(辺4+隅4)。 */
export type CropHandle = "left" | "right" | "top" | "bottom" | "nw" | "ne" | "sw" | "se";

/**
 * 四隅ハンドルの外向き符号。ドラッグの「外向き成分」が正=拡大になるようにする
 * (例: se はx正・y正が外向き、nw はx負・y負が外向き)。
 */
export function transformCornerSigns(corner: TransformCorner): { signX: 1 | -1; signY: 1 | -1 } {
  return {
    signX: corner === "ne" || corner === "se" ? 1 : -1,
    signY: corner === "sw" || corner === "se" ? 1 : -1,
  };
}

/** クロップハンドルが動かす辺(隅は2辺同時)。 */
export function cropHandleEdges(handle: CropHandle): {
  left: boolean;
  top: boolean;
  right: boolean;
  bottom: boolean;
} {
  return {
    left: handle === "left" || handle === "nw" || handle === "sw",
    right: handle === "right" || handle === "ne" || handle === "se",
    top: handle === "top" || handle === "nw" || handle === "ne",
    bottom: handle === "bottom" || handle === "sw" || handle === "se",
  };
}

/**
 * 変形モード・本体ドラッグ=中心オフセット(x/y)の移動。
 * boxWidth/boxHeight はプレビュー上のキャンバス矩形(containedBox)のpx寸法。
 * x/y はキャンバス幅/高さ比のため「px移動量 ÷ キャンバス表示px」がそのまま増分になる。
 */
export function dragFramingMove(
  snapshot: VideoFraming,
  deltaXPx: number,
  deltaYPx: number,
  boxWidthPx: number,
  boxHeightPx: number,
): VideoFraming {
  if (!(boxWidthPx > 0) || !(boxHeightPx > 0)) return snapshot;
  return {
    ...snapshot,
    transform: {
      ...snapshot.transform,
      x: clamp(snapshot.transform.x + deltaXPx / boxWidthPx, -FRAMING_OFFSET_MAX, FRAMING_OFFSET_MAX),
      y: clamp(snapshot.transform.y + deltaYPx / boxHeightPx, -FRAMING_OFFSET_MAX, FRAMING_OFFSET_MAX),
    },
  };
}

/**
 * 変形モード・四隅ハンドルドラッグ=中心固定のscale変更。
 * 外向き移動(コーナーの符号方向)の平均pxぶんだけ有効映像の表示幅が両側へ広がる、
 * という素朴な線形換算(newWidth = width + 2×外向きpx → scale比例)。
 * cropRectWidthPx はドラッグ開始時点の有効映像(cropRect)の表示px幅。
 */
export function dragFramingScale(
  snapshot: VideoFraming,
  deltaXPx: number,
  deltaYPx: number,
  corner: TransformCorner,
  cropRectWidthPx: number,
): VideoFraming {
  if (!(cropRectWidthPx > 0)) return snapshot;
  const { signX, signY } = transformCornerSigns(corner);
  const outwardPx = (signX * deltaXPx + signY * deltaYPx) / 2;
  const factor = (cropRectWidthPx + 2 * outwardPx) / cropRectWidthPx;
  if (!(factor > 0)) {
    return {
      ...snapshot,
      transform: { ...snapshot.transform, scale: FRAMING_SCALE_MIN },
    };
  }
  return {
    ...snapshot,
    transform: {
      ...snapshot.transform,
      scale: clamp(snapshot.transform.scale * factor, FRAMING_SCALE_MIN, FRAMING_SCALE_MAX),
    },
  };
}

/**
 * 編集モードの表示変換(FCP風の「全体が見えるまでズームアウト」)。
 * キャンバス矩形(0,0,boxWidth,boxHeight)とフル映像(videoRect)の合併境界ボックスが
 * キャンバス表示領域へ収まる縮小率と平行移動を返す(拡大はしない=scale上限1)。
 * 写像は p' = p * scale + translate(キャンバス座標系px → 編集表示px)。
 */
export function framingEditView(
  boxWidthPx: number,
  boxHeightPx: number,
  videoRect: { left: number; top: number; width: number; height: number },
  marginRatio = 0.04,
): { scale: number; translateX: number; translateY: number } {
  if (!(boxWidthPx > 0) || !(boxHeightPx > 0)) return { scale: 1, translateX: 0, translateY: 0 };
  const bbLeft = Math.min(0, videoRect.left);
  const bbTop = Math.min(0, videoRect.top);
  const bbRight = Math.max(boxWidthPx, videoRect.left + videoRect.width);
  const bbBottom = Math.max(boxHeightPx, videoRect.top + videoRect.height);
  const bbWidth = Math.max(1, bbRight - bbLeft);
  const bbHeight = Math.max(1, bbBottom - bbTop);
  const margin = 1 + marginRatio * 2;
  const scale = Math.min(1, boxWidthPx / (bbWidth * margin), boxHeightPx / (bbHeight * margin));
  const bbCenterX = (bbLeft + bbRight) / 2;
  const bbCenterY = (bbTop + bbBottom) / 2;
  return {
    scale,
    translateX: boxWidthPx / 2 - bbCenterX * scale,
    translateY: boxHeightPx / 2 - bbCenterY * scale,
  };
}

/**
 * クロップモード・ハンドルドラッグ=crop比率の調整。
 * videoRectWidthPx/HeightPx はドラッグ開始時点のフル映像(videoRect)の表示px寸法。
 * crop はソース映像に対する割合のため「px移動量 ÷ フル映像表示px」が増分になる。
 * 左/上ハンドルは内向き(+x/+y)で crop 増、右/下ハンドルは内向き(-x/-y)で crop 増。
 */
export function dragFramingCrop(
  snapshot: VideoFraming,
  deltaXPx: number,
  deltaYPx: number,
  handle: CropHandle,
  videoRectWidthPx: number,
  videoRectHeightPx: number,
): VideoFraming {
  if (!(videoRectWidthPx > 0) || !(videoRectHeightPx > 0)) return snapshot;
  const edges = cropHandleEdges(handle);
  const crop = { ...snapshot.crop };
  if (edges.left) crop.left = clamp(snapshot.crop.left + deltaXPx / videoRectWidthPx, 0, FRAMING_CROP_MAX);
  if (edges.right) crop.right = clamp(snapshot.crop.right - deltaXPx / videoRectWidthPx, 0, FRAMING_CROP_MAX);
  if (edges.top) crop.top = clamp(snapshot.crop.top + deltaYPx / videoRectHeightPx, 0, FRAMING_CROP_MAX);
  if (edges.bottom) crop.bottom = clamp(snapshot.crop.bottom - deltaYPx / videoRectHeightPx, 0, FRAMING_CROP_MAX);
  return { ...snapshot, crop };
}
