import test from "node:test";
import assert from "node:assert/strict";
import {
  fontProfileSceneToStyle,
  mapFontProfileToEmotionStyles,
  pickPrimaryFontProfile,
  type FontProfile,
} from "../src/lib/fontProfileTheme.ts";

/**
 * 実機のuserData(font_profiles.json)にある「字幕フォント設定」プロファイルを模したフィクスチャ。
 * M PLUS Rounded 1c / weight 900 / size 102 / グラデーション塗り #7BB8DC→#1E5DA8 / patternCount 4。
 */
const savedProfileFixture: FontProfile = {
  id: "profile-1",
  name: "字幕フォント設定",
  patternCount: 4,
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-10T00:00:00.000Z",
  directivesText: "通常/強調/注意/質問",
  scenes: {
    default: {
      font: "M PLUS Rounded 1c",
      weight: 900,
      size: 102,
      fillMode: "gradient",
      fillColor: "#FFFFFF",
      gradientFrom: "#7BB8DC",
      gradientTo: "#1E5DA8",
      strokeEnabled: true,
      innerStrokeColor: "#FFFFFF",
      innerStrokeWidth: 10,
    },
    highlight: {
      font: "M PLUS Rounded 1c",
      weight: 900,
      size: 110,
      fillMode: "solid",
      fillColor: "#FFD400",
      strokeEnabled: true,
      innerStrokeColor: "#111111",
      innerStrokeWidth: 12,
    },
    warning: {
      font: "M PLUS Rounded 1c",
      weight: 900,
      size: 108,
      fillMode: "solid",
      fillColor: "#FF3B30",
      strokeEnabled: true,
      innerStrokeColor: "#111111",
      innerStrokeWidth: 12,
    },
    question: {
      font: "M PLUS Rounded 1c",
      weight: 900,
      size: 102,
      fillMode: "solid",
      fillColor: "#4FC3F7",
      strokeEnabled: true,
      innerStrokeColor: "#111111",
      innerStrokeWidth: 10,
    },
    calm: { font: "M PLUS Rounded 1c", weight: 700, size: 96, fillMode: "solid", fillColor: "#CCCCCC" },
    simple: { font: "M PLUS Rounded 1c", weight: 700, size: 90, fillMode: "solid", fillColor: "#FFFFFF" },
  },
};

/** patternCountが少ない(3)「テスト1」相当のプロファイル(questionパターンが未定義の状態を模す)。 */
const smallProfileFixture: FontProfile = {
  id: "profile-2",
  name: "テスト1",
  patternCount: 3,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-15T00:00:00.000Z",
  directivesText: "通常/強調/注意",
  scenes: {
    default: { font: "Noto Sans JP", weight: 700, size: 80, fillMode: "solid", fillColor: "#FFFFFF" },
    highlight: { font: "Noto Sans JP", weight: 900, size: 90, fillMode: "solid", fillColor: "#FFD400" },
    warning: { font: "Noto Sans JP", weight: 900, size: 88, fillMode: "solid", fillColor: "#FF3B30" },
    question: { font: "Noto Sans JP", weight: 700, size: 80, fillMode: "solid", fillColor: "#FFFFFF" },
    calm: { font: "Noto Sans JP", weight: 700, size: 76, fillMode: "solid", fillColor: "#CCCCCC" },
    simple: { font: "Noto Sans JP", weight: 700, size: 72, fillMode: "solid", fillColor: "#FFFFFF" },
  },
};

test("pickPrimaryFontProfile: patternCountが多いプロファイルを優先して選ぶ(字幕フォント設定 > テスト1)", () => {
  const picked = pickPrimaryFontProfile([smallProfileFixture, savedProfileFixture]);
  assert.equal(picked?.id, "profile-1");
  assert.equal(picked?.name, "字幕フォント設定");
});

