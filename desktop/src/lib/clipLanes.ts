// フェーズV6-5(レーン段組み): 画像・BGMトラックの「1クリップ=1レーン」表示の座標計算と
// レーン順入替えの純関数。データ正本(images.json / bgm.json)の配列順がレーン順の唯一の源で、
// 表示は「配列の末尾=一番上のレーン」に反転する(画像は配列末尾=最前面のため、
// 「上のレーン=手前」という直感に合わせる。BGMも同じ規則で統一する)。
//
// 実行時(値)importのため、node --experimental-strip-types でテストを直接実行できるよう拡張子を明示する。

/** 配列index→レーンindex(0=一番上)。配列末尾(最前面)が一番上のレーンになる。 */
export function laneIndexForArrayIndex(count: number, arrayIndex: number): number {
  return Math.max(0, count - 1 - arrayIndex);
}

/** レーンindex(0=一番上)→配列index。laneIndexForArrayIndexの逆変換。 */
export function arrayIndexForLaneIndex(count: number, laneIndex: number): number {
  return Math.max(0, count - 1 - laneIndex);
}

/** トラック内のY座標(px)→レーンindex。トラック外は最寄りレーンへクランプする。 */
export function laneIndexForOffsetY(offsetYPx: number, laneHeightPx: number, count: number): number {
  if (count <= 0 || laneHeightPx <= 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.floor(offsetYPx / laneHeightPx)));
}

/** トラックの高さ(px)。クリップ0件でも placeholder 用に1レーン分は確保する。 */
export function laneTrackHeightPx(count: number, laneHeightPx: number): number {
  return Math.max(1, count) * laneHeightPx;
}

/**
 * クリップを別レーンへ移動した結果の配列(レーン順入替え)。
 * 配列から対象を抜き、レーンindexに対応する配列位置へ挿し直す(他クリップの相対順は保つ)。
 * 対象なし・同一レーンは元の配列をそのまま返す。
 */
export function moveClipToLane<T extends { id: string }>(
  clips: T[],
  clipId: string,
  targetLaneIndex: number,
): T[] {
  const fromIndex = clips.findIndex((clip) => clip.id === clipId);
  if (fromIndex === -1) return clips;
  const toIndex = arrayIndexForLaneIndex(
    clips.length,
    Math.max(0, Math.min(clips.length - 1, targetLaneIndex)),
  );
  if (toIndex === fromIndex) return clips;
  const next = [...clips];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}
