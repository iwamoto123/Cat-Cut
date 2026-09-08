import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPreviewPlaylist,
  clampTimelineMsToPlaylist,
  compactRangesToKeepSegments,
  compactedTimelineDurationMs,
  mainEntryIndexForSourceMs,
  nextPlaylistIndex,
  opClipFlashMs,
  opClipTelopDelayMs,
  opClipTransitionMs,
  opPhasesMsFor,
  opTimelineShiftMs,
  playlistPositionForTimelineMs,
  playlistTotalDurationMs,
  resolveOpPreviewData,
  shiftTimelineCutRanges,
  shiftTimelineDurationMs,
  timelineMsForPlaylistPosition,
  type OpPreviewData,
} from "../src/lib/previewPlaylist.ts";
import { opTeaserTitleFrame, opTitleCardPhases } from "../src/lib/opTimeline.ts";
import type { TimelineCutRange } from "../src/lib/previewTimeline.ts";

/**
 * フェーズV3(OPのプレビュー再生): 仮想プレイリストの構築・写像・次エントリ探索・総尺と、
 * composition timeline.op + run正本(op_config.json)からのOPプレビューデータ解決のテスト。
 */

// 本編カット2つ。OP(6秒)がある場合のcompositionはタイムラインが6000msオフセット済み(U8仕様)
const RANGES_NO_OP: TimelineCutRange[] = [
  { sourceStartMs: 1000, sourceEndMs: 3000, timelineStartMs: 0, timelineEndMs: 2000 },
  { sourceStartMs: 5000, sourceEndMs: 6000, timelineStartMs: 2000, timelineEndMs: 3000 },
];
const RANGES_WITH_OP: TimelineCutRange[] = [
  { sourceStartMs: 1000, sourceEndMs: 3000, timelineStartMs: 6000, timelineEndMs: 8000 },
  { sourceStartMs: 5000, sourceEndMs: 6000, timelineStartMs: 8000, timelineEndMs: 9000 },
];

const TEASER_OP: OpPreviewData = {
  pattern: "highlight_teaser",
  durationMs: 6000,
  title: "タイトル",
  catchCopy: "",
  accentColor: "#16305E",
  sfxHit: "don",
  sfxTransition: null,
  clips: [
    { sourceStartMs: 1000, sourceEndMs: 3000, text: "見どころ1", style: "special_purple" },
    { sourceStartMs: 5200, sourceEndMs: 5800, text: "", style: "" },
    { sourceStartMs: 2000, sourceEndMs: 5400, text: "見どころ3", style: "" },
  ],
  decoration: "flash_pop",
  textAnimation: "slide_left",
};

const TITLE_CARD_OP: OpPreviewData = {
  pattern: "title_card",
  durationMs: 4000,
  title: "タイトル",
  catchCopy: "キャッチ",
  accentColor: "#16305E",
  sfxHit: "don",
  sfxTransition: "hyu",
  clips: [],
  decoration: "flash_pop",
  textAnimation: "slide_left",
};

test("buildPreviewPlaylist: OPなしは本編エントリのみ(TimelineCutRangeと同値=完全後方互換)", () => {
  const entries = buildPreviewPlaylist(RANGES_NO_OP, null);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    kind: "main",
    sourceStartMs: 1000,
    sourceEndMs: 3000,
    timelineStartMs: 0,
    timelineEndMs: 2000,
  });
  assert.equal(entries[1].kind, "main");
  assert.equal(playlistTotalDurationMs(entries), 3000);
});

