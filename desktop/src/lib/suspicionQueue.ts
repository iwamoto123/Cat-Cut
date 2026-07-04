import { isWordInKeepSegments, type KeepSegment, type TranscriptWord } from "./keepSegments.ts";

export type SuspicionSeverity = "high" | "medium" | "low";

export type SuspicionType =
  | "low_confidence"
  | "telop_review"
  | "boundary_overrun"
  | "short_cut"
  | "filler"
  | "proper_noun"
  | "ai_review";

export type SuspicionItem = {
  id: string;
  type: SuspicionType;
  severity: SuspicionSeverity;
  label: string;
  text: string;
  timestampMs: number;
  wordIds: string[];
  detail: string;
};

export type SuspicionTelopFinding = {
  id: string;
  type: string;
  severity: SuspicionSeverity;
  page_id: string;
  message: string;
  source?: string | null;
  suggestion?: string | null;
};

const SEVERITY_ORDER: Record<SuspicionSeverity, number> = { high: 0, medium: 1, low: 2 };

export type LowConfidenceOptions = {
  highThresholdConfidence?: number;
  mediumThresholdConfidence?: number;
  /**
   * 低confidence検出を明示的にON/OFFする(テスト・将来のUI設定用)。省略時は
   * hasMeaningfulConfidenceVariance() による自動判定に従う(改善2「要確認フラグの限定」節)。
   */
  enabled?: boolean;
  /** 自動判定の閾値: confidenceが0でない単語の割合がこれ以上なら自動的に有効化する。既定0.3(30%)。 */
  varianceMinNonZeroRatio?: number;
};

/**
 * confidenceに「意味のある分散」があるかを判定する。
 * 実機のElevenLabs STT等、全単語のconfidenceが一律0になっているケースでは低confidence検出が
 * 全件ヒットして使い物にならないため、非ゼロ値が一定割合(既定30%)以上存在する場合のみ
 * 低confidence検出を自動的に有効化する(改善2「要確認フラグの限定」節)。
 */
export function hasMeaningfulConfidenceVariance(
  words: TranscriptWord[],
  options: { varianceMinNonZeroRatio?: number } = {},
): boolean {
  const ratioThreshold = options.varianceMinNonZeroRatio ?? 0.3;
  const withConfidence = words.filter((word) => word.confidence != null);
  if (!withConfidence.length) return false;
  const nonZeroCount = withConfidence.filter((word) => Math.abs(word.confidence as number) > 1e-9).length;
  return nonZeroCount / withConfidence.length >= ratioThreshold;
}

/**
 * 低confidence単語（stt_corrected.json の words[].confidence 由来）を検出する。
 * 既定では options.enabled が指定されない限り hasMeaningfulConfidenceVariance() で自動判定する。
 */
export function buildLowConfidenceSuspicions(
  words: TranscriptWord[],
  options: LowConfidenceOptions = {},
): SuspicionItem[] {
  const enabled = options.enabled ?? hasMeaningfulConfidenceVariance(words, options);
  if (!enabled) return [];
  const highThreshold = options.highThresholdConfidence ?? 0.45;
  const mediumThreshold = options.mediumThresholdConfidence ?? 0.6;
  const items: SuspicionItem[] = [];
  for (const word of words) {
    if (word.confidence == null) continue;
    if (word.confidence >= mediumThreshold) continue;
    const severity: SuspicionSeverity = word.confidence < highThreshold ? "high" : "medium";
    items.push({
      id: `low_confidence:${word.id}`,
      type: "low_confidence",
      severity,
      label: "文字起こしの信頼度が低い",
      text: word.text,
      timestampMs: word.startMs,
      wordIds: [word.id],
      detail: `信頼度 ${Math.round(word.confidence * 100)}%`,
    });
  }
  return items;
}

