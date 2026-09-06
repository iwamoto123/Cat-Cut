import test from "node:test";
import assert from "node:assert/strict";
import {
  effectiveTimelineOpInfo,
  moveOpClip,
  opClipDurationLabel,
  opClipFromScene,
  opClipMidpointMs,
  opClipPlayheadMs,
  opClipsFromTimelineOp,
  opClipTimelineOffsets,
  opClipTrimBounds,
  opDurationLabel,
  sanitizeOpClips,
  sanitizeRunOpConfig,
  sceneNumberForOpClip,
  sceneNumberForOpPreviewClip,
  timelineOpInfoFromRunOpConfig,
  trimOpClipEdge,
  type OpClip,
  type RunOpConfig,
} from "../src/lib/opEditor.ts";
import type { Scene } from "../src/lib/scenes.ts";

// フェーズV2: OP編集(op_config.json)のUI側純関数を検証する。
// 正規化規則は main/index.cjs sanitizeRunOpConfig / python _normalize_op_clips と同一。

function clip(overrides: Partial<OpClip> = {}): OpClip {
  return { cut_id: "cut_001", start_ms: 1000, end_ms: 3000, text: "文言", style: "special_purple", ...overrides };
}

function scene(id: string, startMs: number, endMs: number, telopText = ""): Scene {
  return {
    id,
    sourceStartMs: startMs,
    sourceEndMs: endMs,
    words: [],
    telopText,
    telopEdited: false,
    cutMarks: [],
  };
}

test("sanitizeOpClips: 不正エントリを捨て、有効0件はnull(=AI自動選定)", () => {
  const clips = sanitizeOpClips([
    { cut_id: "cut_001", start_ms: 1000, end_ms: 3000, text: " 神回 ", style: " special_purple " },
    { cut_id: "cut_002", start_ms: 5000, end_ms: 5000 }, // 尺ゼロ
    { start_ms: "abc", end_ms: 9000 }, // 型不正
    "garbage",
  ]);
  assert.deepEqual(clips, [
    {
      cut_id: "cut_001", start_ms: 1000, end_ms: 3000, text: "神回", style: "special_purple",
      // フェーズW: フックワード系メタの既定値(旧clipsはverbatim表示)
      display: "verbatim", hook_text: "", keyword: "", keyword_color: "yellow",
    },
  ]);
  assert.equal(sanitizeOpClips([]), null);
  assert.equal(sanitizeOpClips("x"), null);
  assert.equal(sanitizeOpClips(undefined), null);
});

test("sanitizeRunOpConfig: OpConfig部分+clipsの複合正規化(後方互換=clipsなしはnull)", () => {
  const config = sanitizeRunOpConfig({
    pattern: "highlight_teaser",
    title: " T ",
    catch_copy: "C",
    clips: [{ cut_id: "c", start_ms: 0, end_ms: 1500, text: "a", style: "" }],
  });
  assert.equal(config.pattern, "highlight_teaser");
  assert.equal(config.title, "T");
  assert.equal(config.clips?.length, 1);
  // フェーズV5: 旧op_config(decoration/text_animationなし)は既定値が補われる
  assert.equal(config.decoration, "flash_pop");
  assert.equal(config.text_animation, "slide_left");
  // V2以前のop設定(clipsフィールドなし)はclips=null=AI自動選定。旧パターンはteaserへ移行
  const legacy = sanitizeRunOpConfig({ pattern: "title_card", title: "", catch_copy: "" });
  assert.equal(legacy.clips, null);
  assert.equal(legacy.pattern, "highlight_teaser");
  assert.equal(sanitizeRunOpConfig(null).pattern, "none");
});

test("opClipsFromTimelineOp: composition timeline.opのAI選定クリップを復元する", () => {
  const clips = opClipsFromTimelineOp({
    pattern: "highlight_teaser",
    duration_ms: 3500,
    highlight_cuts: [
      {
        file_path: "/run/seg_000.mp4",
        start_ms: 1000,
        end_ms: 3000,
        cut_id: "cut_001",
        source_start_ms: 1000,
        source_end_ms: 3000,
        text: "盛り上がり",
        style: "special_purple",
      },
      // V2以前のcomposition(source_*なし)のクリップは復元できないため捨てる
      { file_path: "/run/seg_001.mp4", start_ms: 0, end_ms: 1500 },
    ],
  });
  assert.deepEqual(clips, [
    {
      cut_id: "cut_001", start_ms: 1000, end_ms: 3000, text: "盛り上がり", style: "special_purple",
      display: "verbatim", hook_text: "", keyword: "", keyword_color: "yellow",
    },
  ]);
  // teaser以外・op無しは空
  assert.deepEqual(opClipsFromTimelineOp({ pattern: "title_card", duration_ms: 4000 }), []);
  assert.deepEqual(opClipsFromTimelineOp(null), []);
});

