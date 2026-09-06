import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { load as loadYamlText } from "js-yaml";
import {
  CHAPTER_TITLE_PATTERN_INFO,
  DEFAULT_OP_CONFIG,
  DEFAULT_OVERLAY_TITLE,
  DEFAULT_VIDEO_EFFECTS,
  OP_PATTERN_INFO,
  OP_PATTERNS,
  sanitizeOpConfig,
  sanitizeOverlayTitle,
  sanitizeVideoEffects,
} from "../src/lib/designExtras.ts";
import {
  CHAPTER_TITLE_FILTER,
  CHAPTER_TITLE_PATTERNS,
  CHAPTER_TITLE_DEFAULTS,
  chapterTitleRenderSpec,
  chapterTitleTextSpec,
  resolveChapterTitlePattern,
} from "../src/lib/overlayStyles.ts";

// フェーズU7/U8: シーンタイトル・OP設定の正規化とパターン定義の整合性リント。

test("sanitizeOverlayTitle: 欠落・不正は有効box_accent(従来挙動=後方互換)", () => {
  assert.deepEqual(sanitizeOverlayTitle(undefined), { enabled: true, style: "box_accent" });
  assert.deepEqual(sanitizeOverlayTitle(null), DEFAULT_OVERLAY_TITLE);
  assert.deepEqual(sanitizeOverlayTitle("box_accent"), DEFAULT_OVERLAY_TITLE);
  assert.deepEqual(sanitizeOverlayTitle({ style: "unknown_pattern" }), DEFAULT_OVERLAY_TITLE);
});

test("sanitizeOverlayTitle: enabled=falseと正しいパターンIDは保持される", () => {
  assert.deepEqual(sanitizeOverlayTitle({ enabled: false, style: "neon_plate" }), {
    enabled: false,
    style: "neon_plate",
  });
  for (const pattern of CHAPTER_TITLE_PATTERNS) {
    assert.equal(sanitizeOverlayTitle({ style: pattern }).style, pattern);
  }
});

test("sanitizeOpConfig: 欠落・不正はpattern=none(OPなし=後方互換)", () => {
  assert.deepEqual(sanitizeOpConfig(undefined), DEFAULT_OP_CONFIG);
  assert.deepEqual(sanitizeOpConfig(null), DEFAULT_OP_CONFIG);
  assert.deepEqual(sanitizeOpConfig({ pattern: "invalid" }), DEFAULT_OP_CONFIG);
});

test("sanitizeOpConfig: pattern/title/catch_copyの保持とtrim・camelCase互換", () => {
  const config = sanitizeOpConfig({ pattern: "highlight_teaser", title: " 猫の話 ", catch_copy: " 知ってた? " });
  assert.deepEqual(config, {
    pattern: "highlight_teaser",
    decoration: "flash_pop",
    text_animation: "slide_left",
    title: "猫の話",
    title_enabled: true,
    catch_copy: "知ってた?",
  });
  // UI(camelCase)からの入力も受ける
  assert.equal(sanitizeOpConfig({ pattern: "highlight_teaser", catchCopy: "なぜ?" }).catch_copy, "なぜ?");
  for (const pattern of OP_PATTERNS) {
    assert.equal(sanitizeOpConfig({ pattern }).pattern, pattern);
  }
});

test("W13-3 sanitizeOpConfig: プレースホルダ的文言は空へ正規化(タイトル・キャッチコピー)", () => {
  for (const placeholder of ["タイトルテキスト", "タイトルテスト", " タイトルテキスト "]) {
    assert.equal(sanitizeOpConfig({ pattern: "highlight_teaser", title: placeholder }).title, "");
  }
  assert.equal(sanitizeOpConfig({ pattern: "highlight_teaser", catch_copy: "キャッチコピー" }).catch_copy, "");
  // 部分一致では消えない(「タイトルテキストの話」等の実タイトルは保持)
  assert.equal(
    sanitizeOpConfig({ pattern: "highlight_teaser", title: "タイトルテキストの話" }).title,
    "タイトルテキストの話"
  );
});

test("W11-5 sanitizeOpConfig: title_enabledは明示falseのみ無効(省略・不正値はtrue=後方互換)", () => {
  assert.equal(sanitizeOpConfig({ pattern: "highlight_teaser", title_enabled: false }).title_enabled, false);
  assert.equal(sanitizeOpConfig({ pattern: "highlight_teaser" }).title_enabled, true);
  assert.equal(sanitizeOpConfig({ pattern: "highlight_teaser", title_enabled: "x" }).title_enabled, true);
});