const TELOP_FINDING_LABELS: Record<string, string> = {
  dictionary: "辞書指摘",
  number_check: "数字確認",
  proper_noun_check: "固有名詞確認",
  filler_check: "相槌確認",
  duplicate_line: "重複行",
  line_break: "改行候補",
  line_prefix: "欠落候補",
  page_boundary: "境界候補",
  filler_only: "フィラーのみ",
  ai_review: "AI指摘",
};

export function telopFindingLabel(type: string) {
  return TELOP_FINDING_LABELS[type] || "テロップ指摘";
}

function cutIndexFromPageId(pageId: string): number | null {
  const match = /^cut_(\d+)/.exec(pageId || "");
  if (!match) return null;
  return Number(match[1]) - 1;
}

/** telop_review.json の findings を、page_id -> cut -> 単語範囲の順にマッピングして疑義化する。 */
export function buildTelopReviewSuspicions(
  findings: SuspicionTelopFinding[],
  words: TranscriptWord[],
  keepSegments: KeepSegment[],
): SuspicionItem[] {
  const sortedSegments = [...keepSegments].sort((a, b) => a.startMs - b.startMs);
  const items: SuspicionItem[] = [];
  for (const finding of findings) {
    const cutIndex = cutIndexFromPageId(finding.page_id);
    const segment = cutIndex != null ? sortedSegments[cutIndex] : undefined;
    const candidateWords = segment
      ? words.filter((word) => word.startMs < segment.endMs && word.endMs > segment.startMs)
      : [];
    const matchedWord =
      (finding.source &&
        candidateWords.find((word) => word.text.trim() && finding.source!.includes(word.text))) ||
      undefined;
    const timestampMs = matchedWord?.startMs ?? segment?.startMs ?? 0;
    items.push({
      id: `telop_review:${finding.id}`,
      type: "telop_review",
      severity: finding.severity,
      label: telopFindingLabel(finding.type),
      text: finding.source || finding.message,
      timestampMs,
      wordIds: matchedWord ? [matchedWord.id] : [],
      detail: finding.message,
    });
  }
  return items;
}

/**
 * フィラー（言い淀み）検出。step04_filler_detect の fillers[].word_id 由来の fillerWordIds に
 * 該当する単語を medium でフラグする(改善2「要確認フラグの限定」節)。
 * ただし該当単語がどのkeep_segmentにも含まれない(=AIが既にカット提案済み)場合はフラグしない。
 * 「AIが既にカットしたものを再確認させない」という要件のため。
 */
export function buildFillerSuspicions(
  words: TranscriptWord[],
  fillerWordIds: string[],
  keepSegments: KeepSegment[],
): SuspicionItem[] {
  if (!fillerWordIds.length) return [];
  const fillerIdSet = new Set(fillerWordIds);
  const items: SuspicionItem[] = [];
  for (const word of words) {
    if (!fillerIdSet.has(word.id)) continue;
    if (!isWordInKeepSegments(word, keepSegments)) continue;
    items.push({
      id: `filler:${word.id}`,
      type: "filler",
      severity: "medium",
      label: "フィラー（言い淀み）",
      text: word.text,
      timestampMs: word.startMs,
      wordIds: [word.id],
      detail: "AIのフィラー検出に該当します(カットされずに残っています)",
    });
  }
  return items;
}

/**
 * suspicionQueue.ts内だけで完結させるための、単語配列(TranscriptWord[])向けの軽量な
 * ヒューリスティック検出ヘルパー。カタカナの連続・数字の連続は、日本語の形態素単位
 * (Intl.Segmenterの単語分割。例:「コンサル」は「コン」「サル」に分かれる)をまたいで
 * 出現することが多いため、単語グループ単位ではなく文字レベルの正規表現マッチで検出する。
 * マッチした文字範囲を、その範囲に文字を持つ元のSourceWord群へ逆引きする。
 */
type TextWordGroup = { text: string; wordIds: string[]; startMs: number; endMs: number };
type HeuristicTermRun = TextWordGroup & { kind: "katakana" | "digit" };

