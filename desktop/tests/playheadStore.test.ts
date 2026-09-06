import test from "node:test";
import assert from "node:assert/strict";
import { createPlayheadStore } from "../src/lib/playheadStore.ts";

test("playheadStore: 初期値はsourceMs=0 / timelineMs=null", () => {
  const store = createPlayheadStore();
  assert.equal(store.getSourceMs(), 0);
  assert.equal(store.getTimelineMs(), null);
});

test("playheadStore: setで値が変わり購読者へ通知される", () => {
  const store = createPlayheadStore();
  let calls = 0;
  store.subscribe(() => {
    calls += 1;
  });
  store.setSourceMs(1234);
  assert.equal(store.getSourceMs(), 1234);
  assert.equal(calls, 1);
  store.setTimelineMs(5678);
  assert.equal(store.getTimelineMs(), 5678);
  assert.equal(calls, 2);
});

test("playheadStore: 同じ値のsetでは通知しない(毎フレームの無駄な通知を防ぐ)", () => {
  const store = createPlayheadStore();
  let calls = 0;
  store.subscribe(() => {
    calls += 1;
  });
  store.setSourceMs(100);
  store.setSourceMs(100);
  store.setTimelineMs(null);
  assert.equal(calls, 1);
});

test("playheadStore: 複数購読者に通知され、unsubscribeで解除される", () => {
  const store = createPlayheadStore();
  let a = 0;
  let b = 0;
  const offA = store.subscribe(() => {
    a += 1;
  });
  store.subscribe(() => {
    b += 1;
  });
  store.setSourceMs(10);
  offA();
  store.setSourceMs(20);
  assert.equal(a, 1);
  assert.equal(b, 2);
});

test("playheadStore: resetで初期値へ戻り通知される(すでに初期値なら通知しない)", () => {
  const store = createPlayheadStore();
  let calls = 0;
  store.subscribe(() => {
    calls += 1;
  });
  store.reset();
  assert.equal(calls, 0);
  store.setSourceMs(500);
  store.setTimelineMs(700);
  store.reset();
  assert.equal(store.getSourceMs(), 0);
  assert.equal(store.getTimelineMs(), null);
  assert.equal(calls, 3);
});
