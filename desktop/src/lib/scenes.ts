// 実行時(値)importのため、node --experimental-strip-types でテストを直接実行できるよう拡張子を明示する。
import type { KeepSegment } from "./keepSegments.ts";
import type { SuspicionItem } from "./suspicionQueue.ts";
import { detectEmotionTag, type EmotionTag } from "./emotionTag.ts";
import { type TelopThemeId, resolveEffectiveStyleId } from "./telopThemes.ts";
import { normalizeTelopDisplayText } from "./telopTextNormalize.ts";

/**
 * シーン行UI（検品UI v2 Phase 1）のデータモデル。
 * `2026-07-03_catcut-scene-row-ui-spec.md` の「データモデル」節に準拠する。
 *
 * scenes 配列を唯一の編集源(single source of truth)とし、keep_segments は
 * このファイルの純関数で毎回 scenes から導出する。「波形を動かすと単語再計算で戻る」
 * という旧UIの問題を、単語からの再計算をやめることで解消する。
 */

export type SceneWord = {
  id: string;
  text: string;
  /** 元動画上の開始時刻(ms)。タイミング層であり書き換え不可。 */
  startMs: number;
  endMs: number;
  /** true の場合この単語区間の動画はカットされる(書き出し用keep_segmentsから除外)。 */
  deleted: boolean;
  /**
   * Phase 3: 端トリムでシーン範囲外に出たため自動的に deleted=true にされたか。
   * ユーザーの手動削除(チップの右クリック等)と区別するために使う。手動削除は
   * このフラグを立てない(常にfalseに戻す)ため、トリムで範囲内に戻っても復活しない。
   * このフラグが立っている単語は、範囲内に戻れば自動的に deleted=false へ復活する
   * (仕様書「トリムアウトの単語処理」節)。省略可能(未指定は手動削除と同じ扱い)。
   */
  autoTrimmed?: boolean;
};

export type Scene = {
  id: string;
  /** 元動画上のIN点(ms)。 */
  sourceStartMs: number;
  /** 元動画上のOUT点(ms)。 */
  sourceEndMs: number;
  words: SceneWord[];
  /** 表示層。初期値はwordsの連結だが自由に書き換え可能(タイミングに影響しない)。 */
  telopText: string;
  /** 手動編集済みか(青字表示の判定に使う)。 */
  telopEdited: boolean;
  /** 右クリック切り込み位置(元動画ms)。Phase 2以降で使用する。 */
  cutMarks: number[];
  /**
   * テーマ×感情の自動スタイリング(T-2): telopTextからルールベースで自動付与される感情タグ。
   * 保存形式の後方互換のためoptional(未指定時は呼び出し側が"normal"として扱う)。
   */
  emotionTag?: EmotionTag;
  /**
   * テーマ×感情の自動スタイリング(T-3): 個別スタイルオーバーライド。
   * telopThemes.ts の themeEmotionStyleId()/EXTRA_STYLE_OPTIONS のいずれかのIDを指す。
   * null/undefinedなら「テーマ×emotionTagの既定スタイル」を使う(個別オーバーライドなし)。
   * オーバーライドは感情タグ・テーマ切替より優先し、テーマ切替時も維持される(IDが
   * 具体テーマ+感情を指しているため、アクティブテーマが変わっても指すスタイルは変化しない)。
   */
  styleOverrideId?: string | null;
};

export type SourceWord = {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  sentenceId?: string;
};

export type SourceSentence = {
  id: string;
  wordIds: string[];
  startMs: number;
  endMs: number;
};

/** 改善8-B-3(シーン初期化=テロップページ): composition.jsonから抽出したBudouXページの絶対ms範囲。 */
export type TelopPageBoundary = {
  startMs: number;
  endMs: number;
  /** 改善10-B-3: パイプライン適用済みのページ本文(句読点ルール済み)。未指定時はwords連結+正規化。 */
  text?: string;
};

export type InitializeScenesInput = {
  words: SourceWord[];
  sentences?: SourceSentence[];
  keepSegments: KeepSegment[];
  /**
   * 改善8-B-3(シーン初期化=テロップページ): 指定されていれば「1シーン=1テロップページ」に
   * 初期分割し、UI独自の改行ヒューリスティック(splitRunByPrimaryBoundary等)は使わない。
   * 未指定または空配列の場合は既存のヒューリスティック分割にフォールバックする
   * (旧runでcomposition.jsonにvoice_data/telopsが無い場合の互換性のため)。
   */
  telopPageBoundaries?: TelopPageBoundary[];
};

let sceneIdCounter = 0;

/** テスト間で採番結果を安定させるためのカウンタリセット(テスト用エクスポート)。 */
export function resetSceneIdCounterForTests() {
  sceneIdCounter = 0;
}

function nextSceneId(): string {
  sceneIdCounter += 1;
  return `scene_${String(sceneIdCounter).padStart(4, "0")}`;
}

/**
 * シーンのwordsからテロップ表示層の自動テキストを生成する。
 * edgeTrim.tsからも参照するため公開する(端トリムでdeleted状態が変わった際の再生成に使う)。
 */
export function autoTelopTextFromWords(words: SceneWord[]): string {
  const joined = words
    .filter((word) => !word.deleted)
    .map((word) => word.text)
    .join("");
  return normalizeTelopDisplayText(joined);
}

