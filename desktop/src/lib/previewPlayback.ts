import type { KeepSegment } from "./keepSegments.ts";

export type KeepPlaybackAction = { seekMs: number | null; stop: boolean };

/**
 * カット再生の遷移だけを決める。停止中の編集シークはkeep外やOUT点でも保持する。
 * 末尾100msを先取りして切らず、実際にOUT点を越えた時点で次区間へ進む。
 * 最後のkeepを越えたらそのOUT点で停止し、除去済みの元動画末尾を再生しない。
 * segmentsは開始ms昇順（PreviewPlayerで一度だけソート済み）。
 */
export function resolveKeepPlaybackAction(
  segments: KeepSegment[],
  currentMs: number,
  playing: boolean,
  options: { keepSegmentsReady?: boolean } = {},
): KeepPlaybackAction {
  if (!playing) return { seekMs: null, stop: false };
  // An initialized empty list means all main footage was cut; do not play the source as a fallback.
  if (!segments.length) return { seekMs: null, stop: options.keepSegmentsReady === true };
  if (!Number.isFinite(currentMs)) return { seekMs: null, stop: false };
  if (segments.some((segment) => currentMs >= segment.startMs && currentMs < segment.endMs)) {
    return { seekMs: null, stop: false };
  }
  const next = segments.find((segment) => segment.startMs > currentMs);
  if (next) return { seekMs: next.startMs, stop: false };
  const finalEndMs = segments.reduce((endMs, segment) => Math.max(endMs, segment.endMs), 0);
  return { seekMs: currentMs === finalEndMs ? null : finalEndMs, stop: true };
}
