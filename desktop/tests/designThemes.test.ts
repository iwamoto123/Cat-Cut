import test from "node:test";
import assert from "node:assert/strict";
import {
  DESIGN_SWATCH_SAMPLES,
  designSwatchEntries,
  findDesignTheme,
  isValidThemeName,
  resolveActiveDesignThemeId,
  sanitizeCustomStyleMap,
  sanitizeDesignScenes,
  sanitizeDesignThemes,
  standardSwatchEntries,
  STANDARD_DESIGN_THEME_ID,
  type DesignTheme,
} from "../src/lib/designThemes.ts";
import { DEFAULT_TYPE_MAPPING, SEMANTIC_TYPES } from "../src/lib/telopTypes.ts";

// フェーズU2(起動フロー=テロップデザイン選択)の純関数テスト。

// --- sanitizeDesignScenes ---

test("sanitizeDesignScenes: 正常なシーンを正規化し、type_stylesは全typeの完全形になる", () => {
  const scenes = sanitizeDesignScenes([
    {
      id: "solo",
      label: "一人語り",
      description: "説明",
      type_styles: { default: { style: "neutral_white" }, question: "question_blue" },
    },
  ]);
  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].id, "solo");
  assert.equal(scenes[0].label, "一人語り");
  // 指定したtypeは反映され、旧形式(文字列)も読める
  assert.equal(scenes[0].typeStyles.default.style, "neutral_white");
  assert.equal(scenes[0].typeStyles.question.style, "question_blue");
  // 欠落typeは既定マッピングで補完される(UIが必ず10種を描画できる)
  for (const type of SEMANTIC_TYPES) {
    assert.ok(scenes[0].typeStyles[type].style, `${type} にstyleがある`);
  }
  assert.equal(scenes[0].typeStyles.cta.style, DEFAULT_TYPE_MAPPING.cta.style);
});

test("sanitizeDesignScenes: id/label欠落・重複id・非配列は捨てる", () => {
  assert.deepEqual(sanitizeDesignScenes(null), []);
  assert.deepEqual(sanitizeDesignScenes({ scenes: [] }), []);
  const scenes = sanitizeDesignScenes([
    { id: "", label: "無効" },
    { id: "solo", label: "" },
    { id: "solo", label: "一人語り" },
    { id: "solo", label: "重複" },
    "not-an-object",
  ]);
  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].label, "一人語り");
});

// --- sanitizeDesignThemes ---

test("sanitizeDesignThemes: 配列と{themes:[...]}の両形式を読める", () => {
  const raw = {
    version: 1,
    themes: [
      {
        id: "theme_1",
        name: "対談用",
        base_scene: "dialogue",
        type_styles: { question: { style: "question_blue", animation_in: "slide_up" } },
        created_at: "2026-07-06T00:00:00Z",
        updated_at: "2026-07-06T01:00:00Z",
      },
    ],
  };
  const fromObject = sanitizeDesignThemes(raw);
  const fromArray = sanitizeDesignThemes(raw.themes);
  assert.equal(fromObject.length, 1);
  assert.deepEqual(fromObject, fromArray);
  assert.equal(fromObject[0].baseScene, "dialogue");
  assert.equal(fromObject[0].typeStyles.question.animation_in, "slide_up");
  assert.equal(fromObject[0].createdAt, "2026-07-06T00:00:00Z");
});

test("sanitizeDesignThemes: id/name欠落・重複は捨てる(壊れたuserDataでUIが落ちない)", () => {
  const themes = sanitizeDesignThemes([
    { id: "a", name: "有効" },
    { id: "a", name: "重複id" },
    { id: "", name: "id無し" },
    { id: "b", name: "" },
    null,
  ]);
  assert.equal(themes.length, 1);
  assert.equal(themes[0].name, "有効");
});

// --- アクティブテーマの解決 ---

function themeFixture(id: string): DesignTheme {
  return {
    id,
    name: `テーマ${id}`,
    baseScene: "solo",
    typeStyles: { ...DEFAULT_TYPE_MAPPING },
    createdAt: "",
    updatedAt: "",
  };
}

