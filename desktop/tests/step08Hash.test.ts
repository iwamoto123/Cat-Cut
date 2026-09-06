// W19-C2: step08入力合成ハッシュ(main/step08Hash.cjs)のテスト。
// 一時ディレクトリに擬似run構造を作り、ハッシュの安定性(同一入力→同一ハッシュ、
// keep_segments変更→不一致、updated_atのみの変更→一致)とスキップ判定
// (ハッシュ一致+composition.json+全セグメント実在)を検証する。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  computeStep08InputHash,
  canSkipStep08,
  writeStep08InputHash,
  readStoredStep08Hash,
  collectCompositionVideoPaths,
  hashJsonFileStable,
} = require("../main/step08Hash.cjs");

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "catcut-step08hash-"));
}

/** 擬似run: ハッシュ対象の入力ファイル一式と元動画を作る。 */
function makeRun(root: string) {
  const runDir = path.join(root, "runs", "20260101_000000_test");
  fs.mkdirSync(path.join(runDir, "images"), { recursive: true });
  fs.mkdirSync(path.join(runDir, "bgm"), { recursive: true });
  fs.mkdirSync(path.join(runDir, "step06_review"), { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "telop_directives.json"),
    JSON.stringify({ slots: [{ slot_id: "s001", text: "こんにちは" }], updated_at: "2026-01-01T00:00:00Z" }),
  );
  fs.writeFileSync(path.join(runDir, "orientation.json"), JSON.stringify({ orientation: "vertical" }));
  fs.writeFileSync(path.join(runDir, "op_config.json"), JSON.stringify({ pattern: "none" }));
  fs.writeFileSync(path.join(runDir, "images", "images.json"), JSON.stringify({ images: [] }));
  fs.writeFileSync(path.join(runDir, "bgm", "bgm.json"), JSON.stringify({ clips: [] }));
  fs.writeFileSync(path.join(runDir, "step06_review", "review.json"), JSON.stringify({ corrections: {} }));
  const videoPath = path.join(root, "source.mp4");
  fs.writeFileSync(videoPath, "dummy video bytes");
  const sttPath = path.join(runDir, "stt_result.json");
  fs.writeFileSync(sttPath, JSON.stringify({ words: [] }));
  return { runDir, videoPath, sttPath };
}

const KEEP_SEGMENTS = [
  { start_ms: 0, end_ms: 3000, text: "a" },
  { start_ms: 5000, end_ms: 8000, text: "b" },
];

function hashInput(run: { runDir: string; videoPath: string; sttPath: string }, overrides: object = {}) {
  return {
    runDir: run.runDir,
    keepSegments: KEEP_SEGMENTS,
    step08Args: ["python/step08_composition.py", "--orientation", "vertical"],
    sourceVideoPath: run.videoPath,
    sttPath: run.sttPath,
    reviewPath: path.join(run.runDir, "step06_review", "review.json"),
    typeMappingPath: "",
    ...overrides,
  };
}

test("同一入力なら同一ハッシュ(安定性)", () => {
  const root = makeTempDir();
  const run = makeRun(root);
  const first = computeStep08InputHash(hashInput(run));
  const second = computeStep08InputHash(hashInput(run));
  assert.equal(first.hash, second.hash);
  assert.deepEqual(first.components, second.components);
});

test("keep_segments が変わるとハッシュ不一致", () => {
  const root = makeTempDir();
  const run = makeRun(root);
  const base = computeStep08InputHash(hashInput(run));
  const trimmed = computeStep08InputHash(
    hashInput(run, { keepSegments: [{ start_ms: 0, end_ms: 2500, text: "a" }, KEEP_SEGMENTS[1]] }),
  );
  assert.notEqual(base.hash, trimmed.hash);
});

test("telop_directives の updated_at だけの変更ではハッシュ一致(内容が同じなら再実行しない)", () => {
  const root = makeTempDir();
  const run = makeRun(root);
  const base = computeStep08InputHash(hashInput(run));
  const directivesPath = path.join(run.runDir, "telop_directives.json");
  const directives = JSON.parse(fs.readFileSync(directivesPath, "utf-8"));
  directives.updated_at = "2026-02-02T12:34:56Z";
  fs.writeFileSync(directivesPath, JSON.stringify(directives));
  assert.equal(computeStep08InputHash(hashInput(run)).hash, base.hash);

  // 本文の変更は不一致になる
  directives.slots[0].text = "こんばんは";
  fs.writeFileSync(directivesPath, JSON.stringify(directives));
  assert.notEqual(computeStep08InputHash(hashInput(run)).hash, base.hash);
});

test("telopOverrides(非directedの本文上書き)の変更でハッシュ不一致・同一なら一致", () => {
  const root = makeTempDir();
  const run = makeRun(root);
  const base = computeStep08InputHash(hashInput(run, { telopOverrides: [null, "上書き"] }));
  const same = computeStep08InputHash(hashInput(run, { telopOverrides: [null, "上書き"] }));
  assert.equal(base.hash, same.hash);
  // 「上書き→auto(null)へ戻す」変更を確実に再実行へ倒す
  const reverted = computeStep08InputHash(hashInput(run, { telopOverrides: [null, null] }));
  assert.notEqual(base.hash, reverted.hash);
});

