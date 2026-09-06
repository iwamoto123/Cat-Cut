import test from "node:test";
import assert from "node:assert/strict";
import {
  filterHighlightWords,
  parseLetterSpacingEm,
  resolveBlockBackground,
  resolveDirectedSceneStyle,
  resolveDirectedStyleDef,
  resolvePreviewAnimation,
  resolvePreviewSfxId,
} from "../src/lib/previewTelop.ts";
import { registerPresetCatalog, type TelopStyleDef } from "../src/lib/telopThemes.ts";
import type { DirectedStyleScene } from "../src/lib/previewTelop.ts";

/**
 * フェーズU1(プレビュー忠実化): directedモードのスタイル・アニメ・効果音解決のテスト。
 * 解決の優先順位が書き出し(step08 + Remotion)と同じであることを純関数レベルで検証する。
 */

const FACT_YELLOW: TelopStyleDef = {
  font_size: 72,
  fill: { type: "solid", color: "#FFFFFF" },
  highlight_color: "#FFE600",
  animation_in: "fade",
  sfx: null,
};

const BOX_YELLOW: TelopStyleDef = {
  font_size: 64,
  fill: { type: "solid", color: "#111111" },
  background: { color: "#FFE600", padding_x: 28, padding_y: 10, border_radius: 4 },
  animation_in: "stamp",
  animation_duration_frames: 9,
  sfx: "don",
};

// composition timeline.telop_styles 相当(書き出しに実際に使われた定義)
const COMPOSITION_STYLES: Record<string, TelopStyleDef> = {
  fact_yellow: FACT_YELLOW,
  box_yellow: BOX_YELLOW,
};

test("resolveDirectedStyleDef: compositionのtelop_stylesを最優先し、無ければカタログへフォールバック", () => {
  assert.equal(resolveDirectedStyleDef("box_yellow", COMPOSITION_STYLES), BOX_YELLOW);
  // compositionに無い名前 → registerPresetCatalog済みのカタログから引く
  registerPresetCatalog({ cta_yellow: { fill: { type: "solid", color: "#FFB300" } } });
  const fromCatalog = resolveDirectedStyleDef("cta_yellow", COMPOSITION_STYLES);
  assert.equal(fromCatalog?.fill.color, "#FFB300");
  // どこにも無い名前はnull
  assert.equal(resolveDirectedStyleDef("no_such_style", COMPOSITION_STYLES), null);
});

test("resolveDirectedSceneStyle: 個別上書き > type×マッピング > fact_yellow の順で解決する", () => {
  const mapping = { default: { style: "fact_yellow" }, cta: { style: "box_yellow" } };
  // 個別上書き(directedStyleId)が最優先
  const overridden: DirectedStyleScene = { directedStyleId: "box_yellow", directedType: "default" };
  assert.equal(resolveDirectedSceneStyle(overridden, mapping, COMPOSITION_STYLES), BOX_YELLOW);
  // 上書きなし → type×マッピング
  const typed: DirectedStyleScene = { directedStyleId: null, directedType: "cta" };
  assert.equal(resolveDirectedSceneStyle(typed, mapping, COMPOSITION_STYLES), BOX_YELLOW);
  // typeもなし → 既定 fact_yellow
  const bare: DirectedStyleScene = {};
  assert.equal(resolveDirectedSceneStyle(bare, mapping, COMPOSITION_STYLES), FACT_YELLOW);
  // 未知のプリセット名へ上書きされた場合も fact_yellow へフォールバックして描画を壊さない
  const unknown: DirectedStyleScene = { directedStyleId: "ghost_style" };
  assert.equal(resolveDirectedSceneStyle(unknown, mapping, COMPOSITION_STYLES), FACT_YELLOW);
});

test("filterHighlightWords: テロップ文言に実在する語のみ有効(directives書き戻しと同じ規則)", () => {
  assert.deepEqual(filterHighlightWords(["夏期講習", "存在しない語"], "白谷塾の夏期講習"), [
    "夏期講習",
  ]);
  assert.deepEqual(filterHighlightWords(undefined, "本文"), []);
  assert.deepEqual(filterHighlightWords(["語"], ""), []);
  assert.deepEqual(filterHighlightWords([""], "本文"), []);
});