function findHeuristicTermRuns(words: TranscriptWord[], katakanaMinLength: number): HeuristicTermRun[] {
  const sorted = [...words].sort((a, b) => a.startMs - b.startMs);
  let concatText = "";
  const ownerIndex: number[] = [];
  sorted.forEach((word, index) => {
    for (const _ch of word.text) {
      concatText += _ch;
      ownerIndex.push(index);
    }
  });
  if (!concatText.length) return [];

  const katakanaRegex = new RegExp(`[\\u30A0-\\u30FFー]{${katakanaMinLength},}`, "g");
  const digitRegex = /[0-9\uFF10-\uFF19]+/g;
  const runs: HeuristicTermRun[] = [];

  function collect(regex: RegExp, kind: "katakana" | "digit") {
    for (const match of concatText.matchAll(regex)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      const memberIndexSet = new Set<number>();
      for (let charIndex = start; charIndex < end; charIndex += 1) memberIndexSet.add(ownerIndex[charIndex]);
      const memberIndices = [...memberIndexSet].sort((a, b) => a - b);
      const memberWords = memberIndices.map((index) => sorted[index]);
      runs.push({
        text: memberWords.map((word) => word.text).join(""),
        wordIds: memberWords.map((word) => word.id),
        startMs: memberWords[0].startMs,
        endMs: memberWords[memberWords.length - 1].endMs,
        kind,
      });
    }
  }
  collect(katakanaRegex, "katakana");
  collect(digitRegex, "digit");
  return runs;
}

export type DictionaryTerm = { wrong?: string; correct?: string };

export type ProperNounOptions = {
  /** カタカナ連続とみなす最小文字数。既定3。 */
  katakanaMinLength?: number;
  /** ユーザーの学習辞書(既知の固有名詞・修正ペア)。ここに載っている語は既知として除外する。 */
  knownDictionary?: DictionaryTerm[];
  /** false の場合、(b)ヒューリスティック検出を行わない(AIモード向け)。既定true。 */
  includeHeuristic?: boolean;
};

const PROPER_NOUN_FINDING_TYPES = new Set(["dictionary", "proper_noun_check", "number_check"]);

/**
 * 不安な固有名詞・数字の検出(改善2「要確認フラグの限定」節)。
 * (a) telop_review findings の dictionary/proper_noun_check/number_check 指摘に該当する単語 -> high
 * (b) カタカナ3文字以上の連続、または数字を含む語で、ユーザー辞書に無いもの -> medium(ヒューリスティック)
 * (a)で既に検出された単語は(b)で重複してフラグしない。
 */
export function buildProperNounSuspicions(
  words: TranscriptWord[],
  telopFindings: SuspicionTelopFinding[],
  keepSegments: KeepSegment[],
  options: ProperNounOptions = {},
): SuspicionItem[] {
  const items: SuspicionItem[] = [];
  const flaggedWordIds = new Set<string>();

  const findingItems = buildTelopReviewSuspicions(
    telopFindings.filter((finding) => PROPER_NOUN_FINDING_TYPES.has(finding.type)),
    words,
    keepSegments,
  );
  for (const item of findingItems) {
    if (!item.wordIds.length) continue;
    items.push({
      ...item,
      id: `proper_noun_finding:${item.id}`,
      type: "proper_noun",
      severity: "high",
      label: "固有名詞・辞書指摘",
    });
    for (const wordId of item.wordIds) flaggedWordIds.add(wordId);
  }

  if (options.includeHeuristic === false) {
    return items;
  }

  const katakanaMinLength = options.katakanaMinLength ?? 3;
  const knownTerms = new Set<string>();
  for (const term of options.knownDictionary || []) {
    if (term.wrong) knownTerms.add(term.wrong);
    if (term.correct) knownTerms.add(term.correct);
  }

  for (const run of findHeuristicTermRuns(words, katakanaMinLength)) {
    const text = run.text.trim();
    if (!text) continue;
    if (run.wordIds.some((wordId) => flaggedWordIds.has(wordId))) continue;
    const overlapsKeepSegment = keepSegments.some(
      (segment) => Math.min(segment.endMs, run.endMs) > Math.max(segment.startMs, run.startMs),
    );
    if (!overlapsKeepSegment) continue;
    if (knownTerms.has(text)) continue;
    items.push({
      id: `proper_noun_heuristic:${run.wordIds.join("_")}`,
      type: "proper_noun",
      severity: "medium",
      label: "固有名詞・数字の要確認",
      text,
      timestampMs: run.startMs,
      wordIds: run.wordIds,
      detail: run.kind === "katakana" ? "カタカナ語で辞書未登録です" : "数字を含む語で辞書未登録です",
    });
  }

  return items;
}

