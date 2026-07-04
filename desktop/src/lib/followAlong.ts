import type { TranscriptWord } from "./keepSegments";

/**
 * 追い読みモード（Phase B）の純関数群。
 * - 「直前の単語」選択ロジック（Space編集対象の決定）
 * - 1単語シーク（←/→）の対象決定
 * - 追い読み進捗（%）計算
 */

export const FOLLOW_ALONG_LOOKBACK_MS = 300;

export const PLAYBACK_RATES = [1, 1.25, 1.5, 2] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];
export const DEFAULT_FOLLOW_ALONG_RATE: PlaybackRate = 1.5;
export const DEFAULT_NORMAL_RATE: PlaybackRate = 1;

/**
 * 指定時刻 atMs 時点でアクティブな単語のインデックスを返す。
 * 単語間の無音・カット区間で atMs がどの単語にもヒットしない場合は、
 * atMs 以前で最も近い単語（直近に読み終えた単語）にフォールバックする。
 */
export function findWordIndexAtOrBefore(words: TranscriptWord[], atMs: number): number {
  if (!words.length) return -1;
  let fallback = -1;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (atMs >= word.startMs && atMs < word.endMs) return i;
    if (word.startMs <= atMs) fallback = i;
  }
  return fallback;
}

/**
 * Space押下時に編集対象とする「直前に読み上げられた単語」のインデックスを返す。
 * 人間の反応遅延を考慮し、現在時刻より lookbackMs（既定300ms）前の時点でハイライトされていた単語を選ぶ。
 * 該当する単語が無ければ -1 を返す。
 */
export function findPreviousReadWordIndex(
  words: TranscriptWord[],
  currentMs: number,
  lookbackMs: number = FOLLOW_ALONG_LOOKBACK_MS,
): number {
  const targetMs = Math.max(0, currentMs - lookbackMs);
  return findWordIndexAtOrBefore(words, targetMs);
}

/**
 * ←/→キーによる1単語シーク先のインデックスを返す。
 * direction: 1 は次の単語へ、-1 は前の単語へ。
 * 現在位置がどの単語にも属さない場合は、直前の単語を基準に前後へ移動する。
 */
export function findAdjacentWordIndex(words: TranscriptWord[], currentMs: number, direction: 1 | -1): number {
  if (!words.length) return -1;
  const base = findWordIndexAtOrBefore(words, currentMs);
  if (base === -1) {
    return direction === 1 ? 0 : -1;
  }
  const next = base + direction;
  if (next < 0) return 0;
  if (next >= words.length) return words.length - 1;
  return next;
}

/**
 * 追い読み進捗（%）を、最後に到達した再生位置（maxReachedMs）と全体長から計算する。
 * 0〜100 の範囲にクランプする。
 */
export function computeReadThroughProgressPercent(maxReachedMs: number, totalDurationMs: number): number {
  if (totalDurationMs <= 0 || !Number.isFinite(totalDurationMs)) return 0;
  const ratio = Math.max(0, maxReachedMs) / totalDurationMs;
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}
