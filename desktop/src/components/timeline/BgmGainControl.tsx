import { useEffect, useRef, useState } from "react";
import type { MediaEditPhase } from "../../lib/editorSelection";

type Props = {
  value: number;
  getValue: () => number;
  disabled?: boolean;
  onChange: (value: number, phase: MediaEditPhase) => void;
};

type Gesture = {
  initial: number;
  latest: number;
  pointerId: number | null;
};

const ADJUSTMENT_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);
const normalizedGain = (value: number) => Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));

/** One drag or held adjustment key publishes live gain, then commits one Undo entry. */
export function BgmGainControl({ value, getValue, disabled = false, onChange }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const cancelledPointerRef = useRef<number | null>(null);
  const previewFrameRef = useRef<number | null>(null);
  const latestRef = useRef({ getValue, onChange });
  latestRef.current = { getValue, onChange };
  const [draft, setDraft] = useState<number | null>(null);
  const displayed = draft ?? value;
  const decibels = displayed <= 0 ? "−∞ dB" : `${(20 * Math.log10(displayed)).toFixed(1)} dB`;

  function cancelFrame() {
    if (previewFrameRef.current !== null) cancelAnimationFrame(previewFrameRef.current);
    previewFrameRef.current = null;
  }
  useEffect(() => cancelFrame, []);

  function begin(pointerId: number | null) {
    if (gestureRef.current) return;
    const initial = normalizedGain(latestRef.current.getValue());
    gestureRef.current = { initial, latest: initial, pointerId };
    setDraft(initial);
  }

  function preview(next: number) {
    const gesture = gestureRef.current;
    if (!gesture) {
      // Assistive/native form changes may have no preceding pointer or key event.
      latestRef.current.onChange(next, "commit");
      return;
    }
    gesture.latest = next;
    setDraft(next);
    if (previewFrameRef.current === null) previewFrameRef.current = requestAnimationFrame(() => {
      previewFrameRef.current = null;
      if (gestureRef.current === gesture) latestRef.current.onChange(gesture.latest, "preview");
    });
  }

  function finish(cancelled = false) {
    const gesture = gestureRef.current;
    if (!gesture) return;
    gestureRef.current = null;
    if (cancelled && gesture.pointerId !== null) cancelledPointerRef.current = gesture.pointerId;
    cancelFrame();
    latestRef.current.onChange(cancelled ? gesture.initial : gesture.latest, "commit");
    setDraft(null);
    if (gesture.pointerId !== null && inputRef.current?.hasPointerCapture(gesture.pointerId)) {
      inputRef.current.releasePointerCapture(gesture.pointerId);
    }
  }

  return (
    <div className="bgmGainControl">
      <div className="bgmGainReadout"><span>ゲイン</span><output>{decibels}</output></div>
      <input
        ref={inputRef}
        type="range"
        aria-label="BGM音量スライダー"
        aria-valuetext={`${Number((displayed * 100).toFixed(1))}% / ${decibels}`}
        min={0}
        max={100}
        step={0.1}
        value={displayed * 100}
        disabled={disabled}
        title="音量を調整。矢印キーで0.1%、Shiftで1%。Escで操作を取り消し"
        onChange={(event) => {
          if (cancelledPointerRef.current === null) preview(normalizedGain(Number(event.currentTarget.value) / 100));
        }}
        onPointerDown={(event) => {
          if (disabled || event.button !== 0) return;
          event.stopPropagation();
          cancelledPointerRef.current = null;
          begin(event.pointerId);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerUp={(event) => {
          if (cancelledPointerRef.current === event.pointerId) cancelledPointerRef.current = null;
          if (gestureRef.current?.pointerId !== event.pointerId) return;
          gestureRef.current.latest = normalizedGain(Number(event.currentTarget.value) / 100);
          finish();
          event.currentTarget.blur();
        }}
        onPointerCancel={() => finish(true)}
        onLostPointerCapture={() => finish(true)}
        onBlur={() => finish()}
        onKeyDown={(event) => {
          if (disabled || event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (gestureRef.current && (event.key === "Escape" || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z"))) {
            event.preventDefault(); event.stopPropagation();
            finish(true);
            event.currentTarget.blur();
            return;
          }
          if (ADJUSTMENT_KEYS.has(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
            event.preventDefault(); event.stopPropagation();
            cancelledPointerRef.current = null;
            begin(null);
            const current = gestureRef.current!.latest;
            const step = event.key.startsWith("Page") ? 0.1 : event.shiftKey ? 0.01 : 0.001;
            const direction = ["ArrowLeft", "ArrowDown", "PageDown"].includes(event.key) ? -1 : 1;
            const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : current + direction * step;
            preview(normalizedGain(next));
          } else if (event.key === "Enter") {
            event.preventDefault(); event.stopPropagation();
            finish(); event.currentTarget.blur();
          }
        }}
        onKeyUp={(event) => {
          if (ADJUSTMENT_KEYS.has(event.key) && gestureRef.current?.pointerId === null) {
            event.stopPropagation();
            finish();
          }
        }}
      />
    </div>
  );
}
