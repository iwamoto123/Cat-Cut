import { useEffect, useRef, useState } from "react";
import { splitHighlightRuns } from "../lib/telopHighlight";
import { isRangeHighlighted, rebaseHighlightWords, setHighlightRange } from "../lib/telopHighlightEdit";

type Props = {
  value: string;
  highlightWords?: string[];
  edited?: boolean;
  rows: number;
  title: string;
  onChange: (text: string) => void;
  onHighlightWordsChange?: (words: string[]) => void;
  onFocus: () => void;
  onBlur: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
};

function renderHighlightBackdrop(text: string, highlightWords?: string[], compositionRange?: { start: number; end: number }) {
  if (!text) return "\u00a0";
  let offset = 0;
  const spans = splitHighlightRuns(text, highlightWords).flatMap((run, runIndex) => {
    const start = offset;
    offset += run.text.length;
    const cuts = [...new Set([start, offset, ...(compositionRange
      ? [compositionRange.start, compositionRange.end].filter((point) => point > start && point < offset) : [])])].sort((a, b) => a - b);
    return cuts.slice(0, -1).map((from, index) => (
      <span
        className={run.highlight ? "telopHlYellow" : undefined}
        key={`${runIndex}-${index}`}
        style={compositionRange && from >= compositionRange.start && from < compositionRange.end
          ? { textDecoration: "underline", textUnderlineOffset: "3px" } : undefined}
      >
        {text.slice(from, cuts[index + 1])}
      </span>
    ));
  });
  // The textarea reserves a final empty line too; keep both scroll surfaces aligned.
  return <>{spans}{text.endsWith("\n") ? "\u00a0" : null}</>;
}

export function TelopHighlightInput({
  value,
  highlightWords,
  edited,
  rows,
  title,
  onChange,
  onHighlightWordsChange,
  onFocus,
  onBlur,
  onKeyDown,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const compositionRef = useRef<{ text: string; words?: string[]; start: number } | null>(null);
  const committedValueRef = useRef(value);
  committedValueRef.current = value;
  const [compositionDraft, setCompositionDraft] = useState<{ text: string; end: number } | null>(null);
  const [selection, setSelection] = useState({ start: 0, end: 0 });

  function syncScroll() {
    const textarea = textareaRef.current;
    const backdrop = backdropRef.current;
    if (!textarea || !backdrop) return;
    backdrop.scrollTop = textarea.scrollTop;
    backdrop.scrollLeft = textarea.scrollLeft;
  }

  function readSelection() {
    const textarea = textareaRef.current;
    if (!textarea) return;
    setSelection({ start: textarea.selectionStart, end: textarea.selectionEnd });
  }

  useEffect(() => {
    syncScroll();
  }, [value, compositionDraft, rows]);

  const displayedText = compositionDraft?.text ?? value;
  const displayedWords = compositionDraft && compositionRef.current
    ? rebaseHighlightWords(compositionRef.current.text, compositionDraft.text, compositionRef.current.words)
    : highlightWords;

  function commitText(text: string) {
    // Some IMEs send a final input after compositionend in the same event turn.
    if (text === committedValueRef.current) return;
    committedValueRef.current = text;
    onChange(text);
  }

  function finishComposition(text: string) {
    const wasComposing = Boolean(compositionRef.current);
    compositionRef.current = null;
    setCompositionDraft(null);
    if (wasComposing) commitText(text);
  }

  const hasSelection = selection.end > selection.start;
  const selectionIsYellow =
    hasSelection && isRangeHighlighted(value, highlightWords, selection.start, selection.end);

  function paintSelection(highlighted: boolean) {
    if (!onHighlightWordsChange || !hasSelection) return;
    onHighlightWordsChange(setHighlightRange(value, highlightWords, selection.start, selection.end, highlighted));
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(selection.start, selection.end);
    });
  }

  return (
    <div className="sceneTelopEditor">
      <div className="sceneTelopInputStack">
        <div aria-hidden className="sceneTelopHighlightLayer" ref={backdropRef}>
          {renderHighlightBackdrop(displayedText, displayedWords, compositionDraft && compositionRef.current
            ? { start: compositionRef.current.start, end: compositionDraft.end } : undefined)}
        </div>
        <textarea
          className={`sceneTelopInput ${edited ? "edited" : ""} isOverlayed`}
          onBlur={(event) => {
            finishComposition(event.currentTarget.value);
            onBlur();
          }}
          onChange={(event) => {
            if (compositionRef.current) {
              setCompositionDraft({ text: event.target.value, end: event.target.selectionEnd });
            } else {
              commitText(event.target.value);
            }
          }}
          onCompositionEnd={(event) => finishComposition(event.currentTarget.value)}
          onCompositionStart={(event) => {
            compositionRef.current = { text: value, words: highlightWords, start: event.currentTarget.selectionStart };
            setCompositionDraft({ text: event.currentTarget.value, end: event.currentTarget.selectionEnd });
          }}
          onFocus={() => {
            onFocus();
            readSelection();
          }}
          onKeyDown={onKeyDown}
          onKeyUp={readSelection}
          onMouseUp={readSelection}
          onScroll={syncScroll}
          onSelect={readSelection}
          ref={textareaRef}
          rows={rows}
          title={title}
          value={displayedText}
        />
      </div>
      {onHighlightWordsChange && (
        <div className="sceneTelopColorActions">
          <button
            className={`sceneTelopColorButton yellow ${selectionIsYellow ? "isActive" : ""}`}
            disabled={!hasSelection}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => paintSelection(true)}
            title="選択中の文字を黄色にする"
            type="button"
          >
            黄色
          </button>
          <button
            className="sceneTelopColorButton white"
            disabled={!hasSelection}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => paintSelection(false)}
            title="選択中の文字を白(通常色)に戻す"
            type="button"
          >
            白
          </button>
        </div>
      )}
    </div>
  );
}