test("buildPreviewPlaylist: highlight_teaserはクリップがOP区間[0,6000)を隙間なく埋め、本編が続く", () => {
  const entries = buildPreviewPlaylist(RANGES_WITH_OP, TEASER_OP);
  assert.equal(entries.length, 5);
  // OPクリップ: 2000ms + 600ms + 3400ms = 6000ms
  assert.deepEqual(entries[0], {
    kind: "op_clip",
    sourceStartMs: 1000,
    sourceEndMs: 3000,
    timelineStartMs: 0,
    timelineEndMs: 2000,
    opClipIndex: 0,
  });
  assert.deepEqual(entries[1], {
    kind: "op_clip",
    sourceStartMs: 5200,
    sourceEndMs: 5800,
    timelineStartMs: 2000,
    timelineEndMs: 2600,
    opClipIndex: 1,
  });
  assert.equal(entries[2].timelineEndMs, 6000);
  // 本編はcompositionのオフセット済みタイムラインをそのまま使う
  assert.equal(entries[3].kind, "main");
  assert.equal(entries[3].timelineStartMs, 6000);
  assert.equal(playlistTotalDurationMs(entries), 9000);
});

test("buildPreviewPlaylist: title_cardは静止エントリ1つ(映像なし=source両端0)+本編", () => {
  const ranges: TimelineCutRange[] = [
    { sourceStartMs: 1000, sourceEndMs: 3000, timelineStartMs: 4000, timelineEndMs: 6000 },
  ];
  const entries = buildPreviewPlaylist(ranges, TITLE_CARD_OP);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    kind: "op_static",
    sourceStartMs: 0,
    sourceEndMs: 0,
    timelineStartMs: 0,
    timelineEndMs: 4000,
  });
  assert.equal(entries[1].kind, "main");
  assert.equal(playlistTotalDurationMs(entries), 6000);
});

test("静止エントリ混在: title_card区間内の写像・次エントリ探索・本編との往復が引ける", () => {
  const ranges: TimelineCutRange[] = [
    { sourceStartMs: 1000, sourceEndMs: 3000, timelineStartMs: 4000, timelineEndMs: 6000 },
    { sourceStartMs: 5000, sourceEndMs: 6000, timelineStartMs: 6000, timelineEndMs: 7000 },
  ];
  const entries = buildPreviewPlaylist(ranges, TITLE_CARD_OP);
  // 静止エントリ(映像なし)の中へも写像できる
  assert.deepEqual(playlistPositionForTimelineMs(entries, 1500), { index: 0, offsetMs: 1500 });
  assert.equal(entries[0].kind, "op_static");
  // 静止エントリ→本編の遷移
  assert.equal(nextPlaylistIndex(entries, 0), 1);
  assert.equal(entries[1].kind, "main");
  // 往復(タイムラインms→位置→タイムラインms)が一致する
  const position = playlistPositionForTimelineMs(entries, 6500);
  assert.ok(position);
  assert.equal(timelineMsForPlaylistPosition(entries, position), 6500);
  assert.equal(playlistTotalDurationMs(entries), 7000);
});

test("playlistPositionForTimelineMs: 半開区間[start,end)で最初に一致したエントリを返す", () => {
  const entries = buildPreviewPlaylist(RANGES_WITH_OP, TEASER_OP);
  // OPクリップ1内
  assert.deepEqual(playlistPositionForTimelineMs(entries, 500), { index: 0, offsetMs: 500 });
  // クリップ境界はちょうど次エントリの先頭
  assert.deepEqual(playlistPositionForTimelineMs(entries, 2000), { index: 1, offsetMs: 0 });
  // OP終端=本編先頭
  assert.deepEqual(playlistPositionForTimelineMs(entries, 6000), { index: 3, offsetMs: 0 });
  // 本編2つ目
  assert.deepEqual(playlistPositionForTimelineMs(entries, 8500), { index: 4, offsetMs: 500 });
  // 総尺以降は区間外
  assert.equal(playlistPositionForTimelineMs(entries, 9000), null);
});

test("clampTimelineMsToPlaylist: 区間外は最寄りエントリの端へ丸める(末尾はend-1ms)", () => {
  const entries = buildPreviewPlaylist(RANGES_WITH_OP, TEASER_OP);
  // 負側→先頭エントリの頭
  assert.deepEqual(clampTimelineMsToPlaylist(entries, -100), { index: 0, offsetMs: 0 });
  // 末尾余白→最終エントリの終端-1ms
  assert.deepEqual(clampTimelineMsToPlaylist(entries, 99999), { index: 4, offsetMs: 999 });
  // 区間内はそのまま
  assert.deepEqual(clampTimelineMsToPlaylist(entries, 2600), { index: 2, offsetMs: 0 });
  assert.equal(clampTimelineMsToPlaylist([], 100), null);
});