test("sanitizeOpConfig: フェーズV5 旧パターンはhighlight_teaserへ無警告マイグレーション", () => {
  assert.equal(sanitizeOpConfig({ pattern: "title_card", title: "T" }).pattern, "highlight_teaser");
  assert.equal(sanitizeOpConfig({ pattern: "question_hook" }).pattern, "highlight_teaser");
  // 旧op_config(decoration/text_animationなし)は既定値へ落ちる
  const migrated = sanitizeOpConfig({ pattern: "title_card", title: "T" });
  assert.equal(migrated.decoration, "flash_pop");
  assert.equal(migrated.text_animation, "slide_left");
});

test("sanitizeOpConfig: フェーズV5 decoration/text_animationの保持と未知値の既定化", () => {
  const config = sanitizeOpConfig({
    pattern: "highlight_teaser",
    decoration: "neon_frame",
    text_animation: "stamp",
  });
  assert.equal(config.decoration, "neon_frame");
  assert.equal(config.text_animation, "stamp");
  const fallback = sanitizeOpConfig({
    pattern: "highlight_teaser",
    decoration: "sparkle",
    text_animation: "spin",
  });
  assert.equal(fallback.decoration, "flash_pop");
  assert.equal(fallback.text_animation, "slide_left");
});

// --- フェーズW2: シーン映像ギミック(video_effects)設定 ---

test("sanitizeVideoEffects: 欠落・不正はpinch/zoomのみON(既定=後方互換。新3種はOFF)", () => {
  const defaults = { pinch: true, zoom: true, dim: false, face_zoom: false, slow_push: false };
  assert.deepEqual(sanitizeVideoEffects(undefined), DEFAULT_VIDEO_EFFECTS);
  assert.deepEqual(sanitizeVideoEffects(null), defaults);
  assert.deepEqual(sanitizeVideoEffects("bad"), defaults);
  assert.deepEqual(sanitizeVideoEffects([]), defaults);
  assert.deepEqual(sanitizeVideoEffects({}), defaults);
});

test("sanitizeVideoEffects: pinch/zoomは明示的なfalseだけがOFFになる", () => {
  assert.deepEqual(
    sanitizeVideoEffects({ pinch: false }),
    { pinch: false, zoom: true, dim: false, face_zoom: false, slow_push: false },
  );
  assert.deepEqual(
    sanitizeVideoEffects({ zoom: false }),
    { pinch: true, zoom: false, dim: false, face_zoom: false, slow_push: false },
  );
  assert.deepEqual(
    sanitizeVideoEffects({ pinch: false, zoom: false }),
    { pinch: false, zoom: false, dim: false, face_zoom: false, slow_push: false },
  );
  // truthyだがboolean以外の値は既定ONのまま(0やnullでOFFにしない)
  assert.deepEqual(sanitizeVideoEffects({ pinch: 0, zoom: null }), DEFAULT_VIDEO_EFFECTS);
});

test("sanitizeVideoEffects(W24 Phase C): 新3種は明示的なtrueだけがONになる", () => {
  assert.deepEqual(
    sanitizeVideoEffects({ dim: true, face_zoom: true, slow_push: true }),
    { pinch: true, zoom: true, dim: true, face_zoom: true, slow_push: true },
  );
  assert.deepEqual(
    sanitizeVideoEffects({ dim: true }),
    { pinch: true, zoom: true, dim: true, face_zoom: false, slow_push: false },
  );
  // truthyだがboolean以外の値・falseは既定OFFのまま(既存run・既存テーマの従来動作を維持)
  assert.deepEqual(
    sanitizeVideoEffects({ dim: 1, face_zoom: "on", slow_push: false }),
    DEFAULT_VIDEO_EFFECTS,
  );
});

test("パターン表示情報が全IDを網羅している(UIカードの取りこぼし防止)", () => {
  for (const pattern of CHAPTER_TITLE_PATTERNS) {
    assert.ok(CHAPTER_TITLE_PATTERN_INFO[pattern]?.label, `title pattern ${pattern} にラベルがある`);
  }
  for (const pattern of OP_PATTERNS) {
    assert.ok(OP_PATTERN_INFO[pattern]?.label, `op pattern ${pattern} にラベルがある`);
  }
});

// --- chapterTitleRenderSpec(U7の描画計画) ---

test("resolveChapterTitlePattern: 未知・欠落はbox_accent", () => {
  assert.equal(resolveChapterTitlePattern(undefined), "box_accent");
  assert.equal(resolveChapterTitlePattern("fact_yellow"), "box_accent"); // 旧preset名は既定へ
  assert.equal(resolveChapterTitlePattern("neon_plate"), "neon_plate");
});

