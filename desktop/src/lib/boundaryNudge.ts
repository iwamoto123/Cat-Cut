import type { KeepSegment } from "./keepSegments";

/**
 * Phase C (C-3): 境界ナッジ(ドラッグ・キーボード)の純関数群。
 * - 20msグリッドへのスナップ
 * - 絶対値指定での境界移動(ドラッグ用)
 * - 相対値(デルタ)指定での境界移動(キーボード [ ] 用)
 *
 * どちらも隣接セグメント・全体長を超えないようクランプし、最小長を確保する。
 * 戻り値は新しい配列(元の配列は変更しない)なので、そのまま useKeepSegments の
 * setKeepSegments に渡して EditSnapshot (Undo/Redo) に積める。
 */

export type BoundaryEdge = "start" | "end";

export type BoundaryNudgeOptions = {
  /** スナップ単位(ms)。既定20ms */
  snapMs?: number;
  /** 移動後に確保する最小セグメント長(ms)。既定はsnapMsと同じ */
  minDurationMs?: number;
  /** 全体の尺(ms)。終了境界が最終セグメントの場合の上限に使う */
  maxMs?: number;
};

export function snapMsToGrid(ms: number, snapMs = 20): number {
  if (snapMs <= 0) return Math.round(ms);
  return Math.round(ms / snapMs) * snapMs;
}

/**
 * segments[segmentIndex] の指定境界(edge)を、絶対時刻 targetMs 付近にスナップ・クランプして設定する。
 * ドラッグ操作（ポインタ位置から算出した絶対ms）に使う。
 */
export function setKeepSegmentBoundaryMs(
  segments: KeepSegment[],
  segmentIndex: number,
  edge: BoundaryEdge,
  targetMs: number,
  options: BoundaryNudgeOptions = {},
): KeepSegment[] {
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs);
  const target = sorted[segmentIndex];
  if (!target) return segments;

  const snapMs = options.snapMs ?? 20;
  const minDurationMs = Math.max(snapMs, options.minDurationMs ?? snapMs);
  const maxMs = options.maxMs ?? Infinity;
  const prev = sorted[segmentIndex - 1];
  const next = sorted[segmentIndex + 1];
  const snapped = snapMsToGrid(targetMs, snapMs);

  const updated: KeepSegment = { ...target };
  if (edge === "start") {
    const lowerBound = prev ? prev.endMs : 0;
    const upperBound = target.endMs - minDurationMs;
    updated.startMs = Math.max(lowerBound, Math.min(upperBound, snapped));
  } else {
    const lowerBound = target.startMs + minDurationMs;
    const upperBound = next ? next.startMs : maxMs;
    updated.endMs = Math.min(upperBound, Math.max(lowerBound, snapped));
  }

  const result = [...sorted];
  result[segmentIndex] = updated;
  return result;
}

/**
 * segments[segmentIndex] の指定境界(edge)を、現在値から deltaMs だけ相対移動する。
 * キーボード操作( `[` `]` = ±100ms, Shift+ `[` `]` = ±20ms )に使う。
 */
export function nudgeKeepSegmentBoundary(
  segments: KeepSegment[],
  segmentIndex: number,
  edge: BoundaryEdge,
  deltaMs: number,
  options: BoundaryNudgeOptions = {},
): KeepSegment[] {
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs);
  const target = sorted[segmentIndex];
  if (!target) return segments;
  const currentMs = edge === "start" ? target.startMs : target.endMs;
  return setKeepSegmentBoundaryMs(sorted, segmentIndex, edge, currentMs + deltaMs, options);
}