test("timelineMsForPlaylistPosition: 再生位置→タイムラインms(オフセットはエントリ尺でクランプ)", () => {
  const entries = buildPreviewPlaylist(RANGES_WITH_OP, TEASER_OP);
  assert.equal(timelineMsForPlaylistPosition(entries, { index: 1, offsetMs: 300 }), 2300);
  assert.equal(timelineMsForPlaylistPosition(entries, { index: 1, offsetMs: 9999 }), 2600);
  assert.equal(timelineMsForPlaylistPosition(entries, { index: 99, offsetMs: 0 }), 0);
});

test("nextPlaylistIndex: 次エントリ(最終はnull)", () => {
  const entries = buildPreviewPlaylist(RANGES_WITH_OP, TEASER_OP);
  assert.equal(nextPlaylistIndex(entries, 0), 1);
  assert.equal(nextPlaylistIndex(entries, 2), 3);
  assert.equal(nextPlaylistIndex(entries, 4), null);
});

test("mainEntryIndexForSourceMs: OPクリップと同じ元動画区間でも本編側のエントリを返す", () => {
  const entries = buildPreviewPlaylist(RANGES_WITH_OP, TEASER_OP);
  // 元動画1500msはOPクリップ1(index0)にも本編カット1(index3)にも含まれるが本編を返す
  assert.equal(mainEntryIndexForSourceMs(entries, 1500), 3);
  assert.equal(mainEntryIndexForSourceMs(entries, 5500), 4);
  // どの本編カットにも属さない
  assert.equal(mainEntryIndexForSourceMs(entries, 4000), null);
});

// ---------------------------------------------------------------------------
// resolveOpPreviewData
// ---------------------------------------------------------------------------

test("resolveOpPreviewData: op無し・不正・pattern=noneはnull(OPなしrunは完全に従来動作)", () => {
  assert.equal(resolveOpPreviewData(null, RANGES_NO_OP), null);
  assert.equal(resolveOpPreviewData(undefined, RANGES_NO_OP), null);
  assert.equal(resolveOpPreviewData({ pattern: "none" }, RANGES_NO_OP), null);
  assert.equal(resolveOpPreviewData({ pattern: "title_card", duration_ms: 0 }, RANGES_NO_OP), null);
});

test("resolveOpPreviewData: V2 composition(source_start/end_ms付き)から絶対msでクリップを復元する", () => {
  const timelineOp = {
    pattern: "highlight_teaser",
    duration_ms: 4000,
    title: "T",
    catch_copy: "",
    sfx_hit: "don",
    highlight_cuts: [
      {
        file_path: "/x/segments/cut_001.mp4",
        start_ms: 0,
        end_ms: 1500,
        source_start_ms: 1200,
        source_end_ms: 2700,
        text: "A",
        style: "special_purple",
      },
      {
        file_path: "/x/segments/cut_002.mp4",
        start_ms: 100,
        end_ms: 600,
        source_start_ms: 5300,
        source_end_ms: 5800,
      },
    ],
  };
  const op = resolveOpPreviewData(timelineOp, RANGES_WITH_OP);
  assert.ok(op);
  assert.equal(op.pattern, "highlight_teaser");
  assert.deepEqual(op.clips, [
    {
      sourceStartMs: 1200, sourceEndMs: 2700, text: "A", style: "special_purple",
      // フェーズW: フックワード系メタの既定値(旧composition=verbatim表示)
      display: "verbatim", hookText: "", keyword: "", keywordColor: "yellow",
    },
    {
      sourceStartMs: 5300, sourceEndMs: 5800, text: "", style: "",
      display: "verbatim", hookText: "", keyword: "", keywordColor: "yellow",
    },
  ]);
  // teaserの尺はクリップ実尺の合計
  assert.equal(op.durationMs, 2000);
  assert.equal(op.sfxHit, "don");
});

