/**
 * フェーズT3: テロップアニメーション(UI側の定義)。
 *
 * シーン行のアニメーションピッカー・TelopTypeMappingModal の「アニメーション」列が使う。
 * ID一覧は remotion/src/lib/telopAnimation.ts / python/shared/telop_types.py の
 * ANIMATION_IN_TYPES と同期すること。
 *
 * 解決の優先順位(レンダリング時):
 * 1. シーン(スロット)の個別上書き(このピッカーで選択)
 * 2. シーン種類(semantic type) → マッピングの animation_in(設定モーダル)
 * 3. プリセット既定(telop_presets.yaml の animation_in)
 * 4. timeline.animation_in(従来のグローバル設定)
 */

/** 登場アニメーションID(remotion/pythonと同期)。 */
export const ANIMATION_IN_IDS = [
  "pop_big",
  "slide_left",
  "slide_up",
  "zoom",
  "stamp",
  "fade",
  "none",
] as const;

export type AnimationInId = (typeof ANIMATION_IN_IDS)[number];

/** ピッカー表示用の日本語ラベル。 */
export const ANIMATION_IN_LABELS: Record<AnimationInId, string> = {
  pop_big: "中央からドン",
  slide_left: "左からスライド",
  slide_up: "下から浮上",
  zoom: "ズーム",
  stamp: "スタンプ",
  fade: "フェード",
  none: "なし",
};

/** ピッカーの選択肢(先頭は「プリセット既定」= 上書きなし)。 */
export const ANIMATION_PICKER_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "", label: "プリセット既定" },
  ...ANIMATION_IN_IDS.map((id) => ({ id, label: ANIMATION_IN_LABELS[id] })),
];

export function isAnimationInId(value: unknown): value is AnimationInId {
  return typeof value === "string" && (ANIMATION_IN_IDS as readonly string[]).includes(value);
}

/** 未知・欠落のアニメIDを null(=上書きなし)へ正規化する。 */
export function sanitizeAnimationInId(value: unknown): AnimationInId | null {
  return isAnimationInId(value) ? value : null;
}

/** アニメIDの日本語ラベル(null/未知は「プリセット既定」)。 */
export function animationInLabel(value: string | null | undefined): string {
  return isAnimationInId(value) ? ANIMATION_IN_LABELS[value] : "プリセット既定";
}
