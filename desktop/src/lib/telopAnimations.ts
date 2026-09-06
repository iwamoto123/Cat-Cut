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

/**
 * 登場アニメーションID(remotion/pythonと同期)。W24 Phase B-1で広告向け4種を追加し計10種+none。
 * W26でショート向けの強い5種(slam/バウンド系)を追加し計15種+none。
 */
export const ANIMATION_IN_IDS = [
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

export type AnimationInId = (typeof ANIMATION_IN_IDS)[number];

/** ピッカー表示用の日本語ラベル。 */
export const ANIMATION_IN_LABELS: Record<AnimationInId, string> = {
  pop_big: "中央からドン",
  slide_left: "左からスライド",
  slide_up: "下から浮上",
  zoom: "ズーム",
  stamp: "スタンプ",
  fade: "フェード",
  blur_in: "ブラー登場",
  typewriter: "タイプライター",
  wipe_up: "ワイプ",
  drop_settle: "ストン",
  slam: "叩きつけ+シェイク",
  bounce_left: "左からバウンド",
  bounce_right: "右からバウンド",
  rise_bounce: "下からバウンド",
  drop_bounce: "上からバウンド",
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

/**
 * フェーズT3: 効果音ID(assets/sfx/ と remotion/python の SFX_IDS と同期)。
 * "none" はマッピングで「このtypeは鳴らさない」を明示する特殊値。
 * フェーズW2: teen(チーン。映像ギミックpinchの既定SFX)を追加。
 */
export const SFX_IDS = ["don", "shakin", "pon", "jan", "hyu", "teen"] as const;

export type SfxId = (typeof SFX_IDS)[number];

/** 効果音の日本語ラベル(TelopTypeMappingModal の「効果音」列で使う)。 */
export const SFX_LABELS: Record<SfxId, string> = {
  don: "ドン(強調)",
  shakin: "シャキン(名言)",
  pon: "ポン(質問)",
  jan: "ジャン(オチ)",
  hyu: "ヒュッ(登場)",
  teen: "チーン(余韻)",
};

/** 効果音ドロップダウンの選択肢(先頭=プリセット既定、末尾=鳴らさない明示)。 */
export const SFX_PICKER_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "", label: "プリセット既定" },
  ...SFX_IDS.map((id) => ({ id, label: SFX_LABELS[id] })),
  { id: "none", label: "鳴らさない" },
];

/** 未知・欠落の効果音指定を null(=プリセット既定)へ正規化する("none"は有効値として残す)。 */
export function sanitizeSfxChoice(value: unknown): SfxId | "none" | null {
  if (value === "none") return "none";
  if (typeof value === "string" && (SFX_IDS as readonly string[]).includes(value)) return value as SfxId;
  return null;
}
