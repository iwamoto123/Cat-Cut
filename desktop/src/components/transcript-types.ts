import type { KeepSegment, TranscriptWord } from "../lib/keepSegments";

export type TranscriptSentence = {
  id: string;
  text: string;
  wordIds: string[];
  startMs: number;
  endMs: number;
};

export type TranscriptReason = "silence" | "filler" | "manual";

export type TranscriptWordState = TranscriptWord & {
  sentenceId: string;
};

export type TranscriptEditorPayload = {
  runDir: string;
  sourceVideoPath: string;
  sourceVideoUrl: string;
  words: TranscriptWordState[];
  sentences: TranscriptSentence[];
  keepSegments: KeepSegment[];
  fillerWordIds: string[];
  maxGapMs: number;
  segmentPaddingMs: number;
  originalDurationMs: number;
  telopFontSize: number;
  telopBaseWidth: number;
};
