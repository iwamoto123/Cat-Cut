import { useEffect, useRef, useState } from "react";
import { splitHighlightRuns } from "../lib/telopHighlight";
import { isRangeHighlighted, setHighlightRange } from "../lib/telopHighlightEdit";

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

function renderHighlightBackdrop(text: string, highlightWords?: string[]) {
  if (!text) return "\u00a0";
  const lines = text.split("\n");
  return lines.map((line, lineIndex) => (
    <span key={`line-${lineIndex}`}>
      {lineIndex > 0 ? "\n" : null}
      {splitHighlightRuns(line || " ", highlightWords).map((run, runIndex) => (
        <span className={run.highlight ? "telopHlYellow" : undefined} key={`run-${lineIndex}-${runIndex}`}>
          {run.text}
        </span>
      ))}
    </span>
  ));
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
  const [composing, setComposing] = useState(false);
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
  }, [value, rows]);

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
          {renderHighlightBackdrop(value, highlightWords)}
        </div>
        <textarea
          className={`sceneTelopInput ${edited ? "edited" : ""} ${composing ? "isComposing" : "isOverlayed"}`}
          onBlur={() => {
            onBlur();
          }}
          onChange={(event) => onChange(event.target.value)}
          onCompositionEnd={() => setComposing(false)}
          onCompositionStart={() => setComposing(true)}
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
          value={value}
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
