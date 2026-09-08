import { weightedTelopLineLength } from "./wrapTelopLine.ts";

/** Composition-relative center. Absence preserves automatic face/style placement. */
export type TelopPosition = { x: number; y: number };
export type TelopPositionRange = { start: number; end: number; position: TelopPosition | null };

/** Half-open cut-relative seconds. Explicit null resets a former per-telop override. */
export function resolveTelopPositionAt(ranges: TelopPositionRange[] | undefined, seconds: number, fallback: unknown): TelopPosition | undefined {
  // Export supplies sorted non-overlapping ranges; long clips need O(log n) lookup per frame.
  let low = 0;
  let high = ranges?.length ?? 0;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((ranges?.[mid].start ?? Infinity) <= seconds) low = mid + 1;
    else high = mid;
  }
  const candidate = ranges?.[low - 1];
  const match = candidate && Number.isFinite(candidate.start) && Number.isFinite(candidate.end) && candidate.start <= seconds && seconds < candidate.end ? candidate : undefined;
  return normalizeTelopPosition(match ? match.position : fallback);
}

export function normalizeTelopPosition(value: unknown): TelopPosition | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { x, y } = value as Partial<TelopPosition>;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return { x: Math.round(Math.max(0, Math.min(1, x)) * 10000) / 10000, y: Math.round(Math.max(0, Math.min(1, y)) * 10000) / 10000 };
}

export type TelopPositionGeometry = {
  lineTexts: string[];
  fontSize: number;
  lineHeight: number;
  letterSpacingEm: number;
  videoWidth: number;
  videoHeight: number;
  paddingX?: number;
  paddingY?: number;
  lineGapPx?: number;
  strokePx?: number;
  rotateDeg?: number;
  verticalWriting?: boolean;
};

/** Same conservative glyph-width estimate as font fitting, including rotation and decoration. */
export function telopPositionBounds(geometry: TelopPositionGeometry) {
  const { lineTexts, fontSize, lineHeight, letterSpacingEm, videoWidth, videoHeight, paddingX = 0, paddingY = 0, lineGapPx = 8, strokePx = 0, rotateDeg = 0, verticalWriting = false } = geometry;
  const advance = fontSize * (1 + letterSpacingEm);
  const width = (verticalWriting ? fontSize * lineHeight : Math.max(1, ...lineTexts.map(weightedTelopLineLength)) * advance + fontSize * 0.6) + paddingX * 2 + strokePx;
  const height = (verticalWriting ? [...(lineTexts[0] ?? "")].length * advance : lineTexts.length * fontSize * lineHeight + Math.max(0, lineTexts.length - 1) * lineGapPx) + paddingY * 2 + strokePx;
  const radians = rotateDeg * Math.PI / 180;
  const rotatedWidth = Math.abs(Math.cos(radians)) * width + Math.abs(Math.sin(radians)) * height;
  const rotatedHeight = Math.abs(Math.sin(radians)) * width + Math.abs(Math.cos(radians)) * height;
  const insetX = Math.min(0.5, 0.04 + rotatedWidth / Math.max(1, videoWidth) / 2);
  const insetY = Math.min(0.5, 0.04 + rotatedHeight / Math.max(1, videoHeight) / 2);
  return { minX: insetX, maxX: 1 - insetX, minY: insetY, maxY: 1 - insetY };
}

/** Only explicit positions use these bounds; existing automatic placement is unchanged. */
export function clampTelopPosition(position: TelopPosition, geometry: TelopPositionGeometry): TelopPosition {
  const normalized = normalizeTelopPosition(position) ?? { x: 0.5, y: 0.5 };
  const bounds = telopPositionBounds(geometry);
  return { x: Math.max(bounds.minX, Math.min(bounds.maxX, normalized.x)), y: Math.max(bounds.minY, Math.min(bounds.maxY, normalized.y)) };
}

export function moveTelopPosition(position: TelopPosition, dx: number, dy: number, displayWidth: number, displayHeight: number, geometry: TelopPositionGeometry): TelopPosition {
  return clampTelopPosition({ x: position.x + dx / Math.max(1, displayWidth), y: position.y + dy / Math.max(1, displayHeight) }, geometry);
}
