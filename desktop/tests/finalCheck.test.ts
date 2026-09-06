// W16-7: AI最終チェック(finalCheck.ts)のテスト。
// 送信ペイロード構築と、指摘→要確認パネル項目の変換(現在の本文基準の検証・無視)を担保する。
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFinalCheckScenesPayload,
  buildFinalCheckSuspicions,
  finalCheckIssueId,
  normalizeFinalCheckIssues,
  remapFinalCheckIssues,
  type FinalCheckIssue,
} from "../src/lib/finalCheck.ts";
import { initializeScenes, resetSceneIdCounterForTests, setChipsDeleted, type SourceWord } from "../src/lib/scenes.ts";
import { buildReviewHotspots } from "../src/lib/reviewHotspots.ts";
import type { SuspicionItem } from "../src/lib/suspicionQueue.ts";

function sourceWords(...specs: Array<[string, string, number, number]>): SourceWord[] {
  return specs.map(([id, text, startMs, endMs]) => ({ id, text, startMs, endMs }));
}

test.beforeEach(() => {
  resetSceneIdCounterForTests();
});

/** 2シーン(「今日は新学校です」「明日は晴れです」)を作る。 */
function buildTwoScenes() {
  const scenes = initializeScenes({
    words: sourceWords(
      ["w1", "今日は", 0, 300],
      ["w2", "新学校です", 300, 600],
      ["w3", "明日は", 1000, 1300],
      ["w4", "晴れです", 1300, 1600],
    ),
    keepSegments: [{ startMs: 0, endMs: 1600 }],
    telopPageBoundaries: [
      { startMs: 0, endMs: 600 },
      { startMs: 1000, endMs: 1600 },
    ],
  });
  assert.equal(scenes.length, 2);
  return scenes;
}

test("buildFinalCheckScenesPayload: 表示テキストのあるシーンだけを表示順で送る", () => {
  const scenes = buildTwoScenes();
  const payload = buildFinalCheckScenesPayload(scenes);
  assert.deepEqual(payload, [
    { sceneId: scenes[0].id, text: scenes[0].telopText },
    { sceneId: scenes[1].id, text: scenes[1].telopText },
  ]);
});

test("buildFinalCheckScenesPayload: 丸ごと削除済みシーンは送らない", () => {
  const scenes = buildTwoScenes();
  const updated = setChipsDeleted(scenes, scenes[0].id, scenes[0].words.map((word) => word.id), true);
  const payload = buildFinalCheckScenesPayload(updated);
  assert.equal(payload.length, 1);
  assert.equal(payload[0].sceneId, scenes[1].id);
});

test("normalizeFinalCheckIssues: snake_caseの指摘を正規化し、不正エントリは捨てる", () => {
  const issues = normalizeFinalCheckIssues([
    { scene_id: "scene_0001", surface: "新学校", suggestion: "進学校", reason: "誤変換の疑い" },
    { scene_id: "scene_0001", surface: "" },
    { scene_id: "", surface: "新学校" },
    "broken",
    { scene_id: "scene_0002", surface: "晴れ" },
  ]);
  assert.equal(issues.length, 2);
  assert.deepEqual(issues[0], {
    sceneId: "scene_0001",
    surface: "新学校",
    suggestion: "進学校",
    reason: "誤変換の疑い",
  });
  assert.equal(issues[1].reason, "表記の疑い");
  assert.equal(issues[1].suggestion, undefined);
});

test("buildFinalCheckSuspicions: 本文に残る指摘だけをSuspicionItemへ変換する", () => {
  const scenes = buildTwoScenes();
  const issues: FinalCheckIssue[] = [
    { sceneId: scenes[0].id, surface: "新学校", suggestion: "進学校", reason: "誤変換の疑い" },
    // 本文に含まれない指摘(編集で直した後など)は落ちる
    { sceneId: scenes[1].id, surface: "存在しない文字列", reason: "x" },
    // 実在しないシーンの指摘も落ちる
    { sceneId: "scene_9999", surface: "新学校", reason: "x" },
  ];
  const map = buildFinalCheckSuspicions(issues, scenes, new Set());
  assert.equal(map.size, 1);
  const items = map.get(scenes[0].id);
  assert.ok(items);
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "final_check");
  assert.equal(items[0].text, "新学校");
  assert.equal(items[0].suggestion, "進学校");
  assert.equal(items[0].timestampMs, scenes[0].sourceStartMs);
});