function buildScene(
  words: SourceWord[],
  sourceStartMs: number,
  sourceEndMs: number,
  telopTextOverride?: string,
): Scene {
  const sceneWords: SceneWord[] = words.map((word) => ({
    id: word.id,
    text: word.text,
    startMs: word.startMs,
    endMs: word.endMs,
    deleted: false,
  }));
  const telopText = telopTextOverride ?? autoTelopTextFromWords(sceneWords);
  return {
    id: nextSceneId(),
    sourceStartMs,
    sourceEndMs,
    words: sceneWords,
    telopText,
    telopEdited: false,
    cutMarks: [],
    emotionTag: detectEmotionTag(telopText),
    styleOverrideId: null,
  };
}

/**
 * シーン初期化の行分割規則(改善2「シーン行の分割位置を自然に」節)で使う定数群。
 * 目安値は仕様書の「全角22〜28文字」「全角6文字未満」の中庸を取っている。
 */
const SENTENCE_END_CHARS = new Set(["。", "？", "！", "?", "!"]);
/** 明確なポーズとみなす単語間ギャップ(ms)。これを超えたら文末でなくても分割点にする。 */
const PAUSE_GAP_MS = 500;
/** 1行の上限(全角換算文字数)。これを超える行は助詞の直後で再分割する。 */
const MAX_LINE_CHARS = 24;
/** 1行の下限(全角換算文字数)。これ未満の行は前後に併合する。 */
const MIN_LINE_CHARS = 6;
/**
 * 助詞の候補(直後で改行してよい語)。「ので」「けど」「って」「から」「まで」「より」は2文字の助詞なので、
 * Intl.Segmenterのグループテキストと完全一致で判定する(部分一致ではないため出現順は問題にならない)。
 */
const TRAILING_PARTICLES = new Set([
  "ので",
  "けど",
  "って",
  "から",
  "まで",
  "より",
  "は",
  "が",
  "を",
  "に",
  "で",
  "と",
  "も",
  "へ",
]);

const rowSplitSegmenter = new Intl.Segmenter("ja", { granularity: "word" });

function charLength(text: string): number {
  return [...text].length;
}

function endsWithSentenceEndChar(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return SENTENCE_END_CHARS.has(trimmed[trimmed.length - 1]);
}

/**
 * 改善2 規則1: 「文末(句読点)の直後」「単語間ギャップ500ms超の直後」「文境界(sentenceIdの変化点、
 * STTの文分割メタデータが句読点より先に手掛かりを持っている場合のフォールバック)の直後」を
 * 一次分割点として、1つのkeep_segment内の連続単語列を分割する。
 */