test("chapterTitleRenderSpec: box_accentは現行デザインと完全一致(後方互換)", () => {
  const spec = chapterTitleRenderSpec("box_accent", 0.5, CHAPTER_TITLE_DEFAULTS);
  assert.equal(spec.container.filter, CHAPTER_TITLE_FILTER);
  assert.equal(spec.plate, null);
  assert.equal(spec.underline, null);
  assert.deepEqual(spec.text, chapterTitleTextSpec(0.5, CHAPTER_TITLE_DEFAULTS));
});

test("chapterTitleRenderSpec: 各パターンが描画可能な計画を返す", () => {
  for (const pattern of CHAPTER_TITLE_PATTERNS) {
    const spec = chapterTitleRenderSpec(pattern, 1, CHAPTER_TITLE_DEFAULTS);
    assert.ok(spec.text.fontSize > 0, `${pattern}: fontSize`);
    assert.ok(spec.text.fontFamily.length > 0, `${pattern}: fontFamily`);
    assert.ok(spec.text.fillColor.length > 0, `${pattern}: fillColor`);
  }
  // 帯・タグ・ネオンは座布団(plate)、ミニマルはアンダーラインを持つ
  assert.ok(chapterTitleRenderSpec("band_gradient", 1, CHAPTER_TITLE_DEFAULTS).plate);
  assert.ok(chapterTitleRenderSpec("tag_ribbon", 1, CHAPTER_TITLE_DEFAULTS).plate);
  assert.ok(chapterTitleRenderSpec("neon_plate", 1, CHAPTER_TITLE_DEFAULTS).plate);
  assert.ok(chapterTitleRenderSpec("minimal_line", 1, CHAPTER_TITLE_DEFAULTS).underline);
});

// --- templates/op_patterns.yaml の整合性リント ---

const TEMPLATES_DIR = path.join(import.meta.dirname, "..", "..", "templates");
const SFX_IDS = new Set(["don", "shakin", "pon", "jan", "hyu"]);

test("op_patterns.yaml: UIの2択+旧パターン(後方互換)を含み、尺・SFXが設計指針の範囲", () => {
  const parsed = loadYamlText(readFileSync(path.join(TEMPLATES_DIR, "op_patterns.yaml"), "utf-8")) as {
    patterns?: Array<Record<string, unknown>>;
  };
  const entries = parsed.patterns ?? [];
  const yamlIds = new Set(entries.map((entry) => String(entry.id)));
  // V5: UIは2択だが、YAMLは旧パターン(title_card / question_hook)を既存run互換のため残す
  for (const pattern of OP_PATTERNS) {
    assert.ok(yamlIds.has(pattern), `UIパターン ${pattern} がYAMLに存在する`);
  }
  for (const legacy of ["title_card", "question_hook"]) {
    assert.ok(yamlIds.has(legacy), `旧パターン ${legacy} が後方互換のためYAMLに残っている`);
  }
  for (const entry of entries) {
    const id = String(entry.id);
    assert.ok(String(entry.label ?? "").length > 0, `${id}: labelがある`);
    assert.ok(String(entry.description ?? "").length > 0, `${id}: descriptionがある`);
    if (id === "none") continue;
    if (entry.duration_ms !== undefined) {
      const duration = Number(entry.duration_ms);
      // ネット調査の設計指針: OPは3〜7秒
      assert.ok(duration >= 3000 && duration <= 7000, `${id}: 尺${duration}msが3〜7秒`);
    }
    if (entry.sfx_hit !== undefined) assert.ok(SFX_IDS.has(String(entry.sfx_hit)), `${id}: sfx_hit`);
    if (entry.sfx_transition !== undefined) {
      assert.ok(SFX_IDS.has(String(entry.sfx_transition)), `${id}: sfx_transition`);
    }
    if (id === "highlight_teaser") {
      // フェーズW(OP 0ベース再設計): 3〜5クリップ・合計10〜15秒で統一
      const minMs = Number(entry.clip_min_ms);
      const maxMs = Number(entry.clip_max_ms);
      const maxClips = Number(entry.max_clips);
      const targetTotalMs = Number(entry.target_total_ms);
      assert.ok(minMs >= 1000 && maxMs <= 3500 && minMs < maxMs, `${id}: クリップ尺1〜3.5秒`);
      assert.ok(maxClips >= 3 && maxClips <= 5, `${id}: 最大クリップ数3〜5`);
      // 1クリップ上限=target_total/クリップ数で合計は常にtarget以下(10〜15秒)
      assert.ok(targetTotalMs >= 10000 && targetTotalMs <= 15000, `${id}: 合計目標10〜15秒`);
    }
  }
});