test("resolveOpPreviewData: U8世代composition(source_*なし)はfile_pathのcut番号から逆算する", () => {
  const timelineOp = {
    pattern: "highlight_teaser",
    duration_ms: 2500,
    title: "T",
    highlight_cuts: [
      // cut_001 = RANGES_WITH_OP[0](元動画1000-3000ms)のセグメント内相対 0-2000ms
      { file_path: "/run/step08_composition/segments/cut_001.mp4", start_ms: 0, end_ms: 2000 },
      // cut_002 = RANGES_WITH_OP[1](元動画5000-6000ms)の相対 100-600ms
      { file_path: "/run/step08_composition/segments/cut_002.mp4", start_ms: 100, end_ms: 600 },
      // 対応するカットが無い番号は捨てる
      { file_path: "/run/step08_composition/segments/cut_099.mp4", start_ms: 0, end_ms: 500 },
    ],
  };
  const op = resolveOpPreviewData(timelineOp, RANGES_WITH_OP);
  assert.ok(op);
  assert.deepEqual(op.clips, [
    {
      sourceStartMs: 1000, sourceEndMs: 3000, text: "", style: "",
      display: "verbatim", hookText: "", keyword: "", keywordColor: "yellow",
    },
    {
      sourceStartMs: 5100, sourceEndMs: 5600, text: "", style: "",
      display: "verbatim", hookText: "", keyword: "", keywordColor: "yellow",
    },
  ]);
  assert.equal(op.durationMs, 2500);
});

test("resolveOpPreviewData: run正本(op_config.json)の明示クリップ・文言が適用前でも優先される", () => {
  const timelineOp = {
    pattern: "highlight_teaser",
    duration_ms: 4000,
    title: "旧タイトル",
    catch_copy: "旧キャッチ",
    highlight_cuts: [
      { file_path: "/x/cut_001.mp4", start_ms: 0, end_ms: 2000, source_start_ms: 1000, source_end_ms: 3000 },
    ],
  };
  const op = resolveOpPreviewData(timelineOp, RANGES_WITH_OP, {
    pattern: "highlight_teaser",
    title: "新タイトル",
    catch_copy: "",
    clips: [
      { start_ms: 5200, end_ms: 5900, text: "差し替え", style: "box_yellow" },
      { start_ms: 2000, end_ms: 2500, text: "", style: "" },
    ],
  });
  assert.ok(op);
  assert.equal(op.title, "新タイトル");
  // 空文字のrun設定はcompositionの値を上書きしない
  assert.equal(op.catchCopy, "旧キャッチ");
  assert.deepEqual(op.clips, [
    {
      sourceStartMs: 5200, sourceEndMs: 5900, text: "差し替え", style: "box_yellow",
      display: "verbatim", hookText: "", keyword: "", keywordColor: "yellow",
    },
    {
      sourceStartMs: 2000, sourceEndMs: 2500, text: "", style: "",
      display: "verbatim", hookText: "", keyword: "", keywordColor: "yellow",
    },
  ]);
  assert.equal(op.durationMs, 1200);
});

test("resolveOpPreviewData: V5 run正本のteaser+clips=null かつ composition旧パターンはcomposition表示のまま", () => {
  const timelineOp = {
    pattern: "title_card",
    duration_ms: 4000,
    title: "旧タイトル",
    catch_copy: "旧キャッチ",
  };
  // 旧パターンのop_configはマイグレーションでteaserになるが、明示クリップが無ければ
  // AI選定は適用しないと確定しないため、compositionの旧パターン表示を維持する(壊さない)
  const op = resolveOpPreviewData(timelineOp, RANGES_WITH_OP, {
    pattern: "highlight_teaser",
    title: "新タイトル",
    catch_copy: "新キャッチ",
    clips: null,
  });
  assert.ok(op);
  assert.equal(op.pattern, "title_card");
  assert.equal(op.title, "旧タイトル");
  assert.equal(op.catchCopy, "旧キャッチ");
});

