import { moveBgmClip, resizeBgmClip } from "./bgmClips.ts";
import { moveImageClip, resizeImageClip } from "./imageClips.ts";
import type { BgmClipData } from "./bgmAudio.ts";
import type { ImageClipData } from "./imageOverlay.ts";

/** Editable clock notation. Plain numbers mean seconds; a colon adds minutes/hours. */
export function parsePrecisionTime(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d{1,3})?$/.test(text)) return null;
  const parts = text.split(":").map(Number);
  if (parts.slice(1).some((part) => part >= 60)) return null;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Number.isFinite(seconds) && seconds * 1000 <= Number.MAX_SAFE_INTEGER ? Math.round(seconds * 1000) : null;
}

export function formatPrecisionTime(rawMs: number): string {
  const ms = Math.max(0, Math.round(Number.isFinite(rawMs) ? rawMs : 0));
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(totalSeconds % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

/** Repeated steps land on actual frame boundaries rather than accumulating rounded 33ms steps. */
export function stepPrecisionFrame(ms: number, direction: number, fps = 30, frames = 1): number {
  const rate = Number.isFinite(fps) && fps > 0 ? fps : 30;
  return Math.max(0, Math.round((Math.round(ms * rate / 1000) + direction * frames) * 1000 / rate));
}

export type MediaTimeField = "start" | "end" | "duration";

/** Start moves the complete clip. End/duration trim it; numeric edits never magnet-snap. */
export function setPrecisionBgmTime<T extends BgmClipData & { audioDurationMs?: number }>(
  clip: T, field: MediaTimeField, valueMs: number, timelineDurationMs: number,
): T {
  if (!Number.isFinite(valueMs)) return clip;
  const bounds = { timelineDurationMs, audioDurationMs: clip.audioDurationMs, snapMs: 0 };
  const updated = field === "start"
    ? moveBgmClip(clip, valueMs - clip.start_ms, bounds)
    : resizeBgmClip(clip, "end", (field === "duration" ? clip.start_ms + valueMs : valueMs) - clip.end_ms, bounds);
  return { ...clip, ...updated };
}

export function setPrecisionImageTime<T extends ImageClipData>(
  clip: T, field: MediaTimeField, valueMs: number, timelineDurationMs: number,
): T {
  if (!Number.isFinite(valueMs)) return clip;
  const bounds = { timelineDurationMs, snapMs: 0 };
  const updated = field === "start"
    ? moveImageClip(clip, valueMs - clip.start_ms, bounds)
    : resizeImageClip(clip, "end", (field === "duration" ? clip.start_ms + valueMs : valueMs) - clip.end_ms, bounds);
  return { ...clip, ...updated };
}

/** Choose the closest scene/media boundary; cap the magnet range at 150ms when zoomed out. */
export function snapMediaDelta(
  clip: { start_ms: number; end_ms: number },
  deltaMs: number,
  mode: "move" | "resize-start" | "resize-end",
  targets: number[],
  pxPerMs: number,
  enabled: boolean,
): number {
  if (!enabled || pxPerMs <= 0 || !Number.isFinite(deltaMs)) return deltaMs;
  const thresholdMs = Math.min(150, 8 / pxPerMs);
  const edges = mode === "move" ? [clip.start_ms, clip.end_ms] : [mode === "resize-start" ? clip.start_ms : clip.end_ms];
  let correction = Infinity;
  for (const target of targets) {
    if (!Number.isFinite(target)) continue;
    for (const edge of edges) {
      const distance = target - (edge + deltaMs);
      if (Math.abs(distance) <= thresholdMs && Math.abs(distance) < Math.abs(correction)) correction = distance;
    }
  }
  return deltaMs + (Number.isFinite(correction) ? correction : 0);
}
