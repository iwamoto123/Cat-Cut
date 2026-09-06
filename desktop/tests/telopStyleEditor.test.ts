import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDropShadow,
  composeColor,
  customSceneStyleId,
  customThemeStyleId,
  formStateToStyleDef,
  isCustomStyleId,
  matchFontOption,
  mergeCustomStyles,
  parseColor,
  parseDropShadow,
  styleDefToFormState,
} from "../src/lib/telopStyleEditor.ts";
import type { TelopStyleDef } from "../src/lib/telopThemes.ts";

/**
 * フェーズU6(テロップスタイル詳細エディタ)の純関数テスト:
 * フォーム状態⇔TelopStyleDef変換・カスタムID生成・custom_stylesマージ。
 */

test("parseColor: #RRGGBB / #RGB / #RRGGBBAA / rgba() を hex+不透明度へ分解する", () => {
  assert.deepEqual(parseColor("#FFDD00"), { hex: "#ffdd00", opacity: 1 });
  assert.deepEqual(parseColor("#fd0"), { hex: "#ffdd00", opacity: 1 });
  assert.equal(parseColor("#ffdd0080").hex, "#ffdd00");
  assert.ok(Math.abs(parseColor("#ffdd0080").opacity - 0.5) < 0.01);
  assert.deepEqual(parseColor("rgba(255,0,0,0.4)"), { hex: "#ff0000", opacity: 0.4 });
  assert.deepEqual(parseColor("rgb(0, 128, 255)"), { hex: "#0080ff", opacity: 1 });
  // 解釈不能はフォールバック色
  assert.deepEqual(parseColor("var(--x)", "#123456"), { hex: "#123456", opacity: 1 });
});

test("composeColor: 不透明は#RRGGBBのまま、半透明はrgba()にする", () => {
  assert.equal(composeColor("#FFDD00", 1), "#ffdd00");
  assert.equal(composeColor("#ff0000", 0.4), "rgba(255,0,0,0.4)");
});

test("parseDropShadow/buildDropShadow: 標準形のラウンドトリップ", () => {
  const form = parseDropShadow("drop-shadow(0px 4px 6px rgba(0,0,0,0.4))");
  assert.equal(form.enabled, true);
  assert.equal(form.blur, 6);
  assert.equal(form.distance, 4);
  assert.equal(form.angle, 90);
  assert.equal(form.colorHex, "#000000");
  assert.ok(Math.abs(form.colorOpacity - 0.4) < 0.01);
  assert.equal(buildDropShadow(form), "drop-shadow(0px 4px 6px rgba(0,0,0,0.4))");
});

test("parseDropShadow: 多重drop-shadow(game系グロウ手書き)は2個目以降をextraで保持する", () => {
  const raw =
    "drop-shadow(0px 0px 12px #00E5FF) drop-shadow(0px 0px 24px #00E5FF) drop-shadow(0px 4px 6px rgba(0,0,0,0.5))";
  const form = parseDropShadow(raw);
  assert.equal(form.extra, "drop-shadow(0px 0px 24px #00E5FF) drop-shadow(0px 4px 6px rgba(0,0,0,0.5))");
  // 編集後もextraは末尾に復元される(既存プリセットの見た目を壊さない)
  const rebuilt = buildDropShadow(form);
  assert.ok(rebuilt?.includes("drop-shadow(0px 0px 24px #00E5FF)"));
});

test("parseDropShadow: 無指定はenabled=false、buildはnullを返す", () => {
  const form = parseDropShadow(null);
  assert.equal(form.enabled, false);
  assert.equal(buildDropShadow(form), null);
});

const SAMPLE_DEF: TelopStyleDef = {
  font_family: '"Zen Kaku Gothic Antique", "Hiragino Sans", sans-serif',
  font_size: 72,
  font_weight: 900,
  letter_spacing: "0.02em",
  line_height: 1.4,
  fill: { type: "gradient", gradient_from: "#FFD93D", gradient_to: "#FF6B35", gradient_direction: "vertical" },
  inner_stroke: { color: "#FFFFFF", width: 10 },
  outer_stroke: { color: "#7A2A00", width: 20 },
  outer_stroke2: { color: "#FFFFFF", width: 30 },
  drop_shadow: "drop-shadow(0px 4px 6px rgba(0,0,0,0.4))",
  glow: { color: "#00E5FF", radius: 14 },
  shadow_offset: { x: 6, y: 6, color: "#000000" },
  background: { color: "rgba(0,0,0,0.85)", padding_x: 48, padding_y: 20, border_radius: 12 },
  highlight_color: "#FFDD00",
  y_position_offset: -0.05,
  particle_scale: 0.7,
  latin_font_family: null,
  animation_in: "pop_big",
  sfx: "don",
};