test("入力ファイル(orientation等)の変更・引数の変更でハッシュ不一致", () => {
  const root = makeTempDir();
  const run = makeRun(root);
  const base = computeStep08InputHash(hashInput(run));

  const args = computeStep08InputHash(
    hashInput(run, { step08Args: ["python/step08_composition.py", "--orientation", "horizontal"] }),
  );
  assert.notEqual(base.hash, args.hash);

  fs.writeFileSync(path.join(run.runDir, "orientation.json"), JSON.stringify({ orientation: "horizontal" }));
  assert.notEqual(computeStep08InputHash(hashInput(run)).hash, base.hash);
});

test("存在しない入力ファイルは absent として安定に扱う(旧run互換)", () => {
  const root = makeTempDir();
  const run = makeRun(root);
  fs.rmSync(path.join(run.runDir, "orientation.json"));
  fs.rmSync(path.join(run.runDir, "op_config.json"));
  const first = computeStep08InputHash(hashInput(run));
  assert.equal(first.components.orientation, "absent");
  assert.equal(first.components.op_config, "absent");
  assert.equal(computeStep08InputHash(hashInput(run)).hash, first.hash);
});

/** スキップ判定用: composition.json とセグメント実体を作る。 */
function makeComposition(runDir: string, segmentNames: string[]) {
  const step08 = path.join(runDir, "step08_composition");
  const segments = path.join(step08, "segments");
  fs.mkdirSync(segments, { recursive: true });
  const cuts = segmentNames.map((name, index) => {
    const filePath = path.join(segments, name);
    fs.writeFileSync(filePath, "seg");
    return { cut_id: `cut_${String(index + 1).padStart(3, "0")}`, video: { file_path: filePath, start_ms: 0, end_ms: 1000 } };
  });
  fs.writeFileSync(path.join(step08, "composition.json"), JSON.stringify({ timeline: { cuts } }));
  return cuts.map((cut) => cut.video.file_path);
}

test("スキップ判定: ハッシュ一致+composition+全セグメント実在でtrue", () => {
  const root = makeTempDir();
  const run = makeRun(root);
  makeComposition(run.runDir, ["seg_aaaaaaaaaaaaaaaa.mp4", "seg_bbbbbbbbbbbbbbbb.mp4"]);
  const inputHash = computeStep08InputHash(hashInput(run));
  writeStep08InputHash(run.runDir, inputHash);

  assert.equal(canSkipStep08(run.runDir, inputHash.hash), true);
  assert.equal(readStoredStep08Hash(run.runDir)?.hash, inputHash.hash);
});

test("スキップ判定: ハッシュファイル無し(旧run)はfalse=従来どおり実行", () => {
  const root = makeTempDir();
  const run = makeRun(root);
  makeComposition(run.runDir, ["seg_aaaaaaaaaaaaaaaa.mp4"]);
  const inputHash = computeStep08InputHash(hashInput(run));
  assert.equal(canSkipStep08(run.runDir, inputHash.hash), false);
});

test("スキップ判定: ハッシュ不一致はfalse", () => {
  const root = makeTempDir();
  const run = makeRun(root);
  makeComposition(run.runDir, ["seg_aaaaaaaaaaaaaaaa.mp4"]);
  writeStep08InputHash(run.runDir, computeStep08InputHash(hashInput(run)));
  const changed = computeStep08InputHash(hashInput(run, { keepSegments: [] }));
  assert.equal(canSkipStep08(run.runDir, changed.hash), false);
});

test("スキップ判定: composition.json欠損・セグメント欠損はfalse", () => {
  const root = makeTempDir();
  const run = makeRun(root);
  const segPaths = makeComposition(run.runDir, ["seg_aaaaaaaaaaaaaaaa.mp4", "seg_bbbbbbbbbbbbbbbb.mp4"]);
  const inputHash = computeStep08InputHash(hashInput(run));
  writeStep08InputHash(run.runDir, inputHash);

  // セグメント1本欠損(キャッシュ掃除等) → false
  fs.rmSync(segPaths[1]);
  assert.equal(canSkipStep08(run.runDir, inputHash.hash), false);

  // composition.json 欠損 → false
  fs.rmSync(path.join(run.runDir, "step08_composition", "composition.json"));
  assert.equal(canSkipStep08(run.runDir, inputHash.hash), false);
});

test("collectCompositionVideoPaths: timeline.cuts と timeline.op.clips を集める", () => {
  const composition = {
    timeline: {
      cuts: [
        { video: { file_path: "/a/seg_1.mp4" } },
        { video: { file_path: "/a/seg_2.mp4" } },
        { video: {} },
      ],
      op: { clips: [{ file_path: "/a/seg_1.mp4" }] },
    },
  };
  assert.deepEqual(collectCompositionVideoPaths(composition), [
    "/a/seg_1.mp4",
    "/a/seg_2.mp4",
    "/a/seg_1.mp4",
  ]);
  assert.deepEqual(collectCompositionVideoPaths({}), []);
});

test("hashJsonFileStable: JSONでないファイルは生内容ハッシュ、欠損はabsent", () => {
  const root = makeTempDir();
  const rawPath = path.join(root, "raw.txt");
  fs.writeFileSync(rawPath, "not json");
  const first = hashJsonFileStable(rawPath);
  assert.equal(first, hashJsonFileStable(rawPath));
  fs.writeFileSync(rawPath, "not json 2");
  assert.notEqual(first, hashJsonFileStable(rawPath));
  assert.equal(hashJsonFileStable(path.join(root, "missing.json")), "absent");
});
