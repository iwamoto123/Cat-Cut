// Position-only projection. Never changes caption pages, animation, or retained media.
function normalizeTelopPosition(value) {
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return undefined;
  const axis = (number) => Math.round(Math.max(0, Math.min(1, number)) * 10000) / 10000;
  return { x: axis(value.x), y: axis(value.y) };
}
function normalizeSceneTelopPositions(value) {
  return (Array.isArray(value) ? value : []).flatMap((entry) => {
    if (!Number.isFinite(entry?.startMs) || !Number.isFinite(entry?.endMs) || entry.endMs <= entry.startMs) return [];
    return [{ startMs: entry.startMs, endMs: entry.endMs, telopPosition: normalizeTelopPosition(entry.telopPosition) ?? null }];
  }).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}
function projectSceneTelopPositions(composition, keepSegments, positions) {
  if (!Array.isArray(positions)) return false;
  const normalized = normalizeSceneTelopPositions(positions);
  let changed = false;
  let sceneIndex = 0;
  let previousCutStart = -Infinity;
  for (const [index, cut] of (composition?.voice_data?.cuts ?? []).entries()) {
    const keep = keepSegments?.[index];
    const startMs = keep?.start_ms ?? keep?.startMs, endMs = keep?.end_ms ?? keep?.endMs;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    const speed = Number.isFinite(keep.speed) && keep.speed > 0 ? keep.speed : 1;
    if (startMs < previousCutStart) sceneIndex = 0;
    previousCutStart = startMs;
    while (sceneIndex < normalized.length && normalized[sceneIndex].endMs <= startMs) sceneIndex++;
    const ranges = [];
    for (let i = sceneIndex; i < normalized.length; i++) {
      const scene = normalized[i];
      if (scene.endMs <= startMs) continue;
      if (scene.startMs >= endMs) break;
      const start = (Math.max(startMs, scene.startMs) - startMs) / (1000 * speed);
      const end = (Math.min(endMs, scene.endMs) - startMs) / (1000 * speed);
      if (end <= start) continue;
      const previous = ranges.at(-1);
      if (previous?.end === start && JSON.stringify(previous.position) === JSON.stringify(scene.telopPosition)) previous.end = end;
      else ranges.push({ start, end, position: scene.telopPosition });
    }
    if (JSON.stringify(cut.telop_position_ranges ?? []) !== JSON.stringify(ranges)) {
      cut.telop_position_ranges = ranges;
      changed = true;
    }
  }
  return changed;
}
function telopPositionForTime(ranges, seconds, fallback) {
  if (!Number.isFinite(seconds)) return normalizeTelopPosition(fallback);
  let left = 0, right = (ranges?.length ?? 0) - 1;
  while (left <= right) {
    const middle = Math.floor((left + right) / 2), range = ranges[middle];
    if (seconds < range.start) right = middle - 1;
    else if (seconds >= range.end) left = middle + 1;
    else return normalizeTelopPosition(range.position);
  }
  return normalizeTelopPosition(fallback);
}
module.exports = { normalizeTelopPosition, normalizeSceneTelopPositions, projectSceneTelopPositions, telopPositionForTime };
