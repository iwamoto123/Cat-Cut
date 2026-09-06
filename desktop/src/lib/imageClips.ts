// フェーズV4(画像挿入トラック): クリップのドラッグ操作(移動・伸縮)と、プレビュー上の
// 位置(x,y)・大きさ(scale)ドラッグの純関数。bgmClips.ts と同じ規則(クランプ・スナップ)を
// 画像クリップ向けに持つ(BGMは音源長制約・フェードがあるため型ごと分けている)。
//
// 実行時(値)importのため、node --experimental-strip-types でテストを直接実行できるよう拡張子を明示する。
import { clampImageScale, type ImageClipData } from "./imageOverlay.ts";

/** クリップの最小尺(ms)。伸縮でゼロ長・負長にしないための下限(BGMと同値)。 */
export const IMAGE_MIN_CLIP_MS = 500;
/** スナップの既定しきい値(ms)。トラック幅換算で約8px相当を呼び出し側が渡す想定の既定値。 */
export const IMAGE_DEFAULT_SNAP_MS = 150;

type ClipBounds = {
  /** タイムライン総尺(ms)。0以下なら右端制約なし(composition未生成時)。 */
  timelineDurationMs: number;
  /** スナップしきい値(ms)。省略時 IMAGE_DEFAULT_SNAP_MS。 */
  snapMs?: number;
};

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/**
 * バー本体ドラッグ=位置移動。長さを保ったまま平行移動し、
 * 先頭0msとタイムライン終端へスナップする(しきい値内なら吸着)。
 */
export function moveImageClip(clip: ImageClipData, deltaMs: number, bounds: ClipBounds): ImageClipData {
  const durationMs = clip.end_ms - clip.start_ms;
  const snapMs = bounds.snapMs ?? IMAGE_DEFAULT_SNAP_MS;
  let startMs = Math.round(clip.start_ms + deltaMs);
  const maxStart = bounds.timelineDurationMs > 0 ? Math.max(0, bounds.timelineDurationMs - durationMs) : Infinity;
  startMs = clamp(startMs, 0, maxStart);
  if (Math.abs(startMs) <= snapMs) startMs = 0;
  else if (bounds.timelineDurationMs > 0 && Math.abs(startMs + durationMs - bounds.timelineDurationMs) <= snapMs) {
    startMs = Math.max(0, bounds.timelineDurationMs - durationMs);
  }
  return { ...clip, start_ms: startMs, end_ms: startMs + durationMs };
}

/**
 * 左右端ドラッグ=開始/終了の伸縮。
 * - 最小尺 IMAGE_MIN_CLIP_MS を下回らない
 * - 開始は0ms・終了はタイムライン総尺へスナップ(総尺クランプ)
 * (静止画なので音源長のような上限はない)
 */
export function resizeImageClip(
  clip: ImageClipData,
  edge: "start" | "end",
  deltaMs: number,
  bounds: ClipBounds,
): ImageClipData {
  const snapMs = bounds.snapMs ?? IMAGE_DEFAULT_SNAP_MS;
  if (edge === "start") {
    let startMs = Math.round(clip.start_ms + deltaMs);
    startMs = clamp(startMs, 0, clip.end_ms - IMAGE_MIN_CLIP_MS);
    if (Math.abs(startMs) <= snapMs) startMs = 0;
    return { ...clip, start_ms: startMs };
  }
  let endMs = Math.round(clip.end_ms + deltaMs);
  const maxEnd = bounds.timelineDurationMs > 0 ? bounds.timelineDurationMs : Infinity;
  endMs = clamp(endMs, clip.start_ms + IMAGE_MIN_CLIP_MS, maxEnd);
  if (bounds.timelineDurationMs > 0 && Math.abs(endMs - bounds.timelineDurationMs) <= snapMs) {
    endMs = bounds.timelineDurationMs;
  }
  return { ...clip, end_ms: endMs };
}

/**
 * プレビュー上の画像ドラッグ=中心位置(x,y)の移動。
 * ドラッグ差分(px)をcontain矩形の実寸で比率化して加算し、中心が画面外に出ないよう0〜1へクランプする。
 */
export function dragImagePosition(
  clip: ImageClipData,
  startX: number,
  startY: number,
  deltaXPx: number,
  deltaYPx: number,
  boxWidthPx: number,
  boxHeightPx: number,
): ImageClipData {
  if (boxWidthPx <= 0 || boxHeightPx <= 0) return clip;
  return {
    ...clip,
    x: clamp(startX + deltaXPx / boxWidthPx, 0, 1),
    y: clamp(startY + deltaYPx / boxHeightPx, 0, 1),
  };
}

/**
 * プレビュー上の四隅ハンドルドラッグ=scale(画面幅比)の変更。
 * 「外向きに引く=拡大」になるよう、ハンドルの左右(horizontalSign: 右側+1/左側-1)・
 * 上下(verticalSign: 下側+1/上側-1)で差分の符号を正規化する。
 * 横だけでなく縦・斜めのドラッグでも効くよう、外向き成分の大きい方を採用する
 * (縦型キャンバスでは横の可動域が狭く、横差分だけだと「効かない」操作感になるため)。
 * 中心固定のため両側に広がる=差分×2を幅に加算する。
 */
export function dragImageScale(
  clip: ImageClipData,
  startScale: number,
  deltaXPx: number,
  deltaYPx: number,
  horizontalSign: 1 | -1,
  verticalSign: 1 | -1,
  boxWidthPx: number,
): ImageClipData {
  if (boxWidthPx <= 0) return clip;
  const outwardX = deltaXPx * horizontalSign;
  const outwardY = deltaYPx * verticalSign;
  const outwardPx = Math.abs(outwardX) >= Math.abs(outwardY) ? outwardX : outwardY;
  return { ...clip, scale: clampImageScale(startScale + (outwardPx * 2) / boxWidthPx) };
}

/** クリップ配列の1件を置き換える(見つからなければそのまま)。 */
export function replaceImageClip(clips: ImageClipData[], next: ImageClipData): ImageClipData[] {
  return clips.map((clip) => (clip.id === next.id ? next : clip));
}

/** クリップ削除。 */
export function removeImageClip(clips: ImageClipData[], clipId: string): ImageClipData[] {
  return clips.filter((clip) => clip.id !== clipId);
}

/** タイムラインms時点で表示すべきクリップ(start以上end未満)。プレビューの表示判定に使う。 */
export function activeImageClipsAtTimelineMs<T extends ImageClipData>(clips: T[], timelineMs: number | null): T[] {
  if (timelineMs === null) return [];
  return clips.filter((clip) => timelineMs >= clip.start_ms && timelineMs < clip.end_ms);
}
