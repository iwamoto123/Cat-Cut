"use strict";

const { spawn } = require("child_process");

/**
 * s16le PCMを逐次集計する。入力チャンクは保持せず、端数の1バイトと現在のビンだけを
 * 次へ繰り越す。丸め方は src/lib/waveform.ts の computePeaksFromPcm16 と同じ。
 */
function createPcm16PeakAccumulator(sampleRate, binMs) {
  const samplesPerBin = Math.max(1, Math.round((sampleRate * binMs) / 1000));
  const peaks = [];
  let pendingByte = null;
  let totalSamples = 0;
  let binSamples = 0;
  let binPeak = 0;
  let finished = false;

  function addSample(value) {
    binPeak = Math.max(binPeak, Math.abs(value));
    totalSamples += 1;
    binSamples += 1;
    if (binSamples === samplesPerBin) {
      peaks.push(Math.round((binPeak / 32768) * 1000) / 1000);
      binSamples = 0;
      binPeak = 0;
    }
  }

  return {
    push(chunk) {
      if (finished) throw new Error("PCM accumulator is already finished");
      let offset = 0;
      if (pendingByte !== null && chunk.length > 0) {
        const unsigned = pendingByte | (chunk[0] << 8);
        addSample(unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned);
        pendingByte = null;
        offset = 1;
      }
      // ビン内の走査はローカル変数でまとめ、1サンプルごとのクロージャ更新を避ける。
      let availableSamples = Math.floor((chunk.length - offset) / 2);
      while (availableSamples > 0) {
        const count = Math.min(samplesPerBin - binSamples, availableSamples);
        const end = offset + count * 2;
        let peak = binPeak;
        for (; offset < end; offset += 2) {
          const sample = Math.abs(chunk.readInt16LE(offset));
          if (sample > peak) peak = sample;
        }
        totalSamples += count;
        binSamples += count;
        binPeak = peak;
        availableSamples -= count;
        if (binSamples === samplesPerBin) {
          peaks.push(Math.round((binPeak / 32768) * 1000) / 1000);
          binSamples = 0;
          binPeak = 0;
        }
      }
      if (offset < chunk.length) pendingByte = chunk[offset];
    },
    finish() {
      if (!finished && binSamples > 0) peaks.push(Math.round((binPeak / 32768) * 1000) / 1000);
      finished = true;
      return { peaks, durationMs: Math.round((totalSamples / sampleRate) * 1000) };
    },
  };
}

/** 既存の一括PCM検証経路も同じ集計器を使う。末尾の不完全サンプルは従来同様無視する。 */
function computeWaveformPeaks(pcmBuffer, sampleRate, binMs) {
  const accumulator = createPcm16PeakAccumulator(sampleRate, binMs);
  accumulator.push(pcmBuffer);
  return accumulator.finish().peaks;
}

/** 空・途中欠落・不正値のキャッシュを再利用しない。全編無音の正しいPCMは有効。 */
function isValidWaveformData(value) {
  if (!value || !Number.isFinite(value.binMs) || value.binMs <= 0 ||
      !Number.isFinite(value.sampleRate) || value.sampleRate <= 0 ||
      !Number.isFinite(value.durationMs) || value.durationMs <= 0 ||
      !Array.isArray(value.peaks) || value.peaks.length === 0) return false;
  const binDurationMs = Math.max(1, Math.round(value.sampleRate * value.binMs / 1000)) / value.sampleRate * 1000;
  // durationMsはPCM集計時に整数へ丸めるため、最大0.5msの誤差を許容する。
  if (value.durationMs < (value.peaks.length - 1) * binDurationMs - 0.5 ||
      value.durationMs > value.peaks.length * binDurationMs + 0.5) return false;
  return value.peaks.every((peak) => Number.isFinite(peak) && peak >= 0 && peak <= 1);
}

/** FFmpegのstdoutをその場でピークへ縮約し、全編PCMをメモリに溜めない。 */
function runFfmpegWaveform(audioPath, sampleRate, binMs, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    const accumulator = createPcm16PeakAccumulator(sampleRate, binMs);
    const child = spawnProcess(
      "ffmpeg",
      ["-y", "-i", audioPath, "-ac", "1", "-ar", String(sampleRate), "-f", "s16le", "-loglevel", "error", "pipe:1"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stdout.on("data", (chunk) => accumulator.push(chunk));
    child.stdout.on("error", (error) => {
      child.kill();
      reject(error);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-64 * 1024);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(accumulator.finish());
      else reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

/** 同じ入力の生成中Promiseだけを共有し、成功・失敗とも完了後は保持しない。 */
function createInFlightTaskRunner() {
  const pending = new Map();
  return (key, task) => {
    if (pending.has(key)) return pending.get(key);
    const promise = Promise.resolve().then(task).finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  };
}

module.exports = {
  createPcm16PeakAccumulator,
  computeWaveformPeaks,
  isValidWaveformData,
  runFfmpegWaveform,
  createInFlightTaskRunner,
};
