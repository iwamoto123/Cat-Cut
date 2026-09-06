// W13-1: 派生キャッシュのクリーンアップ(main/cache.cjs)とキャッシュ管理UIの表示関数のテスト。
// 一時ディレクトリに擬似的なrun構造を作り、対象の選別・old/all判定・
// 「runフォルダ・プロジェクトデータは絶対に消さない」を検証する。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { formatCacheAgeDays, formatCacheBytes } from "../src/lib/cacheManager.ts";

const require = createRequire(import.meta.url);
const cache = require("../main/cache.cjs");

const DAY_MS = 24 * 60 * 60 * 1000;

/** 擬似run: プロジェクトデータ+派生キャッシュ一式を作る。 */
function makeRun(runsRoot: string, name: string, lastUsedMs: number): string {
  const runDir = path.join(runsRoot, name);
  const step08 = path.join(runDir, "step08_composition");
  const segments = path.join(step08, "segments");
  fs.mkdirSync(path.join(runDir, "step07_cut_proposal"), { recursive: true });
  fs.mkdirSync(segments, { recursive: true });

  // プロジェクトデータ(削除してはいけないもの)
  const proposalPath = path.join(runDir, "step07_cut_proposal", "cut_proposal.json");
  fs.writeFileSync(proposalPath, "{}");
  fs.writeFileSync(path.join(step08, "composition.json"), "{}");
  fs.writeFileSync(path.join(runDir, "scene_edits_draft.json"), "{}");

  // 派生キャッシュ(削除対象)
  fs.writeFileSync(path.join(segments, "manifest.json"), "{}");
  fs.writeFileSync(path.join(segments, "seg_0001.mp4"), Buffer.alloc(1000));
  fs.writeFileSync(path.join(step08, "preview_cut_sequence.mp4"), Buffer.alloc(500));
  fs.writeFileSync(path.join(step08, "preview_cut_sequence.txt"), "list");
  fs.writeFileSync(path.join(runDir, ".render_tmp_123.mp4"), Buffer.alloc(200));

  // 最終利用日時をプロジェクトデータのmtimeで表現する
  const time = new Date(lastUsedMs);
  for (const file of [
    proposalPath,
    path.join(step08, "composition.json"),
    path.join(runDir, "scene_edits_draft.json"),
  ]) {
    fs.utimesSync(file, time, time);
  }
  return runDir;
}

function makeTempRunsRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "catcut-cache-test-"));
}

