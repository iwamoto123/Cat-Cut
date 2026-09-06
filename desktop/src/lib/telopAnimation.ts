/**
 * フェーズT3: テロップアニメーションの解決ロジック(純関数)。
 *
 * 解決の優先順位(上が強い):
 * 1. telop 個別指定(telops[].animation_in / animation_out。UIの個別上書き or
 *    type→マッピングの既定を step08 が書き込んだもの)
 * 2. プリセット既定(telop_presets.yaml の animation_in / animation_out)
 * 3. timeline 既定(timeline.animation_in / animation_out。従来のグローバル設定。
 *    旧名 popIn/fadeIn/popOut/fadeOut も後方互換で受ける)
 * 4. "none"
 *
 * アニメーションの実描画(spring/interpolate)は Telop.tsx が行い、
 * ここでは「どのアニメを何フレームで動かすか」だけを決定する(node --test で検証可能)。
 */

/**
 * 登場アニメーションID(フェーズT3の新体系)。
 * フェーズW24 Phase B-1: 広告向けの上品な4種
 * (blur_in / typewriter / wipe_up / drop_settle)を追加して計10種+none。
 * フェーズW26: ショート動画の「動きが弱い」対策として強い5種
 * (slam / bounce_left / bounce_right / rise_bounce / drop_bounce)を追加して計15種+none。
 */
export const ANIMATION_IN_TYPES = [
  "pop_big",
  "slide_left",
  "slide_up",
  "zoom",
  "stamp",
  "fade",
  "blur_in",
  "typewriter",
  "wipe_up",
  "drop_settle",
  "slam",
  "bounce_left",
  "bounce_right",
  "rise_bounce",
  "drop_bounce",
  "none",
] as const;
export type TelopAnimationIn = (typeof ANIMATION_IN_TYPES)[number];

/** 退場アニメーションID。 */
export const ANIMATION_OUT_TYPES = ["fade", "pop_out", "none"] as const;
export type TelopAnimationOut = (typeof ANIMATION_OUT_TYPES)[number];

/** 登場アニメの既定フレーム数(プリセットの animation_duration_frames で上書き可)。 */
export const DEFAULT_ANIMATION_DURATION_FRAMES = 12;

/** timeline.animation_in の旧名(T3以前のグローバル設定)を新体系へ写像する。 */
const LEGACY_IN_ALIASES: Record<string, TelopAnimationIn> = {
  popIn: "zoom",
  fadeIn: "fade",
  stamp: "stamp",
};

/** timeline.animation_out の旧名を新体系へ写像する。 */
const LEGACY_OUT_ALIASES: Record<string, TelopAnimationOut> = {
  popOut: "pop_out",
  fadeOut: "fade",
};

export function sanitizeAnimationIn(value: unknown): TelopAnimationIn | null {
  if (typeof value !== "string") return null;
  if ((ANIMATION_IN_TYPES as readonly string[]).includes(value)) return value as TelopAnimationIn;
  return LEGACY_IN_ALIASES[value] ?? null;
}

export function sanitizeAnimationOut(value: unknown): TelopAnimationOut | null {
  if (typeof value !== "string") return null;
  if ((ANIMATION_OUT_TYPES as readonly string[]).includes(value)) return value as TelopAnimationOut;
  return LEGACY_OUT_ALIASES[value] ?? null;
}

/** アニメ解決に必要な最小限のフィールド(TelopData / TelopStyle のサブセット)。 */
type AnimationSource = {
  telopAnimationIn?: unknown;
  telopAnimationOut?: unknown;
  styleAnimationIn?: unknown;
  styleAnimationOut?: unknown;
  styleDurationFrames?: unknown;
  timelineAnimationIn?: unknown;
  timelineAnimationOut?: unknown;
};

export type ResolvedTelopAnimation = {
  animationIn: TelopAnimationIn;
  animationOut: TelopAnimationOut;
  durationFrames: number;
};

/**
 * 1テロップ分のアニメーションを解決する。
 * 優先順位: telop個別 > プリセット既定 > timeline既定(旧名互換) > none。
 */
export function resolveTelopAnimation(source: AnimationSource): ResolvedTelopAnimation {
  const animationIn =
    sanitizeAnimationIn(source.telopAnimationIn) ??
    sanitizeAnimationIn(source.styleAnimationIn) ??
    sanitizeAnimationIn(source.timelineAnimationIn) ??
    "none";
  const animationOut =
    sanitizeAnimationOut(source.telopAnimationOut) ??
    sanitizeAnimationOut(source.styleAnimationOut) ??
    sanitizeAnimationOut(source.timelineAnimationOut) ??
    "none";
  const rawDuration = Number(source.styleDurationFrames);
  const durationFrames =
    Number.isFinite(rawDuration) && rawDuration > 0
      ? Math.round(rawDuration)
      : DEFAULT_ANIMATION_DURATION_FRAMES;
  return { animationIn, animationOut, durationFrames };
}
