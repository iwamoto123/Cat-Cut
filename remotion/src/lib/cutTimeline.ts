type TimelineCut = {
  timeline: { start_ms: number; end_ms: number };
};

export type CutFrameRange<T> = {
  cut: T;
  from: number;
  durationInFrames: number;
};

/**
 * ミリ秒の編集境界を出力フレームへ変換する。
 * 隣接境界は同じ丸め方にし、両端が同じフレームへ丸められた区間は描画しない。
 * 短くても出力フレームに乗る区間は保持する（例: 総尺1001msの最後の1ms）。
 * Math.max(1, duration) で残片を引き伸ばすと次のカットと重なり、
 * 削除した音声・映像まで再生し得るため、元の編集データは変更せず除外する。
 */
export function cutFrameRanges<T extends TimelineCut>(
  cuts: readonly T[],
  totalDurationMs: number,
  fps: number,
): CutFrameRange<T>[] {
  if (!Number.isFinite(totalDurationMs) || totalDurationMs <= 0 || !Number.isFinite(fps) || fps <= 0) {
    return [];
  }

  // Root.calculateMetadata と同じ終端。最終フレームだけ黒くなることを防ぐ。
  const totalFrames = Math.ceil((totalDurationMs / 1000) * fps);
  const ranges: CutFrameRange<T>[] = [];
  for (const cut of cuts) {
    const { start_ms: startMs, end_ms: rawEndMs } = cut.timeline;
    if (!Number.isFinite(startMs) || !Number.isFinite(rawEndMs) || startMs < 0) continue;
    const endMs = Math.min(rawEndMs, totalDurationMs);
    if (endMs <= startMs) continue;

    const from = Math.round((startMs / 1000) * fps);
    const end = endMs === totalDurationMs
      ? totalFrames
      : Math.round((endMs / 1000) * fps);
    if (end <= from) continue;
    ranges.push({ cut, from, durationInFrames: end - from });
  }
  return ranges;
}