test("resolveActiveDesignThemeId: 実在するIDはそのまま、削除済み・未設定はスタンダードへ", () => {
  const themes = [themeFixture("t1"), themeFixture("t2")];
  assert.equal(resolveActiveDesignThemeId(themes, "t2"), "t2");
  assert.equal(resolveActiveDesignThemeId(themes, "deleted"), STANDARD_DESIGN_THEME_ID);
  assert.equal(resolveActiveDesignThemeId(themes, null), STANDARD_DESIGN_THEME_ID);
  assert.equal(resolveActiveDesignThemeId([], "t1"), STANDARD_DESIGN_THEME_ID);
});

test("findDesignTheme: ID一致のテーマを返す(空文字・未知はnull)", () => {
  const themes = [themeFixture("t1")];
  assert.equal(findDesignTheme(themes, "t1")?.id, "t1");
  assert.equal(findDesignTheme(themes, ""), null);
  assert.equal(findDesignTheme(themes, "zzz"), null);
});

// --- ミニプレビュー(スウォッチ)導出 ---

test("designSwatchEntries: 代表3種(説明・強調・質問)の見本テキスト+割当styleIdを返す", () => {
  const entries = designSwatchEntries({
    default: { style: "neutral_white" },
    emphasis: { style: "box_red" },
  });
  assert.equal(entries.length, DESIGN_SWATCH_SAMPLES.length);
  assert.deepEqual(
    entries.map((entry) => entry.type),
    ["default", "emphasis", "question"],
  );
  assert.equal(entries[0].styleId, "neutral_white");
  assert.equal(entries[1].styleId, "box_red");
  // 未指定typeは既定マッピングへフォールバック
  assert.equal(entries[2].styleId, DEFAULT_TYPE_MAPPING.question.style);
  for (const entry of entries) {
    assert.ok(entry.text.length > 0, "見本テキストがある");
  }
});

test("standardSwatchEntries: マッピング未指定なら既定マッピングのスウォッチになる", () => {
  const entries = standardSwatchEntries();
  assert.equal(entries[0].styleId, DEFAULT_TYPE_MAPPING.default.style);
  assert.equal(entries[1].styleId, DEFAULT_TYPE_MAPPING.emphasis.style);
});

// --- テーマ名バリデーション ---

test("isValidThemeName: 空・空白のみは不可", () => {
  assert.equal(isValidThemeName("対談用ポップ"), true);
  assert.equal(isValidThemeName("  "), false);
  assert.equal(isValidThemeName(""), false);
});

// --- フェーズU6: custom_styles(テーマ専属カスタムプリセット) ---

test("sanitizeDesignThemes: custom_styles はfill付き定義のみ残し、無ければ空辞書", () => {
  const themes = sanitizeDesignThemes([
    {
      id: "t1",
      name: "テーマ1",
      type_styles: {},
      custom_styles: {
        custom_t1_emphasis: { fill: { type: "solid", color: "#FF0000" }, outer_stroke2: { color: "#FFF", width: 30 } },
        broken: { font_size: 72 },
        "": { fill: { type: "solid", color: "#000" } },
      },
    },
    { id: "t2", name: "テーマ2", type_styles: {} },
  ]);
  assert.deepEqual(Object.keys(themes[0].customStyles), ["custom_t1_emphasis"]);
  assert.deepEqual(themes[0].customStyles.custom_t1_emphasis.outer_stroke2, { color: "#FFF", width: 30 });
  assert.deepEqual(themes[1].customStyles, {});
});

test("sanitizeCustomStyleMap: 非辞書・配列・fill欠落を安全に捨てる", () => {
  assert.deepEqual(sanitizeCustomStyleMap(null), {});
  assert.deepEqual(sanitizeCustomStyleMap([1, 2]), {});
  assert.deepEqual(
    Object.keys(
      sanitizeCustomStyleMap({
        ok: { fill: { type: "solid", color: "#fff" } },
        ng1: "string",
        ng2: { fill: "red" },
      }),
    ),
    ["ok"],
  );
});
