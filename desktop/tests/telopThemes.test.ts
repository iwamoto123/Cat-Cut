import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTelopStylePlan,
  clearRuntimeTheme,
  DEFAULT_THEME_ID,
  describeThemeCard,
  getPresetCatalog,
  getPresetStyle,
  hasRuntimeTheme,
  paletteOptionsForTheme,
  registerPresetCatalog,
  registerRuntimeStyles,
  resolveEffectiveStyle,
  resolveEffectiveStyleId,
  resolveStyleById,
  scaleTelopDropShadow,
  scaleTelopStrokeWidth,
  SAVED_THEME_ID,
  setRuntimeTheme,
  telopDisplayScale,
  telopStyleSwatchColors,
  telopStyleToCssProperties,
  THEME_IDS,
  THEME_LABELS,
  themeEmotionStyleId,
  variantOptionsForFamily,
  type TelopStyleDef,
} from "../src/lib/telopThemes.ts";
import { EMOTION_TAGS } from "../src/lib/emotionTag.ts";

/**
 * 改善8-B-1/8-B-2で確認したいのは以下の性質:
 * - telopThemes.tsはyaml(telop_presets.yaml)の内容を「そのままのTelopStyleDef」として扱う
 *   (fill/inner_stroke/outer_stroke/drop_shadowを持つプリセット駆動テーマ)。
 * - テーマ = プリセットファミリー(classic + カラーウェイ12種)単位。
 * - 12カラーウェイ×用途3種(standard/emphasis/subtle)+帯背景(band)というプリセット命名規則に
 *   telopThemes.ts側のfamily組み立てロジック(buildColorwayFamily)が追従する。
 * FALLBACK_CATALOGにはclassic系(default/highlight/simple/calm/warning/question)の6種のみが
 * 含まれるため、カラーウェイ系のテストは registerPresetCatalog() でフィクスチャを登録してから行う。
 */

/** テスト用の最小限のTelopStyleDefを作るヘルパー(改善8-B-2のデザイン共通式を満たす形)。 */
function makeStyle(overrides: Partial<TelopStyleDef> = {}): TelopStyleDef {
  return {
    font_family: '"Zen Kaku Gothic Antique", sans-serif',
    font_size: 72,
    font_weight: 900,
    letter_spacing: "0.02em",
    line_height: 1.4,
    fill: { type: "gradient", gradient_from: "#AAAAAA", gradient_to: "#333333", gradient_direction: "vertical" },
    inner_stroke: { color: "#FFFFFF", width: 9 },
    outer_stroke: { color: "#111111", width: 18 },
    drop_shadow: "drop-shadow(0px 4px 6px rgba(0,0,0,0.4))",
    ...overrides,
  };
}

test.afterEach(() => {
  // 各テスト後にフィクスチャの残留がないよう、カタログをFALLBACK_CATALOGのみへ戻す。
  registerPresetCatalog({});
});

test("registerPresetCatalog/getPresetStyle: 登録したプリセットが取得でき、既存のFALLBACK_CATALOG(classic6種)は保持される", () => {
  registerPresetCatalog({ blue_standard: makeStyle({ font_size: 68 }) });
  assert.deepEqual(getPresetStyle("blue_standard"), makeStyle({ font_size: 68 }));
  assert.ok(getPresetStyle("default"), "yaml未読み込み時の安全網であるFALLBACK_CATALOGのdefaultは常に存在する");
  assert.equal(getPresetStyle("does_not_exist"), null);
});

test("getPresetCatalog: 現在有効なカタログ全体を返す", () => {
  registerPresetCatalog({ blue_standard: makeStyle() });
  const catalog = getPresetCatalog();
  assert.ok(catalog.default, "classic系はFALLBACK_CATALOGとしてマージされたまま残る");
  assert.ok(catalog.blue_standard);
});

test("themeEmotionStyleId: テーマIDと感情タグから安定した `テーマ_感情` 形式のIDを作る", () => {
  assert.equal(themeEmotionStyleId("classic", "normal"), "classic_normal");
  assert.equal(themeEmotionStyleId("blue", "question"), "blue_question");
});

test("THEME_IDS/THEME_LABELS: classic + カラーウェイ12種 = 13ファミリーがテーマとして並ぶ(改善8-B-2)", () => {
  assert.equal(THEME_IDS.length, 13, "classic + 12カラーウェイ");
  assert.ok(THEME_IDS.includes("classic"));
  for (const colorway of ["blue", "orange", "red", "green", "purple", "pink", "gold", "white", "black", "cyan", "navy", "brown"]) {
    assert.ok(THEME_IDS.includes(colorway), `${colorway}ファミリーが存在する`);
    assert.ok(THEME_LABELS[colorway], `${colorway}に日本語ラベルがある`);
  }
  assert.equal(DEFAULT_THEME_ID, "classic");
});

