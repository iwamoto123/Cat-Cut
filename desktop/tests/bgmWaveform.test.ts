import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { bgmWaveformHeights, bgmWaveformPath, createBgmWaveformLoader, type BgmWaveformData } from "../src/lib/bgmWaveform.ts";

const require = createRequire(import.meta.url);
const { createBgmWaveformService, createWaveformDecodeQueue, resolveBgmAudio, boundPeaks, MAX_PEAKS } = require("../main/bgmWaveform.cjs");
const fakeWaveform: BgmWaveformData = { binMs: 20, sampleRate: 8000, durationMs: 100, peaks: [0, 0.25, 1, 0.5, 0], cached: false };

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "catcut-bgm-waveform-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runDir = path.join(root, "run");
  await fs.mkdir(path.join(runDir, "bgm"), { recursive: true });
  await fs.writeFile(path.join(runDir, "bgm", "music.wav"), "first audio");
  return { root, runDir, input: { runDir, file: "music.wav" } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function eventually(condition: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(condition(), "expected asynchronous work to start");
}

test("BGM waveform: filename traversal, folders and symlinks outside run/bgm are rejected", async (t) => {
  const { root, runDir } = await fixture(t);
  for (const file of ["", ".", "..", "../outside.wav", "bgm/music.wav", "bgm\\music.wav", "/tmp/music.wav", "bad\0.wav"]) {
    await assert.rejects(resolveBgmAudio(runDir, file));
  }
  await fs.writeFile(path.join(root, "outside.wav"), "outside");
  await fs.symlink(path.join(root, "outside.wav"), path.join(runDir, "bgm", "outside.wav"));
  await assert.rejects(resolveBgmAudio(runDir, "outside.wav"), /外/);
  await fs.mkdir(path.join(runDir, "bgm", "folder"));
  await assert.rejects(resolveBgmAudio(runDir, "folder"), /音声ファイル/);
  await fs.symlink(path.join(runDir, "bgm", "music.wav"), path.join(runDir, "bgm", "alias.wav"));
  assert.equal((await resolveBgmAudio(runDir, "alias.wav")).audioPath, path.join(runDir, "bgm", "music.wav"));
  const other = path.join(root, "other-run");
  await fs.mkdir(other);
  await fs.symlink(path.join(runDir, "bgm"), path.join(other, "bgm"));
  await assert.rejects(resolveBgmAudio(other, "music.wav"), /外/);
});

test("BGM waveform: shared in-flight decode, compact disk cache, mtime/size invalidation", async (t) => {
  const { runDir, input } = await fixture(t);
  const decode = deferred<{ peaks: number[]; durationMs: number }>();
  let decodeCalls = 0;
  let probeCalls = 0;
  const service = createBgmWaveformService({ resolveRunDir: (value: string) => value,
    probeDurationMs: async () => { probeCalls += 1; return 120000; },
    generate: async (_file: string, rate: number, binMs: number) => {
      decodeCalls += 1;
      assert.equal(rate, 8000);
      assert.equal(binMs, 30);
      return decode.promise;
    } });
  const requests = Array.from({ length: 8 }, () => service(input));
  await eventually(() => decodeCalls === 1);
  decode.resolve({ peaks: [0, 0.4, 0.9], durationMs: 120000 });
  const results = await Promise.all(requests);
  assert.equal(decodeCalls, 1);
  assert.equal(probeCalls, 1);
  assert.ok(results.every((result) => result === results[0]));
  const cached = await service(input);
  assert.equal(cached.cached, true);
  assert.equal(decodeCalls, 1);
  const dir = path.join(runDir, "ui_cache", "bgm-waveforms");
  const files = await fs.readdir(dir);
  assert.equal(files.length, 1);
  const raw = await fs.readFile(path.join(dir, files[0]), "utf-8");
  assert.ok(!raw.includes("\n"), "cache is compact JSON");
  await fs.appendFile(path.join(runDir, "bgm", "music.wav"), "changed");
  assert.equal((await service(input)).cached, false);
  assert.equal(decodeCalls, 2);
  assert.equal((await fs.readdir(dir)).length, 1, "source versions replace one cache file");
});

test("BGM waveform: different files decode serially and a failed job releases the slot", async (t) => {
  const { runDir, input } = await fixture(t);
  await fs.writeFile(path.join(runDir, "bgm", "second.wav"), "second");
  const first = deferred<{ peaks: number[]; durationMs: number }>();
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const service = createBgmWaveformService({ resolveRunDir: (value: string) => value,
    probeDurationMs: async () => 100,
    generate: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const current = ++calls;
      try { return current === 1 ? await first.promise : { peaks: [1], durationMs: 100 }; }
      finally { active -= 1; }
    } });
  const failed = service(input);
  const failure = assert.rejects(failed, /decode failed/);
  await eventually(() => calls === 1);
  const second = service({ runDir, file: "second.wav" });
  first.reject(new Error("decode failed"));
  await failure;
  assert.equal((await second).cached, false);
  assert.equal(maximumActive, 1);
  assert.equal((await service(input)).cached, false, "failed source can retry");
  assert.equal(calls, 3);
});

test("Waveform global decode queue: video/BGM jobs serialize and failures release queued work", async () => {
  const first = deferred<{ peaks: number[]; durationMs: number }>();
  const called: string[] = [];
  const decode = createWaveformDecodeQueue(async (file: string) => {
    called.push(file);
    return file === "video.wav" ? first.promise : { peaks: [1], durationMs: 100 };
  });
  const video = decode("video.wav", 8000, 20);
  const failed = assert.rejects(video, /failed/);
  const bgm = decode("music.wav", 8000, 30);
  await Promise.resolve();
  assert.deepEqual(called, ["video.wav"]);
  first.reject(new Error("failed"));
  await failed;
  assert.deepEqual(await bgm, { peaks: [1], durationMs: 100 });
  assert.deepEqual(called, ["video.wav", "music.wav"]);
});

