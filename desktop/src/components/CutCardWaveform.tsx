import { useEffect, useRef, useState } from "react";
import type { BoundaryOverrunHighlight, CutCard } from "../lib/cutCards";
import { isWordInKeepSegments, type KeepSegment, type TranscriptWord } from "../lib/keepSegments";
import { sliceWaveformPeaks } from "../lib/waveform";

const CANVAS_HEIGHT = 40;
const HANDLE_HIT_PX = 8;

type BoundaryEdge = "start" | "end";

type Props = {
  card: CutCard;
  /** カード範囲の前後に表示する余白(ms)。境界はみ出しを目視できるように少し広げて表示する。 */
  contextMs: number;
  /** 全体のピーク配列(runの音声全体分)。 */
  peaks: number[];
  binMs: number;
  words: TranscriptWord[];
  keepSegments: KeepSegment[];
  overrunHighlights: BoundaryOverrunHighlight[];
  selectedEdge: BoundaryEdge | null;
  visible: boolean;
  onSeek: (ms: number) => void;
  onSelectBoundary: (edge: BoundaryEdge) => void;
  onCommitBoundaryDrag: (edge: BoundaryEdge, targetMs: number) => void;
};

const COLOR_BG = "#111827";
const COLOR_BAR_KEPT = "#5aa0d8";
const COLOR_BAR_CONTEXT = "#3b4658";
const COLOR_WORD_KEPT = "#458bc3";
const COLOR_WORD_CUT = "#6b7280";
const COLOR_BOUNDARY = "#e5e7eb";
const COLOR_BOUNDARY_SELECTED = "#df8d33";
const COLOR_OVERRUN = "rgba(217, 45, 32, 0.55)";

