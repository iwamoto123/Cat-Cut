/**
 * W19-A2(ホバースクラブのsetState排除): ホバーシークのスロットラー。
 * mousemoveごとの video.currentTime 書き込み(デコーダシーク)は重いため、約30ms間隔へ間引く。
 * - 先頭は即時実行(leading)でホバー追従の体感遅延を出さない
 * - 間引いた分は最後の1件だけ遅延実行(trailing)し、マウスを止めた位置に必ず着地させる
 * テスト可能にするためclock(now/setTimeout/clearTimeout)を注入できる純ロジックにしている。
 */
export type ThrottleClock = {
  now: () => number;
  setTimeout: (fn: () => void, delayMs: number) => number;
  clearTimeout: (id: number) => void;
};

export type ThrottledSeek = {
  /** シーク要求。interval内の連続要求は最後の1件へまとめられる。 */
  request: (ms: number) => void;
  /** 保留中のtrailing実行を破棄する(アンマウント時・再生開始時)。 */
  cancel: () => void;
};

export function createThrottledSeek(
  invoke: (ms: number) => void,
  intervalMs: number,
  clock: ThrottleClock = {
    now: () => performance.now(),
    setTimeout: (fn, delayMs) => window.setTimeout(fn, delayMs),
    clearTimeout: (id) => window.clearTimeout(id),
  },
): ThrottledSeek {
  let lastInvokeAt = -Infinity;
  let timerId: number | null = null;
  let pendingMs: number | null = null;

  const flushPending = () => {
    timerId = null;
    if (pendingMs == null) return;
    const ms = pendingMs;
    pendingMs = null;
    lastInvokeAt = clock.now();
    invoke(ms);
  };

  return {
    request(ms: number) {
      const now = clock.now();
      if (timerId == null && now - lastInvokeAt >= intervalMs) {
        lastInvokeAt = now;
        invoke(ms);
        return;
      }
      pendingMs = ms;
      if (timerId == null) {
        const waitMs = Math.max(0, intervalMs - (now - lastInvokeAt));
        timerId = clock.setTimeout(flushPending, waitMs);
      }
    },
    cancel() {
      if (timerId != null) {
        clock.clearTimeout(timerId);
        timerId = null;
      }
      pendingMs = null;
    },
  };
}