test("pickPrimaryFontProfile: patternCountが同数ならupdatedAtが新しい方を選ぶ", () => {
  const older: FontProfile = { ...savedProfileFixture, id: "older", updatedAt: "2026-01-01T00:00:00.000Z" };
  const newer: FontProfile = { ...savedProfileFixture, id: "newer", updatedAt: "2026-06-01T00:00:00.000Z" };
  assert.equal(pickPrimaryFontProfile([older, newer])?.id, "newer");
});

test("pickPrimaryFontProfile: プロファイルが0件ならnull", () => {
  assert.equal(pickPrimaryFontProfile([]), null);
});

test("fontProfileSceneToStyle: gradientモードはfill.gradient_from/toへ、strokeEnabledはinner_stroke/outer_strokeへ反映する(改善8-B-5: 絶対px仕様)", () => {
  const style = fontProfileSceneToStyle(savedProfileFixture.scenes.default);
  assert.deepEqual(style.fill, {
    type: "gradient",
    gradient_from: "#7BB8DC",
    gradient_to: "#1E5DA8",
    gradient_direction: "vertical",
  });
  assert.equal(style.font_size, 102, "scene.sizeをそのまま絶対font_sizeとして使う");
  assert.equal(style.font_weight, 900);
  assert.ok(style.font_family?.includes("M PLUS Rounded 1c"));
  assert.deepEqual(style.inner_stroke, { color: "#FFFFFF", width: 10 });
});

test("fontProfileSceneToStyle: solidモードはfill.colorへ反映し、sizeは動画に依存せずscene.sizeがそのままfont_sizeになる", () => {
  const style = fontProfileSceneToStyle(savedProfileFixture.scenes.highlight);
  assert.deepEqual(style.fill, { type: "solid", color: "#FFD400" });
  assert.equal(style.font_size, 110);
  assert.deepEqual(style.inner_stroke, { color: "#111111", width: 12 });
});

test(
  "mapFontProfileToEmotionStyles: 設計判断のマッピング規則(通常=default/強調=highlight/疑問=question/驚き=warningの流用)",
  () => {
    const mapped = mapFontProfileToEmotionStyles(savedProfileFixture);
    assert.equal(mapped.normal.fill.gradient_to, "#1E5DA8", "通常はdefault(グラデーション)由来");
    assert.equal(mapped.emphasis.fill.color, "#FFD400", "強調はhighlight由来");
    assert.equal(mapped.question.fill.color, "#4FC3F7", "疑問はquestion由来(シーン名が完全一致するため)");
    assert.equal(mapped.surprise.fill.color, "#FF3B30", "驚きはプロファイルに専用パターンが無いためwarning(注意)を流用");
  },
);

test("mapFontProfileToEmotionStyles: patternCount=3で questionパターンが無効な場合はwarningへフォールバックする", () => {
  const mapped = mapFontProfileToEmotionStyles(smallProfileFixture);
  // patternCount=3が有効にするのは default/highlight/warning の3つのみ(question以降は無効)。
  assert.equal(mapped.normal.fill.color, "#FFFFFF");
  assert.equal(mapped.emphasis.fill.color, "#FFD400");
  // questionはpreference [question, warning, highlight, default] のうち最初に有効なwarningへ。
  assert.equal(mapped.question.fill.color, "#FF3B30");
  // surpriseもwarningへ(questionと同じ「注意」パターンを共有する)。
  assert.equal(mapped.surprise.fill.color, "#FF3B30");
  assert.deepEqual(mapped.question, mapped.surprise);
});

test("mapFontProfileToEmotionStyles: 各パターンのfont_sizeはscene.sizeの絶対pxがそのまま反映される", () => {
  const mapped = mapFontProfileToEmotionStyles(savedProfileFixture);
  assert.equal(mapped.normal.font_size, 102);
  assert.equal(mapped.emphasis.font_size, 110, "強調(highlight)は110px");
  assert.equal(mapped.surprise.font_size, 108, "驚き(warning流用)は108px");
});
