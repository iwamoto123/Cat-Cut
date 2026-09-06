// フェーズU9(フィルムストリップ): サムネイル帯のホバー・クリック位置計算の純関数。
// main側(ffmpeg抽出)が返すフレーム時刻はビン中央((i+0.5)/N)なので、
// 「カーソル位置msに最も近いフレーム」= ビンのインデックスそのもの、という対応で計算する。

/** フレームi(0始まり)の代表時刻(ms)。main側 generateFilmstripForRun と同じ「ビン中央」規則。 */
export function filmstripFrameTimesMs(count: number, durationMs: number): number[] {
  if (count <= 0 || durationMs <= 0) return [];
  const times: number[] = [];
  for (let i = 0; i < count; i += 1) {
    times.push(Math.min(durationMs - 1, Math.round(((i + 0.5) / count) * durationMs)));
  }
  return times;
}

/** 帯上の横位置(0〜1)→表示すべきフレームのインデックス(0〜count-1にクランプ)。 */
export function filmstripIndexForRatio(ratio: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.floor(ratio * count)));
}

/** 帯上の横位置(0〜1)→元動画の時刻(ms)。クリックシーク用(0〜durationMsにクランプ)。 */
export function filmstripMsForRatio(ratio: number, durationMs: number): number {
  return Math.max(0, Math.min(durationMs, Math.round(ratio * durationMs)));
}

/**
 * ホバーポップアップの左端位置(px)。カーソルに追従しつつ帯の外へはみ出さないようクランプする。
 */
export function filmstripPopupLeftPx(cursorX: number, popupWidth: number, trackWidth: number): number {
  const half = popupWidth / 2;
  return Math.max(0, Math.min(Math.max(0, trackWidth - popupWidth), cursorX - half));
}

/** mm:ss 表示(ポップアップの時刻ラベル用)。 */
export function formatFilmstripTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
