import test from "node:test";
import assert from "node:assert/strict";
import { loadWaveformWithRetry } from "../src/lib/waveformRequest.ts";

test("waveform: transient failure retries once and publishes the recovered peaks", async () => {
  let calls = 0;
  const peaks = [0, 0.04, 0.6];
  const result = await loadWaveformWithRetry(async () => {
    if (++calls === 1) throw new Error("Audio is not ready yet");
    return peaks;
  }, new AbortController().signal, 0);
  assert.equal(result, peaks);
  assert.equal(calls, 2);
});

test("waveform: persistent failure stops after two reads; a manual retry can recover", async () => {
  let calls = 0;
  const load = async () => {
    if (++calls <= 2) throw new Error("Read failed");
    return [0.5];
  };
  await assert.rejects(loadWaveformWithRetry(load, new AbortController().signal, 0), /Read failed/);
  assert.equal(calls, 2);
  assert.deepEqual(await loadWaveformWithRetry(load, new AbortController().signal, 0), [0.5]);
  assert.equal(calls, 3);
});

test("waveform: switching projects during a slow read discards the old result", async () => {
  const controller = new AbortController();
  let complete!: (peaks: number[]) => void;
  const pending = loadWaveformWithRetry(() => new Promise<number[]>((resolve) => { complete = resolve; }), controller.signal);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  controller.abort();
  complete([0.8]);
  await rejected;
});

test("waveform: switching projects during retry delay cancels the next read", async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = loadWaveformWithRetry(async () => { calls++; throw new Error("Read failed"); }, controller.signal, 1000);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await Promise.resolve();
  controller.abort();
  await rejected;
  assert.equal(calls, 1);
});

test("waveform: successful first reads do not trigger unnecessary retries", async () => {
  let calls = 0;
  assert.equal(await loadWaveformWithRetry(async () => ++calls, new AbortController().signal, 0), 1);
  assert.equal(calls, 1);
});
