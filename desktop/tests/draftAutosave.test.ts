import test from "node:test";
import assert from "node:assert/strict";
import { createDraftAutosave } from "../src/lib/draftAutosave.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("leaving immediately flushes the latest edit before the two-second timer", async () => {
  const saved: number[] = [];
  const queue = createDraftAutosave<number>({ save: async (value) => { saved.push(value); } });
  queue.schedule("run", 1);
  queue.schedule("run", 2);
  assert.equal(queue.isDirty(), true);
  assert.deepEqual(saved, []);
  await queue.flush();
  assert.deepEqual(saved, [2]);
  assert.equal(queue.isDirty(), false);
});

test("a slow write cannot overwrite a newer edit and concurrent flushes share completion", async () => {
  const gate = deferred();
  const started = deferred();
  const saved: number[] = [];
  const queue = createDraftAutosave<number>({ save: async (value) => {
    if (value === 1) { started.resolve(); await gate.promise; }
    saved.push(value);
  } });
  queue.schedule("run", 1);
  const first = queue.flush();
  await started.promise;
  queue.schedule("run", 2);
  queue.schedule("run", 3);
  const second = queue.flush();
  assert.equal(first, second);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(saved, [1, 3]);
});

test("different projects keep separate pending snapshots", async () => {
  const saved: string[] = [];
  const queue = createDraftAutosave<string>({ save: async (value) => { saved.push(value); } });
  queue.schedule("a", "a:old");
  queue.schedule("b", "b:latest");
  queue.schedule("a", "a:latest");
  await queue.flush();
  assert.deepEqual(saved.sort(), ["a:latest", "b:latest"]);
});

test("save failure prevents successful flush and retains changes for retry", async () => {
  let fail = true;
  let errors = 0;
  const saved: number[] = [];
  const queue = createDraftAutosave<number>({
    save: async (value) => { if (fail) throw new Error("disk full"); saved.push(value); },
    onError: () => { errors += 1; },
  });
  queue.schedule("run", 1);
  await assert.rejects(queue.flush(), /disk full/);
  assert.equal(queue.isDirty(), true);
  assert.equal(errors, 1);
  fail = false;
  await queue.flush();
  assert.deepEqual(saved, [1]);
});

test("retry after a failed slow save never replaces a newer pending snapshot", async () => {
  const gate = deferred();
  const started = deferred();
  const saved: number[] = [];
  const queue = createDraftAutosave<number>({ save: async (value) => {
    if (value === 1) { started.resolve(); await gate.promise; throw new Error("write failed"); }
    saved.push(value);
  } });
  queue.schedule("run", 1);
  const first = queue.flush();
  await started.promise;
  queue.schedule("run", 2);
  gate.resolve();
  await assert.rejects(first, /write failed/);
  await queue.flush();
  assert.deepEqual(saved, [2]);
});

test("ordinary autosave still runs without explicit navigation", async () => {
  const done = deferred();
  const queue = createDraftAutosave<number>({ save: async () => { done.resolve(); }, delayMs: 0 });
  queue.schedule("run", 1);
  await done.promise;
  await queue.flush();
  assert.equal(queue.isDirty(), false);
});

test("an old project's failed save cannot block saving the current project", async () => {
  let failOld = true;
  const saved: string[] = [];
  const queue = createDraftAutosave<string>({ save: async (value) => {
    if (value === "a" && failOld) throw new Error("old project is unavailable");
    saved.push(value);
  } });
  queue.schedule("a", "a");
  await assert.rejects(queue.flush("a"), /unavailable/);
  queue.schedule("b", "b");
  await queue.flush("b");
  assert.deepEqual(saved, ["b"]);
  assert.equal(queue.isDirty("b"), false);
  assert.equal(queue.isDirty("a"), true);
  failOld = false;
  await queue.flush("a");
  assert.deepEqual(saved, ["b", "a"]);
  assert.equal(queue.isDirty(), false);
});
