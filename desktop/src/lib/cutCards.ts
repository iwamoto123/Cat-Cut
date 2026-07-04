import type { KeepSegment, TranscriptWord } from "./keepSegments";
// 実行時(値)importのため、node --experimental-strip-types でテストを直接実行できるよう拡張子を明示する。
import { buildBoundaryOverrunSuspicions } from "./suspicionQueue.ts";

/**
 * Phase C (C-2): keep_segment単位の「カットカード」データを組み立てる純関数群。
 */

export type CutCard = {
  index: number;
  startMs: number;
  endMs: number;
  wordIds: string[];
  text: string;
};

/** keep_segmentごとに、その範囲に重なる単語を集めてカード情報を作る。 */
export function buildCutCards(words: TranscriptWord[], keepSegments: KeepSegment[]): CutCard[] {
  const sorted = [...keepSegments].sort((a, b) => a.startMs - b.startMs);
  return sorted.map((segment, index) => {
    const segmentWords = words
      .filter((word) => word.startMs < segment.endMs && word.endMs > segment.startMs)
      .sort((a, b) => a.startMs - b.startMs);
    return {
      index,
      startMs: segment.startMs,
      endMs: segment.endMs,
      wordIds: segmentWords.map((word) => word.id),
      text: segmentWords.map((word) => word.text).join(""),
    };
  });
}

export type BoundaryOverrunHighlight = {
  segmentIndex: number;
  edge: "start" | "end";
  wordId: string;
  rangeStartMs: number;
  rangeEndMs: number;
  overrunMs: number;
};

/**
 * カットカードの波形に赤で強調表示する「80ms超のはみ出し」範囲を計算する。
 * 判定ロジックは疑義キュー(suspicionQueue.ts)の buildBoundaryOverrunSuspicions を共通利用する。
 */
export function computeBoundaryOverrunHighlights(
  words: TranscriptWord[],
  keepSegments: KeepSegment[],
  thresholdMs = 80,
): BoundaryOverrunHighlight[] {
  const sorted = [...keepSegments].sort((a, b) => a.startMs - b.startMs);
  const wordsById = new Map(words.map((word) => [word.id, word]));
  const suspicions = buildBoundaryOverrunSuspicions(words, sorted, { thresholdMs });
  const highlights: BoundaryOverrunHighlight[] = [];
  for (const item of suspicions) {
    const word = wordsById.get(item.wordIds[0]);
    if (!word) continue;
    // id形式: boundary_overrun:${segment.startMs}:${segment.endMs}:${word.id}:start|end
    const parts = item.id.split(":");
    const segmentStartMs = Number(parts[1]);
    const segmentEndMs = Number(parts[2]);
    const edge = parts[4] === "start" ? "start" : "end";
    const segmentIndex = sorted.findIndex(
      (segment) => segment.startMs === segmentStartMs && segment.endMs === segmentEndMs,
    );
    if (segmentIndex === -1) continue;
    const segment = sorted[segmentIndex];
    if (edge === "start") {
      highlights.push({
        segmentIndex,
        edge,
        wordId: word.id,
        rangeStartMs: word.startMs,
        rangeEndMs: segment.startMs,
        overrunMs: segment.startMs - word.startMs,
      });
    } else {
      highlights.push({
        segmentIndex,
        edge,
        wordId: word.id,
        rangeStartMs: segment.endMs,
        rangeEndMs: word.endMs,
        overrunMs: word.endMs - segment.endMs,
      });
    }
  }
  return highlights;
}

/** 指定した単語IDが原因の境界はみ出しハイライトを検索する(疑義キューの「修正する」から境界選択へ直行するために使う)。 */
export function findBoundaryHighlightByWordId(
  highlights: BoundaryOverrunHighlight[],
  wordId: string,
): BoundaryOverrunHighlight | null {
  return highlights.find((highlight) => highlight.wordId === wordId) || null;
}