test("resolveEffectiveStyleId: オーバーライドが最優先、次に感情タグ、最後にテーマ既定(normal)", () => {
  assert.equal(
    resolveEffectiveStyleId("classic", "emphasis", "classic_simple"),
    "classic_simple",
    "個別オーバーライドが最優先",
  );
  assert.equal(
    resolveEffectiveStyleId("classic", "question", null),
    "classic_question",
    "オーバーライドなしなら感情タグに従う",
  );
  assert.equal(
    resolveEffectiveStyleId("classic", undefined, undefined),
    "classic_normal",
    "感情タグ未設定ならテーマの通常スタイルにフォールバック",
  );
});

test("resolveEffectiveStyle: classicテーマの4感情はyaml既存プリセット(default/highlight/question/warning)へ解決される", () => {
  assert.deepEqual(resolveEffectiveStyle("classic", "normal", null), getPresetStyle("default"));
  assert.deepEqual(resolveEffectiveStyle("classic", "emphasis", null), getPresetStyle("highlight"));
  assert.deepEqual(resolveEffectiveStyle("classic", "question", null), getPresetStyle("question"));
  assert.deepEqual(resolveEffectiveStyle("classic", "surprise", null), getPresetStyle("warning"));
});

test("resolveEffectiveStyle: オーバーライドIDがclassicのエキストラ(simple/calm)を指す場合はそのプリセットへ解決される", () => {
  assert.deepEqual(resolveEffectiveStyle("classic", "emphasis", "classic_simple"), getPresetStyle("simple"));
  assert.deepEqual(resolveEffectiveStyle("classic", "normal", "classic_calm"), getPresetStyle("calm"));
});

test("resolveStyleById: 未知のIDはnullを返す", () => {
  assert.equal(resolveStyleById("does_not_exist"), null);
});

test("paletteOptionsForTheme: classicは4感情+2エキストラ(simple/calm)で合計6件", () => {
  const options = paletteOptionsForTheme("classic");
  assert.equal(options.length, 6);
  const normalOption = options.find((o) => o.id === "classic_normal");
  assert.ok(normalOption);
  assert.deepEqual(normalOption?.style, getPresetStyle("default"));
  assert.ok(options.some((o) => o.id === "classic_simple"));
  assert.ok(options.some((o) => o.id === "classic_calm"));
});

test("paletteOptionsForTheme: カラーウェイは4感情のみ(帯背景が無い場合はエキストラ0件)", () => {
  registerPresetCatalog({
    purple_standard: makeStyle({ font_size: 70 }),
    purple_emphasis: makeStyle({ font_size: 92 }),
    purple_subtle: makeStyle({ font_size: 56 }),
  });
  const options = paletteOptionsForTheme("purple");
  assert.equal(options.length, 4, "purpleはhasBand:falseなのでエキストラ無し");
  assert.deepEqual(options.map((o) => o.id).sort(), ["purple_emphasis", "purple_normal", "purple_question", "purple_surprise"].sort());
});

test("variantOptionsForFamily: classicは4感情ラベルの用途カード(帯背景なし)", () => {
  const options = variantOptionsForFamily("classic");
  assert.deepEqual(
    options.map((o) => o.presetName),
    ["default", "highlight", "question", "warning", "simple", "calm"],
  );
});

test("variantOptionsForFamily: カラーウェイ(帯背景あり)は標準/強調大/控えめ小/帯背景の4カード", () => {
  registerPresetCatalog({
    blue_standard: makeStyle({ font_size: 68 }),
    blue_emphasis: makeStyle({ font_size: 92 }),
    blue_subtle: makeStyle({ font_size: 56 }),
    blue_band: makeStyle({ font_size: 68, background: { color: "rgba(0,0,0,0.55)" } }),
  });
  const options = variantOptionsForFamily("blue");
  assert.deepEqual(options.map((o) => o.label), ["標準", "強調大", "控えめ小", "帯背景"]);
  assert.equal(options.find((o) => o.label === "帯背景")?.style.background?.color, "rgba(0,0,0,0.55)");
});

test("variantOptionsForFamily: カラーウェイ(帯背景なし)はプリセット未登録の用途カードのみ除外され、帯背景カードも出ない", () => {
  registerPresetCatalog({ white_standard: makeStyle({ font_size: 70 }) });
  const options = variantOptionsForFamily("white");
  assert.deepEqual(options.map((o) => o.presetName), ["white_standard"], "emphasis/subtle/bandが未登録なら除外される");
});