test("resolveOpPreviewData: フェーズV5 run正本 pattern=none はcompositionにOPがあってもnull(即時反映)", () => {
  const timelineOp = {
    pattern: "highlight_teaser",
    duration_ms: 4000,
    title: "T",
    highlight_cuts: [
      { file_path: "/x/cut_001.mp4", start_ms: 0, end_ms: 2000, source_start_ms: 1000, source_end_ms: 3000 },
    ],
  };
  assert.equal(
    resolveOpPreviewData(timelineOp, RANGES_WITH_OP, {
      pattern: "none",
      title: "",
      catch_copy: "",
      clips: null,
    }),
    null,
  );
});

test("resolveOpPreviewData: フェーズV5 compositionにOPが無くてもrun正本の明示クリップでOPを組む", () => {
  const op = resolveOpPreviewData(null, RANGES_NO_OP, {
    pattern: "highlight_teaser",
    title: "新規OP",
    catch_copy: "",
    decoration: "cinema_bars",
    text_animation: "slide_up",
    clips: [{ start_ms: 1000, end_ms: 3000, text: "見どころ", style: "" }],
  });
  assert.ok(op);
  assert.equal(op.pattern, "highlight_teaser");
  assert.equal(op.durationMs, 2000);
  assert.equal(op.title, "新規OP");
  assert.equal(op.decoration, "cinema_bars");
  assert.equal(op.textAnimation, "slide_up");
  // compositionにOPが無い場合のキメ音はop_patterns.yamlの既定(don)
  assert.equal(op.sfxHit, "don");
});

test("resolveOpPreviewData: フェーズV5 decoration/text_animationはrun正本優先→composition→既定", () => {
  const timelineOp = {
    pattern: "highlight_teaser",
    duration_ms: 2000,
    title: "T",
    decoration: "color_wipe",
    text_animation: "stamp",
    highlight_cuts: [
      { file_path: "/x/cut_001.mp4", start_ms: 0, end_ms: 2000, source_start_ms: 1000, source_end_ms: 3000 },
    ],
  };
  // run正本なし: compositionの値
  const fromComposition = resolveOpPreviewData(timelineOp, RANGES_WITH_OP);
  assert.equal(fromComposition?.decoration, "color_wipe");
  assert.equal(fromComposition?.textAnimation, "stamp");
  // run正本あり: run正本の値で上書き(未知値は既定へ)
  const fromConfig = resolveOpPreviewData(timelineOp, RANGES_WITH_OP, {
    pattern: "highlight_teaser",
    title: "",
    catch_copy: "",
    decoration: "neon_frame",
    text_animation: "unknown_anim",
    clips: null,
  });
  assert.equal(fromConfig?.decoration, "neon_frame");
  assert.equal(fromConfig?.textAnimation, "slide_left");
});

test("resolveOpPreviewData: teaserでクリップが1つも復元できなければnull(OP再生なし)", () => {
  const timelineOp = {
    pattern: "highlight_teaser",
    duration_ms: 4000,
    title: "T",
    highlight_cuts: [{ file_path: "/x/segments/cut_099.mp4", start_ms: 0, end_ms: 500 }],
  };
  assert.equal(resolveOpPreviewData(timelineOp, RANGES_WITH_OP), null);
});

// ---------------------------------------------------------------------------
// OP内フェーズ(ms)計算
// ---------------------------------------------------------------------------

test("opPhasesMsFor: title_cardはRemotionのopTitleCardPhasesと同じフレーム境界のms版", () => {
  const fps = 30;
  const phases = opPhasesMsFor(TITLE_CARD_OP, fps);
  const frames = opTitleCardPhases(Math.round((4000 / 1000) * fps), fps);
  assert.equal(phases.titleMs, (frames.titleFrame / fps) * 1000);
  assert.equal(phases.catchMs, (frames.catchFrame / fps) * 1000);
  assert.equal(phases.fadeOutMs, (frames.fadeOutFrame / fps) * 1000);
  assert.ok(phases.titleMs < phases.catchMs);
  assert.ok(phases.catchMs < phases.fadeOutMs);
});

