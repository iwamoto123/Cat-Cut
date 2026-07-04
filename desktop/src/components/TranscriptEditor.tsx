import { useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw, Scissors, VolumeX } from "lucide-react";
import type { KeepSegment } from "../lib/keepSegments";
import type { TranscriptReason, TranscriptSentence, TranscriptWordState } from "./transcript-types";

type Props = {
  sentences: TranscriptSentence[];
  words: TranscriptWordState[];
  keepSegments: KeepSegment[];
  fillerWordIds: Set<string>;
  manualRemovedWordIds: Set<string>;
  activeWordId: string | null;
  correctionOriginals: Record<string, string>;
  flashWordId: string | null;
  editRequestWordId: string | null;
  onEditRequestConsumed: () => void;
  onSeekWord: (word: TranscriptWordState) => void;
  onToggleWordIds: (wordIds: string[]) => void;
  onCorrectWord: (wordId: string, newText: string) => void;
  /** 追い読みモード（B-2）: Enterで確定/Escでキャンセルした際に呼ばれる。committed時は編集後の単語IDを渡す。 */
  onEditFinished?: (result: { wordId: string; committed: boolean }) => void;
};

const DOUBLE_CLICK_WINDOW_MS = 230;

function isInSegments(word: TranscriptWordState, keepSegments: KeepSegment[]) {
  return keepSegments.some((segment) => Math.min(word.endMs, segment.endMs) > Math.max(word.startMs, segment.startMs));
}

function reasonLabel(reason: TranscriptReason) {
  if (reason === "filler") return "フィラー";
  if (reason === "manual") return "手動";
  return "無音";
}

function reasonIcon(reason: TranscriptReason) {
  if (reason === "filler") return <VolumeX size={12} />;
  if (reason === "manual") return <Scissors size={12} />;
  return <RotateCcw size={12} />;
}

export function TranscriptEditor({
  sentences,
  words,
  keepSegments,
  fillerWordIds,
  manualRemovedWordIds,
  activeWordId,
  correctionOriginals,
  flashWordId,
  editRequestWordId,
  onEditRequestConsumed,
  onSeekWord,
  onToggleWordIds,
  onCorrectWord,
  onEditFinished,
}: Props) {
  const [lastClickedWordIndex, setLastClickedWordIndex] = useState<number | null>(null);
  const [editingWordId, setEditingWordId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const wordIndexById = useMemo(() => new Map(words.map((word, index) => [word.id, index])), [words]);
  const wordsById = useMemo(() => new Map(words.map((word) => [word.id, word])), [words]);
  const activeWordRef = useRef<HTMLButtonElement | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const clickTimerRef = useRef<number | null>(null);

  useEffect(() => {
    // B-3: 単語編集中は自動スクロールを止め、入力中の視点がずれないようにする。
    if (editingWordId) return;
    if (!activeWordRef.current) return;
    activeWordRef.current.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
  }, [activeWordId, editingWordId]);

  useEffect(() => {
    editInputRef.current?.focus();
    editInputRef.current?.select();
  }, [editingWordId]);

  useEffect(() => {
    return () => {
      if (clickTimerRef.current) window.clearTimeout(clickTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!editRequestWordId) return;
    const word = wordsById.get(editRequestWordId);
    if (word) {
      setEditingWordId(word.id);
      setEditDraft(word.text);
    }
    onEditRequestConsumed();
  }, [editRequestWordId, onEditRequestConsumed, wordsById]);

  const sentenceReasons = useMemo(() => {
    const map = new Map<string, TranscriptReason>();
    for (const sentence of sentences) {
      let reason: TranscriptReason | null = null;
      for (const wordId of sentence.wordIds) {
        const word = wordsById.get(wordId);
        if (!word) continue;
        const kept = isInSegments(word, keepSegments);
        if (kept) continue;
        if (manualRemovedWordIds.has(wordId)) {
          reason = "manual";
          break;
        }
        if (fillerWordIds.has(wordId)) reason = reason ?? "filler";
        else reason = reason ?? "silence";
      }
      if (reason) map.set(sentence.id, reason);
    }
    return map;
  }, [fillerWordIds, keepSegments, manualRemovedWordIds, sentences, wordsById]);

  function startEdit(word: TranscriptWordState) {
    setEditingWordId(word.id);
    setEditDraft(word.text);
  }

  function commitEdit() {
    if (!editingWordId) return;
    const wordId = editingWordId;
    const word = wordsById.get(wordId);
    const nextText = editDraft.trim();
    if (word && nextText && nextText !== word.text) {
      onCorrectWord(wordId, nextText);
    }
    setEditingWordId(null);
    onEditFinished?.({ wordId, committed: true });
  }

  function cancelEdit() {
    if (!editingWordId) return;
    const wordId = editingWordId;
    setEditingWordId(null);
    onEditFinished?.({ wordId, committed: false });
  }

  function handleWordClick(word: TranscriptWordState, index: number, event: React.MouseEvent) {
    if (event.shiftKey) {
      if (lastClickedWordIndex != null) {
        const [start, end] = [lastClickedWordIndex, index].sort((a, b) => a - b);
        onToggleWordIds(words.slice(start, end + 1).map((item) => item.id));
      }
      return;
    }
    if (clickTimerRef.current) {
      // ダブルクリックの一部として処理済み（onDoubleClickでカット切り替え）。
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      return;
    }
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null;
      setLastClickedWordIndex(index);
      onSeekWord(word);
      startEdit(word);
    }, DOUBLE_CLICK_WINDOW_MS);
  }

  function handleWordDoubleClick(word: TranscriptWordState) {
    if (clickTimerRef.current) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    onToggleWordIds([word.id]);
  }

  return (
    <div className="transcriptEditor">
      {sentences.map((sentence) => {
        const reason = sentenceReasons.get(sentence.id);
        return (
          <section className="sentenceBlock" key={sentence.id}>
            <header>
              <span>{sentence.id}</span>
              {reason && (
                <span className={`reasonBadge ${reason}`}>
                  {reasonIcon(reason)}
                  {reasonLabel(reason)}
                </span>
              )}
            </header>
            <div className="sentenceWords">
              {sentence.wordIds.map((wordId) => {
                const word = wordsById.get(wordId);
                if (!word) return null;
                const kept = isInSegments(word, keepSegments);
                const isActive = activeWordId === word.id;
                const isEditing = editingWordId === word.id;
                const originalText = correctionOriginals[word.id];
                const isCorrected = originalText != null && originalText !== word.text;
                const index = wordIndexById.get(word.id) ?? 0;

                if (isEditing) {
                  return (
                    <input
                      className="wordEditInput"
                      key={word.id}
                      onBlur={commitEdit}
                      onChange={(event) => setEditDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          commitEdit();
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          cancelEdit();
                        }
                        event.stopPropagation();
                      }}
                      ref={editInputRef}
                      style={{ width: `${Math.max(2, editDraft.length + 1)}ch` }}
                      value={editDraft}
                    />
                  );
                }

                return (
                  <button
                    className={[
                      "wordChip",
                      kept ? "" : "cut",
                      isActive ? "active" : "",
                      isCorrected ? "corrected" : "",
                      flashWordId === word.id ? "flash" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    key={word.id}
                    onClick={(event) => handleWordClick(word, index, event)}
                    onDoubleClick={() => handleWordDoubleClick(word)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        startEdit(word);
                      }
                    }}
                    ref={isActive ? activeWordRef : undefined}
                    title={isCorrected ? `修正前: ${originalText}` : `${Math.round(word.startMs)}ms`}
                    type="button"
                  >
                    {word.text}
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