export function CutCardWaveform({
  card,
  contextMs,
  peaks,
  binMs,
  words,
  keepSegments,
  overrunHighlights,
  selectedEdge,
  visible,
  onSeek,
  onSelectBoundary,
  onCommitBoundaryDrag,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [dragState, setDragState] = useState<{ edge: BoundaryEdge; previewMs: number } | null>(null);
  const [size, setSize] = useState({ width: 320, height: CANVAS_HEIGHT });

  const rangeStartMs = Math.max(0, card.startMs - contextMs);
  const rangeEndMs = card.endMs + contextMs;
  const boundaryStartMs = dragState?.edge === "start" ? dragState.previewMs : card.startMs;
  const boundaryEndMs = dragState?.edge === "end" ? dragState.previewMs : card.endMs;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setSize({ width: Math.max(40, entry.contentRect.width), height: CANVAS_HEIGHT });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = size.width;
    const height = size.height;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = COLOR_BG;
    ctx.fillRect(0, 0, width, height);

    const spanMs = Math.max(1, rangeEndMs - rangeStartMs);
    const msToX = (ms: number) => ((ms - rangeStartMs) / spanMs) * width;

    // 波形バー(カード範囲内=帯青、余白コンテキスト部分=くすんだ色)
    const slicedPeaks = sliceWaveformPeaks(peaks, binMs, rangeStartMs, rangeEndMs);
    if (slicedPeaks.length) {
      const barWidth = Math.max(1, width / slicedPeaks.length);
      for (let i = 0; i < slicedPeaks.length; i += 1) {
        const binStartMs = rangeStartMs + i * binMs;
        const inCard = binStartMs >= card.startMs && binStartMs < card.endMs;
        const barHeight = Math.max(1, slicedPeaks[i] * (height - 6));
        const x = (i / slicedPeaks.length) * width;
        ctx.fillStyle = inCard ? COLOR_BAR_KEPT : COLOR_BAR_CONTEXT;
        ctx.fillRect(x, (height - barHeight) / 2, Math.max(1, barWidth), barHeight);
      }
    }

    // 単語スパン帯(上部4px): カット済み単語はグレー
    for (const word of words) {
      if (word.endMs <= rangeStartMs || word.startMs >= rangeEndMs) continue;
      const kept = isWordInKeepSegments(word, keepSegments);
      const x1 = Math.max(0, msToX(word.startMs));
      const x2 = Math.min(width, msToX(word.endMs));
      ctx.fillStyle = kept ? COLOR_WORD_KEPT : COLOR_WORD_CUT;
      ctx.globalAlpha = kept ? 0.9 : 0.5;
      ctx.fillRect(x1, 0, Math.max(1, x2 - x1), 4);
      ctx.globalAlpha = 1;
    }

    // 80ms超のはみ出しを赤で強調
    for (const highlight of overrunHighlights) {
      if (highlight.rangeEndMs <= rangeStartMs || highlight.rangeStartMs >= rangeEndMs) continue;
      const x1 = Math.max(0, msToX(highlight.rangeStartMs));
      const x2 = Math.min(width, msToX(highlight.rangeEndMs));
      ctx.fillStyle = COLOR_OVERRUN;
      ctx.fillRect(x1, 0, Math.max(2, x2 - x1), height);
    }

    // IN/OUT境界ハンドル
    const drawHandle = (ms: number, edge: BoundaryEdge) => {
      const x = msToX(ms);
      const selected = selectedEdge === edge || dragState?.edge === edge;
      ctx.strokeStyle = selected ? COLOR_BOUNDARY_SELECTED : COLOR_BOUNDARY;
      ctx.lineWidth = selected ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.fillStyle = selected ? COLOR_BOUNDARY_SELECTED : COLOR_BOUNDARY;
      ctx.fillRect(x - 3, edge === "start" ? 0 : height - 6, 6, 6);
    };
    drawHandle(boundaryStartMs, "start");
    drawHandle(boundaryEndMs, "end");
  }, [
    visible,
    size,
    peaks,
    binMs,
    words,
    keepSegments,
    overrunHighlights,
    card,
    rangeStartMs,
    rangeEndMs,
    boundaryStartMs,
    boundaryEndMs,
    selectedEdge,
    dragState,
  ]);

  function xToMs(x: number, width: number) {
    const spanMs = Math.max(1, rangeEndMs - rangeStartMs);
    return rangeStartMs + (x / width) * spanMs;
  }

  function nearestEdgeAtX(x: number, width: number): BoundaryEdge | null {
    const spanMs = Math.max(1, rangeEndMs - rangeStartMs);
    const startX = ((card.startMs - rangeStartMs) / spanMs) * width;
    const endX = ((card.endMs - rangeStartMs) / spanMs) * width;
    const distStart = Math.abs(x - startX);
    const distEnd = Math.abs(x - endX);
    if (distStart <= HANDLE_HIT_PX && distStart <= distEnd) return "start";
    if (distEnd <= HANDLE_HIT_PX) return "end";
    return null;
  }

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const width = rect.width;
    const edge = nearestEdgeAtX(x, width);
    if (!edge) {
      onSeek(Math.max(0, xToMs(x, width)));
      return;
    }
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    setDragState({ edge, previewMs: edge === "start" ? card.startMs : card.endMs });
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!dragState) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const ms = xToMs(x, rect.width);
    setDragState((current) => (current ? { ...current, previewMs: ms } : current));
  }

  function finishDrag(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!dragState) return;
    const canvas = canvasRef.current;
    canvas?.releasePointerCapture(event.pointerId);
    onSelectBoundary(dragState.edge);
    onCommitBoundaryDrag(dragState.edge, dragState.previewMs);
    setDragState(null);
  }

  return (
    <div className="cutCardWaveformWrap" ref={wrapRef}>
      {visible ? (
        <canvas
          className="cutCardWaveformCanvas"
          onPointerCancel={() => setDragState(null)}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishDrag}
          ref={canvasRef}
        />
      ) : (
        <div className="cutCardWaveformPlaceholder" style={{ height: CANVAS_HEIGHT }} />
      )}
    </div>
  );
}