test("opPhasesMsFor: teaserはタイトル被せ(終端1.4秒前)のみ・転換フェードなし", () => {
  const fps = 30;
  const phases = opPhasesMsFor(TEASER_OP, fps);
  const durationFrames = Math.round((6000 / 1000) * fps);
  assert.equal(phases.titleMs, (opTeaserTitleFrame(durationFrames, fps) / fps) * 1000);
  assert.equal(phases.fadeOutMs, 6000);
});

test("opClipTelopDelayMs/opClipFlashMs: 白フラッシュ回避の遅延とフラッシュ長(fps換算)", () => {
  // 30fps: 0.08秒=2.4→2フレーム=約66.7ms、フラッシュ2フレーム=約66.7ms
  assert.ok(Math.abs(opClipTelopDelayMs(30) - 66.6667) < 0.01);
  assert.ok(Math.abs(opClipFlashMs(30) - 66.6667) < 0.01);
  // fps不正は既定30で計算(NaNを返さない)
  assert.ok(Number.isFinite(opClipTelopDelayMs(0)));
});

test("opClipTransitionMs: フェーズV5 装飾ごとの転換演出長(Remotionと同じフレーム計算)", () => {
  // flash系は2フレーム固定、color_wipeは約0.28秒、neon_frameは約0.2秒
  assert.ok(Math.abs(opClipTransitionMs("flash_pop", 30) - 66.6667) < 0.01);
  assert.ok(Math.abs(opClipTransitionMs("cinema_bars", 30) - 66.6667) < 0.01);
  assert.ok(Math.abs(opClipTransitionMs("color_wipe", 30) - (8 / 30) * 1000) < 0.01);
  assert.ok(Math.abs(opClipTransitionMs("neon_frame", 30) - (6 / 30) * 1000) < 0.01);
});

// ---------------------------------------------------------------------------
// フェーズV5-1: 編集後タイムライン軸への変換(opTimelineShiftMs / shiftTimelineCutRanges)
// ---------------------------------------------------------------------------

const COMPOSITION_OP_6S = {
  pattern: "highlight_teaser",
  duration_ms: 6000,
  title: "T",
  highlight_cuts: [
    { file_path: "/x/cut_001.mp4", start_ms: 0, end_ms: 6000, source_start_ms: 1000, source_end_ms: 7000 },
  ],
};

test("opTimelineShiftMs: OP尺の増加=正のシフト(クリップ追加で本編が後ろへ)", () => {
  // 編集後OP: 6000ms → 8000ms(クリップ追加)
  const op: OpPreviewData = { ...TEASER_OP, durationMs: 8000 };
  assert.equal(opTimelineShiftMs(op, COMPOSITION_OP_6S), 2000);
});

test("opTimelineShiftMs: OP尺の減少=負のシフト(クリップ削除で本編が前へ)", () => {
  const op: OpPreviewData = { ...TEASER_OP, durationMs: 3500 };
  assert.equal(opTimelineShiftMs(op, COMPOSITION_OP_6S), -2500);
});

test("opTimelineShiftMs: OPなし化(op=null)はcompositionのOP尺ぶん本編が前詰めになる", () => {
  assert.equal(opTimelineShiftMs(null, COMPOSITION_OP_6S), -6000);
});

test("opTimelineShiftMs: 適用後(編集後OP尺=compositionのOP尺)はdelta=0", () => {
  const op: OpPreviewData = { ...TEASER_OP, durationMs: 6000 };
  assert.equal(opTimelineShiftMs(op, COMPOSITION_OP_6S), 0);
});

test("opTimelineShiftMs: compositionにOPなし+run正本の新規OPは正のシフト、両方なしは0", () => {
  const op: OpPreviewData = { ...TEASER_OP, durationMs: 4000 };
  assert.equal(opTimelineShiftMs(op, null), 4000);
  assert.equal(opTimelineShiftMs(null, null), 0);
  assert.equal(opTimelineShiftMs(null, { pattern: "none" }), 0);
});

