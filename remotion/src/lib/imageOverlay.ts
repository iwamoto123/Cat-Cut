// フェーズV4(画像挿入トラック): composition timeline.images の正規化と配置計算。
//
// Remotion(<Img>)とdesktopプレビュー(<img>のDOM描画)の両方がこの同一ロジックで
// 配置スタイルを計算することで「プレビュー≒書き出しMP4」を保つ。
// remotion側が正、desktop/src/lib/imageOverlay.ts はコピー(sharedRemotionCopies.test.tsで一致担保)。

/** timeline.images の1クリップ(step08 が images.json から転写する)。時刻はタイムラインms基準。 */
export type ImageClipData = {
  id: string;
  /** 画像ファイル。書き出し時は絶対パス(render-cliがHTTP URLへ書き換える)。 */
  file: string;
  start_ms: number;
  end_ms: number;
  /** 画像中心のX位置(画面幅比0〜1)。 */
  x: number;
  /** 画像中心のY位置(画面高さ比0〜1)。 */
  y: number;
  /** 画像の表示幅(画面幅比0.1〜1.0)。高さはアスペクト比なり。 */
  scale: number;
  /** 0〜1。 */
  opacity: number;
};

// 追加時の既定値: 中央上寄り(テロップと重ならない位置)・画面幅55%・不透明。
export const IMAGE_DEFAULT_X = 0.5;
export const IMAGE_DEFAULT_Y = 0.35;
export const IMAGE_DEFAULT_SCALE = 0.55;
export const IMAGE_DEFAULT_OPACITY = 1;
export const IMAGE_MIN_SCALE = 0.1;
export const IMAGE_MAX_SCALE = 1.0;

/**
 * レイヤー順(zIndex)。DOM順では「カット内の映像+テロップ」の間に画像を挟めないため、
 * Remotion側は明示zIndexで 映像(auto=0) < 画像 < テロップ < オーバーレイ を保証する。
 * (desktopプレビューはDOM順=映像→画像→テロップ→オーバーレイで同じ重なりを実現する)
 * V6-5: 画像は「配列順=前後関係」を zIndex(IMAGE_LAYER_Z+配列index)で表すため、
 * テロップ・オーバーレイは画像の枚数上限に食い込まない大きな値に離す。
 */
export const IMAGE_LAYER_Z = 10;
export const TELOP_LAYER_Z = 1000;
export const OVERLAY_LAYER_Z = 2000;

/**
 * V6-5: 画像クリップのzIndex。timeline.images の配列順=前後関係(後ろの要素ほど手前)。
 * UIのレーン表示(上のレーン=手前=配列末尾)と書き出しの重なりが一致する。
 */
export function imageClipZIndex(arrayIndex: number): number {
  return IMAGE_LAYER_Z + Math.max(0, arrayIndex);
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** 比率(0〜1)→%文字列。浮動小数の誤差(0.55*100=55.00000000000001)を丸めてCSSを安定させる。 */
const toPercent = (ratio: number) => `${Number((ratio * 100).toFixed(4))}%`;

/** scaleを許容範囲(画面幅比0.1〜1.0)へ丸める。 */
export function clampImageScale(scale: number): number {
  return clamp(scale, IMAGE_MIN_SCALE, IMAGE_MAX_SCALE);
}

/**
 * timeline.images(未検証JSON)を ImageClipData[] へ正規化する。
 * 不正・区間ゼロの項目は除外(imagesキー自体が無い既存compositionは空配列=完全後方互換)。
 * V6-5: 配列順=前後関係(レーン順)の正本のため、start_msでのソートはしない(入力順を保つ)。
 */
export function normalizeImageTrack(raw: unknown): ImageClipData[] {
  if (!Array.isArray(raw)) return [];
  const clips: ImageClipData[] = [];
  for (const entry of raw as Array<Record<string, unknown>>) {
    if (!entry || typeof entry !== "object") continue;
    const file = typeof entry.file === "string" ? entry.file : "";
    const startMs = Number(entry.start_ms);
    const endMs = Number(entry.end_ms);
    if (!file || !Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    if (endMs <= startMs) continue;
    const x = Number(entry.x);
    const y = Number(entry.y);
    const scale = Number(entry.scale);
    const opacity = Number(entry.opacity);
    clips.push({
      id: typeof entry.id === "string" && entry.id ? entry.id : `image_${clips.length + 1}`,
      file,
      start_ms: Math.max(0, Math.round(startMs)),
      end_ms: Math.round(endMs),
      x: Number.isFinite(x) ? clamp(x, 0, 1) : IMAGE_DEFAULT_X,
      y: Number.isFinite(y) ? clamp(y, 0, 1) : IMAGE_DEFAULT_Y,
      scale: Number.isFinite(scale) ? clampImageScale(scale) : IMAGE_DEFAULT_SCALE,
      opacity: Number.isFinite(opacity) ? clamp(opacity, 0, 1) : IMAGE_DEFAULT_OPACITY,
    });
  }
  return clips;
}

/**
 * 中心座標(x,y=画面比率)+幅(scale=画面幅比)の配置スタイル。
 * すべて%指定+translate(-50%,-50%)にすることで、Remotionのコンポジション解像度と
 * プレビューのcontain矩形(px実寸が異なる)の両方で同じ相対配置になる。
 * 高さはアスペクト比なり(height:auto)なので画像の実寸取得を待つ必要がない。
 */
export function imageOverlayStyle(clip: ImageClipData): {
  position: "absolute";
  left: string;
  top: string;
  width: string;
  height: "auto";
  transform: string;
  opacity: number;
} {
  return {
    position: "absolute",
    left: toPercent(clip.x),
    top: toPercent(clip.y),
    width: toPercent(clip.scale),
    height: "auto",
    transform: "translate(-50%, -50%)",
    opacity: clamp(clip.opacity, 0, 1),
  };
}