test("opClipFromScene: シーン先頭から既定2秒+テロップ1行目(シーンピッカー用変換)", () => {
  const long = opClipFromScene(scene("s1", 10000, 20000, "1行目の文言\n2行目"));
  assert.deepEqual(long, {
    cut_id: "s1", start_ms: 10000, end_ms: 12000, text: "1行目の文言", style: "",
    display: "verbatim", hook_text: "", keyword: "", keyword_color: "yellow",
  });
  // 短いシーンはシーン全体
  const short = opClipFromScene(scene("s2", 10000, 11200, ""));
  assert.equal(short.end_ms, 11200);
  assert.equal(short.text, "");
});

test("moveOpClip: 上下入れ替え(範囲外は無変更)", () => {
  const clips = [clip({ cut_id: "a" }), clip({ cut_id: "b" }), clip({ cut_id: "c" })];
  const moved = moveOpClip(clips, 2, -1);
  assert.deepEqual(moved.map((c) => c.cut_id), ["a", "c", "b"]);
  assert.equal(moveOpClip(clips, 0, -1), clips);
  assert.equal(moveOpClip(clips, 2, 1), clips);
});

test("sceneNumberForOpClip: クリップ中点が属するシーンの1始まり番号", () => {
  const scenes = [scene("s1", 0, 10000), scene("s2", 20000, 30000)];
  assert.equal(sceneNumberForOpClip(scenes, clip({ start_ms: 1000, end_ms: 3000 })), 1);
  assert.equal(sceneNumberForOpClip(scenes, clip({ start_ms: 22000, end_ms: 24000 })), 2);
  // どのシーンにも属さない(削除済みシーンのクリップ等)は null
  assert.equal(sceneNumberForOpClip(scenes, clip({ start_ms: 14000, end_ms: 16000 })), null);
});

test("opClipMidpointMs / opClipDurationLabel: 表示用の派生値", () => {
  assert.equal(opClipMidpointMs(clip({ start_ms: 1000, end_ms: 3000 })), 2000);
  assert.equal(opClipDurationLabel(clip({ start_ms: 1000, end_ms: 2500 })), "1.5秒");
});

test("V8-2 OPサマリカード用: opDurationLabel / sceneNumberForOpPreviewClip", () => {
  assert.equal(opDurationLabel(4500), "4.5秒");
  assert.equal(opDurationLabel(0), "0.0秒");
  const scenes = [scene("s1", 0, 10000), scene("s2", 20000, 30000)];
  // プレビュークリップ(元動画絶対ms)の中点でシーン番号を引く
  assert.equal(sceneNumberForOpPreviewClip(scenes, { sourceStartMs: 1000, sourceEndMs: 3000 }), 1);
  assert.equal(sceneNumberForOpPreviewClip(scenes, { sourceStartMs: 22000, sourceEndMs: 24000 }), 2);
  // どのシーンにも属さない(削除済み範囲のクリップ等)は null
  assert.equal(sceneNumberForOpPreviewClip(scenes, { sourceStartMs: 14000, sourceEndMs: 16000 }), null);
});

// --- フェーズW6: シーン検品先頭のOP行(OpClipRows)用の純関数 ---

test("opClipTimelineOffsets: クリップは前詰め連続でタイムラインに並ぶ(OP先頭=0)", () => {
  const clips = [clip({ start_ms: 1000, end_ms: 3000 }), clip({ start_ms: 9000, end_ms: 10500 })];
  assert.deepEqual(opClipTimelineOffsets(clips), [0, 2000]);
  assert.deepEqual(opClipTimelineOffsets([]), []);
});

test("opClipTrimBounds: 中点が属するシーンの範囲(なければ動画全体)", () => {
  const scenes = [scene("s1", 0, 10000), scene("s2", 20000, 30000)];
  assert.deepEqual(opClipTrimBounds(scenes, clip({ start_ms: 1000, end_ms: 3000 }), 60000), {
    minMs: 0,
    maxMs: 10000,
  });
  // どのシーンにも属さないクリップは動画全体へフォールバック
  assert.deepEqual(opClipTrimBounds(scenes, clip({ start_ms: 14000, end_ms: 16000 }), 60000), {
    minMs: 0,
    maxMs: 60000,
  });
});

