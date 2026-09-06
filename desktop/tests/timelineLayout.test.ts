import test from "node:test";
import assert from "node:assert/strict";
import type { TimelineCutRange } from "../src/lib/previewTimeline.ts";
import {
  buildRulerTicks,
  clampPxPerMs,
  clampZoomFactor,
  fitPxPerMs,
  formatTimelineMs,
  maxZoomFactor,
  nearestFilmstripFrame,
  normalizeTimelineOp,
  resolveTimelineTotalMs,
  sceneTimelineBlocks,
  seekSourceMsForTimelineMs,
  TIMELINE_MAX_PX_PER_MS,
  zoomedScrollLeft,
  zoomFactorForSliderRatio,
  zoomFactorToPxPerMs,
  zoomSliderRatio,
} from "../src/lib/timelineLayout.ts";

// フェーズV1(統合タイムラインView): 座標計算・ズーム・ルーラー・ブロック写像のテスト。

// OPあり(先頭4000msオフセット)を模した対応表: 元動画[1000,5000)→TL[4000,8000)、
// 元動画[10000,16000)→TL[8000,14000)。
const RANGES: TimelineCutRange[] = [
  { sourceStartMs: 1000, sourceEndMs: 5000, timelineStartMs: 4000, timelineEndMs: 8000 },
  { sourceStartMs: 10000, sourceEndMs: 16000, timelineStartMs: 8000, timelineEndMs: 14000 },
];

// --- 総尺の解決 ---

test("resolveTimelineTotalMs: composition総尺を最優先する", () => {
  assert.equal(resolveTimelineTotalMs(20000, RANGES, [15000]), 20000);
});

test("resolveTimelineTotalMs: 総尺0はカット対応表・BGM末尾から推定する", () => {
  assert.equal(resolveTimelineTotalMs(0, RANGES, []), 14000);
  assert.equal(resolveTimelineTotalMs(0, RANGES, [30000]), 30000);
});

test("resolveTimelineTotalMs: 手がかりゼロは60秒の既定値", () => {
  assert.equal(resolveTimelineTotalMs(0, [], []), 60000);
});

// --- ズーム倍率 ---

test("fitPxPerMs: ビューポート幅に総尺が収まる倍率", () => {
  assert.equal(fitPxPerMs(60000, 600), 0.01);
});

test("clampPxPerMs: フィット未満へは縮小しない・上限を超えない", () => {
  assert.equal(clampPxPerMs(0.001, 60000, 600), 0.01);
  assert.equal(clampPxPerMs(9, 60000, 600), TIMELINE_MAX_PX_PER_MS);
  assert.equal(clampPxPerMs(0.05, 60000, 600), 0.05);
});

test("zoomedScrollLeft: カーソル直下のmsを保つ", () => {
  // scrollLeft=100, cursor=50 → ms=(100+50)/0.01=15000。2倍ズーム後: 15000*0.02-50=250
  assert.equal(zoomedScrollLeft(50, 100, 0.01, 0.02), 250);
  // 左端より手前になる場合は0へクランプ
  assert.equal(zoomedScrollLeft(50, 0, 0.01, 0.005), 0);
});

// --- V6-1: フィット基準のズーム係数 ---

test("maxZoomFactor: フィット→最大倍率の比(60秒/600pxならfit=0.01→上限0.1で10倍)", () => {
  assert.equal(maxZoomFactor(60000, 600), 10);
  // 短い動画(フィットが絶対上限0.1px/ms以上)でも最低8倍まではズームインできる
  // (旧仕様の「拡大余地なし=1」だと4秒動画等でピンチ・スライダー・±が全て無反応になる)
  assert.equal(maxZoomFactor(1000, 600), 8);
  assert.equal(maxZoomFactor(4000, 1000), 8);
  // ビューポート未計測(幅0)でも1以上を返す(ゼロ除算・負値にならない)
  assert.ok(maxZoomFactor(60000, 0) >= 1);
});

test("clampZoomFactor: 下限1.0(全体フィット)〜上限maxZoomFactorへ丸める", () => {
  assert.equal(clampZoomFactor(0.2, 60000, 600), 1);
  assert.equal(clampZoomFactor(99, 60000, 600), 10);
  assert.equal(clampZoomFactor(3, 60000, 600), 3);
  assert.equal(clampZoomFactor(Number.NaN, 60000, 600), 1);
});

