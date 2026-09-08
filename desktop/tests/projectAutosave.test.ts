import test from "node:test";
import assert from "node:assert/strict";
import { createProjectAutosave, type ProjectSaveSnapshot } from "../src/lib/projectAutosave.ts";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const snapshot = (runDir = "/fixture", n = 1): ProjectSaveSnapshot => ({
  draft: { runDir, scenes: [], keepSegments: [], overlayEdits: {}, customStyles: {} },
  images: { timelineDurationMs: 1000, clips: [{ id: "image", file: "x.png", start_ms: 0, end_ms: 1000, x: n / 10, y: .5, scale: .3, opacity: 1, url: "fixture:image" }] },
  bgm: { timelineDurationMs: 1000, clips: [{ id: "bgm", file: "x.wav", start_ms: 0, end_ms: 1000, volume: n, fade_in_ms: 0, fade_out_ms: 0, url: "fixture:audio", audioDurationMs: 1000 }] },
});

test("latest media edits and undo save after a delayed response; response never replaces editor data", async () => {
  const gate = deferred();
  const writes: number[] = [];
  let active = 0;
  const queue = createProjectAutosave({ delayMs: 60000, api: {
    saveSceneEditsDraft: async () => ({} as never),
    saveBgm: async () => ({} as never),
    saveImages: async (input) => {
      assert.equal(++active, 1);
      writes.push(input.clips[0]?.x ?? -1);
      if (writes.length === 1) await gate.promise;
      active--;
      return { clips: [], timelineDurationMs: 0 };
    },
  }});
  const original = snapshot();
  queue.schedule("/fixture", original);
  const pending = queue.flush("/fixture");
  await Promise.resolve();
  const changed = snapshot("/fixture", 2);
  queue.schedule("/fixture", changed);
  queue.schedule("/fixture", { ...original, images: { ...original.images!, clips: [] } });
  gate.resolve();
  await pending;
  assert.equal(original.images!.clips.length, 1);
  assert.deepEqual(writes, [.1, -1]);
  assert.equal(queue.isDirty(), false);
});

test("flush waits for other tracks on failure, retries failed track only, and preserves newer edit", async () => {
  const imageGate = deferred();
  let failBgm = true;
  let imageCalls = 0, draftCalls = 0, bgmCalls = 0;
  const queue = createProjectAutosave({ delayMs: 60000, api: {
    saveSceneEditsDraft: async () => { draftCalls++; return {} as never; },
    saveImages: async () => { imageCalls++; await imageGate.promise; return {} as never; },
    saveBgm: async () => { bgmCalls++; if (failBgm) throw Error("disk full"); return {} as never; },
  }});
  const value = snapshot();
  queue.schedule("/fixture", value);
  let settled = false;
  const first = queue.flush().finally(() => { settled = true; });
  const failure = assert.rejects(first, /disk full/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  imageGate.resolve();
  await failure;
  assert.equal(queue.isDirty(), true);
  failBgm = false;
  await queue.flush();
  assert.deepEqual([draftCalls, imageCalls, bgmCalls], [1, 1, 2]);
  assert.equal(queue.isDirty(), false);
});

test("saving text changes does not rewrite unchanged media or leak playback metadata", async () => {
  let images = 0, bgm = 0, drafts = 0;
  const queue = createProjectAutosave({ delayMs: 60000, api: {
    saveSceneEditsDraft: async () => { drafts++; return {} as never; },
    saveImages: async (value) => { images++; assert.equal("url" in value.clips[0], false); return {} as never; },
    saveBgm: async (value) => { bgm++; assert.equal("url" in value.clips[0], false); assert.equal("audioDurationMs" in value.clips[0], false); return {} as never; },
  }});
  const first = snapshot();
  queue.schedule("/fixture", first);
  await queue.flush();
  queue.schedule("/fixture", { ...first, draft: { ...first.draft, overlayEdits: { x: { text: "edited" } } } });
  await queue.flush();
  assert.deepEqual([drafts, images, bgm], [2, 1, 1]);
});

test("a failed run does not prevent saving another run", async () => {
  const done: string[] = [];
  const queue = createProjectAutosave({ delayMs: 60000, api: {
    saveSceneEditsDraft: async (value) => { if (value.runDir === "/bad") throw Error("no access"); done.push(value.runDir); return {} as never; },
    saveImages: async () => ({} as never), saveBgm: async () => ({} as never),
  }});
  queue.schedule("/bad", snapshot("/bad"));
  queue.schedule("/good", snapshot("/good"));
  await assert.rejects(queue.flush("/bad"), /no access/);
  await queue.flush("/good");
  assert.deepEqual(done, ["/good"]);
  assert.equal(queue.isDirty("/bad"), true);
});
