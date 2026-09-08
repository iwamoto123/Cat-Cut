/** Debounced, serialized saves. Navigation can flush without losing the last two seconds. */
export function createDraftAutosave<T>(options: {
  save: (value: T) => Promise<unknown>;
  onSaved?: (value: T) => void;
  onError?: (error: unknown, value: T) => void;
  delayMs?: number;
}) {
  type RunSave = {
    pending: { value: T } | null;
    timer: ReturnType<typeof setTimeout> | null;
    inFlight: Promise<void> | null;
  };
  const runs = new Map<string, RunSave>();

  function clearTimer(run: RunSave) {
    if (run.timer !== null) clearTimeout(run.timer);
    run.timer = null;
  }

  function flushRun(key: string): Promise<void> {
    const run = runs.get(key);
    if (!run) return Promise.resolve();
    clearTimer(run);
    if (run.inFlight) return run.inFlight;
    run.inFlight = Promise.resolve().then(async () => {
      while (run.pending) {
        clearTimer(run);
        const { value } = run.pending;
        run.pending = null;
        try {
          await options.save(value);
          if (!run.pending) options.onSaved?.(value);
        } catch (error) {
          // A newer edit must win over the failed snapshot on retry.
          if (!run.pending) run.pending = { value };
          options.onError?.(error, value);
          throw error;
        }
      }
    }).finally(() => {
      run.inFlight = null;
      if (!run.pending) {
        clearTimer(run);
        runs.delete(key);
      }
    });
    return run.inFlight;
  }

  function flush(key?: string): Promise<void> {
    if (key !== undefined) return flushRun(key);
    const keys = [...runs.keys()];
    if (keys.length === 1) return flushRun(keys[0]);
    return Promise.all(keys.map(flushRun)).then(() => {});
  }

  return {
    schedule(key: string, value: T) {
      const run = runs.get(key) ?? { pending: null, timer: null, inFlight: null };
      runs.set(key, run);
      run.pending = { value };
      clearTimer(run);
      run.timer = setTimeout(() => {
        run.timer = null;
        void flushRun(key).catch(() => { /* Error is reported and snapshot retained for retry. */ });
      }, options.delayMs ?? 2000);
    },
    flush,
    isDirty: (key?: string) => key === undefined ? runs.size > 0 : runs.has(key),
  };
}