test("shiftTimelineCutRanges: timeline軸のみ平行移動しsource軸は不変。shift=0は同一配列", () => {
  const shifted = shiftTimelineCutRanges(RANGES_WITH_OP, 2000);
  assert.deepEqual(shifted, [
    { sourceStartMs: 1000, sourceEndMs: 3000, timelineStartMs: 8000, timelineEndMs: 10000 },
    { sourceStartMs: 5000, sourceEndMs: 6000, timelineStartMs: 10000, timelineEndMs: 11000 },
  ]);
  // 負のシフト(OPなし化: composition 6000ms → 0)
  const removed = shiftTimelineCutRanges(RANGES_WITH_OP, -6000);
  assert.equal(removed[0].timelineStartMs, 0);
  assert.equal(removed[1].timelineEndMs, 3000);
  // shift=0はmemo破壊を避けるため同一参照を返す
  assert.equal(shiftTimelineCutRanges(RANGES_WITH_OP, 0), RANGES_WITH_OP);
});

test("shiftTimelineCutRanges+buildPreviewPlaylist: シフト後の軸で写像の一貫性が保たれる", () => {
  // 編集後OP尺8000ms(composition 6000ms+クリップ追加2000ms)のシナリオ
  const op: OpPreviewData = {
    ...TEASER_OP,
    durationMs: 8000,
    clips: [
      { sourceStartMs: 1000, sourceEndMs: 3000, text: "", style: "" },
      { sourceStartMs: 5200, sourceEndMs: 5800, text: "", style: "" },
      { sourceStartMs: 2000, sourceEndMs: 5400, text: "", style: "" },
      { sourceStartMs: 1000, sourceEndMs: 3000, text: "", style: "" },
    ],
  };
  const shiftMs = opTimelineShiftMs(op, COMPOSITION_OP_6S);
  assert.equal(shiftMs, 2000);
  const entries = buildPreviewPlaylist(shiftTimelineCutRanges(RANGES_WITH_OP, shiftMs), op);
  // OP終端(8000ms)と本編先頭が隙間なく一致する(V5-1の重なり解消)
  assert.equal(entries[3].timelineEndMs, 8000);
  assert.equal(entries[4].kind, "main");
  assert.equal(entries[4].timelineStartMs, 8000);
  // 写像の往復も破綻しない
  const position = playlistPositionForTimelineMs(entries, 8500);
  assert.ok(position);
  assert.equal(timelineMsForPlaylistPosition(entries, position), 8500);
});

test("shiftTimelineDurationMs: 総尺の補正(未生成0はそのまま)", () => {
  assert.equal(shiftTimelineDurationMs(9000, 2000), 11000);
  assert.equal(shiftTimelineDurationMs(9000, -6000), 3000);
  assert.equal(shiftTimelineDurationMs(0, 2000), 0);
});

// --- V8追補: リップル削除(compactRangesToKeepSegments) ---

const RIPPLE_RANGES = [
  { sourceStartMs: 1000, sourceEndMs: 3000, timelineStartMs: 5000, timelineEndMs: 7000 },
  { sourceStartMs: 5000, sourceEndMs: 8000, timelineStartMs: 7000, timelineEndMs: 10000 },
  { sourceStartMs: 10000, sourceEndMs: 12000, timelineStartMs: 10000, timelineEndMs: 12000 },
];

test("compactRangesToKeepSegments: 削除なし(全区間keep)は同一配列参照を返す", () => {
  const keeps = [
    { startMs: 1000, endMs: 3000 },
    { startMs: 5000, endMs: 8000 },
    { startMs: 10000, endMs: 12000 },
  ];
  assert.equal(compactRangesToKeepSegments(RIPPLE_RANGES, keeps), RIPPLE_RANGES);
});

