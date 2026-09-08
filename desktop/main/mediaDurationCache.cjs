const fs = require("node:fs");
const path = require("node:path");

/** Small LRU of successful duration probes, with one subprocess per file version. */
function createMediaDurationCache({ probe, stat = fs.promises.stat, maxEntries = 128 }) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError("maxEntries must be a positive integer");
  }
  const cache = new Map();
  const pending = new Map();
  let generation = 0;
  const signatureOf = (fileStat) => `${fileStat.mtimeMs}:${fileStat.size}`;

  async function durationMs(filePath) {
    const resolved = path.resolve(filePath);
    let signature;
    try {
      signature = signatureOf(await stat(resolved));
    } catch {
      cache.delete(resolved);
      return null;
    }
    const cached = cache.get(resolved);
    if (cached?.signature === signature) {
      cache.delete(resolved);
      cache.set(resolved, cached);
      return cached.duration;
    }
    cache.delete(resolved);
    const key = JSON.stringify([resolved, signature]);
    if (pending.has(key)) return pending.get(key);
    const probeGeneration = generation;
    const request = Promise.resolve().then(async () => {
      const duration = await probe(resolved);
      // Failed probes are retried next time; replacing/deleting a file while a probe
      // runs must not cache the old result as metadata for the new file.
      if (Number.isFinite(duration) && probeGeneration === generation) {
        try {
          if (signatureOf(await stat(resolved)) === signature && probeGeneration === generation) {
            cache.delete(resolved);
            cache.set(resolved, { signature, duration });
            while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
          }
        } catch {
          cache.delete(resolved);
        }
      }
      return Number.isFinite(duration) ? duration : null;
    }).catch(() => null);
    pending.set(key, request);
    try {
      return await request;
    } finally {
      if (pending.get(key) === request) pending.delete(key);
    }
  }

  durationMs.clear = () => {
    generation += 1;
    cache.clear();
    pending.clear();
  };
  return durationMs;
}

module.exports = { createMediaDurationCache };
