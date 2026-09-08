/** Waveform IPC results only; no AudioContext or full audio buffers enter the renderer. */
export type BgmWaveformData = {
  binMs: number;
  sampleRate: number;
  durationMs: number;
  peaks: number[];
  cached: boolean;
};

/** Share source data between clips; only a small LRU of released results is retained. */
export function createBgmWaveformLoader(
  fetchWaveform: (input: { runDir: string; file: string }) => Promise<BgmWaveformData>,
  maxReleasedEntries = 16,
) {
  type Entry = { promise: Promise<BgmWaveformData>; users: number; completed: boolean };
  const entries = new Map<string, Entry>();
  const trim = () => {
    const released = [...entries].filter(([, entry]) => entry.completed && entry.users === 0);
    for (const [key] of released.slice(0, Math.max(0, released.length - maxReleasedEntries))) entries.delete(key);
  };
  return (runDir: string, file: string) => {
    const key = JSON.stringify([runDir, file]);
    let entry = entries.get(key);
    if (!entry) {
      const created: Entry = { promise: Promise.resolve(null as unknown as BgmWaveformData), users: 0, completed: false };
      created.promise = Promise.resolve().then(() => fetchWaveform({ runDir, file })).then((data) => {
        created.completed = true;
        trim();
        return data;
      }, (error: unknown) => {
        // Failure is never sticky: the Retry control requests a fresh main-process job.
        if (entries.get(key) === created) entries.delete(key);
        throw error;
      });
      entry = created;
      entries.set(key, entry);
    } else {
      entries.delete(key);
      entries.set(key, entry);
    }
    entry.users += 1;
    const acquired = entry;
    let released = false;
    return {
      promise: acquired.promise,
      release() {
        if (released) return;
        released = true;
        acquired.users -= 1;
        trim();
      },
    };
  };
}

/** Max-pool time bins into at most 512 columns (1024 polygon points). */
export function bgmWaveformHeights(
  waveform: BgmWaveformData,
  durationMs: number,
  widthPx: number,
  volume: number,
  fadeInMs: number,
  fadeOutMs: number,
): number[] {
  if (durationMs <= 0 || widthPx <= 0 || waveform.binMs <= 0 || !waveform.peaks.length) return [];
  const columns = Math.max(1, Math.min(512, Math.ceil(widthPx / 2)));
  const heights: number[] = [];
  const gain = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 0));
  for (let column = 0; column < columns; column += 1) {
    const startMs = (column / columns) * durationMs;
    const endMs = ((column + 1) / columns) * durationMs;
    const first = Math.max(0, Math.floor(startMs / waveform.binMs));
    const last = Math.min(waveform.peaks.length, Math.ceil(endMs / waveform.binMs));
    let peak = 0;
    if (startMs < waveform.durationMs) {
      for (let index = first; index < last; index += 1) peak = Math.max(peak, waveform.peaks[index]);
    }
    const middleMs = (startMs + endMs) / 2;
    const fadeIn = fadeInMs > 0 ? Math.min(1, middleMs / fadeInMs) : 1;
    const fadeOut = fadeOutMs > 0 ? Math.min(1, (durationMs - middleMs) / fadeOutMs) : 1;
    heights.push(Math.min(1, Math.max(0, peak)) * gain * Math.max(0, Math.min(fadeIn, fadeOut)));
  }
  return heights;
}

export function bgmWaveformPath(heights: number[], widthPx: number, heightPx: number): string {
  if (!heights.length || widthPx <= 0 || heightPx <= 0) return "";
  const center = heightPx / 2;
  const amplitude = Math.max(0, center - 1);
  const xAt = (index: number) => heights.length === 1 ? widthPx / 2 : (index / (heights.length - 1)) * widthPx;
  const upper = heights.map((value, index) => `${index ? "L" : "M"}${xAt(index).toFixed(2)},${(center - value * amplitude).toFixed(2)}`);
  const lower = heights.map((value, index) => `L${xAt(index).toFixed(2)},${(center + value * amplitude).toFixed(2)}`).reverse();
  return upper.join(" ") + " " + lower.join(" ") + " Z";
}