test("describeThemeCard: classicとカラーウェイのラベル・サンプルスタイルを引ける", () => {
  const classicCard = describeThemeCard("classic");
  assert.equal(classicCard.label, "クラシック");
  assert.deepEqual(classicCard.sampleStyle, getPresetStyle("default"));

  registerPresetCatalog({ orange_standard: makeStyle({ font_size: 70 }) });
  const orangeCard = describeThemeCard("orange");
  assert.equal(orangeCard.label, "オレンジ");
  assert.deepEqual(orangeCard.sampleStyle, getPresetStyle("orange_standard"));
});

test("telopStyleToCssProperties: グラデ塗りはbackground-clip:textへ変換され、font_sizeに応じて縁取り幅がスケールする", () => {
  const style = makeStyle({ font_size: 72, inner_stroke: { color: "#FFFFFF", width: 10 }, outer_stroke: { color: "#1E3A5F", width: 18 } });
  const css = telopStyleToCssProperties(style, 52);
  assert.equal(css.fontSize, "52px");
  assert.equal(css.color, "transparent");
  assert.equal(css.WebkitBackgroundClip, "text");
  assert.ok(typeof css.backgroundImage === "string" && css.backgroundImage.includes("linear-gradient"));
  assert.ok(typeof css.textShadow === "string" && css.textShadow.length > 0, "多重縁取りをtext-shadowで近似する");
});

test("telopStyleToCssProperties: 単色塗りはcolorへ直接反映される", () => {
  const style = makeStyle({ fill: { type: "solid", color: "#FFD400" }, inner_stroke: null, outer_stroke: null });
  const css = telopStyleToCssProperties(style, 52);
  assert.equal(css.color, "#FFD400");
  assert.equal(css.backgroundImage, undefined);
});

test("改善9-B-2: 縁取り幅は displayFontSize / presetFontSize でスケールする(classic default 72px→サムネ20pxで外縁≈5px)", () => {
  const style = makeStyle({
    font_size: 72,
    inner_stroke: { color: "#FFFFFF", width: 10 },
    outer_stroke: { color: "#1E3A5F", width: 18 },
  });
  assert.equal(telopDisplayScale(20, 72), 20 / 72);
  const outerScaled = scaleTelopStrokeWidth(style.outer_stroke!.width, 20, style.font_size!);
  assert.ok(Math.abs(outerScaled - 5) < 0.01, `expected ~5px, got ${outerScaled}`);
  const innerScaled = scaleTelopStrokeWidth(style.inner_stroke!.width, 20, style.font_size!);
  assert.ok(Math.abs(innerScaled - 10 * (20 / 72)) < 0.01);
});

test("scaleTelopDropShadow: drop-shadow の px 値も表示比率でスケールする", () => {
  const scaled = scaleTelopDropShadow("drop-shadow(0px 4px 6px rgba(0,0,0,0.4))", 20, 72);
  assert.match(scaled ?? "", /drop-shadow\(0(\.00)?px 1\.11px 1\.67px rgba\(0,0,0,0\.4\)\)/);
});

test("telopStyleSwatchColors: グラデはgradient_to(深い方)を代表色に、単色はcolorをそのまま使う", () => {
  const gradient = makeStyle({ fill: { type: "gradient", gradient_from: "#7BB8DC", gradient_to: "#1E5DA8" } });
  assert.deepEqual(telopStyleSwatchColors(gradient), { color: "#1E5DA8", borderColor: "#111111" });

  const solid = makeStyle({ fill: { type: "solid", color: "#FFFFFF" }, outer_stroke: null, inner_stroke: { color: "#000000", width: 8 } });
  assert.deepEqual(telopStyleSwatchColors(solid), { color: "#FFFFFF", borderColor: "#000000" });
});

test("buildTelopStylePlan: 使用中のスタイルIDのみ辞書化し、テーマ既定normalを常に含める", () => {
  const plan = buildTelopStylePlan(["classic_emphasis", "classic_emphasis", "classic_question"], 52, "classic");
  assert.equal(plan.defaultStyle, "classic_normal");
  assert.deepEqual(Object.keys(plan.styles).sort(), ["classic_emphasis", "classic_normal", "classic_question"].sort());
  assert.deepEqual(plan.styles.classic_normal, getPresetStyle("default"));
});

test("buildTelopStylePlan: 空配列でもテーマ既定normalだけは含まれる", () => {
  const plan = buildTelopStylePlan([], 52, "classic");
  assert.equal(plan.defaultStyle, "classic_normal");
  assert.deepEqual(Object.keys(plan.styles), ["classic_normal"]);
});