test("zoomFactorToPxPerMs: 係数1.0=フィット、上限係数=TIMELINE_MAX_PX_PER_MS", () => {
  assert.equal(zoomFactorToPxPerMs(1, 60000, 600), fitPxPerMs(60000, 600));
  assert.equal(zoomFactorToPxPerMs(10, 60000, 600), TIMELINE_MAX_PX_PER_MS);
  // ズームアウト方向にどれだけ小さい係数を渡しても必ずフィットへ戻れる(V6-1の不具合修正の核心)
  assert.equal(zoomFactorToPxPerMs(0.0001, 60000, 600), fitPxPerMs(60000, 600));
});

test("zoomSliderRatio/zoomFactorForSliderRatio: 対数マッピングの往復が一致する", () => {
  const maxFactor = 10;
  assert.equal(zoomSliderRatio(1, maxFactor), 0);
  assert.equal(zoomSliderRatio(10, maxFactor), 100);
  const factor = zoomFactorForSliderRatio(50, maxFactor);
  assert.ok(Math.abs(zoomSliderRatio(factor, maxFactor) - 50) < 1e-9);
  // 拡大余地なし(maxFactor=1)はスライダー0固定・係数1固定
  assert.equal(zoomSliderRatio(1, 1), 0);
  assert.equal(zoomFactorForSliderRatio(80, 1), 1);
});

// --- ルーラー ---

test("buildRulerTicks: 主目盛りはminMajorPx以上の間隔になる最小候補", () => {
  const { majorMs } = buildRulerTicks(60000, 0.01, 72);
  // 0.01px/ms → 10000ms=100px ≥ 72px が最小(5000ms=50pxでは不足)
  assert.equal(majorMs, 10000);
});

test("buildRulerTicks: 主目盛りと補助目盛り(1/5間隔)が並ぶ", () => {
  const { ticks } = buildRulerTicks(10000, 0.1, 72);
  const majors = ticks.filter((tick) => tick.major).map((tick) => tick.ms);
  assert.deepEqual(majors, [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000]);
  // 補助は200ms間隔
  assert.ok(ticks.some((tick) => tick.ms === 200 && !tick.major));
});

test("formatTimelineMs: mm:ss表示", () => {
  assert.equal(formatTimelineMs(0), "00:00");
  assert.equal(formatTimelineMs(65000), "01:05");
  assert.equal(formatTimelineMs(600000), "10:00");
});

// --- シーン→ブロック写像 ---

test("sceneTimelineBlocks: シーン=カット区間の1対1写像", () => {
  const blocks = sceneTimelineBlocks(
    [
      { id: "s1", sourceStartMs: 1000, sourceEndMs: 5000, telopText: "最初のシーン" },
      { id: "s2", sourceStartMs: 10000, sourceEndMs: 16000, telopText: "次のシーン" },
    ],
    RANGES,
  );
  assert.equal(blocks.length, 2);
  assert.deepEqual(
    blocks.map((block) => [block.timelineStartMs, block.timelineEndMs]),
    [
      [4000, 8000],
      [8000, 14000],
    ],
  );
  assert.equal(blocks[0].sceneIndex, 0);
  assert.equal(blocks[1].telopText, "次のシーン");
  assert.equal(blocks[1].sourceStartMs, 10000);
});

test("sceneTimelineBlocks: 複数カットにまたがるシーンは写像の最小開始〜最大終了", () => {
  const blocks = sceneTimelineBlocks(
    [{ id: "s1", sourceStartMs: 3000, sourceEndMs: 12000, telopText: "またぎ" }],
    RANGES,
  );
  assert.equal(blocks.length, 1);
  // [3000,5000)→TL[6000,8000) と [10000,12000)→TL[8000,10000) を包含
  assert.equal(blocks[0].timelineStartMs, 6000);
  assert.equal(blocks[0].timelineEndMs, 10000);
});

test("sceneTimelineBlocks: どのカットとも重ならないシーンはブロックを作らない", () => {
  const blocks = sceneTimelineBlocks(
    [{ id: "s1", sourceStartMs: 6000, sourceEndMs: 9000, telopText: "全カット済み" }],
    RANGES,
  );
  assert.equal(blocks.length, 0);
});

test("sceneTimelineBlocks: V6-2 全単語deletedのシーンはブロックを作らない(削除の即時連動)", () => {
  const blocks = sceneTimelineBlocks(
    [
      {
        id: "s1",
        sourceStartMs: 1000,
        sourceEndMs: 5000,
        telopText: "削除済み",
        words: [{ deleted: true }, { deleted: true }],
      },
      {
        id: "s2",
        sourceStartMs: 10000,
        sourceEndMs: 16000,
        telopText: "一部だけ削除",
        words: [{ deleted: true }, { deleted: false }],
      },
    ],
    RANGES,
  );
  // 全滅シーンだけ消え、一部削除のシーンは残る。sceneIndexは元配列基準を保つ
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].sceneId, "s2");
  assert.equal(blocks[0].sceneIndex, 1);
});

