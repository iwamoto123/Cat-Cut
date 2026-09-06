// フェーズU1(プレビュー忠実化): プレビュー用のテロップ解決ロジック(純関数)。
//
// U1-1: directedモードのスタイル解決。従来プレビューは常にテーマ×感情(full用)の
//   resolveEffectiveStyle で解決していたため、directed runではプリセット(fact_yellow等)が
//   一切反映されていなかった(バグ級ギャップ)。ここでは
//   「シーンの effectiveDirectedStyleId → composition の telop_styles → プリセットカタログ」
//   の順でスタイル定義を引く(書き出し時に step08 が composition へ書くスタイルと同じ内容)。
// U1-6: 登場アニメーション・効果音の解決。優先順位は Remotion 側
//   (telopAnimation.resolveTelopAnimation / telopSfx.resolveTelopSfxId)と同一:
//   シーン個別上書き > type→マッピング > プリセット既定 > timeline既定 > none。
//
// 実行時(値)importのため、node --experimental-strip-types でテストを直接実行できるよう拡張子を明示する。
import type { Scene } from "./scenes.ts";
import { effectiveDirectedStyleId } from "./directedTelop.ts";
import { getPresetStyle, type TelopStyleDef } from "./telopThemes.ts";
import {
  resolveAnimationForType,
  sanitizeMappingEntry,
  sanitizeSemanticType,
  type TelopTypeMapping,
  type TelopTypeMappingEntry,
} from "./telopTypes.ts";
import {
  DEFAULT_ANIMATION_DURATION_FRAMES,
  resolveTelopAnimation,
  type TelopAnimationIn,
} from "./telopAnimation.ts";
import { resolveTelopSfxId } from "./telopSfx.ts";

/** directedスタイル解決に使う最小限のシーン形(Scene のサブセット)。 */
export type DirectedStyleScene = Pick<
  Scene,
  "directedStyleId" | "directedType" | "directedHighlightWords" | "directedAnimationIn" | "speaker"
>;

/**
 * スタイルID(プリセット名)を実定義へ解決する。
 * composition.json の timeline.telop_styles(書き出し時に実際に使われた定義)を最優先し、
 * 無ければ telop-presets:list 由来のカタログ(registerPresetCatalog 済み)へフォールバックする。
 */
export function resolveDirectedStyleDef(
  styleId: string,
  compositionStyles?: Record<string, TelopStyleDef> | null,
): TelopStyleDef | null {
  const fromComposition = compositionStyles?.[styleId];
  if (fromComposition) return fromComposition;
  return getPresetStyle(styleId);
}

/**
 * U1-1: directedモードのシーンの有効スタイル定義。
 * effectiveDirectedStyleId(個別上書き > 話者カラー > type×マッピング > fact_yellow)で
 * 名前を解決してから実定義を引く。未知のプリセット名は既定(fact_yellow → default)へ
 * フォールバックする。speakerColors はフェーズW1の話者カラー(発動時のみ非null)。
 */
export function resolveDirectedSceneStyle(
  scene: DirectedStyleScene,
  typeMapping: Partial<TelopTypeMapping> | null | undefined,
  compositionStyles?: Record<string, TelopStyleDef> | null,
  speakerColors?: import("./speakerColors.ts").ActiveSpeakerColors | null,
): TelopStyleDef | null {
  const styleId = effectiveDirectedStyleId(scene, typeMapping, speakerColors);
  return (
    resolveDirectedStyleDef(styleId, compositionStyles) ??
    resolveDirectedStyleDef("fact_yellow", compositionStyles) ??
    resolveDirectedStyleDef("default", compositionStyles)
  );
}

/** highlight_words はテロップ文言に実在する語のみ有効(Remotion側・directives書き戻しと同じ規則)。 */
export function filterHighlightWords(
  words: readonly string[] | undefined,
  telopText: string,
): string[] {
  if (!words || !words.length || !telopText) return [];
  return words.filter((word) => Boolean(word) && telopText.includes(word));
}

export type ResolvedPreviewAnimation = {
  animationIn: TelopAnimationIn;
  /** CSS近似アニメの再生時間(ms)。Remotionのanimation_duration_frames ÷ fps。 */
  durationMs: number;
};

/**
 * U1-6: プレビューの登場アニメーション解決。
 * directed: シーン個別上書き(アニメーションピッカー) > type→マッピング既定 >
 * プリセット既定 > timeline既定 > none(step08 がレンダリング前に telops[].animation_in へ
 * 書き込む内容と同じ優先順位)。full: プリセット既定 > timeline既定 > none。
 */
export function resolvePreviewAnimation(input: {
  directedAnimationIn?: string | null;
  directedType?: string | null;
  typeMapping?: Partial<TelopTypeMapping> | null;
  style: TelopStyleDef | null | undefined;
  timelineAnimationIn?: string | null;
  fps?: number;
}): ResolvedPreviewAnimation {
  const mappingAnimation =
    input.directedType != null
      ? resolveAnimationForType(input.directedType, input.typeMapping)
      : null;
  const resolved = resolveTelopAnimation({
    telopAnimationIn: input.directedAnimationIn ?? mappingAnimation ?? undefined,
    styleAnimationIn: input.style?.animation_in,
    styleDurationFrames: input.style?.animation_duration_frames,
    timelineAnimationIn: input.timelineAnimationIn ?? undefined,
  });
  const fps = input.fps && input.fps > 0 ? input.fps : 30;
  const durationFrames = resolved.durationFrames || DEFAULT_ANIMATION_DURATION_FRAMES;
  return {
    animationIn: resolved.animationIn,
    durationMs: Math.round((durationFrames / fps) * 1000),
  };
}

/**
 * U1-6: プレビューの効果音ID解決。
 * directed: type→マッピングの sfx("none"=鳴らさない明示) > プリセット既定。
 * full: プリセット既定のみ。Remotion側 resolveTelopSfxId と同じ規則
 * (マッピング由来の値は step08 が telops[].sfx へ書き込むためレンダリングと一致する)。
 */
export function resolvePreviewSfxId(input: {
  directedType?: string | null;
  typeMapping?: Partial<TelopTypeMapping> | null;
  style: TelopStyleDef | null | undefined;
}): string | null {
  let mappingSfx: string | undefined;
  if (input.directedType != null) {
    const normalized = sanitizeSemanticType(input.directedType);
    const entry: Partial<TelopTypeMappingEntry> | null = sanitizeMappingEntry(
      input.typeMapping?.[normalized],
    );
    if (entry?.sfx) mappingSfx = entry.sfx;
  }
  return resolveTelopSfxId(
    mappingSfx === undefined ? {} : { sfx: mappingSfx },
    input.style ?? undefined,
  );
}

/**
 * U1-2: ブロック背景(box系の座布団)の判定。Remotion Telop.tsx の resolveBlockBackground と
 * 同じ規則: background に padding_x / padding_y があれば「文字ブロック全体の1枚のベタ長方形」、
 * 無ければ従来の「行ごとの帯」(後方互換)。
 */
export function resolveBlockBackground(
  style: TelopStyleDef | null | undefined,
): NonNullable<TelopStyleDef["background"]> | null {
  const background = style?.background;
  if (!background) return null;
  return background.padding_x !== undefined || background.padding_y !== undefined
    ? background
    : null;
}

/** letter_spacing文字列("0.02em"等)をem単位の数値に変換する(Remotion Telop.tsxと同じ規則)。 */
export function parseLetterSpacingEm(letterSpacing: string | undefined): number {
  return Number.parseFloat(letterSpacing ?? "0.02em") || 0;
}
