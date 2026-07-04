import { useMemo } from "react";
import { useEditHistory } from "./useEditHistory";
import {
  buildRemoveRanges,
  type KeepSegment,
  type RecomputeOptions,
  recomputeKeepSegmentsFromWords,
  type TranscriptWord,
} from "../lib/keepSegments";

export type EditSnapshot = {
  keepSegments: KeepSegment[];
  manualRemovedWordIds: string[];
  /** 単語テキスト修正（Phase A/B）: wordId -> 修正後テキスト。カット操作と同一のUndo/Redoスタックで管理する（B-4）。 */
  wordCorrections: Record<string, string>;
  /** 修正前の原文。ツールチップ表示・差分判定に使う。 */
  correctionOriginals: Record<string, string>;
};

type UseKeepSegmentsInput = {
  words: TranscriptWord[];
  initialKeepSegments: KeepSegment[];
  recomputeOptions: RecomputeOptions;
};

const EMPTY_SNAPSHOT_EXTRAS = { wordCorrections: {}, correctionOriginals: {} };

export function useKeepSegments({ words, initialKeepSegments, recomputeOptions }: UseKeepSegmentsInput) {
  const history = useEditHistory<EditSnapshot>({
    keepSegments: initialKeepSegments,
    manualRemovedWordIds: [],
    ...EMPTY_SNAPSHOT_EXTRAS,
  });

  const manualRemovedSet = useMemo(
    () => new Set(history.present.manualRemovedWordIds),
    [history.present.manualRemovedWordIds],
  );

  const removedRanges = useMemo(
    () => buildRemoveRanges(history.present.keepSegments, recomputeOptions.originalDurationMs),
    [history.present.keepSegments, recomputeOptions.originalDurationMs],
  );

  const applyWordSelection = (wordIds: string[], forceKeep: boolean | null) => {
    if (!wordIds.length) return;
    history.setPresent((current) => {
      const keepSet = new Set(
        words.filter((word) => current.keepSegments.some((segment) => segment.startMs < word.endMs && segment.endMs > word.startMs)).map((word) => word.id),
      );
      const nextRemoved = new Set(current.manualRemovedWordIds);
      const shouldKeep = forceKeep == null ? !wordIds.some((id) => keepSet.has(id)) : forceKeep;
      for (const id of wordIds) {
        if (shouldKeep) {
          keepSet.add(id);
          nextRemoved.delete(id);
        } else {
          keepSet.delete(id);
          nextRemoved.add(id);
        }
      }
      const removedSet = new Set(words.map((word) => word.id).filter((id) => !keepSet.has(id)));
      return {
        ...current,
        keepSegments: recomputeKeepSegmentsFromWords(words, removedSet, recomputeOptions),
        manualRemovedWordIds: Array.from(nextRemoved),
      };
    });
  };

  const toggleWords = (wordIds: string[]) => applyWordSelection(wordIds, null);
  const setWordsKept = (wordIds: string[], keep: boolean) => applyWordSelection(wordIds, keep);

  const replaceKeepSegments = (segments: KeepSegment[]) => {
    history.setPresent((current) => ({
      ...current,
      keepSegments: segments,
    }));
  };

  const restoreAllManual = () => {
    history.setPresent((current) => ({
      ...current,
      keepSegments: initialKeepSegments,
      manualRemovedWordIds: [],
    }));
  };

  /**
   * 単語テキスト修正（B-4）。カット操作と同一のUndo/Redoスタックに時系列で積む。
   * originalText は修正対象単語の「現在保存されている」原文（transcript側の値）を渡す。
   */
  const correctWord = (wordId: string, newText: string, originalText: string) => {
    const trimmed = newText.trim();
    if (!trimmed) return;
    history.setPresent((current) => {
      const baselineOriginal = current.correctionOriginals[wordId] ?? originalText;
      if (trimmed === baselineOriginal) {
        if (current.wordCorrections[wordId] === undefined) return current;
        const nextCorrections = { ...current.wordCorrections };
        delete nextCorrections[wordId];
        const nextOriginals = { ...current.correctionOriginals };
        delete nextOriginals[wordId];
        return { ...current, wordCorrections: nextCorrections, correctionOriginals: nextOriginals };
      }
      if (current.wordCorrections[wordId] === trimmed) return current;
      const nextOriginals =
        current.correctionOriginals[wordId] != null
          ? current.correctionOriginals
          : { ...current.correctionOriginals, [wordId]: originalText };
      return {
        ...current,
        wordCorrections: { ...current.wordCorrections, [wordId]: trimmed },
        correctionOriginals: nextOriginals,
      };
    });
  };

  return {
    keepSegments: history.present.keepSegments,
    manualRemovedWordIds: history.present.manualRemovedWordIds,
    manualRemovedSet,
    removedRanges,
    wordCorrections: history.present.wordCorrections,
    correctionOriginals: history.present.correctionOriginals,
    setKeepSegments: replaceKeepSegments,
    toggleWords,
    setWordsKept,
    correctWord,
    restoreAllManual,
    undo: history.undo,
    redo: history.redo,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    reset: history.reset,
  };
}