test("W13-1 runCacheEntryPaths: 派生キャッシュのみ列挙する(プロジェクトデータは含めない)", () => {
  const runsRoot = makeTempRunsRoot();
  try {
    const runDir = makeRun(runsRoot, "run_a", Date.now());
    const entries: string[] = cache.runCacheEntryPaths(runDir);
    const names = entries.map((entry: string) => path.relative(runDir, entry)).sort();
    assert.deepEqual(names, [
      ".render_tmp_123.mp4",
      path.join("step08_composition", "preview_cut_sequence.mp4"),
      path.join("step08_composition", "preview_cut_sequence.txt"),
      path.join("step08_composition", "segments"),
    ]);
  } finally {
    fs.rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("W13-1 runLastUsedMs: 主要編集ファイルのmtimeの最大を返す", () => {
  const runsRoot = makeTempRunsRoot();
  try {
    const base = Date.now() - 10 * DAY_MS;
    const runDir = makeRun(runsRoot, "run_a", base);
    // scene_edits_draft.json だけ新しくする→こちらが最終利用になる
    const newer = new Date(base + 3 * DAY_MS);
    fs.utimesSync(path.join(runDir, "scene_edits_draft.json"), newer, newer);
    const lastUsed = cache.runLastUsedMs(runDir);
    assert.ok(Math.abs(lastUsed - (base + 3 * DAY_MS)) < 2000, `lastUsed=${lastUsed}`);
  } finally {
    fs.rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("W13-1 cleanCaches(old): 7日超のrunだけ掃除し、runフォルダ・プロジェクトデータは残す", () => {
  const runsRoot = makeTempRunsRoot();
  try {
    const now = Date.now();
    const oldRun = makeRun(runsRoot, "run_old", now - 10 * DAY_MS);
    const freshRun = makeRun(runsRoot, "run_fresh", now - 1 * DAY_MS);

    const result = cache.cleanCaches(runsRoot, { mode: "old", nowMs: now });
    assert.equal(result.ok, true);
    assert.equal(result.cleanedRuns, 1);
    assert.ok(result.freedBytes >= 1700, `freedBytes=${result.freedBytes}`);

    // 古いrun: キャッシュは消え、runフォルダとプロジェクトデータは残る
    assert.ok(fs.existsSync(oldRun));
    assert.ok(fs.existsSync(path.join(oldRun, "step08_composition", "composition.json")));
    assert.ok(fs.existsSync(path.join(oldRun, "scene_edits_draft.json")));
    assert.ok(!fs.existsSync(path.join(oldRun, "step08_composition", "segments")));
    assert.ok(!fs.existsSync(path.join(oldRun, "step08_composition", "preview_cut_sequence.mp4")));
    assert.ok(!fs.existsSync(path.join(oldRun, ".render_tmp_123.mp4")));

    // 新しいrun: キャッシュも残る
    assert.ok(fs.existsSync(path.join(freshRun, "step08_composition", "segments")));
    assert.ok(fs.existsSync(path.join(freshRun, "step08_composition", "preview_cut_sequence.mp4")));
  } finally {
    fs.rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("W13-1 cleanCaches(all): 全runを掃除するが、実行中ジョブのrunはスキップする", () => {
  const runsRoot = makeTempRunsRoot();
  try {
    const now = Date.now();
    const runA = makeRun(runsRoot, "run_a", now);
    const runB = makeRun(runsRoot, "run_b", now);

    const result = cache.cleanCaches(runsRoot, { mode: "all", nowMs: now, activeRunDir: runB });
    assert.equal(result.cleanedRuns, 1);
    assert.ok(!fs.existsSync(path.join(runA, "step08_composition", "segments")));
    // 実行中ジョブのrunは無傷
    assert.ok(fs.existsSync(path.join(runB, "step08_composition", "segments")));
    assert.ok(fs.existsSync(path.join(runB, "step08_composition", "preview_cut_sequence.mp4")));
  } finally {
    fs.rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("W13-1 collectCacheStats: 合計とrun別内訳(bytes降順・old判定)を返す", () => {
  const runsRoot = makeTempRunsRoot();
  try {
    const now = Date.now();
    makeRun(runsRoot, "run_old", now - 10 * DAY_MS);
    const bigRun = makeRun(runsRoot, "run_big", now);
    fs.writeFileSync(
      path.join(bigRun, "step08_composition", "segments", "seg_0002.mp4"),
      Buffer.alloc(5000),
    );

    const stats = cache.collectCacheStats(runsRoot, { nowMs: now });
    assert.equal(stats.retentionDays, 7);
    assert.equal(stats.runs.length, 2);
    assert.equal(stats.runs[0].runName, "run_big");
    assert.equal(stats.runs[0].old, false);
    assert.equal(stats.runs[1].runName, "run_old");
    assert.equal(stats.runs[1].old, true);
    assert.equal(
      stats.totalBytes,
      stats.runs.reduce((sum: number, run: { bytes: number }) => sum + run.bytes, 0),
    );
  } finally {
    fs.rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("W13-1 collectCacheStats: runsRootが無い・キャッシュゼロでも壊れない", () => {
  const stats = cache.collectCacheStats(path.join(os.tmpdir(), "catcut-cache-missing-root"));
  assert.deepEqual(stats, { totalBytes: 0, retentionDays: 7, runs: [] });
});

test("W13-1 formatCacheBytes / formatCacheAgeDays: 表示用フォーマット", () => {
  assert.equal(formatCacheBytes(0), "0 B");
  assert.equal(formatCacheBytes(512), "512 B");
  assert.equal(formatCacheBytes(2048), "2.0 KB");
  assert.equal(formatCacheBytes(2.5 * 1024 * 1024 * 1024), "2.5 GB");
  const now = Date.now();
  assert.equal(formatCacheAgeDays(now, now), "今日");
  assert.equal(formatCacheAgeDays(now - 3 * DAY_MS, now), "3日前");
  assert.equal(formatCacheAgeDays(0, now), "不明");
});
