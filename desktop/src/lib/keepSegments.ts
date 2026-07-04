export type TranscriptWord = {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number | null;
};

export type KeepSegment = {
  startMs: number;
  endMs: number;
};

export type RecomputeOptions = {
  maxGapMs: number;
  segmentPaddingMs: number;
  originalDurationMs: number;
};

export type RemoveRange = {
  startMs: number;
  endMs: number;
  durationMs: number;
  reason: "gap" | "trailing_silence";
};

function clampMs(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function mergeOverlapping(segments: KeepSegment[]) {
  if (segments.length <= 1) return segments;
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs);
  const merged: KeepSegment[] = [sorted[0]];
  for (const segment of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (segment.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, segment.endMs);
      continue;
    }
    merged.push({ ...segment });
  }
  return merged;
}

export function normalizeKeepSegments(segments: KeepSegment[], originalDurationMs: number) {
  const normalized = segments
    .map((segment) => ({
      startMs: clampMs(segment.startMs, 0, Math.max(0, originalDurationMs)),
      endMs: clampMs(segment.endMs, 0, Math.max(0, originalDurationMs)),
    }))
    .filter((segment) => segment.endMs > segment.startMs);
  return mergeOverlapping(normalized);
}

export function isWordInKeepSegments(word: TranscriptWord, keepSegments: KeepSegment[]) {
  return keepSegments.some((segment) => {
    const overlapStart = Math.max(segment.startMs, word.startMs);
    const overlapEnd = Math.min(segment.endMs, word.endMs);
    return overlapEnd > overlapStart;
  });
}

export function recomputeKeepSegmentsFromWords(
  words: TranscriptWord[],
  removedWordIds: Set<string>,
  options: RecomputeOptions,
) {
  const keptWords = words.filter((word) => !removedWordIds.has(word.id));
  if (!keptWords.length) return [] as KeepSegment[];

  const maxGapMs = Math.max(0, Math.round(options.maxGapMs));
  const paddingMs = Math.max(0, Math.round(options.segmentPaddingMs));
  const durationMs = Math.max(0, Math.round(options.originalDurationMs));

  const clusters: TranscriptWord[][] = [];
  let currentCluster: TranscriptWord[] = [keptWords[0]];
  for (const word of keptWords.slice(1)) {
    const prev = currentCluster[currentCluster.length - 1];
    const gap = word.startMs - prev.endMs;
    if (gap > maxGapMs) {
      clusters.push(currentCluster);
      currentCluster = [word];
    } else {
      currentCluster.push(word);
    }
  }
  clusters.push(currentCluster);

  const segments = clusters.map((cluster) => ({
    startMs: clampMs(cluster[0].startMs - paddingMs, 0, durationMs),
    endMs: clampMs(cluster[cluster.length - 1].endMs + paddingMs, 0, durationMs),
  }));
  return normalizeKeepSegments(segments, durationMs);
}

export function buildRemoveRanges(keepSegments: KeepSegment[], originalDurationMs: number): RemoveRange[] {
  const normalized = normalizeKeepSegments(keepSegments, originalDurationMs);
  if (!normalized.length) {
    return originalDurationMs > 0
      ? [{ startMs: 0, endMs: originalDurationMs, durationMs: originalDurationMs, reason: "trailing_silence" }]
      : [];
  }

  const ranges: RemoveRange[] = [];
  let cursor = 0;
  for (const segment of normalized) {
    if (segment.startMs > cursor) {
      ranges.push({
        startMs: cursor,
        endMs: segment.startMs,
        durationMs: segment.startMs - cursor,
        reason: "gap",
      });
    }
    cursor = segment.endMs;
  }
  if (cursor < originalDurationMs) {
    ranges.push({
      startMs: cursor,
      endMs: originalDurationMs,
      durationMs: originalDurationMs - cursor,
      reason: "trailing_silence",
    });
  }
  return ranges;
}

export function findActiveWordIndex(words: TranscriptWord[], currentMs: number) {
  if (!words.length) return -1;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (currentMs >= word.startMs && currentMs < word.endMs) return i;
  }
  return -1;
}