test("sceneTimelineBlocks: words未指定・空配列のシーンは従来どおり表示する(後方互換)", () => {
  const blocks = sceneTimelineBlocks(
    [{ id: "s1", sourceStartMs: 1000, sourceEndMs: 5000, telopText: "words無し", words: [] }],
    RANGES,
  );
  assert.equal(blocks.length, 1);
});

test("sceneTimelineBlocks: speed=2の出力ブロック幅は元素材尺の半分", () => {
  const blocks = sceneTimelineBlocks(
    [{ id: "s1", sourceStartMs: 0, sourceEndMs: 4000, telopText: "倍速", speed: 2 }],
    [{ sourceStartMs: 0, sourceEndMs: 4000, timelineStartMs: 1000, timelineEndMs: 3000, speed: 2 }],
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].timelineStartMs, 1000);
  assert.equal(blocks[0].timelineEndMs, 3000);
  assert.equal(blocks[0].speed, 2);
});

// --- クリックシークの写像 ---

test("seekSourceMsForTimelineMs: カット区間内は正確に逆写像する", () => {
  assert.equal(seekSourceMsForTimelineMs(RANGES, 5000), 2000);
  assert.equal(seekSourceMsForTimelineMs(RANGES, 9000), 11000);
});

test("seekSourceMsForTimelineMs: OP区間(先頭の未写像域)は最寄りカットの先頭へ寄せる", () => {
  assert.equal(seekSourceMsForTimelineMs(RANGES, 1000), 1000);
});

test("seekSourceMsForTimelineMs: 末尾余白は最終カットの終端近くへ寄せる", () => {
  assert.equal(seekSourceMsForTimelineMs(RANGES, 99999), 15999);
});

test("seekSourceMsForTimelineMs: 対応表が空ならnull", () => {
  assert.equal(seekSourceMsForTimelineMs([], 1000), null);
});

// --- サムネ選択 ---

test("nearestFilmstripFrame: 最も近い時刻のフレームを選ぶ", () => {
  const frames = [{ ms: 500 }, { ms: 1500 }, { ms: 2500 }];
  assert.equal(nearestFilmstripFrame(frames, 0)?.ms, 500);
  assert.equal(nearestFilmstripFrame(frames, 1400)?.ms, 1500);
  assert.equal(nearestFilmstripFrame(frames, 99999)?.ms, 2500);
  assert.equal(nearestFilmstripFrame([], 1000), null);
});

// --- OPブロック ---

test("normalizeTimelineOp: title_cardは1ブロック", () => {
  const op = normalizeTimelineOp({ pattern: "title_card", duration_ms: 4000, title: "本日のテーマ" });
  assert.ok(op);
  assert.equal(op.durationMs, 4000);
  assert.equal(op.clips.length, 1);
  assert.deepEqual(op.clips[0], { label: "タイトル", startMs: 0, endMs: 4000 });
});

test("normalizeTimelineOp: highlight_teaserはクリップ実尺比でサブブロック分割", () => {
  const op = normalizeTimelineOp({
    pattern: "highlight_teaser",
    duration_ms: 4800,
    title: "T",
    highlight_cuts: [
      { file_path: "a.mp4", start_ms: 0, end_ms: 1200 },
      { file_path: "b.mp4", start_ms: 0, end_ms: 1200 },
      { file_path: "c.mp4", start_ms: 0, end_ms: 2400 },
    ],
  });
  assert.ok(op);
  assert.equal(op.clips.length, 3);
  assert.deepEqual(op.clips[0], { label: "OP1", startMs: 0, endMs: 1200 });
  assert.deepEqual(op.clips[1], { label: "OP2", startMs: 1200, endMs: 2400 });
  // 最終クリップの終端はOP尺へ吸着(丸め誤差を残さない)
  assert.deepEqual(op.clips[2], { label: "OP3", startMs: 2400, endMs: 4800 });
});

test("normalizeTimelineOp: pattern=none・不正データはnull(OPブロックなし)", () => {
  assert.equal(normalizeTimelineOp(null), null);
  assert.equal(normalizeTimelineOp({ pattern: "none", duration_ms: 4000 }), null);
  assert.equal(normalizeTimelineOp({ pattern: "title_card", duration_ms: 0 }), null);
  // highlight_teaserでクリップゼロはnull
  assert.equal(
    normalizeTimelineOp({ pattern: "highlight_teaser", duration_ms: 4800, highlight_cuts: [] }),
    null,
  );
});
