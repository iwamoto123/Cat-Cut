import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createMediaDurationCache } = require("../main/mediaDurationCache.cjs");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("concurrent delayed probes share one task and subsequent edits hit the cache", async () => {
  const gate = deferred<number>();
  let probes = 0;
  const probe = createMediaDurationCache({
    stat: async () => ({ mtimeMs: 1, size: 10 }),
    probe: async () => { probes++; return gate.promise; },
  });
  const replies = Array.from({ length: 20 }, () => probe("/tmp/song.wav"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probes, 1);
  gate.resolve(12345);
  assert.deepEqual(await Promise.all(replies), Array(20).fill(12345));
  assert.equal(await probe("/tmp/song.wav"), 12345);
  assert.equal(probes, 1);
});

test("path, mtime and size invalidate results; missing files do not return stale duration", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "catcut-duration-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "song.wav");
  await fs.writeFile(file, "x");
  let probes = 0;
  const probe = createMediaDurationCache({ probe: async () => ++probes * 1000 });
  assert.equal(await probe(file), 1000);
  assert.equal(await probe(file), 1000);
  const first = await fs.stat(file);
  await fs.utimes(file, first.atime, new Date(first.mtimeMs + 1000));
  assert.equal(await probe(file), 2000);
  const second = await fs.stat(file);
  await fs.appendFile(file, "y");
  await fs.utimes(file, second.atime, second.mtime);
  assert.equal(await probe(file), 3000);
  await fs.copyFile(file, path.join(dir, "other.wav"));
  assert.equal(await probe(path.join(dir, "other.wav")), 4000);
  await fs.rm(file);
  assert.equal(await probe(file), null);
  assert.equal(probes, 4);
});

test("LRU evicts the least recently used entry at the configured limit", async () => {
  const calls: string[] = [];
  const probe = createMediaDurationCache({
    maxEntries: 2,
    stat: async () => ({ mtimeMs: 1, size: 10 }),
    probe: async (file: string) => { calls.push(file); return 1000; },
  });
  for (const name of ["a", "b", "a", "c", "a", "b"]) await probe(`/tmp/${name}`);
  assert.deepEqual(calls, ["/tmp/a", "/tmp/b", "/tmp/c", "/tmp/b"]);
});

test("failed probes retry and concurrent rejection is converted to null", async () => {
  let probes = 0;
  const probe = createMediaDurationCache({
    stat: async () => ({ mtimeMs: 1, size: 10 }),
    probe: async () => {
      probes++;
      if (probes === 1) throw new Error("ffprobe unavailable");
      if (probes === 2) return null;
      return 1000;
    },
  });
  assert.deepEqual(await Promise.all([probe("/tmp/a"), probe("/tmp/a")]), [null, null]);
  assert.equal(probes, 1);
  assert.equal(await probe("/tmp/a"), null);
  assert.equal(await probe("/tmp/a"), 1000);
  assert.equal(await probe("/tmp/a"), 1000);
  assert.equal(probes, 3);
});

test("replacement during a delayed probe cannot overwrite the newer version", async () => {
  let version = 1;
  let probes = 0;
  const old = deferred<number>();
  const probe = createMediaDurationCache({
    stat: async () => ({ mtimeMs: version, size: 10 }),
    probe: async () => ++probes === 1 ? old.promise : 2000,
  });
  const first = probe("/tmp/a");
  await new Promise((resolve) => setImmediate(resolve));
  version = 2;
  assert.equal(await probe("/tmp/a"), 2000);
  old.resolve(1000);
  assert.equal(await first, 1000);
  assert.equal(await probe("/tmp/a"), 2000);
  assert.equal(probes, 2);
});

test("clear discards cached and in-flight entries without late cache repopulation", async () => {
  let probes = 0;
  const old = deferred<number>();
  const probe = createMediaDurationCache({
    stat: async () => ({ mtimeMs: 1, size: 10 }),
    probe: async () => ++probes === 1 ? old.promise : 2000,
  });
  const first = probe("/tmp/a");
  await new Promise((resolve) => setImmediate(resolve));
  probe.clear();
  assert.equal(await probe("/tmp/a"), 2000);
  old.resolve(1000);
  assert.equal(await first, 1000);
  assert.equal(await probe("/tmp/a"), 2000);
  assert.equal(probes, 2);
  probe.clear();
  await probe("/tmp/a");
  assert.equal(probes, 3);
});
