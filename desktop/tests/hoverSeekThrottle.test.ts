import { strict as assert } from "node:assert";
import test from "node:test";
import { createThrottledSeek, type ThrottleClock } from "../src/lib/hoverSeekThrottle.ts";

/** テスト用の手動進行クロック(setTimeoutはadvanceで発火する)。 */
function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { fireAt: number; fn: () => void }>();
  const clock: ThrottleClock = {
    now: () => now,
    setTimeout: (fn, delayMs) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { fireAt: now + delayMs, fn });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
  };
  const advance = (deltaMs: number) => {
    const target = now + deltaMs;
    // fireAt順に発火する(1回のadvanceで複数発火し得る)
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.fireAt <= target)
        .sort((a, b) => a[1].fireAt - b[1].fireAt)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].fireAt;
      due[1].fn();
    }
    now = target;
  };
  return { clock, advance, pendingTimerCount: () => timers.size };
}

test("hoverSeekThrottle: 最初の要求は即時実行される(leading)", () => {
  const { clock } = createFakeClock();
  const calls: number[] = [];
  const throttle = createThrottledSeek((ms) => calls.push(ms), 30, clock);
  throttle.request(100);
  assert.deepEqual(calls, [100]);
});

test("hoverSeekThrottle: interval内の連続要求は最後の1件だけtrailingで実行される", () => {
  const { clock, advance } = createFakeClock();
  const calls: number[] = [];
  const throttle = createThrottledSeek((ms) => calls.push(ms), 30, clock);
  throttle.request(100);
  advance(10);
  throttle.request(110);
  advance(5);
  throttle.request(120);
  assert.deepEqual(calls, [100]);
  advance(30);
  assert.deepEqual(calls, [100, 120]);
});

test("hoverSeekThrottle: interval経過後の要求は再び即時実行される", () => {
  const { clock, advance } = createFakeClock();
  const calls: number[] = [];
  const throttle = createThrottledSeek((ms) => calls.push(ms), 30, clock);
  throttle.request(100);
  advance(31);
  throttle.request(200);
  assert.deepEqual(calls, [100, 200]);
});

test("hoverSeekThrottle: trailing待機中の追加要求は保留値を上書きする(タイマーは1本のまま)", () => {
  const { clock, advance, pendingTimerCount } = createFakeClock();
  const calls: number[] = [];
  const throttle = createThrottledSeek((ms) => calls.push(ms), 30, clock);
  throttle.request(100);
  throttle.request(110);
  throttle.request(120);
  throttle.request(130);
  assert.equal(pendingTimerCount(), 1);
  advance(30);
  assert.deepEqual(calls, [100, 130]);
});

test("hoverSeekThrottle: cancelで保留中のtrailing実行を破棄する", () => {
  const { clock, advance, pendingTimerCount } = createFakeClock();
  const calls: number[] = [];
  const throttle = createThrottledSeek((ms) => calls.push(ms), 30, clock);
  throttle.request(100);
  throttle.request(110);
  throttle.cancel();
  assert.equal(pendingTimerCount(), 0);
  advance(100);
  assert.deepEqual(calls, [100]);
});

test("hoverSeekThrottle: trailing実行後は実行時刻を基準に次のintervalが始まる", () => {
  const { clock, advance } = createFakeClock();
  const calls: number[] = [];
  const throttle = createThrottledSeek((ms) => calls.push(ms), 30, clock);
  throttle.request(100); // t=0 即時
  advance(10);
  throttle.request(110); // trailing予約(t=30発火)
  advance(20); // t=30: trailingで110実行
  assert.deepEqual(calls, [100, 110]);
  advance(10); // t=40(前回実行から10ms)
  throttle.request(120); // まだinterval内→trailing
  assert.deepEqual(calls, [100, 110]);
  advance(20); // t=60で発火
  assert.deepEqual(calls, [100, 110, 120]);
});
