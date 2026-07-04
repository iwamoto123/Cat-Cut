import { useEffect, useMemo, useRef, useState } from "react";
import { Waves } from "lucide-react";
import { CutCardWaveform } from "./CutCardWaveform";
import { buildCutCards, computeBoundaryOverrunHighlights } from "../lib/cutCards";
import type { KeepSegment, TranscriptWord } from "../lib/keepSegments";

const CONTEXT_MS = 400;

export type SelectedBoundary = { segmentIndex: number; edge: "start" | "end" };
export type WaveformResult = Awaited<ReturnType<typeof window.catcut.generateWaveform>>;

type Props = {
  words: TranscriptWord[];
  keepSegments: KeepSegment[];
  waveform: WaveformResult | null;
  waveformLoading: boolean;
  waveformError: string;
  selectedBoundary: SelectedBoundary | null;
  focusSegmentIndex: number | null;
  onFocusConsumed: () => void;
  onSeek: (ms: number) => void;
  onSelectBoundary: (segmentIndex: number, edge: "start" | "end") => void;
  onCommitBoundaryDrag: (segmentIndex: number, edge: "start" | "end", targetMs: number) => void;
};

function formatMs(ms: number) {
  const totalMs = Math.max(0, Math.round(ms));
  const totalSeconds = Math.floor(totalMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = totalMs % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function CutCardRow({
  card,
  peaks,
  binMs,
  words,
  keepSegments,
  overrunHighlights,
  isSelected,
  selectedEdge,
  isFocused,
  onSeek,
  onSelectBoundary,
  onCommitBoundaryDrag,
}: {
  card: ReturnType<typeof buildCutCards>[number];
  peaks: number[];
  binMs: number;
  words: TranscriptWord[];
  keepSegments: KeepSegment[];
  overrunHighlights: ReturnType<typeof computeBoundaryOverrunHighlights>;
  isSelected: boolean;
  selectedEdge: "start" | "end" | null;
  isFocused: boolean;
  onSeek: (ms: number) => void;
  onSelectBoundary: (edge: "start" | "end") => void;
  onCommitBoundaryDrag: (edge: "start" | "end", targetMs: number) => void;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = rowRef.current;
    if (!el) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) setVisible(entry.isIntersecting);
      },
      { root: el.closest(".cutCardsList"), rootMargin: "200px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (isFocused) rowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [isFocused]);

  const cardWords = useMemo(
    () => words.filter((word) => word.endMs > card.startMs - CONTEXT_MS && word.startMs < card.endMs + CONTEXT_MS),
    [words, card.startMs, card.endMs],
  );

  return (
    <div className={`cutCard ${isSelected ? "selected" : ""} ${isFocused ? "focused" : ""}`} ref={rowRef}>
      <div className="cutCardHeader">
        <span className="cutCardIndex">#{card.index + 1}</span>
        <span className="cutCardRange">
          {formatMs(card.startMs)} 〜 {formatMs(card.endMs)}
        </span>
        <span className="cutCardDuration">{Math.round(card.endMs - card.startMs)}ms</span>
        <span className="cutCardText">{card.text || "(無音区間)"}</span>
      </div>
      {/* 実際のcanvas描画はvisible時のみ行う(画面内カードのみ描画する仮想化)。 */}
      <CutCardWaveform
        binMs={binMs}
        card={card}
        contextMs={CONTEXT_MS}
        keepSegments={keepSegments}
        onCommitBoundaryDrag={onCommitBoundaryDrag}
        onSeek={onSeek}
        onSelectBoundary={onSelectBoundary}
        overrunHighlights={overrunHighlights}
        peaks={peaks}
        selectedEdge={isSelected ? selectedEdge : null}
        visible={visible}
        words={cardWords}
      />
    </div>
  );
}

export function CutCardsPanel({
  words,
  keepSegments,
  waveform,
  waveformLoading,
  waveformError,
  selectedBoundary,
  focusSegmentIndex,
  onFocusConsumed,
  onSeek,
  onSelectBoundary,
  onCommitBoundaryDrag,
}: Props) {
  const cards = useMemo(() => buildCutCards(words, keepSegments), [words, keepSegments]);
  const overrunHighlights = useMemo(() => computeBoundaryOverrunHighlights(words, keepSegments), [words, keepSegments]);

  useEffect(() => {
    if (focusSegmentIndex == null) return;
    const timer = window.setTimeout(onFocusConsumed, 900);
    return () => window.clearTimeout(timer);
  }, [focusSegmentIndex, onFocusConsumed]);

  const peaks = waveform?.peaks || [];
  const binMs = waveform?.binMs || 20;

  return (
    <section className="cutCardsPanel">
      <div className="cutCardsPanelHeader">
        <Waves size={15} />
        <span>カットカード（境界確認）</span>
        {waveformLoading && <span className="cutCardsPanelStatus">波形を生成中です…</span>}
        {waveformError && <span className="cutCardsPanelStatus error">{waveformError}</span>}
        {!waveformLoading && !waveformError && (
          <span className="cutCardsPanelStatus">波形クリックでシーク／端の縦線をドラッグまたは選択して[ ]で境界を微調整</span>
        )}
      </div>
      <div className="cutCardsList">
        {cards.map((card) => (
          <CutCardRow
            binMs={binMs}
            card={card}
            isFocused={focusSegmentIndex === card.index}
            isSelected={selectedBoundary?.segmentIndex === card.index}
            key={`${card.startMs}-${card.endMs}`}
            keepSegments={keepSegments}
            onCommitBoundaryDrag={(edge, targetMs) => onCommitBoundaryDrag(card.index, edge, targetMs)}
            onSeek={onSeek}
            onSelectBoundary={(edge) => onSelectBoundary(card.index, edge)}
            overrunHighlights={overrunHighlights.filter((highlight) => highlight.segmentIndex === card.index)}
            peaks={peaks}
            selectedEdge={selectedBoundary?.segmentIndex === card.index ? selectedBoundary.edge : null}
            words={words}
          />
        ))}
        {!cards.length && <div className="cutCardsEmpty">keep_segment がありません。</div>}
      </div>
    </section>
  );
}
