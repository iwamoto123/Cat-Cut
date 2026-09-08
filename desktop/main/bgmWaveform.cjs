"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { runFfmpegWaveform, createInFlightTaskRunner } = require("./waveformPcm.cjs");

const MAX_PEAKS = 4096;
const SAMPLE_RATE = 8000;
const CACHE_VERSION = 1;
const signatureOf = (stat) => `${stat.mtimeMs}:${stat.size}`;
const isInside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** Only a local BGM asset is accepted, including after resolving symlinks. */
async function resolveBgmAudio(runDir, file) {
  if (typeof file !== "string" || !file || file === "." || file === ".." || /[/\\\0]/.test(file)) {
    throw new Error("BGMのファイル名が不正です");
  }
  const realRun = await fs.promises.realpath(runDir);
  const realBgm = await fs.promises.realpath(path.join(realRun, "bgm"));
  if (!isInside(realRun, realBgm)) throw new Error("BGMフォルダがプロジェクトの外を参照しています");
  const audioPath = await fs.promises.realpath(path.join(realBgm, file));
  if (!isInside(realBgm, audioPath)) throw new Error("BGMファイルがBGMフォルダの外を参照しています");
  const stat = await fs.promises.stat(audioPath);
  if (!stat.isFile()) throw new Error("BGMの音声ファイルが見つかりません");
  return { realRun, audioPath, stat };
}

/** Keep at most 4096 bins even if the container's duration slightly underestimates PCM. */
function boundPeaks(peaks, binMs) {
  const factor = Math.max(1, Math.ceil(peaks.length / MAX_PEAKS));
  if (factor === 1) return { peaks, binMs };
  const bounded = [];
  for (let index = 0; index < peaks.length; index += factor) {
    let peak = 0;
    for (let offset = index; offset < Math.min(index + factor, peaks.length); offset += 1) {
      peak = Math.max(peak, peaks[offset]);
    }
    bounded.push(peak);
  }
  return { peaks: bounded, binMs: binMs * factor };
}

/** Shared by source-video and BGM requests in main: at most one waveform FFmpeg. */
function createWaveformDecodeQueue(generate = runFfmpegWaveform) {
  let tail = Promise.resolve();
  return (...args) => {
    const work = tail.then(() => generate(...args));
    tail = work.then(() => undefined, () => undefined);
    return work;
  };
}

/** Small disk cache; BGM jobs share one decode slot and never retain decoded PCM. */
function createBgmWaveformService({ resolveRunDir, probeDurationMs, generate = runFfmpegWaveform }) {
  const share = createInFlightTaskRunner();
  let tail = Promise.resolve();
  const enqueue = (task) => {
    const work = tail.then(task);
    tail = work.then(() => undefined, () => undefined);
    return work;
  };

  return async function getBgmWaveform({ runDir, file } = {}) {
    const resolved = resolveRunDir(runDir);
    const audio = await resolveBgmAudio(resolved, file);
    const signature = signatureOf(audio.stat);
    const key = JSON.stringify([audio.realRun, audio.audioPath, signature]);
    return share(key, async () => {
      const cacheName = `${crypto.createHash("sha256").update(file).digest("hex").slice(0, 32)}.json`;
      const cacheDir = path.join(audio.realRun, "ui_cache", "bgm-waveforms");
      const cachePath = path.join(cacheDir, cacheName);
      // Also reject redirected cache directories; a cache must stay inside this run.
      for (const directory of [path.dirname(cacheDir), cacheDir]) {
        await fs.promises.mkdir(directory, { recursive: true });
        if (!isInside(audio.realRun, await fs.promises.realpath(directory))) {
          throw new Error("BGM波形キャッシュがプロジェクトの外を参照しています");
        }
      }
      try {
        const cacheStat = await fs.promises.lstat(cachePath);
        if (!cacheStat.isFile() || cacheStat.size > 128 * 1024) throw new Error("Invalid waveform cache");
        const cached = JSON.parse(await fs.promises.readFile(cachePath, "utf-8"));
        if (cached.version === CACHE_VERSION && cached.audioPath === audio.audioPath &&
            cached.audioMtimeMs === audio.stat.mtimeMs && cached.audioSize === audio.stat.size &&
            cached.sampleRate === SAMPLE_RATE && Number.isFinite(cached.binMs) && cached.binMs >= 20 &&
            Number.isFinite(cached.durationMs) && cached.durationMs >= 0 &&
            Array.isArray(cached.peaks) && cached.peaks.length <= MAX_PEAKS &&
            cached.peaks.every((peak) => Number.isFinite(peak) && peak >= 0 && peak <= 1)) {
          return { binMs: cached.binMs, sampleRate: SAMPLE_RATE, durationMs: cached.durationMs, peaks: cached.peaks, cached: true };
        }
      } catch {
        // Missing or incomplete cache files are regenerated, never displayed as audio.
      }
      return enqueue(async () => {
        const before = await resolveBgmAudio(resolved, file);
        if (before.audioPath !== audio.audioPath || signatureOf(before.stat) !== signature) {
          throw new Error("BGM音源が更新されました。波形を再読み込みしてください");
        }
        const sourceDurationMs = await probeDurationMs(audio.audioPath);
        if (!Number.isFinite(sourceDurationMs) || sourceDurationMs <= 0) {
          throw new Error("BGMの長さを取得できませんでした");
        }
        const binMs = Math.max(20, Math.ceil(sourceDurationMs / MAX_PEAKS));
        const generated = await generate(audio.audioPath, SAMPLE_RATE, binMs);
        const after = await resolveBgmAudio(resolved, file);
        if (after.audioPath !== audio.audioPath || signatureOf(after.stat) !== signature) {
          throw new Error("BGM音源が更新されました。波形を再読み込みしてください");
        }
        const bounded = boundPeaks(generated.peaks, binMs);
        const result = { ...bounded, sampleRate: SAMPLE_RATE, durationMs: generated.durationMs, cached: false };
        const payload = { version: CACHE_VERSION, audioPath: audio.audioPath,
          audioMtimeMs: audio.stat.mtimeMs, audioSize: audio.stat.size, ...result };
        const temporaryPath = `${cachePath}.${crypto.randomUUID()}.tmp`;
        try {
          await fs.promises.writeFile(temporaryPath, JSON.stringify(payload), "utf-8");
          await fs.promises.rename(temporaryPath, cachePath);
        } finally {
          await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
        }
        return result;
      });
    });
  };
}

module.exports = { createBgmWaveformService, createWaveformDecodeQueue, resolveBgmAudio, boundPeaks, MAX_PEAKS };
