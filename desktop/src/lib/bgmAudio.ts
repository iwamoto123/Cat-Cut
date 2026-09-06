// フェーズU9(BGMトラック): composition timeline.bgm の正規化とフェード音量カーブ。
//
// Remotion(<Audio volume={...}>)とdesktopプレビュー(HTMLAudioのrAF音量更新)の両方が
// この同一ロジックで音量を計算することで「プレビュー≒書き出しMP4」を保つ。
// remotion側が正、desktop/src/lib/bgmAudio.ts はコピー(sharedRemotionCopies.test.tsで一致担保)。

/** timeline.bgm の1クリップ(step08 が bgm.json から転写する)。時刻はタイムラインms基準。 */
export type BgmClipData = {
  id: string;
  /** 音源ファイル。書き出し時は絶対パス(render-cliがHTTP URLへ書き換える)。 */
  file: string;
  start_ms: number;
  end_ms: number;
  /** 0〜1。フェード適用前のベース音量。 */
  volume: number;
  fade_in_ms: number;
  fade_out_ms: number;
};

/** 追加時の既定音量。100%を既定とし、ユーザーがタイムラインで下げて微調整する運用(実機FB 2026-09-03)。 */
export const BGM_DEFAULT_VOLUME = 1;
/** 追加時の既定フェードイン/アウト長(ms)。 */
export const BGM_DEFAULT_FADE_MS = 1500;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/**
 * timeline.bgm(未検証JSON)を BgmClipData[] へ正規化する。
 * 不正・区間ゼロの項目は除外(bgmキー自体が無い既存compositionは空配列=完全後方互換)。
 */
export function normalizeBgmTrack(raw: unknown): BgmClipData[] {
  if (!Array.isArray(raw)) return [];
  const clips: BgmClipData[] = [];
  for (const entry of raw as Array<Record<string, unknown>>) {
    if (!entry || typeof entry !== "object") continue;
    const file = typeof entry.file === "string" ? entry.file : "";
    const startMs = Number(entry.start_ms);
    const endMs = Number(entry.end_ms);
    if (!file || !Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    if (endMs <= startMs) continue;
    const durationMs = endMs - startMs;
    const volumeRaw = Number(entry.volume);
    // フェードはクリップ長を超えない(超過JSONでも音量カーブが破綻しないように丸める)
    const fadeIn = Math.max(0, Math.min(durationMs, Math.round(Number(entry.fade_in_ms) || 0)));
    const fadeOut = Math.max(0, Math.min(durationMs, Math.round(Number(entry.fade_out_ms) || 0)));
    clips.push({
      id: typeof entry.id === "string" && entry.id ? entry.id : `bgm_${clips.length + 1}`,
      file,
      start_ms: Math.max(0, Math.round(startMs)),
      end_ms: Math.round(endMs),
      volume: Number.isFinite(volumeRaw) ? clamp01(volumeRaw) : BGM_DEFAULT_VOLUME,
      fade_in_ms: fadeIn,
      fade_out_ms: fadeOut,
    });
  }
  return [...clips].sort((a, b) => a.start_ms - b.start_ms);
}

/**
 * クリップ先頭からの経過ms → 実効音量(ベース音量×フェードゲイン)。
 * フェードは線形。フェードイン/アウトが重なる短いクリップは両カーブのminを取る
 * (中央が持ち上がって音が跳ねるのを防ぐ)。区間外は0。
 */
export function bgmVolumeAtMs(clip: BgmClipData, msFromClipStart: number): number {
  const durationMs = clip.end_ms - clip.start_ms;
  if (durationMs <= 0) return 0;
  if (msFromClipStart < 0 || msFromClipStart >= durationMs) return 0;
  let gain = 1;
  if (clip.fade_in_ms > 0) {
    gain = Math.min(gain, msFromClipStart / clip.fade_in_ms);
  }
  if (clip.fade_out_ms > 0) {
    gain = Math.min(gain, (durationMs - msFromClipStart) / clip.fade_out_ms);
  }
  return clamp01(clip.volume) * clamp01(gain);
}

/**
 * タイムラインms → そのクリップの実効音量(区間外は0)。プレビューのHTMLAudio音量更新用。
 */
export function bgmVolumeAtTimelineMs(clip: BgmClipData, timelineMs: number): number {
  return bgmVolumeAtMs(clip, timelineMs - clip.start_ms);
}
