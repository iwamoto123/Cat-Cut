/**
 * Serialize reads/appends/saves per track file. Response enrichment happens after
 * the commit, using its own payload, so a slow probe never mixes two save replies.
 */
function createMediaTrackStore({
  resolveRunDir,
  jsonPathForRun,
  readClips,
  sanitizeClips,
  writeJson,
  enrichClips,
  timelineDurationMsForRun,
}) {
  const pending = new Map();
  function enqueue(resolved, operation) {
    const key = jsonPathForRun(resolved);
    const previous = pending.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    pending.set(key, next);
    const cleanup = () => {
      if (pending.get(key) === next) pending.delete(key);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  async function toState(resolved, clips) {
    return {
      clips: await enrichClips(resolved, clips),
      timelineDurationMs: timelineDurationMsForRun(resolved),
    };
  }

  return {
    async load(runDir) {
      const resolved = resolveRunDir(runDir);
      const clips = await enqueue(resolved, () => sanitizeClips(resolved, readClips(resolved)));
      return toState(resolved, clips);
    },
    async save(runDir, rawClips) {
      const resolved = resolveRunDir(runDir);
      // Normalize immediately to detach the queued snapshot from caller mutation.
      const clips = sanitizeClips(resolved, rawClips);
      await enqueue(resolved, () => writeJson(jsonPathForRun(resolved), clips));
      return toState(resolved, clips);
    },
    async append(runDir, createClip) {
      const resolved = resolveRunDir(runDir);
      const clips = await enqueue(resolved, async () => {
        const clip = await createClip();
        const raw = readClips(resolved);
        const next = sanitizeClips(resolved, [...(Array.isArray(raw) ? raw : []), clip]);
        await writeJson(jsonPathForRun(resolved), next);
        return next;
      });
      return toState(resolved, clips);
    },
  };
}

module.exports = { createMediaTrackStore };