test("trimOpClipEdge: 端ドラッグを尺400〜4000ms・シーン境界へクランプして適用する", () => {
  const clips = [clip({ start_ms: 2000, end_ms: 4000 }), clip({ start_ms: 9000, end_ms: 10500 })];
  const bounds = { minMs: 1000, maxMs: 12000 };
  // start端を左へ広げる(そのまま反映)
  assert.equal(trimOpClipEdge(clips, 0, "start", 1500, bounds)[0].start_ms, 1500);
  // boundsより左へは出ない
  assert.equal(trimOpClipEdge(clips, 0, "start", 200, bounds)[0].start_ms, 1000);
  // 最小尺400msを割るまでは縮められない
  assert.equal(trimOpClipEdge(clips, 0, "start", 3900, bounds)[0].start_ms, 3600);
  // end端: 最大尺4000msを超えない(start=2000 → end最大6000)
  assert.equal(trimOpClipEdge(clips, 0, "end", 9000, bounds)[0].end_ms, 6000);
  // 他クリップは不変・対象外indexや無変更は同一配列
  assert.equal(trimOpClipEdge(clips, 0, "end", 9000, bounds)[1], clips[1]);
  assert.equal(trimOpClipEdge(clips, 5, "end", 9000, bounds), clips);
  assert.equal(trimOpClipEdge(clips, 0, "end", 4000, bounds), clips);
});

test("opClipPlayheadMs: プレビューのタイムラインms→クリップ内の元動画ms", () => {
  const clips = [clip({ start_ms: 1000, end_ms: 3000 }), clip({ start_ms: 9000, end_ms: 10500 })];
  // 2つ目のクリップはタイムライン2000ms開始 → 2500msはクリップ内500ms地点
  assert.equal(opClipPlayheadMs(clips, 1, 2500), 9500);
  assert.equal(opClipPlayheadMs(clips, 0, 500), 1500);
  // 範囲外・null(本編再生中など)は null
  assert.equal(opClipPlayheadMs(clips, 0, 2500), null);
  assert.equal(opClipPlayheadMs(clips, 1, null), null);
  assert.equal(opClipPlayheadMs(clips, 9, 100), null);
});

/** テスト用のRunOpConfig(V5スキーマの既定値つき)。 */
function runConfig(overrides: Partial<RunOpConfig> = {}): RunOpConfig {
  return {
    pattern: "highlight_teaser",
    decoration: "flash_pop",
    text_animation: "slide_left",
    title: "",
    catch_copy: "",
    clips: null,
    ...overrides,
  };
}

test("timelineOpInfoFromRunOpConfig: 明示クリップのteaserのみOPブロック表示を上書きする", () => {
  const info = timelineOpInfoFromRunOpConfig(
    runConfig({
      title: "T",
      clips: [clip({ start_ms: 1000, end_ms: 3000 }), clip({ start_ms: 5000, end_ms: 6500 })],
    }),
  );
  assert.ok(info);
  assert.equal(info.pattern, "highlight_teaser");
  assert.equal(info.durationMs, 3500);
  assert.deepEqual(info.clips, [
    { label: "OP1", startMs: 0, endMs: 2000 },
    { label: "OP2", startMs: 2000, endMs: 3500 },
  ]);
  // AI自動選定(clips=null)・OPなしは上書きしない(composition表示のまま)
  assert.equal(timelineOpInfoFromRunOpConfig(runConfig({ clips: null })), null);
  assert.equal(timelineOpInfoFromRunOpConfig(runConfig({ pattern: "none", clips: [clip()] })), null);
  assert.equal(timelineOpInfoFromRunOpConfig(null), null);
});

test("effectiveTimelineOpInfo: フェーズV5-1 run正本を表示の正とする", () => {
  const compositionOp = {
    pattern: "highlight_teaser",
    duration_ms: 4000,
    title: "C",
    highlight_cuts: [{ file_path: "seg.mp4", start_ms: 0, end_ms: 4000 }],
  };
  // pattern=none: compositionにOPが残っていてもブロックを消す(OPなし化の即時反映)
  assert.equal(effectiveTimelineOpInfo(runConfig({ pattern: "none" }), compositionOp), null);
  // 明示クリップ: run正本のクリップ数・尺でブロックを組む
  const explicit = effectiveTimelineOpInfo(
    runConfig({ clips: [clip({ start_ms: 1000, end_ms: 3000 })] }),
    compositionOp,
  );
  assert.equal(explicit?.durationMs, 2000);
  // AI自動選定(clips=null)はcomposition表示に任せる
  const auto = effectiveTimelineOpInfo(runConfig({ clips: null }), compositionOp);
  assert.equal(auto?.durationMs, 4000);
  // run正本なし(旧経路)もcomposition表示
  assert.equal(effectiveTimelineOpInfo(null, compositionOp)?.durationMs, 4000);
});