export type AiReviewTranscriptNeedsReview = {
  word_ids?: string[];
  start_ms?: number;
  end_ms?: number;
  text?: string;
  reason?: string;
};

export type AiReviewTelopNeedsReview = {
  page_id?: string;
  text?: string;
  reason?: string;
  suggestion?: string;
};

export type AiReviewInput = {
  enabled: boolean;
  transcriptNeedsReview?: AiReviewTranscriptNeedsReview[];
  telopNeedsReview?: AiReviewTelopNeedsReview[];
  dismissedFindingIds?: string[];
};

function aiReviewLabel(reason: string): string {
  const normalized = reason.trim();
  if (!normalized) return "AI要確認";
  if (/復元|崩れ|文字起こし/.test(normalized)) return "AIが復元できなかった箇所";
  if (/言い直し|リテイク|言い直/.test(normalized)) return "言い直しの疑い";
  return "AI要確認";
}

/** reason / suggestion 内の「」引用を抽出する。 */
function extractQuotedTexts(text: string): string[] {
  const results: string[] = [];
  for (const match of text.matchAll(/「([^」]{2,})」/g)) {
    if (match[1]) results.push(match[1]);
  }
  return results;
}

/** telop needs_review の位置解決用候補テキスト (長い順)。 */
export function collectAiReviewCandidateTexts(entry: AiReviewTelopNeedsReview): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const push = (value: string | undefined) => {
    const trimmed = String(value || "").trim();
    if (trimmed.length < 3 || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push(trimmed);
  };

  push(entry.text);
  push(entry.suggestion);
  for (const quoted of extractQuotedTexts(String(entry.reason || ""))) push(quoted);
  for (const quoted of extractQuotedTexts(String(entry.suggestion || ""))) push(quoted);
  push(entry.reason);
  return candidates.sort((a, b) => b.length - a.length);
}

type SegmentRow = {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
  words: TranscriptWord[];
};

function buildSegmentRows(words: TranscriptWord[], keepSegments: KeepSegment[]): SegmentRow[] {
  const sortedSegments = [...keepSegments].sort((a, b) => a.startMs - b.startMs);
  return sortedSegments.map((segment, index) => {
    const segmentWords = words
      .filter((word) => word.startMs < segment.endMs && word.endMs > segment.startMs)
      .sort((a, b) => a.startMs - b.startMs);
    return {
      index,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segmentWords.map((word) => word.text).join(""),
      words: segmentWords,
    };
  });
}

function cutHintMs(pageId: string, keepSegments: KeepSegment[]): number | null {
  const cutIndex = cutIndexFromPageId(pageId);
  if (cutIndex == null) return null;
  const sortedSegments = [...keepSegments].sort((a, b) => a.startMs - b.startMs);
  const segment = sortedSegments[cutIndex];
  if (!segment) return null;
  return Math.round((segment.startMs + segment.endMs) / 2);
}

