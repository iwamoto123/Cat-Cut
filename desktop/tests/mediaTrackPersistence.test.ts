import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { compileFunction } from "node:vm";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const mainFile = new URL("../main/index.cjs", import.meta.url);
const mainRequire = createRequire(mainFile);
const mainSource = fs.readFileSync(mainFile, "utf8");

/** Execute the actual IPC handlers against a temporary repo, with no app/AI startup. */
function setup(t: TestContext, options: { heldProbes?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catcut-media-ipc-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const runDir = path.join(root, "runs", "synthetic");
  fs.mkdirSync(path.join(runDir, "step08_composition"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "step08_composition", "composition.json"), JSON.stringify({
    timeline: { total_duration_ms: 10000 },
  }));
  const handlers = new Map<string, Function>();
  const probes: Array<() => void> = [];
  let probeCalls = 0;
  let trackJsonReads = 0;
  let failRename = false;
  const io = {
    ...fs.promises,
    async rename(from: string, to: string) {
      if (failRename) throw new Error("synthetic disk full");
      return fs.promises.rename(from, to);
    },
  };
  const fakeRequire = (name: string) => {
    if (name === "electron") return {
      app: { whenReady: () => ({ then() {} }), on() {} },
      ipcMain: { handle: (channel: string, callback: Function) => handlers.set(channel, callback) },
    };
    if (name === "./apiKeys.cjs") return { createApiKeysModule: () => ({}) };
    if (name === "./license.cjs") return { createLicenseModule: () => ({}), registerLicenseIpc() {} };
    if (name === "./atomicJsonWriter.cjs") return {
      createAtomicJsonWriter: () => mainRequire(name).createAtomicJsonWriter(io),
    };
    if (name === "fs") return {
      ...fs,
      readFileSync(file: string, ...args: any[]) {
        if (/[/\\](bgm|images)\.json$/.test(String(file))) trackJsonReads++;
        return (fs.readFileSync as Function)(file, ...args);
      },
    };
    if (name === "child_process") return {
      spawn(bin: string) {
        assert.equal(bin, "ffprobe", "media tests must not spawn an analysis pipeline");
        probeCalls++;
        const child = Object.assign(new EventEmitter(), { stdout: new PassThrough() });
        const complete = () => {
          child.stdout.emit("data", Buffer.from("2.5\n"));
          child.emit("close", 0);
        };
        if (options.heldProbes) probes.push(complete);
        else setImmediate(complete);
        return child;
      },
    };
    return mainRequire(name);
  };
  const module = { exports: {} };
  compileFunction(mainSource, ["require", "module", "exports", "__dirname", "__filename"], {
    filename: mainFile.pathname,
  })(fakeRequire, module, module.exports, path.join(root, "desktop", "main"), mainFile.pathname);
  return {
    root, runDir, probes,
    get probeCalls() { return probeCalls; },
    get trackJsonReads() { return trackJsonReads; },
    failSave(value: boolean) { failRename = value; },
    invoke(channel: string, args: Record<string, unknown> = {}) {
      const handler = handlers.get(channel);
      assert.ok(handler, channel);
      return handler({}, { runDir, ...args });
    },
    source(name: string, content = "synthetic media") {
      const file = path.join(root, name);
      fs.writeFileSync(file, content);
      return file;
    },
    material(kind: string, name: string) {
      fs.mkdirSync(path.join(runDir, kind), { recursive: true });
      fs.writeFileSync(path.join(runDir, kind, name), "synthetic media");
    },
    saved(kind: string) {
      return JSON.parse(fs.readFileSync(path.join(runDir, kind, `${kind}.json`), "utf8"));
    },
  };
}

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.ok(predicate(), "expected async operation did not start");
}

test("BGM overlapping saves share a delayed probe and replies retain each committed payload", async (t) => {
  const fixture = setup(t, { heldProbes: true });
  fixture.material("bgm", "song.wav");
  const base = { id: "bgm_1", file: "song.wav", start_ms: 0, end_ms: 4000 };
  const old = fixture.invoke("bgm:save", { clips: [{ ...base, volume: 0.25 }] });
  await until(() => fixture.probes.length === 1);
  const newer = fixture.invoke("bgm:save", { clips: [{ ...base, volume: 0.75 }] });
  await until(() => fixture.saved("bgm")[0].volume === 0.75);
  assert.equal(fixture.probeCalls, 1);
  fixture.probes.shift()!();
  const [first, second] = await Promise.all([old, newer]);
  assert.equal(first.clips[0].volume, 0.25);
  assert.equal(second.clips[0].volume, 0.75);
  assert.equal(first.clips[0].audioDurationMs, 2500);
  assert.equal(second.timelineDurationMs, 10000);
  assert.equal(fixture.trackJsonReads, 0, "save replies must not reread the track JSON");
  await fixture.invoke("bgm:save", { clips: [{ ...base, volume: 0.5 }] });
  assert.equal(fixture.probeCalls, 1, "volume-only changes reuse duration metadata");
});