// =============================================================================
// 改善7-3 / 改善8-B-5: 保存済みフォントプロファイルの実行時テーマ登録("saved"テーマ)
// =============================================================================

test("setRuntimeTheme/clearRuntimeTheme: 'saved'テーマを実行時に登録・解除でき、レジストリにも反映される", () => {
  assert.equal(hasRuntimeTheme(SAVED_THEME_ID), false);
  const styles: Record<string, TelopStyleDef> = {
    normal: makeStyle({ fill: { type: "solid", color: "#111111" } }),
    emphasis: makeStyle({ fill: { type: "solid", color: "#222222" } }),
    question: makeStyle({ fill: { type: "solid", color: "#333333" } }),
    surprise: makeStyle({ fill: { type: "solid", color: "#444444" } }),
  };
  setRuntimeTheme(SAVED_THEME_ID, styles as Record<(typeof EMOTION_TAGS)[number], TelopStyleDef>);
  try {
    assert.equal(hasRuntimeTheme(SAVED_THEME_ID), true);
    assert.deepEqual(resolveEffectiveStyle(SAVED_THEME_ID, "emphasis", null), styles.emphasis);
    assert.equal(resolveStyleById(themeEmotionStyleId(SAVED_THEME_ID, "question"))?.fill.color, "#333333");
    const card = describeThemeCard(SAVED_THEME_ID);
    assert.deepEqual(card.sampleStyle, styles.normal);
  } finally {
    clearRuntimeTheme(SAVED_THEME_ID);
  }
  assert.equal(hasRuntimeTheme(SAVED_THEME_ID), false);
  assert.equal(resolveStyleById(themeEmotionStyleId(SAVED_THEME_ID, "question")), null);
});

test("buildTelopStylePlan: 'saved'テーマを既定にした場合も書き出しスタイルプランに反映される", () => {
  setRuntimeTheme(SAVED_THEME_ID, {
    normal: makeStyle({ fill: { type: "gradient", gradient_from: "#7BB8DC", gradient_to: "#1E5DA8" } }),
    emphasis: makeStyle({ fill: { type: "solid", color: "#FF0000" } }),
    question: makeStyle({ fill: { type: "solid", color: "#0000FF" } }),
    surprise: makeStyle({ fill: { type: "solid", color: "#00FF00" } }),
  } as Record<(typeof EMOTION_TAGS)[number], TelopStyleDef>);
  try {
    const plan = buildTelopStylePlan([], 102, SAVED_THEME_ID);
    assert.equal(plan.defaultStyle, "saved_normal");
    assert.equal(plan.styles.saved_normal.fill.type, "gradient");
    assert.equal(plan.styles.saved_normal.fill.gradient_from, "#7BB8DC");
    assert.equal(plan.styles.saved_normal.fill.gradient_to, "#1E5DA8");
  } finally {
    clearRuntimeTheme(SAVED_THEME_ID);
  }
});

// --- フェーズU6: カスタムスタイルの実行時登録(詳細エディタの即時プレビュー反映) ---

test("registerRuntimeStyles: custom_* 定義をカタログへ追記し getPresetStyle で解決できる", () => {
  const def: TelopStyleDef = {
    font_size: 72,
    fill: { type: "solid", color: "#FF00AA" },
    outer_stroke2: { color: "#FFFFFF", width: 30 },
    glow: { color: "#00E5FF", radius: 12 },
  };
  registerRuntimeStyles({ custom_scene_test: def });
  assert.deepEqual(getPresetStyle("custom_scene_test"), def);
  // 既存プリセットは消えない(registerPresetCatalogと違い追記のみ)
  assert.ok(getPresetStyle("default"));
  // 上書き登録(再保存)は後勝ち
  const updated = { ...def, fill: { type: "solid" as const, color: "#000000" } };
  registerRuntimeStyles({ custom_scene_test: updated });
  assert.equal(getPresetStyle("custom_scene_test")?.fill.color, "#000000");
  // fill無し・null定義は無視される
  registerRuntimeStyles({ broken: {} as TelopStyleDef });
  assert.equal(getPresetStyle("broken"), null);
  registerRuntimeStyles(null);
});

test("telopStyleSwatchColors: 第3縁(outer_stroke2)があれば最外縁の色をborderColorに使う", () => {
  const colors = telopStyleSwatchColors({
    fill: { type: "solid", color: "#FFFFFF" },
    inner_stroke: { color: "#111111", width: 8 },
    outer_stroke: { color: "#222222", width: 16 },
    outer_stroke2: { color: "#333333", width: 26 },
  });
  assert.equal(colors.borderColor, "#333333");
});
