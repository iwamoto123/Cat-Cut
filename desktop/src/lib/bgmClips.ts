// フェーズU9(BGMトラック): クリップのドラッグ操作(移動・伸縮・フェード調整)の純関数。
// UIコンポーネント(BgmTrack)はpx→ms換算した差分をここへ渡すだけにして、
// クランプ・スナップの規則を1箇所に集約する(node --testで直接検証できる)。
//
// 実行時(値)importのため、node --experimental-strip-types でテストを直接実行できるよう拡張子を明示する。
import type { BgmClipData } from "./bgmAudio.ts";

/** クリップの最小尺(ms)。伸縮でゼロ長・負長にしないための下限。 */
export const BGM_MIN_CLIP_MS = 500;
/** スナップの既定しきい値(ms)。トラック幅換算で約8px相当を呼び出し側が渡す想定の既定値。 */
export const BGM_DEFAULT_SNAP_MS = 150;

type ClipBounds = {
  /** タイムライン総尺(ms)。0以下なら右端制約なし(composition未生成時)。 */
  timelineDurationMs: number;
  /** 音源自体の長さ(ms)。0以下なら音源長の制約なし(ffprobe失敗時)。 */
  audioDurationMs?: number;
  /** スナップしきい値(ms)。省略時 BGM_DEFAULT_SNAP_MS。 */
  snapMs?: number;
};

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** フェードをクリップ長以内へ丸める(伸縮後の整合を保つ)。 */
function clampFades(clip: BgmClipData): BgmClipData {
  const durationMs = clip.end_ms - clip.start_ms;
  return {
    ...clip,
    fade_in_ms: clamp(Math.round(clip.fade_in_ms), 0, durationMs),
    fade_out_ms: clamp(Math.round(clip.fade_out_ms), 0, durationMs),
  };
}

/**
 * バー本体ドラッグ=位置移動。長さを保ったまま平行移動し、
 * 先頭0msとタイムライン終端へスナップする(しきい値内なら吸着)。
 */
export function moveBgmClip(clip: BgmClipData, deltaMs: number, bounds: ClipBounds): BgmClipData {
  const durationMs = clip.end_ms - clip.start_ms;
  const snapMs = bounds.snapMs ?? BGM_DEFAULT_SNAP_MS;
  let startMs = Math.round(clip.start_ms + deltaMs);
  // タイムライン内へクランプ(総尺不明なら左端のみ)
  const maxStart = bounds.timelineDurationMs > 0 ? Math.max(0, bounds.timelineDurationMs - durationMs) : Infinity;
  startMs = clamp(startMs, 0, maxStart);
  // スナップ: 開始0ms / 終了=総尺端
  if (Math.abs(startMs) <= snapMs) startMs = 0;
  else if (bounds.timelineDurationMs > 0 && Math.abs(startMs + durationMs - bounds.timelineDurationMs) <= snapMs) {
    startMs = Math.max(0, bounds.timelineDurationMs - durationMs);
  }
  return { ...clip, start_ms: startMs, end_ms: startMs + durationMs };
}

/**
 * 左右端ドラッグ=開始/終了の伸縮。
 * - 最小尺 BGM_MIN_CLIP_MS を下回らない
 * - 音源長(audioDurationMs)より長くはできない(音が無い区間を作らない)
 * - 開始は0ms・終了はタイムライン総尺へスナップ
 * - フェードは伸縮後のクリップ長へ丸める
 */
export function resizeBgmClip(
  clip: BgmClipData,
  edge: "start" | "end",
  deltaMs: number,
  bounds: ClipBounds,
): BgmClipData {
  const snapMs = bounds.snapMs ?? BGM_DEFAULT_SNAP_MS;
  const audioMs = bounds.audioDurationMs && bounds.audioDurationMs > 0 ? bounds.audioDurationMs : Infinity;
  if (edge === "start") {
    let startMs = Math.round(clip.start_ms + deltaMs);
    // 最小尺と音源長: end - start ∈ [BGM_MIN_CLIP_MS, audioMs]
    startMs = clamp(startMs, Math.max(0, clip.end_ms - audioMs), clip.end_ms - BGM_MIN_CLIP_MS);
    if (Math.abs(startMs) <= snapMs && clip.end_ms - 0 <= audioMs) startMs = 0;
    return clampFades({ ...clip, start_ms: startMs });
  }
  let endMs = Math.round(clip.end_ms + deltaMs);
  const maxEnd = Math.min(
    clip.start_ms + audioMs,
    bounds.timelineDurationMs > 0 ? bounds.timelineDurationMs : Infinity,
  );
  endMs = clamp(endMs, clip.start_ms + BGM_MIN_CLIP_MS, maxEnd);
  if (
    bounds.timelineDurationMs > 0 &&
    Math.abs(endMs - bounds.timelineDurationMs) <= snapMs &&
    bounds.timelineDurationMs <= maxEnd
  ) {
    endMs = bounds.timelineDurationMs;
  }
  return clampFades({ ...clip, end_ms: endMs });
}

/** フェードつまみのドラッグ。edge=start はフェードイン長、end はフェードアウト長を更新する。 */
export function setBgmFade(clip: BgmClipData, edge: "start" | "end", fadeMs: number): BgmClipData {
  const durationMs = clip.end_ms - clip.start_ms;
  const clamped = clamp(Math.round(fadeMs), 0, durationMs);
  return edge === "start" ? { ...clip, fade_in_ms: clamped } : { ...clip, fade_out_ms: clamped };
}

/** 音量スライダ(0〜100%)。W18: 1%付近を調整できるよう0.1%刻みで保持する。 */
export function setBgmVolume(clip: BgmClipData, volume: number): BgmClipData {
  return { ...clip, volume: clamp(Math.round(volume * 1000) / 1000, 0, 1) };
}

/**
 * フェーズV1(タイムラインView): クリップ上に描いた音量水平線の上下ドラッグ。
 * エンベロープ描画域の高さ(px)を100%とし、上へ動かすほど音量が上がる。
 * 1%刻みに丸める(setBgmVolumeと同じ粒度でbgm.jsonの値が細かく揺れないように)。
 */
export function dragBgmVolume(
  clip: BgmClipData,
  startVolume: number,
  deltaYPx: number,
  envelopeHeightPx: number,
): BgmClipData {
  if (envelopeHeightPx <= 0) return clip;
  // 画面座標は下が正なので、下ドラッグ=音量減
  return setBgmVolume(clip, startVolume - deltaYPx / envelopeHeightPx);
}

/**
 * フェーズV6-5: 「+ BGM」で追加するクリップの既定開始位置。
 * 既存クリップの最後尾の終端(=一番遅いend_ms)に続けて置く。1本目は0。
 */
export function nextBgmClipStartMs(clips: Array<{ end_ms: number }>): number {
  if (!clips.length) return 0;
  return Math.max(0, ...clips.map((clip) => clip.end_ms));
}

/** クリップ配列の1件を置き換える(見つからなければそのまま)。 */
export function replaceBgmClip(clips: BgmClipData[], next: BgmClipData): BgmClipData[] {
  return clips.map((clip) => (clip.id === next.id ? next : clip));
}

/** クリップ削除。 */
export function removeBgmClip(clips: BgmClipData[], clipId: string): BgmClipData[] {
  return clips.filter((clip) => clip.id !== clipId);
}
