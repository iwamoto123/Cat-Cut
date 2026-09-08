import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createAtomicJsonWriter } = require("../main/atomicJsonWriter.cjs");

test("overlapping saves commit in request order using unique temporary paths", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "catcut-save-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const files = new Set<string>();
  const writer = createAtomicJsonWriter({ ...fs, writeFile: async (file: string, data: string, encoding: "utf8") => {
    assert.equal(files.has(file), false);
    files.add(file);
    // Make the oldest payload slower than all subsequent payloads.
    if (JSON.parse(data).revision === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.writeFile(file, data, encoding);
  } });
  const output = path.join(dir, "draft.json");
  await Promise.all(Array.from({ length: 20 }, (_, revision) => writer(output, { revision })));
  assert.deepEqual(JSON.parse(await fs.readFile(output, "utf8")), { revision: 19 });
  assert.deepEqual(await fs.readdir(dir), ["draft.json"]);
});

test("failed save preserves last good file and does not block the next save", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "catcut-save-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const output = path.join(dir, "draft.json");
  await fs.writeFile(output, '{"revision":0}');
  let fail = true;
  const writer = createAtomicJsonWriter({ ...fs, rename: async (from: string, to: string) => {
    if (fail) throw new Error("disk full");
    await fs.rename(from, to);
  } });
  await assert.rejects(writer(output, { revision: 1 }), /disk full/);
  assert.deepEqual(JSON.parse(await fs.readFile(output, "utf8")), { revision: 0 });
  assert.deepEqual(await fs.readdir(dir), ["draft.json"]);
  fail = false;
  await writer(output, { revision: 2 });
  assert.deepEqual(JSON.parse(await fs.readFile(output, "utf8")), { revision: 2 });
});
