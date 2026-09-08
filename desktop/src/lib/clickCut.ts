import { computeSceneKeptSubRanges, type Scene } from "./scenes.ts";
import { cutSceneRangeMs, MIN_RANGE_CUT_MS, snapRangeCutBounds, type RangeCutMode, type RangeCutOptions } from "./rangeCut.ts";

export type ClickCutPreview = {
  /** A first incision is a local marker; it never changes scene data or Undo. */
  kind: "anchor" | "cut" | "none";
  pointMs: number;
  anchorMs: number | null;
  intent: "interval" | "start" | "end";
  rawStartMs: number;
  rawEndMs: number;
  appliedStartMs: number;
  appliedEndMs: number;
  mode: RangeCutMode;
  removedDurationMs: number;
  unavailableReason?: "removed" | "tooShort";
};

/** Find an edge in the sorted retained intervals without scanning every earlier cut. */
function firstRangeWithEdgeAfter(
  ranges: Array<{ startMs: number; endMs: number }>,
  timeMs: number,
  edge: "startMs" | "endMs",
  inclusive: boolean,
): number {
  let lower = 0;
  let upper = ranges.length;
  while (lower < upper) {
    const middle = (lower + upper) >>> 1;
    const value = ranges[middle][edge];
    if (value < timeMs || (!inclusive && value === timeMs)) lower = middle + 1;
    else upper = middle;
  }
  return lower;
}

/**
 * Two incisions remove the interval in either direction. A first incision can remove
 * a leading/trailing margin only when it lies outside all active spoken words.
 * Do not infer an edge from proximity alone: that would silently remove speech.
 * Preview and commit share cutSceneRangeMs, including its 80 ms guard and snapping.
 */
export function previewClickCut(
  scene: Scene,
  rawPointMs: number,
  rawAnchorMs: number | null = null,
  options: RangeCutOptions = {},
): ClickCutPreview {
  const pointMs = snapRangeCutBounds(scene, rawPointMs, rawPointMs, options).startMs;
  const anchorMs = rawAnchorMs == null ? null : snapRangeCutBounds(scene, rawAnchorMs, rawAnchorMs, options).startMs;
  const base: ClickCutPreview = {
    kind: "anchor", pointMs, anchorMs, intent: "interval",
    rawStartMs: rawPointMs, rawEndMs: rawPointMs,
    appliedStartMs: pointMs, appliedEndMs: pointMs, mode: "none", removedDurationMs: 0,
  };
  if (!Number.isFinite(rawPointMs) || (rawAnchorMs != null && !Number.isFinite(rawAnchorMs))) {
    return { ...base, kind: "none" };
  }
  const kept = computeSceneKeptSubRanges(scene);
  if (!kept.some((range) => pointMs >= range.startMs && pointMs <= range.endMs)) {
    return { ...base, kind: "none", unavailableReason: "removed" };
  }

  let startMs = rawAnchorMs;
  let endMs = rawPointMs;
  let intent: ClickCutPreview["intent"] = "interval";
  if (startMs == null) {
    let speechStartMs = Infinity;
    let speechEndMs = -Infinity;
    for (const word of scene.words) {
      if (word.deleted || word.silence || word.endMs <= scene.sourceStartMs || word.startMs >= scene.sourceEndMs) continue;
      const first = kept[firstRangeWithEdgeAfter(kept, word.startMs, "endMs", false)];
      if (!first || first.startMs >= word.endMs) continue;
      const last = kept[firstRangeWithEdgeAfter(kept, word.endMs, "startMs", true) - 1];
      speechStartMs = Math.min(speechStartMs, Math.max(word.startMs, first.startMs));
      speechEndMs = Math.max(speechEndMs, Math.min(word.endMs, last.endMs));
    }
    // Without any spoken words, the intended edge is ambiguous. Require two points.
    if (!Number.isFinite(speechStartMs)) return base;
    if (pointMs > scene.sourceStartMs && pointMs <= speechStartMs) {
      startMs = scene.sourceStartMs;
      intent = "start";
    } else if (pointMs < scene.sourceEndMs && pointMs >= speechEndMs) {
      startMs = rawPointMs;
      endMs = scene.sourceEndMs;
      intent = "end";
    } else {
      return base;
    }
  }
  const preview = cutSceneRangeMs([scene], scene.id, startMs, endMs, options);
  const removedDurationMs = kept.reduce((sum, range) => sum + Math.max(0,
    Math.min(range.endMs, preview.appliedEndMs) - Math.max(range.startMs, preview.appliedStartMs)), 0);
  return {
    ...base, kind: preview.mode === "none" || removedDurationMs === 0 ? "none" : "cut", intent,
    rawStartMs: startMs, rawEndMs: endMs,
    appliedStartMs: preview.appliedStartMs, appliedEndMs: preview.appliedEndMs,
    mode: preview.mode, removedDurationMs,
    unavailableReason: preview.appliedEndMs - preview.appliedStartMs < MIN_RANGE_CUT_MS ? "tooShort"
      : removedDurationMs === 0 ? "removed" : preview.mode === "none" ? "tooShort" : undefined,
  };
}
