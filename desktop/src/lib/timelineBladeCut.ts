import { timelineMsToSourceMs, type TimelineCutRange } from "./previewTimeline.ts";
import type { SceneTimelineBlock } from "./timelineLayout.ts";

/** A blade point uses the output clock, including OP offset, prior cuts and speed. */
export function timelineBladePoint(block: SceneTimelineBlock, offsetPx: number, pxPerMs: number,
  ranges: TimelineCutRange[], fps = 30): { timelineMs: number; sourceMs: number } | null {
  if (!Number.isFinite(offsetPx) || !Number.isFinite(pxPerMs) || pxPerMs <= 0) return null;
  const rate = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const rawMs = block.timelineStartMs + offsetPx / pxPerMs;
  const timelineMs = Math.round(Math.round(rawMs * rate / 1000) * 1000 / rate);
  // At an existing block edge there is nothing to divide. Do not seek into an adjacent clip.
  if (timelineMs <= block.timelineStartMs || timelineMs >= block.timelineEndMs) return null;
  const sourceMs = timelineMsToSourceMs(ranges, timelineMs);
  return sourceMs == null ? null : { timelineMs, sourceMs: Math.round(sourceMs) };
}
