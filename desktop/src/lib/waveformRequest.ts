/** Retry a transient read once. An abandoned run must neither retry nor publish its result. */
export async function loadWaveformWithRetry<T>(
  load: () => Promise<T>,
  signal: AbortSignal,
  retryDelayMs = 800,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted();
    try {
      const result = await load();
      signal.throwIfAborted();
      return result;
    } catch (error) {
      signal.throwIfAborted();
      if (attempt >= 1) throw error;
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, retryDelayMs);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
  }
}