test("compactRangesToKeepSegments: 中間シーン削除で後続が前へ詰まる(OPオフセット維持)", () => {
  // 2番目のrange(source 5000-8000)が丸ごと削除された状態
  const keeps = [
    { startMs: 1000, endMs: 3000 },
    { startMs: 10000, endMs: 12000 },
  ];
  const result = compactRangesToKeepSegments(RIPPLE_RANGES, keeps);
  assert.equal(result.length, 2);
  // 先頭のOPオフセット(5000)は維持
  assert.deepEqual(result[0], {
    sourceStartMs: 1000, sourceEndMs: 3000, timelineStartMs: 5000, timelineEndMs: 7000,
  });
  // 後続は隙間なく前へ詰まる(旧10000開始→7000開始)
  assert.deepEqual(result[1], {
    sourceStartMs: 10000, sourceEndMs: 12000, timelineStartMs: 7000, timelineEndMs: 9000,
  });
});

test("compactRangesToKeepSegments: range内部の部分削除(チップ削除)は分裂して隙間なく連結する", () => {
  const keeps = [
    { startMs: 1000, endMs: 3000 },
    { startMs: 5000, endMs: 6000 }, // 6000-7000を削除
    { startMs: 7000, endMs: 8000 },
    { startMs: 10000, endMs: 12000 },
  ];
  const result = compactRangesToKeepSegments(RIPPLE_RANGES, keeps);
  assert.equal(result.length, 4);
  assert.equal(result[1].timelineStartMs, 7000);
  assert.equal(result[1].timelineEndMs, 8000);
  // 分裂後も隙間なし
  assert.equal(result[2].timelineStartMs, 8000);
  assert.equal(result[2].sourceStartMs, 7000);
  assert.equal(result[3].timelineStartMs, 9000);
  assert.equal(result[3].timelineEndMs, 11000);
});

test("compactRangesToKeepSegments: keepSegmentsが空(初期化前)は何もしない", () => {
  assert.equal(compactRangesToKeepSegments(RIPPLE_RANGES, []), RIPPLE_RANGES);
  assert.equal(compactRangesToKeepSegments(RIPPLE_RANGES, [], { keepSegmentsReady: false }), RIPPLE_RANGES);
});

test("compactRangesToKeepSegments: 初期化後の全カットは本編を除きOP尺だけ残す", () => {
  const result = compactRangesToKeepSegments(RIPPLE_RANGES, [], { keepSegmentsReady: true });
  assert.deepEqual(result, []);
  assert.deepEqual(buildPreviewPlaylist(result, null), []);
  assert.equal(compactedTimelineDurationMs(12000, RIPPLE_RANGES, result), 5000);
});

test("compactRangesToKeepSegments: cut単位telop_y(W24 Phase A-2)は分裂後の断片へも引き継ぐ", () => {
  const rangesWithTelopY = [
    { ...RIPPLE_RANGES[0], telopY: 0.64 },
    { ...RIPPLE_RANGES[1], telopY: 0.36 },
    { ...RIPPLE_RANGES[2] },
  ];
  const keeps = [
    { startMs: 1000, endMs: 3000 },
    { startMs: 5000, endMs: 6000 }, // 6000-7000を削除(2番目のrangeが分裂)
    { startMs: 7000, endMs: 8000 },
    { startMs: 10000, endMs: 12000 },
  ];
  const result = compactRangesToKeepSegments(rangesWithTelopY, keeps);
  assert.equal(result.length, 4);
  assert.equal(result[0].telopY, 0.64);
  assert.equal(result[1].telopY, 0.36);
  assert.equal(result[2].telopY, 0.36);
  // telopYの無いrange由来の断片はキー自体を持たない(グローバルtelop_yのまま)
  assert.ok(!("telopY" in result[3]));
});

test("compactedTimelineDurationMs: 削除で縮んだ分を総尺から引く", () => {
  const keeps = [
    { startMs: 1000, endMs: 3000 },
    { startMs: 10000, endMs: 12000 },
  ];
  const compacted = compactRangesToKeepSegments(RIPPLE_RANGES, keeps);
  // 元総尺12000から削除3000ms分が縮む
  assert.equal(compactedTimelineDurationMs(12000, RIPPLE_RANGES, compacted), 9000);
  // 無変換(同一参照)は総尺もそのまま
  assert.equal(compactedTimelineDurationMs(12000, RIPPLE_RANGES, RIPPLE_RANGES), 12000);
});