function mapCharIndexToWord(words: TranscriptWord[], charIndex: number): TranscriptWord | undefined {
  let offset = 0;
  for (const word of words) {
    const next = offset + word.text.length;
    if (charIndex >= offset && charIndex < next) return word;
    offset = next;
  }
  return words[words.length - 1];
}

export type AiReviewAnchor = {
  timestampMs: number;
  wordIds: string[];
  segmentIndex: number | null;
};

type AiReviewTextMatch = {
  row: SegmentRow;
  word: TranscriptWord;
  matchLen: number;
  distanceMs: number;
};

function findBestAiReviewTextMatch(
  candidates: string[],
  rows: SegmentRow[],
  hintMs: number | null,
): AiReviewTextMatch | null {
  let bestMatch: AiReviewTextMatch | null = null;

  for (const candidate of candidates) {
    let foundFullCandidate = false;
    for (let len = candidate.length; len >= 3; len -= 1) {
      for (let start = 0; start <= candidate.length - len; start += 1) {
        const needle = candidate.slice(start, start + len);
        for (const row of rows) {
          let searchFrom = 0;
          while (searchFrom < row.text.length) {
            const foundAt = row.text.indexOf(needle, searchFrom);
            if (foundAt < 0) break;
            const word = mapCharIndexToWord(row.words, foundAt);
            if (!word) {
              searchFrom = foundAt + 1;
              continue;
            }
            const distanceMs = hintMs == null ? 0 : Math.abs(word.startMs - hintMs);
            const next: AiReviewTextMatch = { row, word, matchLen: len, distanceMs };
            if (
              !bestMatch ||
              next.matchLen > bestMatch.matchLen ||
              (next.matchLen === bestMatch.matchLen && next.distanceMs < bestMatch.distanceMs)
            ) {
              bestMatch = next;
            }
            searchFrom = foundAt + 1;
          }
        }
      }
      if ((bestMatch?.matchLen ?? 0) === candidate.length) {
        foundFullCandidate = true;
        break;
      }
    }
    if (foundFullCandidate || (bestMatch?.matchLen ?? 0) >= 6) break;
  }

  return bestMatch;
}

/**
 * telop needs_review の page_id と引用テキストから、最も一致する keep_segment 行へ
 * timestamp / wordIds を解決する (改善16-B)。
 */
export function resolveAiReviewAnchor(
  entry: AiReviewTelopNeedsReview,
  words: TranscriptWord[],
  keepSegments: KeepSegment[],
): AiReviewAnchor {
  const pageId = String(entry.page_id || "");
  const hintMs = pageId ? cutHintMs(pageId, keepSegments) : null;
  const rows = buildSegmentRows(words, keepSegments);
  const candidates = collectAiReviewCandidateTexts(entry);
  const bestMatch = findBestAiReviewTextMatch(candidates, rows, hintMs);

  if (bestMatch) {
    return {
      timestampMs: bestMatch.word.startMs,
      wordIds: [bestMatch.word.id],
      segmentIndex: bestMatch.row.index,
    };
  }

  const cutIndex = pageId ? cutIndexFromPageId(pageId) : null;
  const sortedSegments = [...keepSegments].sort((a, b) => a.startMs - b.startMs);
  const segment = cutIndex != null ? sortedSegments[cutIndex] : undefined;
  const fallbackWords = segment
    ? words.filter((word) => word.startMs < segment.endMs && word.endMs > segment.startMs)
    : [];
  const fallbackWord = fallbackWords[0];
  return {
    timestampMs: fallbackWord?.startMs ?? segment?.startMs ?? 0,
    wordIds: fallbackWord ? [fallbackWord.id] : [],
    segmentIndex: cutIndex,
  };
}