test("BGM waveform: changing audio during decode never caches old data", async (t) => {
  const { runDir, input } = await fixture(t);
  const decode = deferred<{ peaks: number[]; durationMs: number }>();
  let started = false;
  const service = createBgmWaveformService({ resolveRunDir: (value: string) => value,
    probeDurationMs: async () => 100,
    generate: async () => { started = true; return decode.promise; } });
  const request = service(input);
  const rejection = assert.rejects(request, /更新/);
  await eventually(() => started);
  await fs.appendFile(path.join(runDir, "bgm", "music.wav"), "new revision");
  decode.resolve({ peaks: [1], durationMs: 100 });
  await rejection;
  assert.deepEqual(await fs.readdir(path.join(runDir, "ui_cache", "bgm-waveforms")), []);
});

test("BGM waveform: corrupt caches regenerate and redirected cache directories receive no files", async (t) => {
  const { root, runDir, input } = await fixture(t);
  let calls = 0;
  const service = createBgmWaveformService({ resolveRunDir: (value: string) => value,
    probeDurationMs: async () => 100,
    generate: async () => { calls += 1; return { peaks: [1], durationMs: 100 }; } });
  await service(input);
  const dir = path.join(runDir, "ui_cache", "bgm-waveforms");
  const [cacheFile] = await fs.readdir(dir);
  await fs.writeFile(path.join(dir, cacheFile), '{"broken":');
  assert.equal((await service(input)).cached, false);
  assert.equal(calls, 2);
  await fs.rm(path.join(runDir, "ui_cache"), { recursive: true });
  const outside = path.join(root, "outside-cache");
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(runDir, "ui_cache"));
  await assert.rejects(service(input), /外/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test("BGM waveform: unknown duration does not start an unbounded decode; long peaks stay bounded", async (t) => {
  const { input } = await fixture(t);
  let calls = 0;
  const service = createBgmWaveformService({ resolveRunDir: (value: string) => value,
    probeDurationMs: async () => null, generate: async () => { calls += 1; } });
  await assert.rejects(service(input), /長さ/);
  assert.equal(calls, 0);
  const source = Array.from({ length: MAX_PEAKS * 3 + 1 }, (_, index) => index === 9100 ? 1 : 0);
  const result = boundPeaks(source, 20);
  assert.ok(result.peaks.length <= MAX_PEAKS);
  assert.equal(result.peaks[Math.floor(9100 / 4)], 1, "downsampling preserves transients");
  assert.equal(result.binMs, 80);
});

test("BGM renderer: source requests share work, released cache is bounded, and failures retry", async () => {
  const calls: string[] = [];
  let fail = false;
  const acquire = createBgmWaveformLoader(async ({ file }) => {
    calls.push(file);
    if (fail) throw new Error("unavailable");
    return fakeWaveform;
  }, 1);
  const first = acquire("run", "first");
  const shared = acquire("run", "first");
  assert.equal(first.promise, shared.promise);
  await first.promise;
  first.release(); first.release(); shared.release();
  const second = acquire("run", "second");
  await second.promise; second.release();
  const repeated = acquire("run", "first");
  await repeated.promise; repeated.release();
  assert.deepEqual(calls, ["first", "second", "first"]);
  fail = true;
  const failing = acquire("run", "failure");
  await assert.rejects(failing.promise, /unavailable/); failing.release();
  fail = false;
  const retry = acquire("run", "failure");
  await retry.promise; retry.release();
  assert.equal(calls.filter((file) => file === "failure").length, 2);
});

test("BGM renderer: release while pending leaves no growing completed cache and active data stays shared", async () => {
  let calls = 0;
  const pending = deferred<BgmWaveformData>();
  const acquire = createBgmWaveformLoader(async () => { calls += 1; return pending.promise; }, 0);
  const first = acquire("run", "music");
  first.release();
  pending.resolve(fakeWaveform);
  await first.promise;
  const again = acquire("run", "music");
  await again.promise;
  assert.equal(calls, 2);
  const activeShared = acquire("run", "music");
  assert.equal(activeShared.promise, again.promise);
  activeShared.release(); again.release();
});

test("BGM renderer: real peaks preserve silence/transients, gain/fades and source duration, bounded geometry", () => {
  assert.deepEqual(bgmWaveformHeights(fakeWaveform, 100, 10, 1, 0, 0), [0, 0.25, 1, 0.5, 0]);
  assert.deepEqual(bgmWaveformHeights(fakeWaveform, 100, 10, 0, 0, 0), [0, 0, 0, 0, 0]);
  assert.deepEqual(bgmWaveformHeights(fakeWaveform, 100, 10, 0.5, 0, 0), [0, 0.125, 0.5, 0.25, 0]);
  const faded = bgmWaveformHeights({ ...fakeWaveform, peaks: [1, 1, 1, 1, 1] }, 100, 10, 1, 100, 100);
  assert.deepEqual(faded, [0.1, 0.3, 0.5, 0.3, 0.1]);
  const extended = bgmWaveformHeights(fakeWaveform, 200, 20, 1, 0, 0);
  assert.deepEqual(extended.slice(5), [0, 0, 0, 0, 0]);
  const heights = bgmWaveformHeights(fakeWaveform, 100, 100000, 1, 0, 0);
  assert.equal(heights.length, 512);
  const geometry = bgmWaveformPath(heights, 100000, 32);
  assert.equal((geometry.match(/[ML]/g) ?? []).length, 1024);
  assert.ok(!geometry.includes("NaN"));
  assert.equal(bgmWaveformPath([], 0, 32), "");
});
