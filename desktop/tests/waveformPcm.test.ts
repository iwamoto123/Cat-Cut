import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { computePeaksFromPcm16 } from "../src/lib/waveform.ts";

const require = createRequire(import.meta.url);
const {
  createPcm16PeakAccumulator,
  computeWaveformPeaks,
  isValidWaveformData,
  runFfmpegWaveform,
  createInFlightTaskRunner,
} = require("../main/waveformPcm.cjs");

test("波形キャッシュ: 正しい小音量・全編無音・端数ビンは再利用できる", () => {
  for (const samples of [new Array(8000).fill(0), [0, 32, -65, ...new Array(400).fill(0)], new Array(8001).fill(100)]) {
    const accumulator = createPcm16PeakAccumulator(8000, 20);
    accumulator.push(pcmBytes(samples));
    assert.equal(isValidWaveformData({ ...accumulator.finish(), binMs: 20, sampleRate: 8000 }), true);
  }
});

test("波形キャッシュ: 空や欠落・非数値を成功扱いして空欄を固定しない", () => {
  const valid = { binMs: 20, sampleRate: 8000, durationMs: 60, peaks: [0.1, 0.001, 0] };
  assert.equal(isValidWaveformData(valid), true);
  for (const value of [null, {}, { ...valid, peaks: [] }, { ...valid, peaks: [0.1] },
    { ...valid, peaks: [0, 0, 0, 0, 0] }, { ...valid, durationMs: 0 },
    { ...valid, durationMs: NaN }, { ...valid, binMs: 0 }, { ...valid, sampleRate: -1 },
    ...[null, "0.2", NaN, Infinity, -0.1, 1.1].map(peak => ({ ...valid, peaks: [0.1, peak, 0] })),
  ]) assert.equal(isValidWaveformData(value), false, JSON.stringify(value));
});

function pcmBytes(samples: number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, index * 2));
  return buffer;
}

test("PCM逐次集計: 1バイト・サンプル/ビン途中の分割でも既存波形と一致する", () => {
  const samples = Array.from({ length: 1047 }, (_, index) => ((index * 7919) % 65536) - 32768);
  const pcm = pcmBytes(samples);
  for (const { sampleRate, binMs } of [
    { sampleRate: 8000, binMs: 20 },
    { sampleRate: 44100, binMs: 17 },
    { sampleRate: 1000, binMs: 1 },
  ]) {
    const expected = computePeaksFromPcm16(samples, { sampleRate, binMs });
    assert.deepEqual(computeWaveformPeaks(pcm, sampleRate, binMs), expected);
    for (const chunkSize of [1, 3, 159, 160, 161, 319, 640, 2048]) {
      const accumulator = createPcm16PeakAccumulator(sampleRate, binMs);
      for (let offset = 0; offset < pcm.length; offset += chunkSize) {
        accumulator.push(pcm.subarray(offset, offset + chunkSize));
        accumulator.push(Buffer.alloc(0));
      }
      const result = accumulator.finish();
      assert.deepEqual(result.peaks, expected, `${sampleRate}Hz/${binMs}ms/${chunkSize}B`);
      assert.equal(result.durationMs, Math.round((samples.length / sampleRate) * 1000));
      assert.deepEqual(accumulator.finish(), result, "finishを再読しても最後のビンが増えない");
    }
  }
});

test("PCM逐次集計: 空・不完全な末尾サンプル・無音・正負の最大振幅を扱う", () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from([255])]) {
    const accumulator = createPcm16PeakAccumulator(1000, 10);
    accumulator.push(bytes);
    assert.deepEqual(accumulator.finish(), { peaks: [], durationMs: 0 });
  }
  const accumulator = createPcm16PeakAccumulator(1000, 1);
  accumulator.push(Buffer.concat([pcmBytes([0, 32767, -32768, -16384]), Buffer.from([1])]));
  assert.deepEqual(accumulator.finish(), { peaks: [0, 1, 1, 0.5], durationMs: 4 });
});

test("PCM逐次集計: 入力チャンクを再利用・変更しても処理済みサンプルを保持しない", () => {
  const accumulator = createPcm16PeakAccumulator(1000, 3);
  const bytes = pcmBytes([16384, 0]);
  accumulator.push(bytes.subarray(0, 3));
  bytes.fill(255);
  accumulator.push(Buffer.from([0, 0, 0]));
  assert.deepEqual(accumulator.finish(), { peaks: [0.5], durationMs: 3 });
});

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill() { this.killed = true; },
  });
}

test("FFmpeg波形: stdoutの分割出力を集計し、成功時だけ結果を返す", async () => {
  const child = fakeChild();
  const promise = runFfmpegWaveform("audio.wav", 8000, 20, (command: string, args: string[]) => {
    assert.equal(command, "ffmpeg");
    assert.ok(args.includes("s16le"));
    assert.ok(args.includes("8000"));
    return child;
  });
  const bytes = pcmBytes([0, -32768, 16384]);
  child.stdout.write(bytes.subarray(0, 1));
  child.stdout.write(bytes.subarray(1));
  child.emit("close", 0);
  assert.deepEqual(await promise, { peaks: [1], durationMs: 0 });
});

test("FFmpeg波形: 部分PCMの後で失敗しても結果を成功扱いしない", async () => {
  const child = fakeChild();
  const promise = runFfmpegWaveform("audio.wav", 8000, 20, () => child);
  child.stdout.write(pcmBytes([16384]));
  child.stderr.write("decoder failed");
  child.emit("close", 1);
  await assert.rejects(promise, /decoder failed/);
});

test("FFmpeg波形: stdoutの読み取りエラーで子プロセスを終了する", async () => {
  const child = fakeChild();
  const promise = runFfmpegWaveform("audio.wav", 8000, 20, () => child);
  child.stdout.emit("error", new Error("read failed"));
  await assert.rejects(promise, /read failed/);
  assert.equal(child.killed, true);
});

test("波形要求共有: 同じ入力の並行要求は1回、完了後は再評価する", async () => {
  const run = createInFlightTaskRunner();
  let calls = 0;
  let complete!: (value: number) => void;
  const task = () => { calls += 1; return new Promise<number>((resolve) => { complete = resolve; }); };
  const first = run("run/20ms/source-v1", task);
  const second = run("run/20ms/source-v1", task);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  complete(42);
  assert.deepEqual(await Promise.all([first, second]), [42, 42]);
  assert.equal(await run("run/20ms/source-v1", () => { calls += 1; return 43; }), 43);
  assert.equal(calls, 2);
});

test("波形要求共有: 異なる入力を混ぜず、失敗後は再試行できる", async () => {
  const run = createInFlightTaskRunner();
  const failure = run("run/20ms/source-v1", () => { throw new Error("failed"); });
  assert.equal(failure, run("run/20ms/source-v1", () => "unexpected"));
  assert.equal(await run("run/40ms/source-v1", () => 40), 40);
  await assert.rejects(failure, /failed/);
  assert.equal(await run("run/20ms/source-v1", () => 20), 20);
});