/** パス1/2の AI needs_review を疑義キュー項目に変換する(改善13)。 */
export function buildAiReviewSuspicions(
  aiReview: AiReviewInput,
  words: TranscriptWord[],
  keepSegments: KeepSegment[],
): SuspicionItem[] {
  if (!aiReview.enabled) return [];
  const items: SuspicionItem[] = [];

  for (const [index, entry] of (aiReview.transcriptNeedsReview || []).entries()) {
    const wordIds = Array.isArray(entry.word_ids) ? entry.word_ids.map(String) : [];
    const matchedWords = wordIds
      .map((wordId) => words.find((word) => word.id === wordId))
      .filter((word): word is TranscriptWord => Boolean(word));
    const timestampMs =
      Number(entry.start_ms) ||
      matchedWords[0]?.startMs ||
      0;
    const text = String(entry.text || matchedWords.map((word) => word.text).join("") || "");
    const reason = String(entry.reason || "要確認");
    items.push({
      id: `ai_review:transcript:${index}:${wordIds.join("_") || timestampMs}`,
      type: "ai_review",
      severity: "high",
      label: aiReviewLabel(reason),
      text,
      timestampMs,
      wordIds,
      detail: reason,
    });
  }

  for (const [index, entry] of (aiReview.telopNeedsReview || []).entries()) {
    const pageId = String(entry.page_id || "");
    const reason = String(entry.reason || "要確認");
    const suggestion = entry.suggestion ? String(entry.suggestion) : "";
    const text = String(entry.text || suggestion || reason);
    const anchor = resolveAiReviewAnchor(entry, words, keepSegments);
    items.push({
      id: `ai_review:telop:${pageId || "text"}:${index}`,
      type: "ai_review",
      severity: "high",
      label: aiReviewLabel(reason),
      text,
      timestampMs: anchor.timestampMs,
      wordIds: anchor.wordIds,
      detail: suggestion ? `${reason}（案: ${suggestion}）` : reason,
    });
  }

  return items;
}

export type BoundaryOverrunOptions = { thresholdMs?: number };

/** keep_segment の端で単語が >thresholdMs はみ出しているケースを検出する。 */
export function buildBoundaryOverrunSuspicions(
  words: TranscriptWord[],
  keepSegments: KeepSegment[],
  options: BoundaryOverrunOptions = {},
): SuspicionItem[] {
  const thresholdMs = options.thresholdMs ?? 80;
  const items: SuspicionItem[] = [];
  for (const segment of keepSegments) {
    for (const word of words) {
      if (word.startMs < segment.startMs && segment.startMs < word.endMs) {
        const overrunMs = segment.startMs - word.startMs;
        if (overrunMs > thresholdMs) {
          items.push({
            id: `boundary_overrun:${segment.startMs}:${segment.endMs}:${word.id}:start`,
            type: "boundary_overrun",
            severity: overrunMs > 300 ? "high" : "medium",
            label: "境界はみ出し（開始側）",
            text: word.text,
            timestampMs: word.startMs,
            wordIds: [word.id],
            detail: `${Math.round(overrunMs)}ms はみ出し`,
          });
        }
      }
      if (word.startMs < segment.endMs && segment.endMs < word.endMs) {
        const overrunMs = word.endMs - segment.endMs;
        if (overrunMs > thresholdMs) {
          items.push({
            id: `boundary_overrun:${segment.startMs}:${segment.endMs}:${word.id}:end`,
            type: "boundary_overrun",
            severity: overrunMs > 300 ? "high" : "medium",
            label: "境界はみ出し（終了側）",
            text: word.text,
            timestampMs: Math.max(0, segment.endMs - 200),
            wordIds: [word.id],
            detail: `${Math.round(overrunMs)}ms はみ出し`,
          });
        }
      }
    }
  }
  return items;
}

export type ShortCutOptions = { minDurationMs?: number };

