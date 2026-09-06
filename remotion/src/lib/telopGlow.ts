/**
 * フェーズU6(テロップ詳細エディタ): 光彩(グロウ)のCSS filter生成。
 *
 * グロウは「ぼかしのみ・オフセットなしのdrop-shadowを多重に重ねる」ことで表現する
 * (ゲーム系プリセットが drop_shadow 文字列で手書きしていた表現の、明示フィールド版)。
 * radius はプリセット font_size 基準のpx値で、shadow_offset と同じく実フォントサイズに
 * 比例スケールして呼び出す(Remotion側=fontSize/(font_size??52)、desktop側=表示px比)。
 *
 * このファイルは remotion が原本で、desktop/src/lib/telopGlow.ts へ完全一致コピーする
 * (sharedRemotionCopies.test.ts でバイト一致を担保。telopTypography方式)。
 */

export type TelopGlow = {
  color: string;
  /** プリセット font_size 基準のグロウ半径(px)。 */
  radius: number;
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * グロウ1件をCSS filter文字列へ変換する。
 * 内側(0.5r)・中間(r)・外側(2r)の3層drop-shadowで「芯のある光」を作る
 * (1層だけだと薄く、ネオン系の見た目にならないため)。
 */
export function buildGlowFilter(
  glow: TelopGlow | null | undefined,
  scale: number,
): string | null {
  if (!glow || !glow.color) return null;
  const radius = Number(glow.radius);
  if (!Number.isFinite(radius) || radius <= 0) return null;
  const scaled = radius * (Number.isFinite(scale) && scale > 0 ? scale : 1);
  const layers = [scaled * 0.5, scaled, scaled * 2].map(
    (r) => `drop-shadow(0px 0px ${round2(r)}px ${glow.color})`,
  );
  return layers.join(" ");
}

/** 複数のfilter片(グロウ・drop_shadow等)を結合する。全て空ならundefined(filter無指定)。 */
export function combineTelopFilters(
  ...parts: Array<string | null | undefined>
): string | undefined {
  const present = parts.filter((part): part is string => Boolean(part));
  return present.length ? present.join(" ") : undefined;
}
