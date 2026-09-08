import test from "node:test";
import assert from "node:assert/strict";
import { createPreviewAudioGroup } from "../src/lib/previewAudio.ts";

test("explicit pause stops every active effect and also a late play promise", async () => {
  const group = createPreviewAudioGroup();
  const makeAudio = () => {
    let resolve!: () => void, pauses = 0;
    const promise = new Promise<void>((done) => { resolve = done; });
    const listeners = new Map<string, any>();
    return { play: () => promise, pause: () => { pauses++; }, addEventListener: (name: string, fn: any) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name), resolve, get pauses() { return pauses; }, listeners };
  };
  const a = makeAudio(), b = makeAudio();
  group.play(a); group.play(b); group.pauseAll();
  assert.equal(a.pauses, 1); assert.equal(b.pauses, 1);
  assert.equal(a.listeners.size, 0); assert.equal(b.listeners.size, 0);
  a.resolve(); b.resolve(); await Promise.resolve();
  assert.equal(a.pauses, 2); assert.equal(b.pauses, 2);
  group.pauseAll(); assert.equal(a.pauses, 2);
});

test("completed sounds release their handlers and do not accumulate", async () => {
  const group = createPreviewAudioGroup();
  const listeners = new Map<string, any>();
  let pauses = 0;
  const audio = { play: async () => {}, pause: () => { pauses++; }, addEventListener: (name: string, fn: any) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name) };
  group.play(audio); await Promise.resolve();
  listeners.get("ended")(); group.pauseAll();
  assert.equal(pauses, 0); assert.equal(listeners.size, 0);
});