/** 700ms未満(既定値)の極端に短いkeep_segmentを検出する。 */
export function buildShortCutSuspicions(
  keepSegments: KeepSegment[],
  words: TranscriptWord[],
  options: ShortCutOptions = {},
): SuspicionItem[] {
  const minDurationMs = options.minDurationMs ?? 700;
  const items: SuspicionItem[] = [];
  for (const segment of keepSegments) {
    const durationMs = segment.endMs - segment.startMs;
    if (durationMs >= minDurationMs) continue;
    const segmentWords = words
      .filter((word) => word.startMs < segment.endMs && word.endMs > segment.startMs)
      .sort((a, b) => a.startMs - b.startMs);
    items.push({
      id: `short_cut:${segment.startMs}:${segment.endMs}`,
      type: "short_cut",
      severity: durationMs < 400 ? "high" : "medium",
      label: "短いカット",
      text: segmentWords.map((word) => word.text).join("") || "(無音区間)",
      timestampMs: segment.startMs,
      wordIds: segmentWords.map((word) => word.id),
      detail: `${Math.round(durationMs)}ms`,
    });
  }
  return items;
}

export type SuspicionQueueInput = {
  words: TranscriptWord[];
  keepSegments: KeepSegment[];
  telopFindings?: SuspicionTelopFinding[];
  /** step04_filler_detect の fillers[].word_id 由来(改善2「フィラー検出」節)。 */
  fillerWordIds?: string[];
  /** ユーザーの学習辞書(改善2「不安な固有名詞検出」節で既知語の除外に使う)。 */
  dictionaryRules?: DictionaryTerm[];
  /** 改善13: AI校正結果。enabled 時は AIモードの要確認リスト生成に使う。 */
  aiReview?: AiReviewInput;
  lowConfidenceOptions?: LowConfidenceOptions;
  boundaryOverrunOptions?: BoundaryOverrunOptions;
  shortCutOptions?: ShortCutOptions;
  properNounOptions?: ProperNounOptions;
};

/**
 * 疑義キューを生成する(改善2以降): 低confidence(自動判定・既定オフ)・フィラー・
 * 不安な固有名詞/辞書指摘・境界はみ出し・短いカットの5系統を統合し、重要度→時刻の順でソートする。
 * 改善13: aiReview.enabled 時は AIモード(ヒューリスティック抑制・AI needs_review 優先)。
 */
export function buildSuspicionQueue(input: SuspicionQueueInput): SuspicionItem[] {
  const aiReview = input.aiReview;
  const aiMode = Boolean(aiReview?.enabled);
  const dismissedIds = new Set(aiReview?.dismissedFindingIds || []);
  const telopFindings = (input.telopFindings || []).filter((finding) => !dismissedIds.has(finding.id));

  const aiItems = buildAiReviewSuspicions(aiReview || { enabled: false }, input.words, input.keepSegments);

  const fillerItems = aiMode
    ? []
    : buildFillerSuspicions(input.words, input.fillerWordIds || [], input.keepSegments);

  const properNounItems = buildProperNounSuspicions(input.words, telopFindings, input.keepSegments, {
    ...input.properNounOptions,
    knownDictionary: input.properNounOptions?.knownDictionary ?? input.dictionaryRules,
    includeHeuristic: aiMode ? false : input.properNounOptions?.includeHeuristic,
  });

  const boundaryItems = buildBoundaryOverrunSuspicions(
    input.words,
    input.keepSegments,
    input.boundaryOverrunOptions,
  ).filter((item) => !aiMode || item.severity === "high");

  const shortCutItems = buildShortCutSuspicions(
    input.keepSegments,
    input.words,
    input.shortCutOptions,
  ).filter((item) => !aiMode || item.severity === "high");

  const items = [
    ...aiItems,
    ...buildLowConfidenceSuspicions(input.words, input.lowConfidenceOptions),
    ...fillerItems,
    ...properNounItems,
    ...boundaryItems,
    ...shortCutItems,
  ];
  return items.sort((a, b) => {
    const severityDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (severityDiff !== 0) return severityDiff;
    return a.timestampMs - b.timestampMs;
  });
}