test("buildFinalCheckSuspicions: 「無視」済みの指摘は出さない", () => {
  const scenes = buildTwoScenes();
  const issue: FinalCheckIssue = { sceneId: scenes[0].id, surface: "新学校", reason: "x" };
  const ignored = new Set([finalCheckIssueId(issue)]);
  const map = buildFinalCheckSuspicions([issue], scenes, ignored);
  assert.equal(map.size, 0);
});

// --- W19-B2: パイプライン自動実行(auto_XXXX仮ID)の指摘を現在のシーンIDへ再マップする ---

test("remapFinalCheckIssues: 仮IDの指摘を本文一致で現在のシーンIDへ再マップする", () => {
  const scenes = buildTwoScenes();
  const inputScenes = [
    { sceneId: "auto_0001", text: scenes[0].telopText },
    { sceneId: "auto_0002", text: scenes[1].telopText },
  ];
  const issues: FinalCheckIssue[] = [
    { sceneId: "auto_0001", surface: "新学校", suggestion: "進学校", reason: "誤変換" },
    { sceneId: "auto_0002", surface: "晴れ", reason: "確認" },
  ];
  const remapped = remapFinalCheckIssues(issues, inputScenes, scenes);
  assert.equal(remapped.length, 2);
  assert.equal(remapped[0].sceneId, scenes[0].id);
  assert.equal(remapped[0].suggestion, "進学校");
  assert.equal(remapped[1].sceneId, scenes[1].id);
});

test("remapFinalCheckIssues: 現在のシーンに実在するIDはそのまま通す(手動実行の結果)", () => {
  const scenes = buildTwoScenes();
  const issues: FinalCheckIssue[] = [{ sceneId: scenes[0].id, surface: "新学校", reason: "x" }];
  const remapped = remapFinalCheckIssues(issues, [], scenes);
  assert.equal(remapped.length, 1);
  assert.equal(remapped[0].sceneId, scenes[0].id);
});

test("remapFinalCheckIssues: 対応の取れない指摘は捨てる(本文編集後・入力に無い仮ID)", () => {
  const scenes = buildTwoScenes();
  const issues: FinalCheckIssue[] = [
    // 入力側に無い仮ID
    { sceneId: "auto_9999", surface: "新学校", reason: "x" },
    // 入力本文が現在のどのシーン本文とも一致しない(編集済み)
    { sceneId: "auto_0001", surface: "新学校", reason: "x" },
  ];
  const inputScenes = [{ sceneId: "auto_0001", text: "もう書き換えられた本文" }];
  assert.deepEqual(remapFinalCheckIssues(issues, inputScenes, scenes), []);
});

test("remapFinalCheckIssues: 同一本文のシーンが複数ある場合は出現順で対応付ける", () => {
  const scenes = buildTwoScenes().map((scene) => ({ ...scene, telopText: "同じ本文" }));
  const inputScenes = [
    { sceneId: "auto_0001", text: "同じ本文" },
    { sceneId: "auto_0002", text: "同じ本文" },
  ];
  const issues: FinalCheckIssue[] = [
    { sceneId: "auto_0001", surface: "同じ", reason: "x" },
    { sceneId: "auto_0002", surface: "本文", reason: "x" },
  ];
  const remapped = remapFinalCheckIssues(issues, inputScenes, scenes);
  assert.equal(remapped.length, 2);
  assert.equal(remapped[0].sceneId, scenes[0].id);
  assert.equal(remapped[1].sceneId, scenes[1].id);
});

test("buildReviewHotspots: final_checkの指摘は編集済みシーンでも表示される", () => {
  const scenes = buildTwoScenes();
  const issue: FinalCheckIssue = { sceneId: scenes[0].id, surface: "新学校", suggestion: "進学校", reason: "誤変換" };
  const finalCheckItemsBySceneId = buildFinalCheckSuspicions([issue], scenes, new Set());
  const hotspots = buildReviewHotspots(scenes, new Map<string, SuspicionItem[]>(), {
    // シーン1は編集済み(既存疑義は除外される)だが、最終チェックは現在の本文基準なので表示する
    editedSceneIds: new Set([scenes[0].id]),
    finalCheckItemsBySceneId,
  });
  assert.equal(hotspots.length, 1);
  assert.equal(hotspots[0].scene.id, scenes[0].id);
  assert.equal(hotspots[0].items[0].type, "final_check");
});