test("resolvePreviewAnimation: シーン個別上書き > マッピング > プリセット既定 > timeline既定 > none", () => {
  const mapping = { default: { style: "fact_yellow", animation_in: "slide_up" } };
  // シーン個別上書きが最優先
  assert.equal(
    resolvePreviewAnimation({
      directedAnimationIn: "pop_big",
      directedType: "default",
      typeMapping: mapping,
      style: FACT_YELLOW,
    }).animationIn,
    "pop_big",
  );
  // 上書きなし → type×マッピングの既定
  assert.equal(
    resolvePreviewAnimation({
      directedType: "default",
      typeMapping: mapping,
      style: FACT_YELLOW,
    }).animationIn,
    "slide_up",
  );
  // マッピング指定なし → プリセット既定(fact_yellow=fade)
  assert.equal(
    resolvePreviewAnimation({
      directedType: "default",
      typeMapping: { default: { style: "fact_yellow" } },
      style: FACT_YELLOW,
    }).animationIn,
    "fade",
  );
  // fullモード(type情報なし) → プリセット既定 → timeline既定(旧名popIn=zoom互換)
  assert.equal(
    resolvePreviewAnimation({ style: { fill: { type: "solid" } }, timelineAnimationIn: "popIn" })
      .animationIn,
    "zoom",
  );
  assert.equal(resolvePreviewAnimation({ style: null }).animationIn, "none");
});

test("resolvePreviewAnimation: 再生時間ms = duration_frames ÷ fps(既定12フレーム/30fps=400ms)", () => {
  assert.equal(resolvePreviewAnimation({ style: FACT_YELLOW }).durationMs, 400);
  // box_yellowはanimation_duration_frames=9 → 9/30=300ms
  assert.equal(resolvePreviewAnimation({ style: BOX_YELLOW }).durationMs, 300);
  // fps=60なら半分の時間
  assert.equal(resolvePreviewAnimation({ style: BOX_YELLOW, fps: 60 }).durationMs, 150);
});

test("resolvePreviewSfxId: マッピングのsfx('none'=OFF明示) > プリセット既定", () => {
  // type×マッピングのsfxが最優先
  assert.equal(
    resolvePreviewSfxId({
      directedType: "default",
      typeMapping: { default: { style: "fact_yellow", sfx: "jan" } },
      style: BOX_YELLOW,
    }),
    "jan",
  );
  // マッピング未指定 → プリセット既定(box_yellow=don)
  assert.equal(
    resolvePreviewSfxId({
      directedType: "default",
      typeMapping: { default: { style: "fact_yellow" } },
      style: BOX_YELLOW,
    }),
    "don",
  );
  // "none"は「鳴らさない」の明示
  assert.equal(
    resolvePreviewSfxId({
      directedType: "default",
      typeMapping: { default: { style: "fact_yellow", sfx: "none" } },
      style: BOX_YELLOW,
    }),
    null,
  );
  // fullモード(typeなし)はプリセット既定のみ
  assert.equal(resolvePreviewSfxId({ style: BOX_YELLOW }), "don");
  assert.equal(resolvePreviewSfxId({ style: FACT_YELLOW }), null);
});

test("resolveBlockBackground: padding_x/padding_yがあるbox系のみブロック背景扱い(行帯と区別)", () => {
  assert.equal(resolveBlockBackground(BOX_YELLOW), BOX_YELLOW.background);
  // paddingなしの帯(band系)はブロック背景ではない(従来の行ごと帯)
  assert.equal(
    resolveBlockBackground({ fill: { type: "solid" }, background: { color: "#000" } }),
    null,
  );
  assert.equal(resolveBlockBackground(FACT_YELLOW), null);
  assert.equal(resolveBlockBackground(null), null);
});

test("parseLetterSpacingEm: em文字列→数値(未指定は既定0.02、不正は0)", () => {
  assert.equal(parseLetterSpacingEm("0.03em"), 0.03);
  assert.equal(parseLetterSpacingEm(undefined), 0.02);
  assert.equal(parseLetterSpacingEm("abc"), 0);
});