function splitRunByPrimaryBoundary(run: SourceWord[]): SourceWord[][] {
  const chunks: SourceWord[][] = [];
  let current: SourceWord[] = [];
  for (let index = 0; index < run.length; index += 1) {
    const word = run[index];
    current.push(word);
    const next = run[index + 1];
    if (!next) continue;
    const gapMs = next.startMs - word.endMs;
    const sentenceChanged =
      word.sentenceId !== undefined && next.sentenceId !== undefined && word.sentenceId !== next.sentenceId;
    if (endsWithSentenceEndChar(word.text) || gapMs > PAUSE_GAP_MS || sentenceChanged) {
      chunks.push(current);
      current = [];
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * chunk(SourceWord列)を Intl.Segmenter('ja', {granularity:'word'}) の単語グループ単位に束ねる。
 * wordGroups.ts の computeWordGroups と近いロジックだが、こちらは SourceWord(初期化前の生単語)
 * 向けであり Scene 型に依存しない。助詞の直後判定(規則2)専用の内部ヘルパーとして複製している。
 */
function groupChunkByWord(chunk: SourceWord[]): Array<{ text: string; words: SourceWord[] }> {
  const concatText = chunk.map((word) => word.text).join("");
  if (!concatText.length) return [];
  const charOwner: number[] = [];
  chunk.forEach((word, wordIndex) => {
    for (const _ch of word.text) charOwner.push(wordIndex);
  });

  const groups: Array<{ text: string; words: SourceWord[] }> = [];
  let currentIndices: number[] = [];
  const consumed = new Set<number>();
  function flush() {
    if (!currentIndices.length) return;
    const memberWords = currentIndices.map((index) => chunk[index]);
    groups.push({ text: memberWords.map((word) => word.text).join(""), words: memberWords });
    currentIndices = [];
  }

  for (const segment of rowSplitSegmenter.segment(concatText)) {
    const startChar = segment.index;
    const endChar = segment.index + segment.segment.length;
    const memberSet = new Set<number>();
    for (let charIndex = startChar; charIndex < endChar; charIndex += 1) {
      const owner = charOwner[charIndex];
      if (!consumed.has(owner)) memberSet.add(owner);
    }
    const members = [...memberSet].sort((a, b) => a - b);
    if (!members.length) continue;
    for (const member of members) consumed.add(member);
    if (segment.isWordLike) {
      flush();
      currentIndices = members;
    } else if (currentIndices.length) {
      currentIndices.push(...members);
    } else {
      currentIndices = members;
      flush();
    }
  }
  flush();
  return groups;
}

/** 列挙トークン("一、"「二、」等)の判定に使う漢数字の集合(改行規則v2)。 */
const ENUMERATION_NUMERAL_RE = /^[一二三四五六七八九十百千]+$/;
/** 行末に来てはいけない1文字接頭語(改行規則v2)。「お、」「ご、」のように読点が続く形で出現し得る。 */
const PROHIBITED_LINE_END_PREFIXES = new Set(["お", "ご"]);

function stripTrailingComma(text: string): string {
  return text.endsWith("、") ? text.slice(0, -1) : text;
}

/** "一、"「二、」等、漢数字+読点だけからなる列挙トークンかどうか(改行規則v2禁則: 次内容と同行に保つ)。 */
function isEnumerationCommaToken(groupText: string): boolean {
  if (!groupText.endsWith("、")) return false;
  return ENUMERATION_NUMERAL_RE.test(stripTrailingComma(groupText));
}

/** 「お」「ご」のような1文字接頭語だけで終わる境界かどうか(改行規則v2禁則)。読点付き("お、")も対象。 */
function endsWithProhibitedPrefix(groupText: string): boolean {
  return PROHIBITED_LINE_END_PREFIXES.has(stripTrailingComma(groupText));
}

/**
 * 改行規則v2(改善7-5): 1行が全角 MAX_LINE_CHARS 文字を超える場合の第2分割点。
 * 優先順位は「読点『、』直後」＞「助詞(TRAILING_PARTICLES)直後」。
 * 禁則: (a) 「一、」「二、」等の列挙トークン直後は分割点にしない(次内容と同行に保つ)、
 * (b) 「お」「ご」のような1文字接頭語だけで終わる境界は分割点にしない(行頭が「、続けて…」のような
 * 不自然な形になるのを防ぐ)。読点・助詞のいずれの境界も見つからない場合は上限を超えても
 * 無理な途中分割はせず、次の境界まで待つ(改善2からの既存方針を維持)。
 */
function splitChunkAtParticles(chunk: SourceWord[]): SourceWord[][] {
  const totalLen = charLength(chunk.map((word) => word.text).join(""));
  if (totalLen <= MAX_LINE_CHARS) return [chunk];

  const groups = groupChunkByWord(chunk);
  const lines: SourceWord[][] = [];
  let currentWords: SourceWord[] = [];
  let currentLen = 0;
  let commaBoundaryWordCount = -1;
  let particleBoundaryWordCount = -1;

  for (const group of groups) {
    currentWords.push(...group.words);
    currentLen += charLength(group.text);

    const isCommaBoundary =
      group.text.endsWith("、") &&
      currentLen >= MIN_LINE_CHARS &&
      !isEnumerationCommaToken(group.text) &&
      !endsWithProhibitedPrefix(group.text);
    if (isCommaBoundary) commaBoundaryWordCount = currentWords.length;

    const isParticleBoundary =
      TRAILING_PARTICLES.has(group.text) && currentLen >= MIN_LINE_CHARS && !endsWithProhibitedPrefix(group.text);
    if (isParticleBoundary) particleBoundaryWordCount = currentWords.length;

    if (currentLen > MAX_LINE_CHARS) {
      const boundaryWordCount = commaBoundaryWordCount > 0 ? commaBoundaryWordCount : particleBoundaryWordCount;
      if (boundaryWordCount > 0) {
        lines.push(currentWords.slice(0, boundaryWordCount));
        currentWords = currentWords.slice(boundaryWordCount);
        currentLen = charLength(currentWords.map((word) => word.text).join(""));
        commaBoundaryWordCount = -1;
        particleBoundaryWordCount = -1;
      }
    }
  }
  if (currentWords.length) lines.push(currentWords);
  return lines.length ? lines : [chunk];
}

/**
 * 改善2 規則3: 全角 MIN_LINE_CHARS 文字未満の行を作らない。短い行は前(なければ後ろ)へ併合する。
 * keep_segment内(=同じ配列内)でのみ併合し、境界をまたぐ併合は行わない(呼び出し側の保証による)。
 */
function mergeShortChunks(chunks: SourceWord[][]): SourceWord[][] {
  if (chunks.length <= 1) return chunks;
  const result: SourceWord[][] = chunks.map((chunk) => [...chunk]);
  let index = 0;
  while (index < result.length) {
    if (result.length <= 1) break;
    const len = charLength(result[index].map((word) => word.text).join(""));
    if (len >= MIN_LINE_CHARS) {
      index += 1;
      continue;
    }
    if (index === 0) {
      result[0] = [...result[0], ...result[1]];
      result.splice(1, 1);
      continue;
    }
    // 前(index-1)へ併合する(自然な読み順を保つため、後方の行を巻き込まない)。
    result[index - 1] = [...result[index - 1], ...result[index]];
    result.splice(index, 1);
    index = Math.max(0, index - 1);
  }
  return result;
}

/**
 * 改善2のヒューリスティック分割(文末/ポーズ/文境界→助詞→短行併合の3段階)を1つの
 * keep_segment内の連続単語列に適用し、[startMs, endMs]付きのSceneを組み立てる。
 * 改善8-B-3で「1シーン=1テロップページ」へ主経路が切り替わった後も、
 * (a) composition.jsonにページ情報が無い旧runでの全体フォールバック、
 * (b) ページ境界はあるがある特定のkeep_segmentに対応するページが見つからない場合の
 * その区間限定のフォールバック、の両方で使うため関数として独立させている。
 */
function heuristicScenesForSegment(segmentWords: SourceWord[], segmentStartMs: number, segmentEndMs: number): Scene[] {
  const primaryChunks = splitRunByPrimaryBoundary(segmentWords);
  const lengthAdjustedChunks = primaryChunks.flatMap((chunk) => splitChunkAtParticles(chunk));
  const runs = mergeShortChunks(lengthAdjustedChunks);
  return runs.map((run, index) => {
    const prevRun = runs[index - 1];
    const nextRun = runs[index + 1];
    const startMs =
      index === 0 ? segmentStartMs : Math.round(((prevRun![prevRun!.length - 1].endMs || 0) + run[0].startMs) / 2);
    const endMs =
      index === runs.length - 1
        ? segmentEndMs
        : Math.round((run[run.length - 1].endMs + (nextRun ? nextRun[0].startMs : run[run.length - 1].endMs)) / 2);
    return buildScene(run, startMs, endMs);
  });
}

/**
 * 改善8-B-3(シーン初期化=テロップページ): BudouXテロップページ境界(telopPageBoundaries)を
 * keep_segmentごとに割り当て、1ページ=1シーンとして初期分割する。あるkeep_segmentに
 * 対応するページが1つも見つからない場合(ページ抽出の取りこぼし等)は、その区間だけ
 * heuristicScenesForSegment()にフォールバックする。
 */
function initializeScenesFromPageBoundaries(
  sortedSegments: KeepSegment[],
  sortedPages: TelopPageBoundary[],
  wordsWithSentenceId: SourceWord[],
): Scene[] {
  const scenes: Scene[] = [];
  for (const segment of sortedSegments) {
    const segmentWords = wordsWithSentenceId
      .filter((word) => word.startMs < segment.endMs && word.endMs > segment.startMs)
      .sort((a, b) => a.startMs - b.startMs);
    if (!segmentWords.length) continue;

    const pagesInSegment = sortedPages.filter(
      (page) => page.startMs < segment.endMs && page.endMs > segment.startMs,
    );
    if (!pagesInSegment.length) {
      scenes.push(...heuristicScenesForSegment(segmentWords, segment.startMs, segment.endMs));
      continue;
    }

    pagesInSegment.forEach((page, index) => {
      const prevPage = pagesInSegment[index - 1];
      const nextPage = pagesInSegment[index + 1];
      const startMs = index === 0 ? segment.startMs : Math.round((prevPage.endMs + page.startMs) / 2);
      const endMs =
        index === pagesInSegment.length - 1 ? segment.endMs : Math.round((page.endMs + nextPage.startMs) / 2);
      const sceneWords = segmentWords.filter((word) => word.startMs < endMs && word.endMs > startMs);
      const pageText = typeof page.text === "string" && page.text.trim() ? page.text.trim() : undefined;
      if (sceneWords.length) scenes.push(buildScene(sceneWords, startMs, endMs, pageText));
    });
  }
  return scenes;
}

/**
 * 既存runのcut_proposal(keep_segments)とstt_corrected(words/sentences)からscenesを構築する。
 *
 * 改善8-B-3(シーン初期化=テロップページ): `input.telopPageBoundaries`が指定されていれば、
 * パイプラインが既にBudouXで決めたテロップページ境界に一致させて初期分割する
 * (1シーン=1テロップページ=基本1行)。UI自前の改行ヒューリスティック(下記)は、
 * ページ境界が使えない場合のフォールバックとしてのみ働く。
 *
 * フォールバック時の設計判断(改善2「シーン行の分割位置を自然に」節): 1 keep_segment内の
 * 連続単語列に対し、(1) 文末(句読点)・500ms超のポーズ・文境界のいずれかの直後を一次分割点にし、
 * (2) 1行が全角24文字を超える場合は助詞の直後でさらに分割し、
 * (3) 全角6文字未満の行は前(または後ろ)に併合する、の3段階を順に適用する。
 * 分割境界は「前の単語の終了時刻と次の単語の開始時刻の中点」に置き、各シーンの
 * [sourceStartMs, sourceEndMs]が隙間なく連続するようにする。これにより、編集を一切行わない場合は
 * deriveKeepSegments(scenes) が元のkeep_segmentsと一致する(隣接シーンが同じ境界で接するため、
 * 書き出し時に自動的に1つのkeep_segmentへ再結合される)。keep_segmentの境界は常に尊重し、
 * 併合(3)も含めkeep_segmentをまたぐ結合は行わない。
 */
export function initializeScenes(input: InitializeScenesInput): Scene[] {
  const sortedSegments = [...input.keepSegments].sort((a, b) => a.startMs - b.startMs);
  const sentenceIdByWordId = new Map<string, string>();
  for (const sentence of input.sentences || []) {
    for (const wordId of sentence.wordIds) sentenceIdByWordId.set(wordId, sentence.id);
  }
  const wordsWithSentenceId = input.words.map((word) => ({
    ...word,
    sentenceId: word.sentenceId ?? sentenceIdByWordId.get(word.id),
  }));

  if (input.telopPageBoundaries && input.telopPageBoundaries.length) {
    const sortedPages = [...input.telopPageBoundaries].sort((a, b) => a.startMs - b.startMs);
    return initializeScenesFromPageBoundaries(sortedSegments, sortedPages, wordsWithSentenceId);
  }

  const scenes: Scene[] = [];
  for (const segment of sortedSegments) {
    const segmentWords = wordsWithSentenceId
      .filter((word) => word.startMs < segment.endMs && word.endMs > segment.startMs)
      .sort((a, b) => a.startMs - b.startMs);
    if (!segmentWords.length) continue;
    scenes.push(...heuristicScenesForSegment(segmentWords, segment.startMs, segment.endMs));
  }
  return scenes;
}

/** シーン内で削除された単語区間を [sourceStartMs, sourceEndMs] から取り除いた残存区間(複数になり得る)。 */
export function computeSceneKeptSubRanges(scene: Scene): Array<{ startMs: number; endMs: number }> {
  const deletedRanges = scene.words
    .filter((word) => word.deleted)
    .map((word) => ({
      startMs: Math.max(scene.sourceStartMs, word.startMs),
      endMs: Math.min(scene.sourceEndMs, word.endMs),
    }))
    .filter((range) => range.endMs > range.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  const mergedDeleted: Array<{ startMs: number; endMs: number }> = [];
  for (const range of deletedRanges) {
    const last = mergedDeleted[mergedDeleted.length - 1];
    if (last && range.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, range.endMs);
    } else {
      mergedDeleted.push({ ...range });
    }
  }

  const result: Array<{ startMs: number; endMs: number }> = [];
  let cursor = scene.sourceStartMs;
  for (const deletedRange of mergedDeleted) {
    if (deletedRange.startMs > cursor) result.push({ startMs: cursor, endMs: deletedRange.startMs });
    cursor = Math.max(cursor, deletedRange.endMs);
  }
  if (cursor < scene.sourceEndMs) result.push({ startMs: cursor, endMs: scene.sourceEndMs });
  return result.filter((range) => range.endMs > range.startMs);
}

type ScenePiece = { startMs: number; endMs: number; sceneIndex: number };

function collectScenePieces(scenes: Scene[]): ScenePiece[] {
  const pieces: ScenePiece[] = [];
  scenes.forEach((scene, sceneIndex) => {
    for (const range of computeSceneKeptSubRanges(scene)) {
      pieces.push({ ...range, sceneIndex });
    }
  });
  return pieces.sort((a, b) => a.startMs - b.startMs);
}

type MergedSceneGroup = { startMs: number; endMs: number; sceneIndices: number[] };

/** 連続/重複する区間ピースを合併し、各グループに寄与したシーンのindex(出現順・重複なし)を記録する。 */
function groupScenePieces(pieces: ScenePiece[]): MergedSceneGroup[] {
  const groups: MergedSceneGroup[] = [];
  for (const piece of pieces) {
    const last = groups[groups.length - 1];
    if (last && piece.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, piece.endMs);
      if (last.sceneIndices[last.sceneIndices.length - 1] !== piece.sceneIndex) {
        last.sceneIndices.push(piece.sceneIndex);
      }
    } else {
      groups.push({ startMs: piece.startMs, endMs: piece.endMs, sceneIndices: [piece.sceneIndex] });
    }
  }
  return groups;
}

/**
 * 書き出し用keep_segmentsの導出。
 * 「各シーンの[sourceStartMs, sourceEndMs]からdeleted単語の区間を除いた区間の合併」
 * (シーン間の隙間＝カット)。main側のcut_proposal組み立て(step08のcut_id割り当て)と
 * 同じ順序(startMs昇順)になるようにソート済みで返す。
 */
export function deriveKeepSegments(scenes: Scene[]): KeepSegment[] {
  return groupScenePieces(collectScenePieces(scenes)).map((group) => ({
    startMs: group.startMs,
    endMs: group.endMs,
  }));
}

/**
 * deriveKeepSegments()と同じグルーピングで、各keep_segment(=書き出し後のcut)に対応する
 * テロップ上書きテキストを導出する。null は「自動生成テロップのままでよい(上書き不要)」を表す。
 *
 * 設計判断: 1つのシーンが(チップ削除により)複数のkeep_segmentに分裂した場合、編集済み全文は
 * 最初に出現するグループにのみ割り当てる(重複掲載を避けるため)。複数シーンが隣接して1つの
 * keep_segmentへ合併された場合は、寄与する各シーンの実効テキスト(編集済みならtelopText、
 * そうでなければ単語連結)をシーン順に連結する。どのシーンも編集していないグループはnullとし、
 * 自動生成されたテロップページをそのまま使う(意図しない改行・スタイルの変化を避ける)。
 */
export function deriveTelopOverrides(scenes: Scene[]): Array<string | null> {
  const groups = groupScenePieces(collectScenePieces(scenes));
  const usedSceneIndices = new Set<number>();
  return groups.map((group) => {
    const freshIndices = group.sceneIndices.filter((index) => !usedSceneIndices.has(index));
    for (const index of freshIndices) usedSceneIndices.add(index);
    const hasEdited = freshIndices.some((index) => scenes[index].telopEdited);
    if (!hasEdited) return null;
    return freshIndices
      .map((index) => (scenes[index].telopEdited ? scenes[index].telopText : autoTelopTextFromWords(scenes[index].words)))
      .join("");
  });
}

/**
 * T-5(書き出し反映): deriveKeepSegments()と同じグルーピングで、各keep_segment(=書き出し後の
 * cut)に対応するスタイルIDを導出する。1つのcutに複数シーンが寄与する場合は、時系列で
 * 最初に寄与するシーン(group.sceneIndices[0])のスタイルをそのcut全体の代表スタイルとする
 * (deriveTelopOverridesと異なり、スタイルは連結できないため単一選択にする設計判断)。
 * resolveStyleId には telopThemes.ts の resolveEffectiveStyleId をそのまま渡す想定。
 */
export function deriveTelopStyleIds(
  scenes: Scene[],
  themeId: TelopThemeId,
  resolveStyleId: (
    themeId: TelopThemeId,
    emotionTag: EmotionTag | undefined,
    styleOverrideId: string | null | undefined,
  ) => string = resolveEffectiveStyleId,
): string[] {
  const groups = groupScenePieces(collectScenePieces(scenes));
  return groups.map((group) => {
    const scene = scenes[group.sceneIndices[0]];
    return resolveStyleId(themeId, scene.emotionTag, scene.styleOverrideId);
  });
}

/** バッジクリックによる感情タグの手動変更(T-2)。 */
export function setSceneEmotionTag(scenes: Scene[], sceneId: string, tag: EmotionTag): Scene[] {
  return scenes.map((scene) => (scene.id === sceneId ? { ...scene, emotionTag: tag } : scene));
}

/** スウォッチ→パレットからの個別スタイルオーバーライド設定/解除(T-3)。 */
export function setSceneStyleOverride(scenes: Scene[], sceneId: string, styleId: string | null): Scene[] {
  return scenes.map((scene) => (scene.id === sceneId ? { ...scene, styleOverrideId: styleId } : scene));
}

/**
 * T-3「このスタイルを同じ感情の全シーンに適用」: 対象シーンの感情タグ(未設定は"normal"扱い)と
 * 一致する全シーン(対象シーン自身を含む)にstyleIdを一括オーバーライドする。1回の呼び出しで
 * 1つの不変更新(=呼び出し側で1回のUndo操作)になる。
 */
export function applyStyleOverrideToEmotionGroup(scenes: Scene[], sceneId: string, styleId: string): Scene[] {
  const target = scenes.find((scene) => scene.id === sceneId);
  if (!target) return scenes;
  const targetTag: EmotionTag = target.emotionTag ?? "normal";
  return scenes.map((scene) =>
    (scene.emotionTag ?? "normal") === targetTag ? { ...scene, styleOverrideId: styleId } : scene,
  );
}

/**
 * チップ(単語)の削除/復元を切り替える。telopTextが未編集の場合は自動的に再生成する。
 * 手動操作なので autoTrimmed フラグは常にfalseへ戻す(端トリムによる自動復活の対象から外す)。
 */
export function setChipDeleted(scenes: Scene[], sceneId: string, wordId: string, deleted: boolean): Scene[] {
  return scenes.map((scene) => {
    if (scene.id !== sceneId) return scene;
    let changed = false;
    const words = scene.words.map((word) => {
      if (word.id !== wordId || (word.deleted === deleted && !word.autoTrimmed)) return word;
      changed = true;
      return { ...word, deleted, autoTrimmed: false };
    });
    if (!changed) return scene;
    const telopText = scene.telopEdited ? scene.telopText : autoTelopTextFromWords(words);
    return { ...scene, words, telopText };
  });
}

/** チップの削除/復元をトグルする(現在の状態を見て反転させる)。 */
export function toggleChipDeleted(scenes: Scene[], sceneId: string, wordId: string): Scene[] {
  const scene = scenes.find((item) => item.id === sceneId);
  const word = scene?.words.find((item) => item.id === wordId);
  if (!word) return scenes;
  return setChipDeleted(scenes, sceneId, wordId, !word.deleted);
}

/**
 * 改善1(単語グループチップ): グループ内の全単語(複数のSceneWord)を一括でdeleted状態にする。
 * 1回の呼び出しで1つの不変更新(=呼び出し側のuseEditHistory.setPresentでは1回のUndo操作)になるため、
 * 「1グループ=1操作」を満たす。setChipDeletedと同じくtelopText未編集なら自動再生成し、
 * 手動操作なのでautoTrimmedは常にfalseへ戻す。
 */
export function setChipsDeleted(scenes: Scene[], sceneId: string, wordIds: string[], deleted: boolean): Scene[] {
  const wordIdSet = new Set(wordIds);
  return scenes.map((scene) => {
    if (scene.id !== sceneId) return scene;
    let changed = false;
    const words = scene.words.map((word) => {
      if (!wordIdSet.has(word.id) || (word.deleted === deleted && !word.autoTrimmed)) return word;
      changed = true;
      return { ...word, deleted, autoTrimmed: false };
    });
    if (!changed) return scene;
    const telopText = scene.telopEdited ? scene.telopText : autoTelopTextFromWords(words);
    return { ...scene, words, telopText };
  });
}

/**
 * グループチップの削除/復元をトグルする。グループ内の単語が一部だけdeletedの状態は
 * 通常発生しない(グループ操作は常に一括で行うため)想定だが、念のため「全員deleted」の場合のみ
 * 復元(false)へ、それ以外(1つでも未削除が残っている場合を含む)は削除(true)へ倒す。
 */
export function toggleChipsDeleted(scenes: Scene[], sceneId: string, wordIds: string[]): Scene[] {
  const scene = scenes.find((item) => item.id === sceneId);
  if (!scene || !wordIds.length) return scenes;
  const allDeleted = wordIds.every((wordId) => scene.words.find((word) => word.id === wordId)?.deleted);
  return setChipsDeleted(scenes, sceneId, wordIds, !allDeleted);
}

/** テロップ本文(表示層)を書き換える。自動生成テキストと一致する場合はtelopEditedをfalseに戻す。 */
export function setSceneTelopText(scenes: Scene[], sceneId: string, text: string): Scene[] {
  return scenes.map((scene) => {
    if (scene.id !== sceneId) return scene;
    const autoText = autoTelopTextFromWords(scene.words);
    return { ...scene, telopText: text, telopEdited: text !== autoText };
  });
}


export {
  countTelopOccurrencesInOtherScenes,
  findTelopOccurrencesInOtherScenes,
  replaceTelopOccurrences,
  type TelopOccurrence,
  type TelopOccurrenceTarget,
} from "./telopOccurrences.ts";

/**
 * チップ境界でシーンを分割する。secondFirstWordId が後半シーンの先頭単語になる。
 * 分割点(ms)は前半シーンの最後の単語の終了時刻と後半シーンの先頭単語の開始時刻の中点。
 * telopTextの扱い: 未編集なら前後ともチップ連結で再生成。編集済みなら前半シーンに編集済み
 * 全文を残し、後半は新規にチップ連結で生成する(telopEditedは前半のみ維持)。
 */
export function splitSceneAtWord(scenes: Scene[], sceneId: string, secondFirstWordId: string): Scene[] {
  const sceneIndex = scenes.findIndex((scene) => scene.id === sceneId);
  if (sceneIndex === -1) return scenes;
  const scene = scenes[sceneIndex];
  const wordIndex = scene.words.findIndex((word) => word.id === secondFirstWordId);
  if (wordIndex <= 0 || wordIndex >= scene.words.length) return scenes;

  const firstWords = scene.words.slice(0, wordIndex);
  const secondWords = scene.words.slice(wordIndex);
  const boundaryMs = Math.round((firstWords[firstWords.length - 1].endMs + secondWords[0].startMs) / 2);

  const firstTelopText = scene.telopEdited ? scene.telopText : autoTelopTextFromWords(firstWords);
  const secondTelopText = autoTelopTextFromWords(secondWords);
  const firstScene: Scene = {
    id: `${scene.id}L`,
    sourceStartMs: scene.sourceStartMs,
    sourceEndMs: boundaryMs,
    words: firstWords,
    telopText: firstTelopText,
    telopEdited: scene.telopEdited,
    cutMarks: scene.cutMarks.filter((mark) => mark < boundaryMs),
    // 感情タグ(T-2)は分割後の本文に対して再判定する。個別スタイルオーバーライド(T-3)は
    // 「分割」という構造操作ではユーザーの意図を推測できないため両半分にそのまま引き継ぐ。
    emotionTag: detectEmotionTag(firstTelopText),
    styleOverrideId: scene.styleOverrideId,
  };
  const secondScene: Scene = {
    id: `${scene.id}R`,
    sourceStartMs: boundaryMs,
    sourceEndMs: scene.sourceEndMs,
    words: secondWords,
    telopText: secondTelopText,
    telopEdited: false,
    cutMarks: scene.cutMarks.filter((mark) => mark >= boundaryMs),
    emotionTag: detectEmotionTag(secondTelopText),
    styleOverrideId: scene.styleOverrideId,
  };

  return [...scenes.slice(0, sceneIndex), firstScene, secondScene, ...scenes.slice(sceneIndex + 1)];
}

/**
 * 任意ms位置でシーンを分割する(Phase 2: 切り込み(cutMark)位置でのEnter分割用)。
 * splitSceneAtWord() と異なり、分割点(ms)はチップ境界に限らず任意の位置を取り得る。
 * 「分割時のテキスト処理」節の「切り込み(音節の途中)で分割」規則に従い、境界にまたがるチップは
 * 中点(startMsとendMsの中間)が属する側のシーンへ丸ごと入れる。動画の分割点はms ちょうど。
 * ms がシーンの範囲外([sourceStartMs, sourceEndMs])にあるか、範囲の両端と一致する場合は
 * (どちらか一方が空シーンになってしまうため)分割せずそのまま返す。
 */
export function splitSceneAtMs(scenes: Scene[], sceneId: string, ms: number): Scene[] {
  const sceneIndex = scenes.findIndex((scene) => scene.id === sceneId);
  if (sceneIndex === -1) return scenes;
  const scene = scenes[sceneIndex];
  if (ms <= scene.sourceStartMs || ms >= scene.sourceEndMs) return scenes;

  const firstWords: SceneWord[] = [];
  const secondWords: SceneWord[] = [];
  for (const word of scene.words) {
    const midpointMs = (word.startMs + word.endMs) / 2;
    if (midpointMs < ms) firstWords.push(word);
    else secondWords.push(word);
  }
  if (!firstWords.length || !secondWords.length) return scenes;

  const firstTelopText = scene.telopEdited ? scene.telopText : autoTelopTextFromWords(firstWords);
  const secondTelopText = autoTelopTextFromWords(secondWords);
  const firstScene: Scene = {
    id: `${scene.id}L`,
    sourceStartMs: scene.sourceStartMs,
    sourceEndMs: ms,
    words: firstWords,
    telopText: firstTelopText,
    telopEdited: scene.telopEdited,
    cutMarks: scene.cutMarks.filter((mark) => mark < ms),
    emotionTag: detectEmotionTag(firstTelopText),
    styleOverrideId: scene.styleOverrideId,
  };
  const secondScene: Scene = {
    id: `${scene.id}R`,
    sourceStartMs: ms,
    sourceEndMs: scene.sourceEndMs,
    words: secondWords,
    telopText: secondTelopText,
    telopEdited: false,
    cutMarks: scene.cutMarks.filter((mark) => mark > ms),
    emotionTag: detectEmotionTag(secondTelopText),
    styleOverrideId: scene.styleOverrideId,
  };

  return [...scenes.slice(0, sceneIndex), firstScene, secondScene, ...scenes.slice(sceneIndex + 1)];
}

/** 右クリック「ここに切り込み」: シーンのcutMarksに位置(ms)を追加する(重複・範囲外は無視、昇順で保持)。 */
export function addCutMark(scenes: Scene[], sceneId: string, ms: number): Scene[] {
  return scenes.map((scene) => {
    if (scene.id !== sceneId) return scene;
    if (ms <= scene.sourceStartMs || ms >= scene.sourceEndMs) return scene;
    if (scene.cutMarks.includes(ms)) return scene;
    return { ...scene, cutMarks: [...scene.cutMarks, ms].sort((a, b) => a - b) };
  });
}

/** 現在シーンを次のシーンと結合する(⌘M相当。Phase 2でキー操作から呼ばれる想定)。 */
export function mergeSceneWithNext(scenes: Scene[], sceneId: string): Scene[] {
  const sceneIndex = scenes.findIndex((scene) => scene.id === sceneId);
  if (sceneIndex === -1 || sceneIndex >= scenes.length - 1) return scenes;
  const first = scenes[sceneIndex];
  const second = scenes[sceneIndex + 1];
  const words = [...first.words, ...second.words];
  const telopEdited = first.telopEdited || second.telopEdited;
  const telopText = telopEdited
    ? `${first.telopEdited ? first.telopText : autoTelopTextFromWords(first.words)}${
        second.telopEdited ? second.telopText : autoTelopTextFromWords(second.words)
      }`
    : autoTelopTextFromWords(words);
  const merged: Scene = {
    id: `${first.id}_${second.id}`,
    sourceStartMs: first.sourceStartMs,
    sourceEndMs: second.sourceEndMs,
    words,
    telopText,
    telopEdited,
    cutMarks: [...first.cutMarks, ...second.cutMarks],
    // 結合後の本文で感情タグ(T-2)を再判定する。個別スタイルオーバーライド(T-3)は
    // 前半シーンのものを優先し、前半になければ後半のものを引き継ぐ。
    emotionTag: detectEmotionTag(telopText),
    styleOverrideId: first.styleOverrideId ?? second.styleOverrideId ?? null,
  };
  return [...scenes.slice(0, sceneIndex), merged, ...scenes.slice(sceneIndex + 2)];
}

/** 指定ms時点に該当するシーンのindexを返す(該当なしは-1)。 */
export function findSceneIndexAtMs(scenes: Scene[], ms: number): number {
  for (let index = 0; index < scenes.length; index += 1) {
    const scene = scenes[index];
    if (ms >= scene.sourceStartMs && ms < scene.sourceEndMs) return index;
  }
  return -1;
}

/**
 * 疑義キュー(suspicionQueue.tsの出力)をシーンに紐づける。
 * wordIdsが該当シーンの単語と一致すればそのシーンに、一致しなければtimestampMsが
 * 収まるシーンにフォールバックで紐づける。
 */
export function attachSuspicionsToScenes(
  scenes: Scene[],
  suspicionItems: SuspicionItem[],
): Map<string, SuspicionItem[]> {
  const sceneIdByWordId = new Map<string, string>();
  for (const scene of scenes) {
    for (const word of scene.words) sceneIdByWordId.set(word.id, scene.id);
  }

  const result = new Map<string, SuspicionItem[]>();
  for (const item of suspicionItems) {
    let sceneId: string | undefined;
    for (const wordId of item.wordIds) {
      sceneId = sceneIdByWordId.get(wordId);
      if (sceneId) break;
    }
    if (!sceneId) {
      const index = findSceneIndexAtMs(scenes, item.timestampMs);
      sceneId = index >= 0 ? scenes[index].id : undefined;
    }
    if (!sceneId) continue;
    const list = result.get(sceneId);
    if (list) list.push(item);
    else result.set(sceneId, [item]);
  }
  return result;
}

const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** 疑義リストの中から最も重要度が高いものを返す(左ボーダー色の決定に使う)。 */
export function highestSeveritySuspicion(items: SuspicionItem[] | undefined): SuspicionItem | null {
  if (!items || !items.length) return null;
  return [...items].sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9))[0];
}
