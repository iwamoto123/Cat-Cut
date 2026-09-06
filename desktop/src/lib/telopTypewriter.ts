/**
 * フェーズW24 Phase B-1: typewriter(1文字ずつ登場)の文字分割と出現タイミング(純関数)。
 *
 * Remotion本描画(Telop.tsx: フレーム→typewriterVisibleCount)と
 * プレビューCSS近似(TelopStyledText.tsx: 文字ごとのanimation-delay)の両方が
 * この同じ規則を使うことで、書き出しとプレビューの文字出現タイミングを体感一致させる:
 *   文字 i (0始まり) は 進捗 progress >= i / total で表示される
 *   (CSS側の delay = (i / total) × duration と同値)。
 *
 * 日本語テロップは絵文字・結合文字を含みうるため、コードポイントではなく
 * grapheme(書記素)単位で分割する(Intl.Segmenter。無い環境はコードポイントへフォールバック)。
 */

// Intl.Segmenter の構造的型(tsconfigのlibにES2022.Intlが無い環境でもコンパイルできるようにする)
type GraphemeSegmenter = { segment(text: string): Iterable<{ segment: string }> };
type SegmenterConstructor = new (
  locale: string,
  options: { granularity: "grapheme" },
) => GraphemeSegmenter;

/** テキストをgrapheme(書記素)単位に分割する。 */
export function splitGraphemes(text: string): string[] {
  if (!text) return [];
  const SegmenterCtor =
    typeof Intl !== "undefined"
      ? (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter
      : undefined;
  if (typeof SegmenterCtor === "function") {
    const segmenter = new SegmenterCtor("ja", { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (segment) => segment.segment);
  }
  // フォールバック: サロゲートペアは保てる(結合文字は分かれるが表示順は保たれる)
  return Array.from(text);
}

/** 文字 index (0始まり) の出現タイミング(アニメ全長に対する比率 0〜1未満)。 */
export function typewriterRevealRatio(index: number, total: number): number {
  if (total <= 0) return 0;
  const clamped = Math.max(0, Math.min(total - 1, Math.floor(index)));
  return clamped / total;
}

/**
 * 進捗 progress (0〜1) 時点で表示する文字数。
 * progress=0 でも先頭1文字は出る(タイプライターは開始と同時に打ち始める)。
 * progress>=1 で全文字表示。
 */
export function typewriterVisibleCount(total: number, progress: number): number {
  if (total <= 0) return 0;
  if (!Number.isFinite(progress) || progress < 0) return 0;
  if (progress >= 1) return total;
  // 文字iは progress >= i/total で表示 → floor(progress×total)+1 文字
  return Math.min(total, Math.floor(progress * total + 1e-6) + 1);
}

/** プレビューCSS近似用: 文字 index の animation-delay (ms)。 */
export function typewriterCharDelayMs(index: number, total: number, durationMs: number): number {
  return Math.round(typewriterRevealRatio(index, total) * Math.max(0, durationMs));
}

/**
 * 複数行テロップの行頭grapheme通し番号(行をまたいで順に打たれる)。
 * 戻り値: { offsets: 各行の開始index, total: 全行の合計grapheme数 }
 */
export function typewriterLineOffsets(lineTexts: readonly string[]): {
  offsets: number[];
  total: number;
} {
  const offsets: number[] = [];
  let total = 0;
  for (const lineText of lineTexts) {
    offsets.push(total);
    total += splitGraphemes(lineText).length;
  }
  return { offsets, total };
}
