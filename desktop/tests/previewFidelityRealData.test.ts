/**
 * フェーズU1(プレビュー忠実化): 実データrun(directed実行・オーバーレイ8件・172テロップ)を使った
 * タイムライン写像・スロット選択・スタイル解決の統合確認。実APIは呼ばない。
 *
 * main/index.cjs の buildTimelineCutRanges / buildTelopPageBoundaries と同じ組み立てを
 * composition.json + cut_proposal.json から再現し、レンダラー側の純関数
 * (previewTimeline / previewTelop / scenes)が書き出しと同じ値を返すことを検証する。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  activeOverlaysAtSourceMs,
  sanitizeTimelineCutRanges,
  sourceMsToTimelineMs,
  timelineMsToSourceMs,
} from "../src/lib/previewTimeline.ts";
import { normalizeOverlays } from "../src/lib/overlayItems.ts";
import {
  filterHighlightWords,
  resolveDirectedSceneStyle,
  resolvePreviewAnimation,
} from "../src/lib/previewTelop.ts";
import { DEFAULT_TYPE_MAPPING, SEMANTIC_TYPES } from "../src/lib/telopTypes.ts";
import {
  findSceneIndexAtMs,
  initializeScenes,
  resetSceneIdCounterForTests,
  type SourceWord,
  type TelopPageBoundary,
} from "../src/lib/scenes.ts";
import type { TelopStyleDef } from "../src/lib/telopThemes.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runDir = path.resolve(
  __dirname,
  "../../runs/20260706_012849_笠井俊哉くん_山口県立大学_夏期講習の感想インタビュー",
);

function readJson(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

const composition = readJson(path.join(runDir, "step08_composition", "composition.json"));
const proposal = readJson(path.join(runDir, "step07_cut_proposal", "cut_proposal.json"));
const stt = readJson(path.join(runDir, "step02b_transcript_correct", "stt_corrected.json"));

const timeline = composition.timeline;
const keepSegments: Array<{ startMs: number; endMs: number }> = proposal.keep_segments.map(
  (segment: any) => ({ startMs: Number(segment.start_ms || 0), endMs: Number(segment.end_ms || 0) }),
);
const compositionStyles = timeline.telop_styles as Record<string, TelopStyleDef>;

/** main/index.cjs buildTimelineCutRanges と同じ対応表(timeline.cuts[i] ↔ keep_segments[i])。 */
function buildTimelineCutRanges(): unknown {
  return (timeline.cuts as any[]).map((cut, index) => ({
    sourceStartMs: keepSegments[index]?.startMs,
    sourceEndMs: keepSegments[index]?.endMs,
    timelineStartMs: Number(cut?.timeline?.start_ms),
    timelineEndMs: Number(cut?.timeline?.end_ms),
  }));
}

/** main/index.cjs buildTelopPageBoundaries(directed分岐)と同じスロット境界の組み立て。 */
function buildDirectedPageBoundaries(): TelopPageBoundary[] {
  const boundaries: TelopPageBoundary[] = [];
  (composition.voice_data.cuts as any[]).forEach((cut, index) => {
    const segment = keepSegments[index];
    if (!segment) return;
    for (const telop of cut.telops ?? []) {
      const startMs = segment.startMs + Math.round(Number(telop.start) * 1000);
      const endMs = segment.startMs + Math.round(Number(telop.end) * 1000);
      if (endMs <= startMs) continue;
      const styleId = telop.style ? String(telop.style) : "";
      const typeId =
        typeof telop.type === "string" && (SEMANTIC_TYPES as readonly string[]).includes(telop.type)
          ? telop.type
          : "";
      const highlightWords = Array.isArray(telop.highlight_words)
        ? telop.highlight_words.map(String).filter(Boolean)
        : [];
      boundaries.push({
        startMs,
        endMs,
        ...(telop.text ? { text: String(telop.text) } : {}),
        ...(styleId ? { styleId } : {}),
        ...(typeId ? { typeId } : {}),
        ...(telop.style_overridden ? { styleOverridden: true } : {}),
        ...(styleId && highlightWords.length ? { highlightWords } : {}),
      });
    }
  });
  return boundaries.sort((a, b) => a.startMs - b.startMs);
}

test("実データ前提: directed run・95カット・オーバーレイ8件", () => {
  assert.equal(composition.meta.telop_mode, "directed");
  assert.equal(timeline.cuts.length, 95);
  assert.equal(keepSegments.length, 95);
  assert.equal(normalizeOverlays(timeline.overlays).length, 8);
});

test("U1-5(実データ): 元動画ms→タイムラインmsの写像がtimeline.cutsと一致する", () => {
  const ranges = sanitizeTimelineCutRanges(buildTimelineCutRanges());
  assert.equal(ranges.length, 95);
  // 先頭カット: 元動画340ms(keep_segments[0].start) = タイムライン0ms
  assert.equal(sourceMsToTimelineMs(ranges, 340), 0);
  // 2番目カット: 元動画15560ms = タイムライン14750ms(cut_002.timeline.start_ms)
  assert.equal(sourceMsToTimelineMs(ranges, 15560), 14750);
  // カット間の除去区間(15090〜15560)は写像不能
  assert.equal(sourceMsToTimelineMs(ranges, 15200), null);
  assert.equal(sourceMsToTimelineMs(ranges, 100), null);
  // 逆写像との往復一致
  for (const sourceMs of [340, 10000, 15560, 17000]) {
    const timelineMs = sourceMsToTimelineMs(ranges, sourceMs);
    assert.notEqual(timelineMs, null, `sourceMs=${sourceMs}が写像不能`);
    assert.equal(timelineMsToSourceMs(ranges, timelineMs!), sourceMs);
  }
});

