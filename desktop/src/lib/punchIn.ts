// フェーズW26(ショート動画のシーン切替改善): カット単位のパンチイン(交互ズーム)。
//
// 縦型ショートは同一カメラのジャンプカット連結になりやすく、フレーミングが同じままだと
// 切替が「編集ミス」に見える。カットごとにズーム率を交互に変える(パンチイン)ことで
// ジャンプカットを意図した演出に見せる(2026-08-21 Fable手動編集の検証で確認した手法)。
//
// step08_composition.py (shared/punch_in.py) が cuts[].punch_scale / punch_origin を
// 書き込み、Remotion(CatCutComposition)とプレビュー(PreviewPlayer)が本モジュールの
// 同一計算でtransformを適用する。無い既存run・横型は null=変形なし(完全後方互換)。

/** パンチイン倍率の上限(これ以上は顔が寄りすぎ・画質劣化が目立つ)。 */
export const MAX_PUNCH_SCALE = 1.2;

export type PunchIn = {
  /** 拡大率(1.0より大きい)。 */
  scale: number;
  /** 拡大の注視点X(0〜1。顔中心 or 0.5)。 */
  originX: number;
  /** 拡大の注視点Y(0〜1。顔中心 or 0.42)。 */
  originY: number;
};

/**
 * cuts[].punch_scale / punch_origin を検証して正規化する。
 * scale が数値でない・1.0以下・上限超えは null(=変形なし)。originは0〜1へクランプ。
 */
export function normalizePunchIn(rawScale: unknown, rawOrigin: unknown): PunchIn | null {
  const scale = Number(rawScale);
  if (!Number.isFinite(scale) || scale <= 1.0 || scale > MAX_PUNCH_SCALE) return null;
  const origin = (rawOrigin ?? {}) as { x?: unknown; y?: unknown };
  const clamp01 = (value: unknown, fallback: number) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(1, Math.max(0, num));
  };
  return {
    scale,
    originX: clamp01(origin.x, 0.5),
    originY: clamp01(origin.y, 0.42),
  };
}

/** パンチインのCSS変形(Remotionのカットラッパー/プレビューの映像ラッパーで共用)。 */
export function punchInStyle(punch: PunchIn): { transform: string; transformOrigin: string } {
  return {
    transform: `scale(${punch.scale})`,
    transformOrigin: `${(punch.originX * 100).toFixed(2)}% ${(punch.originY * 100).toFixed(2)}%`,
  };
}