test("styleDefToFormState⇔formStateToStyleDef: 主要フィールドのラウンドトリップ", () => {
  const form = styleDefToFormState(SAMPLE_DEF);
  // フォーム側の読み取り確認
  assert.equal(form.fillMode, "gradient");
  assert.deepEqual(form.strokes[2], { enabled: true, colorHex: "#ffffff", width: 30 });
  assert.equal(form.glowEnabled, true);
  assert.equal(form.glowRadius, 14);
  assert.equal(form.backgroundMode, "box");
  assert.equal(form.latinFontFamily, "none");
  assert.equal(form.sfx, "don");

  const rebuilt = formStateToStyleDef(form);
  assert.equal(rebuilt.font_size, 72);
  assert.equal(rebuilt.letter_spacing, "0.02em");
  // 色はカラーピッカー互換のため小文字hexへ正規化される(視覚的には同一)
  assert.deepEqual(rebuilt.fill, {
    type: "gradient",
    gradient_from: "#ffd93d",
    gradient_to: "#ff6b35",
    gradient_direction: "vertical",
  });
  assert.deepEqual(rebuilt.inner_stroke, { color: "#ffffff", width: 10 });
  assert.deepEqual(rebuilt.outer_stroke2, { color: "#ffffff", width: 30 });
  assert.deepEqual(rebuilt.glow, { color: "#00e5ff", radius: 14 });
  assert.deepEqual(rebuilt.shadow_offset, { x: 6, y: 6, color: "#000000" });
  assert.equal(rebuilt.drop_shadow, "drop-shadow(0px 4px 6px rgba(0,0,0,0.4))");
  assert.deepEqual(rebuilt.background, { color: "rgba(0,0,0,0.85)", padding_x: 48, padding_y: 20, border_radius: 12 });
  assert.equal(rebuilt.highlight_color, "#ffdd00");
  assert.equal(rebuilt.y_position_offset, -0.05);
  assert.equal(rebuilt.particle_scale, 0.7);
  assert.equal(rebuilt.latin_font_family, null);
  assert.equal(rebuilt.animation_in, "pop_big");
  assert.equal(rebuilt.sfx, "don");
});

test("styleDefToFormState: 行帯背景(padding無し)はband、背景無しはnoneになる", () => {
  const band = styleDefToFormState({ ...SAMPLE_DEF, background: { color: "rgba(0,0,0,0.6)" } });
  assert.equal(band.backgroundMode, "band");
  const bandDef = formStateToStyleDef(band);
  assert.deepEqual(bandDef.background, { color: "rgba(0,0,0,0.6)" });

  const none = styleDefToFormState({ ...SAMPLE_DEF, background: null });
  assert.equal(none.backgroundMode, "none");
  assert.equal(formStateToStyleDef(none).background, null);
});

test("formStateToStyleDef: 縁OFFはnull、光彩OFFはnullになる(後方互換の形)", () => {
  const form = styleDefToFormState(SAMPLE_DEF);
  form.strokes[2].enabled = false;
  form.glowEnabled = false;
  const def = formStateToStyleDef(form);
  assert.equal(def.outer_stroke2, null);
  assert.equal(def.glow, null);
});

test("customThemeStyleId: テーマ×typeで安定したID(再保存で上書きされる)", () => {
  assert.equal(customThemeStyleId("theme_abc-123", "emphasis"), "custom_theme_abc_123_emphasis");
  assert.equal(
    customThemeStyleId("theme_abc-123", "emphasis"),
    customThemeStyleId("theme_abc-123", "emphasis"),
  );
});

test("customSceneStyleId: シーンごとに一意でcustom_scene_プレフィクス", () => {
  const id = customSceneStyleId("scene-042");
  assert.equal(id, "custom_scene_scene_042");
  assert.ok(isCustomStyleId(id));
  assert.ok(!isCustomStyleId("fact_yellow"));
});

test("mergeCustomStyles: 後勝ちマージ、fillの無い壊れた定義は捨てる", () => {
  const a = { custom_x: { fill: { type: "solid" as const, color: "#fff" } } };
  const b = {
    custom_x: { fill: { type: "solid" as const, color: "#000" } },
    broken: {} as TelopStyleDef,
  };
  const merged = mergeCustomStyles(a, b, null, undefined);
  assert.deepEqual(Object.keys(merged), ["custom_x"]);
  assert.equal(merged.custom_x.fill.color, "#000");
});

test("matchFontOption: フォールバック表記が違っても先頭ファミリー一致で解決する", () => {
  const option = matchFontOption('"Zen Kaku Gothic Antique", "Meiryo", sans-serif');
  assert.equal(option?.label, "Zen角ゴシック");
  assert.equal(matchFontOption('"存在しないフォント", sans-serif'), null);
  assert.equal(matchFontOption(""), null);
});
