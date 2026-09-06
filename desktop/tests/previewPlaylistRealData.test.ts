/**
 * フェーズV3(OPのプレビュー再生): OP付き実データrun(highlight_teaser・U8世代=source_*なし)で
 * transcript:load 相当のデータ(composition+cut_proposal)から仮想プレイリストが正しく組める
 * ことの統合確認。実APIは呼ばない。
 * main/index.cjs の buildTimelineCutRanges と同じ組み立てを再現する
 * (previewFidelityRealData.test.ts と同方式)。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPreviewPlaylist,
  clampTimelineMsToPlaylist,
  playlistPositionForTimelineMs,
  playlistTotalDurationMs,
  resolveOpPreviewData,
} from "../src/lib/previewPlaylist.ts";
import { sanitizeTimelineCutRanges } from "../src/lib/previewTimeline.ts";
import { sanitizeRunOpConfig } from "../src/lib/opEditor.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runDir = path.resolve(
  __dirname,
  "../../runs/20260706_151514_笠井俊哉くん_山口県立大学_夏期講習の感想インタビュー",
);

function readJson(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

const composition = readJson(path.join(runDir, "step08_composition", "composition.json"));
const proposal = readJson(path.join(runDir, "step07_cut_proposal", "cut_proposal.json"));
const timeline = composition.timeline;

// main/index.cjs buildTimelineCutRanges と同じ組み立て
function buildRanges() {
  const keepSegments: Array<{ start_ms: number; end_ms: number }> = proposal.keep_segments;
  const ranges = timeline.cuts.map((cut: any, index: number) => ({
    sourceStartMs: Number(keepSegments[index]?.start_ms || 0),
    sourceEndMs: Number(keepSegments[index]?.end_ms || 0),
    timelineStartMs: Number(cut?.timeline?.start_ms),
    timelineEndMs: Number(cut?.timeline?.end_ms),
  }));
  return sanitizeTimelineCutRanges(ranges);
}

test("V3実データ: OP付きrunのcompositionからOPプレビューデータが解決できる", () => {
  const ranges = buildRanges();
  assert.ok(ranges.length > 0);
  const op = resolveOpPreviewData(timeline.op, ranges);
  assert.ok(op, "timeline.op からOPプレビューデータが解決できること");
  assert.equal(op.pattern, "highlight_teaser");
  assert.equal(op.title, "タイトルテスト");
  // このrunのOPはクリップ3本×2000ms=6000ms
  assert.equal(op.clips.length, 3);
  assert.equal(op.durationMs, timeline.op.duration_ms);
  // U8世代(source_*なし)のfile_path逆算: 各クリップが該当カットの元動画区間に収まる
  for (const clip of op.clips) {
    const host = ranges.find(
      (range) => range.sourceStartMs <= clip.sourceStartMs && clip.sourceEndMs <= range.sourceEndMs,
    );
    assert.ok(host, `クリップ(${clip.sourceStartMs}-${clip.sourceEndMs})が本編カット内にあること`);
  }
});

test("V3実データ: 仮想プレイリストがOP区間[0,6000)+オフセット済み本編で隙間なく組める", () => {
  const ranges = buildRanges();
  const op = resolveOpPreviewData(timeline.op, ranges);
  const entries = buildPreviewPlaylist(ranges, op);
  assert.equal(entries.length, 3 + ranges.length);
  // OPクリップがタイムライン先頭から連続配置される
  assert.equal(entries[0].kind, "op_clip");
  assert.equal(entries[0].timelineStartMs, 0);
  assert.equal(entries[2].timelineEndMs, timeline.op.duration_ms);
  // 本編先頭はOP尺分オフスセット済みのcomposition cutsと一致する
  assert.equal(entries[3].kind, "main");
  assert.equal(entries[3].timelineStartMs, timeline.op.duration_ms);
  // 総尺=composition total_duration_ms(丸め誤差1ms未満)
  assert.ok(Math.abs(playlistTotalDurationMs(entries) - timeline.total_duration_ms) <= 1);
  // OP内・本編内の写像が引ける
  assert.deepEqual(playlistPositionForTimelineMs(entries, 0), { index: 0, offsetMs: 0 });
  const mid = playlistPositionForTimelineMs(entries, timeline.op.duration_ms + 1000);
  assert.ok(mid && entries[mid.index].kind === "main");
  // 総尺超えのクリックは最終エントリ末尾へクランプされる
  const clamped = clampTimelineMsToPlaylist(entries, timeline.total_duration_ms + 5000);
  assert.ok(clamped && clamped.index === entries.length - 1);
});

test("V3実データ: op_config.json相当(明示クリップ)のrun正本が適用前でもプレイリストへ反映される", () => {
  const ranges = buildRanges();
  // OpEditorModalが保存する形のop_config.json(クリップ差し替え・文言変更)をrun正本として与える
  const runOpConfig = sanitizeRunOpConfig({
    pattern: "highlight_teaser",
    title: "編集後タイトル",
    catch_copy: "",
    clips: [
      {
        cut_id: "cut_001",
        start_ms: ranges[0].sourceStartMs,
        end_ms: ranges[0].sourceStartMs + 1500,
        text: "編集後テロップ",
        style: "special_purple",
      },
    ],
  });
  const op = resolveOpPreviewData(timeline.op, ranges, runOpConfig);
  assert.ok(op);
  assert.equal(op.title, "編集後タイトル");
  assert.equal(op.clips.length, 1);
  assert.equal(op.clips[0].text, "編集後テロップ");
  assert.equal(op.durationMs, 1500);
  const entries = buildPreviewPlaylist(ranges, op);
  // OPが1500msへ短縮されても本編(オフセット6000msのまま)とはエントリ順で破綻しない
  assert.equal(entries[0].kind, "op_clip");
  assert.equal(entries[0].timelineEndMs, 1500);
  assert.equal(entries[1].kind, "main");
  assert.equal(entries[1].timelineStartMs, timeline.op.duration_ms);
  // OP末尾と本編先頭の間(1500〜6000ms)はクランプで最寄りの端へ寄る
  const gap = clampTimelineMsToPlaylist(entries, 3000);
  assert.ok(gap && (gap.index === 0 || gap.index === 1));
});
