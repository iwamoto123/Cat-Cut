import { normalizeVideoEffects, type VideoEffect } from "./videoEffects.ts";
import { computeSceneKeptSubRanges, type Scene } from "./scenes.ts";
import type { TimelineCutRange } from "./previewTimeline.ts";

/** 保存済みの時間軸を現在のカット・OP・速度へ写し、シーンの未保存指定を優先する。 */
export function resolvePreviewVideoEffects(raw: unknown, original: TimelineCutRange[], edited: TimelineCutRange[], scenes: Scene[]): VideoEffect[] {
  const mapSource = (start: number, end: number) => edited.flatMap((range) => {
    const a = Math.max(start, range.sourceStartMs), b = Math.min(end, range.sourceEndMs);
    const ratio = (range.timelineEndMs - range.timelineStartMs) / (range.sourceEndMs - range.sourceStartMs);
    return b > a ? [{ start_ms: range.timelineStartMs + (a - range.sourceStartMs) * ratio, end_ms: range.timelineStartMs + (b - range.sourceStartMs) * ratio }] : [];
  });
  let effects = normalizeVideoEffects(raw).flatMap((effect) => original.flatMap((range) => {
    const a = Math.max(effect.start_ms, range.timelineStartMs), b = Math.min(effect.end_ms, range.timelineEndMs);
    if (b <= a) return [];
    const ratio = (range.sourceEndMs - range.sourceStartMs) / (range.timelineEndMs - range.timelineStartMs);
    return mapSource(range.sourceStartMs + (a - range.timelineStartMs) * ratio, range.sourceStartMs + (b - range.timelineStartMs) * ratio)
      .map((interval) => ({ ...effect, ...interval }));
  }));
  for (const scene of scenes) {
    const override = scene.videoEffectOverride;
    if (!override) continue;
    for (const kept of computeSceneKeptSubRanges(scene)) {
      for (const interval of mapSource(kept.startMs, kept.endMs)) {
        // 「なし」も既存の効果を除去する。隣のシーンには影響させない。
        effects = effects.flatMap((effect) => {
          if (effect.end_ms <= interval.start_ms || effect.start_ms >= interval.end_ms) return [effect];
          return [
            ...(effect.start_ms < interval.start_ms ? [{ ...effect, end_ms: interval.start_ms }] : []),
            ...(effect.end_ms > interval.end_ms ? [{ ...effect, start_ms: interval.end_ms }] : []),
          ];
        });
        if (override !== "none") effects.push(...normalizeVideoEffects([{
          id: `scene_${scene.id}`, slot_id: scene.id, type: override, ...interval,
          ...(override === "pinch" ? { sfx: "teen" } : {}),
        }]));
      }
    }
  }
  const merged: VideoEffect[] = [];
  for (const effect of effects.sort((a, b) => a.start_ms - b.start_ms)) {
    const previous = merged[merged.length - 1];
    if (previous && previous.id === effect.id && Math.abs(previous.end_ms - effect.start_ms) < 1) previous.end_ms = effect.end_ms;
    else merged.push({ ...effect });
  }
  return merged;
}
