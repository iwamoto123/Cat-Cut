import type { Scene } from "./scenes.ts";
import { isRangeDragActivated, rangeSelectionFromPx } from "./rangeCut.ts";

export type WaveformGestureKind = "range" | "start" | "end";
export type WaveformPointer = { pointerId: number; clientX: number; clientY: number; altKey: boolean };

/** The coordinate scale belongs to the press, so preview trims or resizing cannot move the target. */
export type WaveformGesture = {
  kind: WaveformGestureKind;
  pointerId: number;
  scene: Scene;
  widthPx: number;
  startX: number;
  startClientX: number;
  startClientY: number;
  current: WaveformPointer;
  activated: boolean;
};

export const EDGE_DRAG_ACTIVATE_PX = 3;
const WORD_SNAP_PX = 8;
const MAX_WORD_SNAP_MS = 80;

/** Suspicions and other display metadata can replace a Scene while the mouse is held.
 * Cancel only when the source selection or editable transcript actually changed. */
export function sameWaveformEditScene(first: Scene, second: Scene): boolean {
  if (first === second) return true;
  if (first.id !== second.id || first.sourceStartMs !== second.sourceStartMs || first.sourceEndMs !== second.sourceEndMs ||
    first.telopText !== second.telopText || first.telopEdited !== second.telopEdited ||
    first.words.length !== second.words.length || first.cutMarks.length !== second.cutMarks.length) return false;
  const a = first.sourceKeepRanges, b = second.sourceKeepRanges;
  if (!!a !== !!b || (a && b && (a.length !== b.length || a.some((range, index) => range.startMs !== b[index].startMs || range.endMs !== b[index].endMs)))) return false;
  if (first.cutMarks.some((mark, index) => mark !== second.cutMarks[index])) return false;
  return first.words.every((word, index) => {
    const other = second.words[index];
    return word.id === other.id && word.text === other.text && word.startMs === other.startMs && word.endMs === other.endMs &&
      word.deleted === other.deleted && !!word.autoTrimmed === !!other.autoTrimmed && !!word.silence === !!other.silence;
  });
}

/** Pixel affinity is capped in time, preventing large jumps on long scenes. Alt keeps the 20 ms grid. */
export function waveformSnapToleranceMs(msPerPx: number, altKey = false): number {
  return altKey ? 0 : Math.min(MAX_WORD_SNAP_MS, WORD_SNAP_PX * Math.max(0, msPerPx));
}

export function beginWaveformGesture(
  kind: WaveformGestureKind,
  scene: Scene,
  widthPx: number,
  startX: number,
  pointer: WaveformPointer,
): WaveformGesture {
  return {
    kind, scene, widthPx: Math.max(1, widthPx), startX,
    pointerId: pointer.pointerId,
    startClientX: pointer.clientX,
    startClientY: pointer.clientY,
    current: { pointerId: pointer.pointerId, clientX: pointer.clientX, clientY: pointer.clientY, altKey: pointer.altKey },
    activated: false,
  };
}

export function moveWaveformGesture(gesture: WaveformGesture, pointer: WaveformPointer): WaveformGesture {
  if (pointer.pointerId !== gesture.pointerId) return gesture;
  const deltaX = pointer.clientX - gesture.startClientX;
  const deltaY = pointer.clientY - gesture.startClientY;
  const threshold = gesture.kind === "range" ? undefined : EDGE_DRAG_ACTIVATE_PX;
  const activated = gesture.activated || (
    isRangeDragActivated(deltaX, threshold) && Math.abs(deltaX) >= Math.abs(deltaY)
  );
  return { ...gesture, current: { pointerId: pointer.pointerId, clientX: pointer.clientX, clientY: pointer.clientY, altKey: pointer.altKey }, activated };
}

export function waveformGesturePosition(gesture: WaveformGesture) {
  const deltaX = gesture.current.clientX - gesture.startClientX;
  const msPerPx = (gesture.scene.sourceEndMs - gesture.scene.sourceStartMs) / gesture.widthPx;
  const range = rangeSelectionFromPx(gesture.scene, gesture.startX, gesture.startX + deltaX, gesture.widthPx);
  const edgeStartMs = gesture.kind === "start" ? gesture.scene.sourceStartMs : gesture.scene.sourceEndMs;
  return {
    range,
    rawTargetMs: edgeStartMs + deltaX * msPerPx,
    chipSnapToleranceMs: waveformSnapToleranceMs(msPerPx, gesture.current.altKey),
    // Returning to the press cancels the edit, even if the gesture previously crossed the threshold.
    moved: Math.abs(deltaX) > (gesture.kind === "range" ? 0 : EDGE_DRAG_ACTIVATE_PX),
  };
}

export function formatWaveformTime(ms: number): string {
  const value = Math.max(0, Math.round(ms));
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.floor(value % 60_000 / 1000);
  const millis = value % 1000;
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}