test("BGM simultaneous imports append both files, retain originals, and preserve defaults", async (t) => {
  const fixture = setup(t, { heldProbes: true });
  const source = fixture.source("song.wav");
  const first = fixture.invoke("bgm:add-file", { filePath: source, startMs: 0 });
  const second = fixture.invoke("bgm:add-file", { filePath: source, startMs: 5000 });
  await until(() => fixture.probes.length === 1);
  fixture.probes.shift()!();
  await until(() => fixture.probes.length === 1);
  fixture.probes.shift()!();
  const replies = await Promise.all([first, second]);
  const saved = fixture.saved("bgm");
  assert.deepEqual(saved.map((clip: any) => clip.file), ["song.wav", "song-2.wav"]);
  assert.equal(new Set(saved.map((clip: any) => clip.id)).size, 2);
  assert.equal(replies[0].clips.length, 1);
  assert.equal(replies[1].clips.length, 2);
  assert.equal(fixture.probeCalls, 2);
  for (const clip of saved) {
    assert.equal(clip.volume, 1);
    assert.equal(clip.end_ms - clip.start_ms, 2500);
    assert.equal(clip.fade_in_ms, 1500);
    assert.equal(clip.fade_out_ms, 1500);
  }
  await fixture.invoke("bgm:save", { clips: [] });
  assert.ok(fs.existsSync(path.join(fixture.runDir, "bgm", "song.wav")));
  assert.ok(fs.existsSync(source));
  const restored = await fixture.invoke("bgm:save", { clips: saved });
  assert.equal(restored.clips.length, 2, "Undo can still reference removed clips' media");
});

test("image async imports keep both clips with unique filenames and deletion remains undoable", async (t) => {
  const fixture = setup(t);
  const source = fixture.source("overlay.png");
  const replies = await Promise.all([
    fixture.invoke("images:add-file", { filePath: source, startMs: 0 }),
    fixture.invoke("images:add-file", { filePath: source, startMs: 9999 }),
  ]);
  assert.deepEqual(replies.map((state: any) => state.clips.length), [1, 2]);
  const saved = fixture.saved("images");
  assert.deepEqual(saved.map((clip: any) => clip.file), ["overlay.png", "overlay-2.png"]);
  assert.equal(new Set(saved.map((clip: any) => clip.id)).size, 2);
  assert.equal(saved[0].x, 0.5);
  assert.equal(saved[0].y, 0.35);
  assert.equal(saved[0].scale, 0.55);
  assert.equal(saved[1].start_ms, 9500);
  assert.equal(saved[1].end_ms, 10000);
  await fixture.invoke("images:save", { clips: [] });
  assert.ok(fs.existsSync(path.join(fixture.runDir, "images", "overlay.png")));
  const restored = await fixture.invoke("images:save", { clips: saved });
  assert.equal(restored.clips.length, 2);
  assert.equal((await fixture.invoke("images:list")).clips.length, 2);
  assert.equal(fixture.probeCalls, 0);
});

test("image rapid saves commit in order with individual replies and no response reread", async (t) => {
  const fixture = setup(t);
  fixture.material("images", "overlay.png");
  const replies = await Promise.all(Array.from({ length: 12 }, (_, revision) =>
    fixture.invoke("images:save", { clips: [{
      id: `image_${revision}`, file: "overlay.png", start_ms: 0, end_ms: 1000,
    }] }),
  ));
  assert.deepEqual(replies.map((state: any) => state.clips[0].id),
    Array.from({ length: 12 }, (_, revision) => `image_${revision}`));
  assert.equal(fixture.saved("images")[0].id, "image_11");
  assert.equal(fixture.trackJsonReads, 0);
  assert.deepEqual(fs.readdirSync(path.join(fixture.runDir, "images")).sort(), ["images.json", "overlay.png"]);
});

test("failed atomic track save preserves the previous JSON and a retry is not blocked", async (t) => {
  const fixture = setup(t);
  fixture.material("images", "overlay.png");
  const clip = { id: "image_1", file: "overlay.png", start_ms: 0, end_ms: 1000 };
  await fixture.invoke("images:save", { clips: [clip] });
  fixture.failSave(true);
  await assert.rejects(fixture.invoke("images:save", { clips: [] }), /synthetic disk full/);
  assert.equal(fixture.saved("images").length, 1);
  assert.deepEqual(fs.readdirSync(path.join(fixture.runDir, "images")).sort(), ["images.json", "overlay.png"]);
  fixture.failSave(false);
  await fixture.invoke("images:save", { clips: [] });
  assert.deepEqual(fixture.saved("images"), []);
});

test("track normalization preserves order, clamps values, and drops absent media", async (t) => {
  const fixture = setup(t);
  fixture.material("bgm", "song.wav");
  fixture.material("images", "overlay.png");
  const bgm = await fixture.invoke("bgm:save", { clips: [
    { id: "late", file: "../song.wav", start_ms: 5000.4, end_ms: 6000.4, volume: 9, fade_in_ms: 5000, fade_out_ms: -5 },
    { id: "early", file: "song.wav", start_ms: 0, end_ms: 1000 },
    { id: "missing", file: "absent.wav", start_ms: 0, end_ms: 1000 },
  ] });
  assert.deepEqual(bgm.clips.map((clip: any) => clip.id), ["late", "early"]);
  assert.equal(bgm.clips[0].file, "song.wav");
  assert.equal(bgm.clips[0].volume, 1);
  assert.equal(bgm.clips[0].fade_in_ms, 1000);
  assert.equal(bgm.clips[0].fade_out_ms, 0);
  assert.equal(bgm.clips[1].volume, 1);
  const images = await fixture.invoke("images:save", { clips: [
    { id: "image", file: "overlay.png", start_ms: -2, end_ms: 1000, x: -1, y: 2, scale: 0, opacity: 3 },
  ] });
  assert.deepEqual(fixture.saved("images"), [{
    id: "image", file: "overlay.png", start_ms: 0, end_ms: 1000, x: 0, y: 1, scale: 0.1, opacity: 1,
  }]);
  assert.equal(images.clips[0].url, "");
  assert.equal(images.timelineDurationMs, 10000);
});