test("U1-5(実データ): 再生位置でのオーバーレイ表示判定(章見出し・プロフィールカード)", () => {
  const ranges = sanitizeTimelineCutRanges(buildTimelineCutRanges());
  const overlays = normalizeOverlays(timeline.overlays);
  // 冒頭(タイムライン0ms): 第1章見出し + プロフィールカードが同時表示
  assert.deepEqual(
    activeOverlaysAtSourceMs(overlays, ranges, 340).map((item) => item.id),
    ["chapter_01", "ov_profile_card_00"],
  );
  // 第2章開始(タイムライン50560ms)の直後は chapter_02 のみ
  const chapter2SourceMs = timelineMsToSourceMs(ranges, 50560);
  assert.notEqual(chapter2SourceMs, null);
  assert.deepEqual(
    activeOverlaysAtSourceMs(overlays, ranges, chapter2SourceMs! + 1).map((item) => item.id),
    ["chapter_02"],
  );
});

test("U1-4(実データ): 1シーン=1スロット初期化と再生時刻ベースのスロット選択", () => {
  resetSceneIdCounterForTests();
  const boundaries = buildDirectedPageBoundaries();
  assert.equal(boundaries.length, 172); // 全95カットの合計スロット数
  const words: SourceWord[] = stt.words.map((word: any) => ({
    id: String(word.id),
    text: String(word.text || ""),
    startMs: Number(word.start_ms || 0),
    endMs: Number(word.end_ms || 0),
  }));
  const scenes = initializeScenes({ words, keepSegments, telopPageBoundaries: boundaries });
  assert.equal(scenes.length, 172, "1シーン=1スロットで初期化されるはず");

  // cut_001は4スロット。p00区間(340+0ms〜340+3840ms)の途中では p00 の文言・typeが選ばれる
  const p00Index = findSceneIndexAtMs(scenes, 1500);
  assert.notEqual(p00Index, -1);
  assert.equal(scenes[p00Index].telopText, "白谷塾オンライン教室の夏期講習");
  assert.equal(scenes[p00Index].directedType, "default");
  assert.deepEqual(scenes[p00Index].directedHighlightWords, ["白谷塾オンライン教室", "夏期講習"]);

  // p01区間(340+3840ms〜)へ再生が進むとスロットが切り替わる
  const p01Index = findSceneIndexAtMs(scenes, 340 + 3840 + 500);
  assert.equal(scenes[p01Index].telopText, "参加を迷ってる人に向けて");
  assert.equal(p01Index, p00Index + 1);
});

test("U1-1(実データ): 全172スロットのスタイル解決が書き出し(telops[].style)と一致する", () => {
  resetSceneIdCounterForTests();
  (composition.voice_data.cuts as any[]).forEach((cut) => {
    for (const telop of cut.telops ?? []) {
      // buildScene と同じ規則でシーンのdirectedフィールドを再現する
      // (typeあり・上書きなしのスロットは directedStyleId を持たず type×マッピングで解決)
      const typeId =
        typeof telop.type === "string" && (SEMANTIC_TYPES as readonly string[]).includes(telop.type)
          ? telop.type
          : null;
      const scene = {
        directedStyleId: telop.style_overridden || !typeId ? String(telop.style) : null,
        directedType: typeId,
      };
      const resolved = resolveDirectedSceneStyle(scene, DEFAULT_TYPE_MAPPING, compositionStyles);
      assert.equal(
        resolved,
        compositionStyles[String(telop.style)],
        `${telop.id}: 解決結果が書き出しスタイル(${telop.style})と一致しない`,
      );
    }
  });
});

test("U1-2/U1-6(実データ): highlight_wordsは全て文言に実在し、アニメはプリセット既定へ解決される", () => {
  let highlightCount = 0;
  (composition.voice_data.cuts as any[]).forEach((cut) => {
    for (const telop of cut.telops ?? []) {
      if (Array.isArray(telop.highlight_words) && telop.highlight_words.length) {
        highlightCount += 1;
        // python側検証済みの実データでは filterHighlightWords が全語を素通しする
        assert.deepEqual(
          filterHighlightWords(telop.highlight_words, String(telop.text)),
          telop.highlight_words,
          `${telop.id}: highlight_wordsに文言未収載の語がある`,
        );
      }
    }
  });
  assert.equal(highlightCount, 48);

  // cut_001_p00(fact_yellow)はtelop個別のanimation_inがnull → プリセット既定 "fade"(12f/30fps=400ms)
  const animation = resolvePreviewAnimation({
    directedType: "default",
    typeMapping: DEFAULT_TYPE_MAPPING,
    style: compositionStyles.fact_yellow,
    timelineAnimationIn: String(timeline.animation_in || "none"),
    fps: Number(timeline.fps || 30),
  });
  assert.equal(animation.animationIn, "fade");
  assert.equal(animation.durationMs, 400);
});
