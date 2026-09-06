import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { load as loadYamlText } from "js-yaml";
import { sanitizeDesignScenes } from "../src/lib/designThemes.ts";
import { SEMANTIC_TYPES } from "../src/lib/telopTypes.ts";
import { DIRECTED_STYLE_OPTIONS } from "../src/lib/directedTelop.ts";
import { CHAPTER_TITLE_PATTERNS } from "../src/lib/overlayStyles.ts";
import { OP_PATTERNS } from "../src/lib/designExtras.ts";

// フェーズU2-1: templates/design_scenes.yaml の整合性リント。
// - style は templates/telop_presets.yaml に実在するプリセット名のみ
// - style は UI(DIRECTED_STYLE_OPTIONS)= python ALLOWED_DIRECTIVE_STYLES の選択肢に含まれる
//   (含まれないと step08 の sanitize_style で fact_yellow に落ち、テーマの意図とズレる)
// - semantic type / animation_in / sfx は既知のIDのみ
// 将来シーンやプリセット割当を追加してもこのテストが破綻を検出する。

const TEMPLATES_DIR = path.join(import.meta.dirname, "..", "..", "templates");

function loadYaml(fileName: string): unknown {
  return loadYamlText(readFileSync(path.join(TEMPLATES_DIR, fileName), "utf-8"));
}

const ANIMATION_IN_IDS = new Set([
  "pop_big", "slide_left", "slide_up", "zoom", "stamp", "fade",
  "blur_in", "typewriter", "wipe_up", "drop_settle", "none",
]);
const SFX_IDS = new Set(["don", "shakin", "pon", "jan", "hyu", "none"]);

test("design_scenes.yaml: 動画ジャンル8種(フェーズU5)が定義されている", () => {
  const parsed = loadYaml("design_scenes.yaml") as { scenes?: unknown };
  const scenes = sanitizeDesignScenes((parsed as { scenes?: unknown[] }).scenes);
  assert.deepEqual(
    scenes.map((scene) => scene.id),
    ["solo", "business", "dialogue", "podcast", "vlog", "variety", "beauty", "game"],
  );
  for (const scene of scenes) {
    assert.ok(scene.label.length > 0, `${scene.id} に表示名がある`);
    assert.ok(scene.description.length > 0, `${scene.id} に説明がある`);
  }
});

test("design_scenes.yaml: 割当プリセットが telop_presets.yaml に実在し、UI選択肢にも含まれる", () => {
  const presetsDoc = loadYaml("telop_presets.yaml") as { presets?: Record<string, unknown> };
  const presetNames = new Set(Object.keys(presetsDoc.presets ?? {}));
  assert.ok(presetNames.size > 0, "telop_presets.yaml が読める");
  const optionIds = new Set(DIRECTED_STYLE_OPTIONS.map((option) => option.id));

  const parsed = loadYaml("design_scenes.yaml") as { scenes?: unknown[] };
  const scenes = parsed.scenes ?? [];
  assert.ok(scenes.length > 0);
  for (const rawScene of scenes as Array<{ id: string; type_styles?: Record<string, unknown> }>) {
    const typeStyles = rawScene.type_styles ?? {};
    for (const [type, rawEntry] of Object.entries(typeStyles)) {
      assert.ok(
        (SEMANTIC_TYPES as readonly string[]).includes(type),
        `${rawScene.id}.${type}: 未知のsemantic type`,
      );
      const entry = rawEntry as { style?: string; animation_in?: string; sfx?: string };
      assert.ok(entry.style, `${rawScene.id}.${type}: styleが必須`);
      assert.ok(
        presetNames.has(entry.style as string),
        `${rawScene.id}.${type}: プリセット ${entry.style} が telop_presets.yaml に無い`,
      );
      assert.ok(
        optionIds.has(entry.style as string),
        `${rawScene.id}.${type}: プリセット ${entry.style} が DIRECTED_STYLE_OPTIONS(=python許可リスト)に無い`,
      );
      if (entry.animation_in !== undefined) {
        assert.ok(
          ANIMATION_IN_IDS.has(entry.animation_in),
          `${rawScene.id}.${type}: 未知のanimation_in ${entry.animation_in}`,
        );
      }
      if (entry.sfx !== undefined) {
        assert.ok(SFX_IDS.has(entry.sfx), `${rawScene.id}.${type}: 未知のsfx ${entry.sfx}`);
      }
    }
  }
});

test("design_scenes.yaml: 全シーンが sanitize後も全typeの完全マッピングを持つ", () => {
  const parsed = loadYaml("design_scenes.yaml") as { scenes?: unknown[] };
  const scenes = sanitizeDesignScenes(parsed.scenes);
  for (const scene of scenes) {
    for (const type of SEMANTIC_TYPES) {
      assert.ok(scene.typeStyles[type].style, `${scene.id}.${type} が解決できる`);
    }
  }
});

test("design_scenes.yaml: フェーズU7 全シーンにoverlay_title既定があり、styleは既知パターン", () => {
  const parsed = loadYaml("design_scenes.yaml") as {
    scenes?: Array<{ id: string; overlay_title?: { enabled?: unknown; style?: unknown } }>;
  };
  const patternIds = new Set<string>(CHAPTER_TITLE_PATTERNS);
  for (const scene of parsed.scenes ?? []) {
    const overlayTitle = scene.overlay_title;
    assert.ok(overlayTitle, `${scene.id}: overlay_title 既定がある`);
    assert.equal(typeof overlayTitle?.enabled, "boolean", `${scene.id}: enabledがboolean`);
    assert.ok(patternIds.has(String(overlayTitle?.style)), `${scene.id}: style ${overlayTitle?.style} が既知パターン`);
  }
  // ジャンルの性格による割当(仕様書U7)の要点が維持されていること
  const byId = new Map((parsed.scenes ?? []).map((scene) => [scene.id, scene.overlay_title?.style]));
  assert.equal(byId.get("vlog"), "minimal_line");
  assert.equal(byId.get("game"), "neon_plate");
  assert.equal(byId.get("business"), "box_accent");
});

test("design_scenes.yaml: フェーズV2 全シーンにop既定があり、patternは既知ID", () => {
  const parsed = loadYaml("design_scenes.yaml") as {
    scenes?: Array<{ id: string; op?: { pattern?: unknown } }>;
  };
  const patternIds = new Set<string>(OP_PATTERNS);
  for (const scene of parsed.scenes ?? []) {
    assert.ok(scene.op, `${scene.id}: op 既定がある`);
    assert.ok(patternIds.has(String(scene.op?.pattern)), `${scene.id}: pattern ${scene.op?.pattern} が既知ID`);
  }
  // ジャンルの性格による割当(仕様書V2)の要点: 会話の熱量があるジャンルはダイジェスト既定
  const byId = new Map((parsed.scenes ?? []).map((scene) => [scene.id, scene.op?.pattern]));
  for (const genre of ["solo", "dialogue", "variety", "game"]) {
    assert.equal(byId.get(genre), "highlight_teaser", `${genre} はダイジェスト既定`);
  }
  assert.equal(byId.get("vlog"), "none");
  // sanitize後(UI側)もopがシーンの初期値として通ること
  const scenes = sanitizeDesignScenes(parsed.scenes);
  assert.equal(scenes.find((scene) => scene.id === "solo")?.op.pattern, "highlight_teaser");
});
