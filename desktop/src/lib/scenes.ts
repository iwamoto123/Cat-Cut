// 実行時(値)importのため、node --experimental-strip-types でテストを直接実行できるよう拡張子を明示する。
import type { KeepSegment } from "./keepSegments.ts";
import type { SuspicionItem } from "./suspicionQueue.ts";
import { detectEmotionTag, type EmotionTag } from "./emotionTag.ts";
import { type TelopThemeId, resolveEffectiveStyleId } from "./telopThemes.ts";
import { normalizeTelopDisplayText } from "./telopTextNormalize.ts";
import { isTrivialUtteranceText } from "./trivialUtterance.ts";
import type { VideoEffectOverride } from "./videoEffectCatalog.ts";
import { highlightMaskFromWords, highlightWordsFromMask, rebaseHighlightWords } from "./telopHighlightEdit.ts";
import { normalizeTelopPosition, type TelopPosition } from "./telopPosition.ts";

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
  /**
   * W16-1(無音チップ): 単語間ギャップから生成された無音区間word。textは常に空文字
   * (テロップ・書き出しテキストへ一切影響させない)。チップUIでは `[...]` ラベルで表示し、
   * 削除すればその区間が書き出しからカットされる(computeSceneKeptSubRangesの既存規則)。
   * 省略可能(silence無しの既存run/ドラフトは完全に従来動作)。
   */
  silence?: boolean;
};

export type Scene = {
  id: string;
  /** 手動指定のテロップ中心位置。未指定は顔回避/スタイルの既定位置。 */
  telopPosition?: TelopPosition;
  /** 元動画上のIN点(ms)。 */
  sourceStartMs: number;
  /** 元動画上のOUT点(ms)。 */
  sourceEndMs: number;
  /**
   * 編集後に残す元動画区間。指定時は映像・音声の唯一のタイミング源とし、単語の再配置や
   * テロップ結合から再計算しない。[] は全域カット。未指定の旧ドラフトは単語から導出する。
   * 結合/分割は現状の区間を維持し、端を広げる明示操作だけが新しい区間を追加できる。
   */
  sourceKeepRanges?: Array<{ startMs: number; endMs: number }>;
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
  /**
   * フェーズT2(directedモード): 演出ディレクティブのスタイルID(fact_yellow等、
   * directedTelop.ts の DIRECTED_STYLE_OPTIONS のいずれか)。
   * フェーズT2.5-4以降は「個別プリセット上書き」の意味になり、null/undefined なら
   * directedType × type→presetマッピングでスタイルを解決する。T2の旧run(type無し)では
   * ディレクティブのstyleスナップショットがそのままここに入る(後方互換)。
   */
  directedStyleId?: string | null;
  /**
   * フェーズT2.5-4(directedモード): シーンの意味種類(semantic type。telopTypes.ts の
   * SEMANTIC_TYPES のいずれか)。directedモードのスタイルバッジはこの日本語名を主表示にし、
   * type→presetマッピング(ユーザー設定)でプリセットを解決する。
   * 旧run(type無し)・fullモードでは未使用(undefined)。
   */
  directedType?: string | null;
  /** フェーズT2(directedモード): 演出ディレクティブの部分強調語(テロップ文言内の部分文字列)。 */
  directedHighlightWords?: string[];
  /**
   * フェーズT3(directedモード): 登場アニメの個別上書き(シーン行のアニメーションピッカー)。
   * null/undefined なら上書きなし(type→マッピング → プリセット既定で解決される)。
   */
  directedAnimationIn?: string | null;
  /** シーン映像演出の手動指定。undefined/null=自動、none=明示的になし。 */
  videoEffectOverride?: VideoEffectOverride | null;
  /**
   * フェーズW1(directedモード): スロットの話者ID("speaker_0"等。diarize由来の
   * dominant speaker)。話者カラー発動時のスタイル解決に使う。旧run・fullモードでは未指定。
   */
  speaker?: string;
  /** 素材再生速度。1=等速。書き出し・タイムライン尺に効く。未指定は1。 */
  speed?: number;
};

export const SCENE_SPEEDS = [1, 1.25, 1.5, 2] as const;
export type SceneSpeed = (typeof SCENE_SPEEDS)[number];

export function normalizeSceneSpeed(speed: unknown): SceneSpeed {
  const value = Number(speed);
  return SCENE_SPEEDS.includes(value as SceneSpeed) ? (value as SceneSpeed) : 1;
}

export type SourceWord = {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  sentenceId?: string;
  /** フェーズW1: diarize時の話者ID。旧runでは undefined。 */
  speaker?: string;
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
  telopPosition?: TelopPosition;
  /** 改善10-B-3: パイプライン適用済みのページ本文(句読点ルール済み)。未指定時はwords連結+正規化。 */
  text?: string;
  /** フェーズT2(directedモード): ディレクティブのスタイルID(fact_yellow等)。fullモードでは未指定。 */
  styleId?: string;
  /** フェーズT2.5-4(directedモード): シーンの意味種類(semantic type)。旧run・fullモードでは未指定。 */
  typeId?: string;
  /** フェーズT2.5-4(directedモード): styleId が個別上書き(type→presetマッピングより優先)かどうか。 */
  styleOverridden?: boolean;
  /**
   * フェーズT3(directedモード): 登場アニメの個別上書き(UIピッカー由来のもののみ。
   * マッピング・プリセット既定由来の解決結果は含まれない)。
   */
  animationIn?: string;
  videoEffectOverride?: VideoEffectOverride;
  /** フェーズT2(directedモード): ディレクティブの部分強調語。 */
  highlightWords?: string[];
  /** フェーズW1(directedモード): スロットの話者ID。旧runでは未指定。 */
  speaker?: string;
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

/** W16-1(無音チップ): この長さ以上の単語間ギャップを無音チップとして挿入する(ms)。 */
export const SILENCE_CHIP_MIN_MS = 500;

/**
 * W16-1(無音チップ): 隣接する単語間のギャップが minGapMs 以上なら、そのギャップ区間を
 * 無音word(text空文字・silence: true)として挿入する。シーン先頭/末尾の無音は既存の
 * 端トリムで扱えるため対象外。idは前の単語のidから決定的に導出する(単語idはrun内で
 * 一意なため、無音idも一意になる)。
 */
export function insertSilenceChipWords(words: SceneWord[], minGapMs: number = SILENCE_CHIP_MIN_MS): SceneWord[] {
  if (words.length < 2) return words;
  const result: SceneWord[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    result.push(word);
    const next = words[index + 1];
    if (!next) continue;
    const gapMs = next.startMs - word.endMs;
    if (gapMs >= minGapMs) {
      result.push({
        id: `sil_${word.id}`,
        text: "",
        startMs: word.endMs,
        endMs: next.startMs,
        deleted: false,
        silence: true,
      });
    }
  }
  return result;
}

function buildScene(
  words: SourceWord[],
  sourceStartMs: number,
  sourceEndMs: number,
  telopTextOverride?: string,
  directedFields?: {
    telopPosition?: TelopPosition;
    styleId?: string;
    typeId?: string;
    styleOverridden?: boolean;
    animationIn?: string;
    videoEffectOverride?: VideoEffectOverride;
    highlightWords?: string[];
    speaker?: string;
  },
): Scene {
  // W16-1: 単語間の長い無音をチップとして挿入する(テキストは空=テロップへ影響しない)。
  const sceneWords: SceneWord[] = insertSilenceChipWords(
    words.map((word) => ({
      id: word.id,
      text: word.text,
      startMs: word.startMs,
      endMs: word.endMs,
      deleted: false,
    })),
  );
  const rawTelopText = telopTextOverride ?? autoTelopTextFromWords(sceneWords);
  // W10-7(相槌・極短シーンのテロップ空欄化): 「うん」「はい」「あのー」等の相槌・フィラーだけの
  // シーンは、初期テロップを空欄にする(words・再生区間はそのまま=映像は残りテロップだけ非表示)。
  // ユーザーがtextareaへ入力すればtelopEdited=true経路で表示される。
  const telopText = isTrivialUtteranceText(rawTelopText) ? "" : rawTelopText;
  const scene: Scene = {
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
  const position = normalizeTelopPosition(directedFields?.telopPosition);
  if (position) scene.telopPosition = position;
  // フェーズT2(directedモード): ページ境界がディレクティブ由来の場合のみ付与する
  // (fullモードのSceneには余計なフィールドを増やさない)。
  // フェーズT2.5-4: typeがあるシーンのスタイルは type×マッピング で解決するため、
  // directedStyleId は「個別上書き」または「type無しの旧run(スナップショットが正)」の
  // 場合のみ設定する。
  if (directedFields?.styleId || directedFields?.typeId) {
    if (directedFields.typeId) scene.directedType = directedFields.typeId;
    if (directedFields.styleId && (directedFields.styleOverridden || !directedFields.typeId)) {
      scene.directedStyleId = directedFields.styleId;
    }
    // フェーズT3: アニメの個別上書き(animation_overridden由来)はシーンに復元する
    if (directedFields.animationIn) scene.directedAnimationIn = directedFields.animationIn;
    if (directedFields.videoEffectOverride) scene.videoEffectOverride = directedFields.videoEffectOverride;
    scene.directedHighlightWords = directedFields.highlightWords ?? [];
    // フェーズW1: スロットの話者ID(話者カラー発動時のスタイル解決に使う)
    if (directedFields.speaker) scene.speaker = directedFields.speaker;
  }
  return scene;
}

/** 発話のないkeep範囲も映像として保持し、削除・分割できる無音チップにする。 */
function buildSilenceScene(startMs: number, endMs: number): Scene {
  const scene = buildScene([], startMs, endMs);
  scene.words = [{
    id: `sil_${scene.id}`, text: "", startMs, endMs, deleted: false, silence: true,
  }];
  return scene;
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
    if (!segmentWords.length) {
      scenes.push(buildSilenceScene(segment.startMs, segment.endMs));
      continue;
    }

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
      const directedFields =
        page.styleId || page.typeId || page.videoEffectOverride || page.telopPosition
          ? {
              telopPosition: page.telopPosition,
              styleId: page.styleId,
              typeId: page.typeId,
              styleOverridden: page.styleOverridden,
              animationIn: page.animationIn,
              videoEffectOverride: page.videoEffectOverride,
              highlightWords: page.highlightWords,
              speaker: page.speaker,
            }
          : undefined;
      if (endMs <= startMs) return;
      scenes.push(sceneWords.length
        ? buildScene(sceneWords, startMs, endMs, pageText, directedFields)
        : buildSilenceScene(startMs, endMs));
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
  const sortedSegments = input.keepSegments
    .filter((segment) => Number.isFinite(segment.startMs) && Number.isFinite(segment.endMs) && segment.endMs > segment.startMs)
    .sort((a, b) => a.startMs - b.startMs);
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
    if (!segmentWords.length) {
      scenes.push(buildSilenceScene(segment.startMs, segment.endMs));
      continue;
    }
    scenes.push(...heuristicScenesForSegment(segmentWords, segment.startMs, segment.endMs));
  }
  return scenes;
}

/** シーン内で削除された単語区間を [sourceStartMs, sourceEndMs] から取り除いた残存区間(複数になり得る)。
 *
 * V8追補(リップル削除の無音断片対策): 削除は「連続して削除された単語のラン」単位で
 * [先頭単語のstart, 末尾単語のend] のスパンとして扱う(単語間のポーズも一緒に消す)。
 * さらにランがシーン先頭/末尾の単語を含む場合はシーン境界まで拡張する。これをしないと、
 * シーン丸ごと削除(全単語deleted)でも単語間ポーズ・シーン端の余白が数百msの無音断片として
 * keep_segmentsに残り、タイムラインのスキマ・再生/書き出しの無音区間になる。 */
export function computeSceneKeptSubRanges(scene: Scene): Array<{ startMs: number; endMs: number }> {
  const explicit = normalizeSceneSourceKeepRanges(scene.sourceKeepRanges, scene.sourceStartMs, scene.sourceEndMs);
  return explicit ?? computeLegacySceneKeptSubRanges(scene);
}

/** A transcript restore cannot restore this completely removed word; Undo/edge stretch can. */
export function isSceneWordCutLocked(scene: Scene, word: SceneWord): boolean {
  return Array.isArray(scene.sourceKeepRanges) && word.deleted &&
    !computeSceneKeptSubRanges(scene).some((range) => range.startMs < word.endMs && range.endMs > word.startMs);
}

/** 保存データと編集プリミティブ共通の正規化。未指定/未知の形式は旧形式へフォールバック。 */
export function normalizeSceneSourceKeepRanges(
  value: unknown,
  sourceStartMs: number,
  sourceEndMs: number,
): Array<{ startMs: number; endMs: number }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const ranges = value.flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const { startMs, endMs } = item as { startMs?: unknown; endMs?: unknown };
    if (typeof startMs !== "number" || typeof endMs !== "number" || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
    const start = Math.max(sourceStartMs, startMs);
    const end = Math.min(sourceEndMs, endMs);
    return end > start ? [{ startMs: start, endMs: end }] : [];
  }).sort((a, b) => a.startMs - b.startMs);
  const merged: Array<{ startMs: number; endMs: number }> = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.startMs <= previous.endMs) previous.endMs = Math.max(previous.endMs, range.endMs);
    else merged.push({ ...range });
  }
  return merged;
}

/** Sorted, disjoint source intervals. Used by cut and word deletion without quantizing time. */
export function subtractSourceRanges(
  ranges: Array<{ startMs: number; endMs: number }>,
  removed: Array<{ startMs: number; endMs: number }>,
): Array<{ startMs: number; endMs: number }> {
  const result: Array<{ startMs: number; endMs: number }> = [];
  let removedIndex = 0;
  for (const range of ranges) {
    let cursor = range.startMs;
    while (removedIndex < removed.length && removed[removedIndex].endMs <= cursor) removedIndex += 1;
    for (let index = removedIndex; index < removed.length && removed[index].startMs < range.endMs; index += 1) {
      const cut = removed[index];
      if (cut.startMs > cursor) result.push({ startMs: cursor, endMs: Math.min(cut.startMs, range.endMs) });
      cursor = Math.max(cursor, cut.endMs);
      if (cursor >= range.endMs) break;
    }
    if (cursor < range.endMs) result.push({ startMs: cursor, endMs: range.endMs });
  }
  return result;
}

function computeLegacySceneKeptSubRanges(scene: Scene): Array<{ startMs: number; endMs: number }> {
  // 単語配列の並び順(=チップ表示順・時系列)で、連続する削除単語をランへまとめる
  const deletedRanges: Array<{ startMs: number; endMs: number }> = [];
  let runStartIndex = -1;
  for (let index = 0; index <= scene.words.length; index += 1) {
    const isDeleted = index < scene.words.length && scene.words[index].deleted;
    if (isDeleted && runStartIndex === -1) runStartIndex = index;
    if (!isDeleted && runStartIndex !== -1) {
      const firstWord = scene.words[runStartIndex];
      const lastWord = scene.words[index - 1];
      const startMs =
        runStartIndex === 0 ? scene.sourceStartMs : Math.max(scene.sourceStartMs, firstWord.startMs);
      const endMs =
        index === scene.words.length ? scene.sourceEndMs : Math.min(scene.sourceEndMs, lastWord.endMs);
      if (endMs > startMs) deletedRanges.push({ startMs, endMs });
      runStartIndex = -1;
    }
  }
  deletedRanges.sort((a, b) => a.startMs - b.startMs);

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

type ScenePiece = { startMs: number; endMs: number; sceneIndex: number; speed: SceneSpeed };

function collectScenePieces(scenes: Scene[]): ScenePiece[] {
  const pieces: ScenePiece[] = [];
  scenes.forEach((scene, sceneIndex) => {
    for (const range of computeSceneKeptSubRanges(scene)) {
      pieces.push({ ...range, sceneIndex, speed: normalizeSceneSpeed(scene.speed) });
    }
  });
  return pieces.sort((a, b) => a.startMs - b.startMs);
}

type MergedSceneGroup = { startMs: number; endMs: number; sceneIndices: number[]; speed: SceneSpeed };

/** 連続/重複する区間ピースを合併し、各グループに寄与したシーンのindex(出現順・重複なし)を記録する。 */
function groupScenePieces(pieces: ScenePiece[]): MergedSceneGroup[] {
  const groups: MergedSceneGroup[] = [];
  for (const piece of pieces) {
    const last = groups[groups.length - 1];
    if (last && piece.startMs <= last.endMs && piece.speed === last.speed) {
      last.endMs = Math.max(last.endMs, piece.endMs);
      if (last.sceneIndices[last.sceneIndices.length - 1] !== piece.sceneIndex) {
        last.sceneIndices.push(piece.sceneIndex);
      }
    } else {
      groups.push({
        startMs: piece.startMs,
        endMs: piece.endMs,
        sceneIndices: [piece.sceneIndex],
        speed: piece.speed,
      });
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
    ...(group.speed === 1 ? {} : { speed: group.speed }),
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

/** One commit updates one or all scenes; absent/invalid positions restore automatic placement. */
export function setSceneTelopPosition(scenes: Scene[], sceneId: string | null, position: TelopPosition | null): Scene[] {
  const normalized = normalizeTelopPosition(position);
  let changed = false;
  const updated = scenes.map((scene) => {
    if (sceneId !== null && scene.id !== sceneId) return scene;
    const current = normalizeTelopPosition(scene.telopPosition);
    if (current?.x === normalized?.x && current?.y === normalized?.y) return scene;
    changed = true;
    const { telopPosition: _position, ...rest } = scene;
    return normalized ? { ...rest, telopPosition: normalized } : rest;
  });
  return changed ? updated : scenes;
}

/**
 * フェーズT2(directedモード): スタイルバッジからdirectedスタイルIDを個別上書きする
 * (T2.5-4以降は「type→presetマッピングより優先される個別上書き」の意味。null=上書き解除)。
 */
export function setSceneDirectedStyle(scenes: Scene[], sceneId: string, styleId: string | null): Scene[] {
  return scenes.map((scene) => (scene.id === sceneId ? { ...scene, directedStyleId: styleId } : scene));
}

/**
 * フェーズT2.5-4(directedモード): typeバッジからシーンの意味種類を変更する。
 * type変更はスタイルをマッピング解決へ戻す意図なので、個別上書き(directedStyleId)は解除する。
 */
export function setSceneDirectedType(scenes: Scene[], sceneId: string, typeId: string): Scene[] {
  return scenes.map((scene) =>
    scene.id === sceneId ? { ...scene, directedType: typeId, directedStyleId: null } : scene,
  );
}

/**
 * フェーズT3(directedモード): シーン行のアニメーションピッカーから登場アニメを個別上書きする
 * (null=上書き解除。type→マッピング → プリセット既定の解決へ戻す)。
 */
export function setSceneDirectedAnimation(scenes: Scene[], sceneId: string, animationId: string | null): Scene[] {
  return scenes.map((scene) =>
    scene.id === sceneId ? { ...scene, directedAnimationIn: animationId } : scene,
  );
}

/** シーン映像演出の手動指定(null=自動選定へ戻す)。 */
export function setSceneVideoEffectOverride(
  scenes: Scene[],
  sceneId: string,
  override: VideoEffectOverride | null,
): Scene[] {
  return scenes.map((scene) =>
    scene.id === sceneId ? { ...scene, videoEffectOverride: override } : scene,
  );
}

/** タイムラインからの素材速度変更。無効値は等速へ丸める。 */
export function setSceneSpeed(scenes: Scene[], sceneId: string, speed: number): Scene[] {
  const normalized = normalizeSceneSpeed(speed);
  return scenes.map((scene) => {
    if (scene.id !== sceneId || normalizeSceneSpeed(scene.speed) === normalized) return scene;
    return { ...scene, speed: normalized };
  });
}

/** 全シーンを同じ素材速度へ変更する。1呼び出し=1 Undo。 */
export function setAllSceneSpeeds(scenes: Scene[], speed: number): Scene[] {
  const normalized = normalizeSceneSpeed(speed);
  if (scenes.every((scene) => normalizeSceneSpeed(scene.speed) === normalized)) return scenes;
  return scenes.map((scene) => ({ ...scene, speed: normalized }));
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
  return setChipsDeleted(scenes, sceneId, [wordId], deleted);
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
  const next = scenes.map((scene) => {
    if (scene.id !== sceneId) return scene;
    const explicit = normalizeSceneSourceKeepRanges(scene.sourceKeepRanges, scene.sourceStartMs, scene.sourceEndMs);
    let changed = false;
    const words = scene.words.map((word) => {
      if (!wordIdSet.has(word.id) || (word.deleted === deleted && !word.autoTrimmed)) return word;
      // A transcript restore cannot bring a waveform cut back. Keep its chip visibly deleted
      // unless some audio belonging to that word still remains in the established media range.
      if (!deleted && explicit && !explicit.some((range) => range.startMs < word.endMs && range.endMs > word.startMs)) return word;
      changed = true;
      return { ...word, deleted, autoTrimmed: false };
    });
    const deleteAll = deleted && scene.words.length > 0 && scene.words.every((word) => wordIdSet.has(word.id));
    if (!changed && !(deleteAll && explicit?.length)) return scene;
    const telopText = scene.telopEdited ? scene.telopText : autoTelopTextFromWords(words);
    // Established cuts are independent of transcript restoration. Only newly deleted timing is
    // subtracted; concatenated historical deleted-word runs must not trim additional video.
    const newlyDeleted = deleted && explicit
      ? subtractSourceRanges(computeLegacySceneKeptSubRanges(scene), computeLegacySceneKeptSubRanges({ ...scene, words }))
      : [];
    const sourceKeepRanges = explicit
      ? (deleteAll ? [] : subtractSourceRanges(explicit, newlyDeleted))
      : undefined;
    return { ...scene, words, telopText, ...(explicit ? { sourceKeepRanges } : {}) };
  });
  return next.some((scene, index) => scene !== scenes[index]) ? next : scenes;
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
    const directedHighlightWords = rebaseHighlightWords(scene.telopText, text, scene.directedHighlightWords);
    return {
      ...scene,
      telopText: text,
      telopEdited: text !== autoText,
      directedHighlightWords: directedHighlightWords.length ? directedHighlightWords : undefined,
    };
  });
}

/** テロップの黄色部分(highlight_words)をシーン単位で上書きする。 */
export function setSceneDirectedHighlightWords(
  scenes: Scene[],
  sceneId: string,
  words: string[] | undefined,
): Scene[] {
  return scenes.map((scene) => {
    if (scene.id !== sceneId) return scene;
    const directedHighlightWords = highlightWordsFromMask(
      scene.telopText, highlightMaskFromWords(scene.telopText, words),
    );
    return {
      ...scene,
      directedHighlightWords: directedHighlightWords.length ? directedHighlightWords : undefined,
    };
  });
}


export {
  countTelopOccurrencesInOtherScenes,
  findTelopOccurrencesInOtherScenes,
  replaceTelopOccurrences,
  type TelopOccurrence,
  type TelopOccurrenceTarget,
} from "./telopOccurrences.ts";

// --- W10-4(分割時のテロップ文言分配) ---

/** splitEditedTelopTextの正規化で無視する文字(空白・改行と、自動テキストが除去する句点)。 */
const SPLIT_NORMALIZE_IGNORE_RE = /[\s。]/u;

/** deleted以外の単語テキストを連結し、正規化(空白・改行・句点除去)した文字列を返す。 */
function normalizedVisibleWordsText(words: SceneWord[]): string {
  return words
    .filter((word) => !word.deleted)
    .map((word) => word.text)
    .join("")
    .split("")
    .filter((ch) => !SPLIT_NORMALIZE_IGNORE_RE.test(ch))
    .join("");
}

/**
 * W10-4: 編集済みtelopTextをシーン分割の前後半へ分配する純関数。
 *
 * 1. 一致探索: 後半words(非deleted)の先頭からの連結文字列(正規化: 空白・改行・句点除去)の
 *    できるだけ長い接頭辞をeditedText(同正規化)の中から探索し、見つかればその最後の出現位置で
 *    分割する(先頭語1語だけの一致でも採用)。ユーザーが前半・後半の一方だけを短縮・修正した
 *    ケースで、編集済み文言を正しい側に残せる。
 * 2. フォールバック(W10-12): 一致しなければ前半words正規化長の比率でeditedTextを切り、
 *    後半に残りを全て割当する(省略編集で片側が空になる分配も許容)。
 * 3. どちらの半分にも編集済み全文を丸ごと複製しない(上下同一表示の根絶)。片側が空になる分配は
 *    そのまま許容する(テロップなし)。
 */
export function splitEditedTelopText(
  editedText: string,
  firstWords: SceneWord[],
  secondWords: SceneWord[],
): { first: string; second: string } {
  const chars = [...editedText];
  // 正規化後インデックス→元テキストインデックスの対応表(改行・空白をまたがない分割位置の復元に使う)。
  const normChars: string[] = [];
  const normToOriginal: number[] = [];
  chars.forEach((ch, index) => {
    if (SPLIT_NORMALIZE_IGNORE_RE.test(ch)) return;
    normChars.push(ch);
    normToOriginal.push(index);
  });
  const normText = normChars.join("");
  if (!normText.length) return { first: "", second: "" };

  const originalIndexForNormPos = (normPos: number): number =>
    normPos >= normToOriginal.length ? chars.length : normToOriginal[normPos];

  const buildResult = (splitOriginalIndex: number): { first: string; second: string } => {
    const clamped = Math.max(0, Math.min(chars.length, splitOriginalIndex));
    // 分割点の前後に残った空白・改行は境界をまたがせず取り除く(前半末尾・後半先頭)。
    const first = chars.slice(0, clamped).join("").replace(/\s+$/u, "");
    const second = chars.slice(clamped).join("").replace(/^\s+/u, "");
    return { first, second };
  };

  // 1. 一致探索: 後半words連結の「できるだけ長い接頭辞」(単語境界単位)を後方から探す。
  const visibleSecondTexts = secondWords.filter((word) => !word.deleted).map((word) => word.text);
  for (let count = visibleSecondTexts.length; count >= 1; count -= 1) {
    const prefix = visibleSecondTexts
      .slice(0, count)
      .join("")
      .split("")
      .filter((ch) => !SPLIT_NORMALIZE_IGNORE_RE.test(ch))
      .join("");
    if (!prefix) continue;
    const foundNormPos = normText.lastIndexOf(prefix);
    if (foundNormPos === -1) continue;
    return buildResult(originalIndexForNormPos(foundNormPos));
  }

  // 2. フォールバック(W10-12): 前半words正規化長の比率でeditedTextを切り、後半に残りを全て割当。
  const firstLen = normalizedVisibleWordsText(firstWords).length;
  const secondLen = normalizedVisibleWordsText(secondWords).length;
  const totalLen = firstLen + secondLen;
  const ratio = totalLen > 0 ? firstLen / totalLen : 0.5;
  const targetNormPos = Math.round(ratio * normChars.length);
  return buildResult(originalIndexForNormPos(targetNormPos));
}

/**
 * チップ境界でシーンを分割する。secondFirstWordId が後半シーンの先頭単語になる。
 * 分割点(ms)は前半シーンの最後の単語の終了時刻と後半シーンの先頭単語の開始時刻の中点。
 * telopTextの扱い: 未編集なら前後ともチップ連結で再生成。編集済みならW10-4の
 * splitEditedTelopText()で編集済みテキストを前後半へ分配する(両半分ともtelopEdited=trueを維持。
 * 旧実装の「前半に全文コピー+後半は自動再生成」は上下同一表示・短縮テキスト巻き戻りの原因のため廃止)。
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
  if (!Number.isFinite(boundaryMs) || boundaryMs <= scene.sourceStartMs || boundaryMs >= scene.sourceEndMs) return scenes;

  const editedParts = scene.telopEdited ? splitEditedTelopText(scene.telopText, firstWords, secondWords) : null;
  const firstTelopText = editedParts ? editedParts.first : autoTelopTextFromWords(firstWords);
  const secondTelopText = editedParts ? editedParts.second : autoTelopTextFromWords(secondWords);
  const firstScene: Scene = {
    id: `${scene.id}L`,
    sourceStartMs: scene.sourceStartMs,
    sourceEndMs: boundaryMs,
    sourceKeepRanges: normalizeSceneSourceKeepRanges(computeSceneKeptSubRanges(scene), scene.sourceStartMs, boundaryMs),
    words: firstWords,
    telopText: firstTelopText,
    telopEdited: scene.telopEdited,
    cutMarks: scene.cutMarks.filter((mark) => mark < boundaryMs),
    // 感情タグ(T-2)は分割後の本文に対して再判定する。個別スタイルオーバーライド(T-3)・
    // directedスタイル(T2)・アニメ上書き(T3)・話者(W1)は「分割」という構造操作ではユーザーの意図を
    // 推測できないため両半分にそのまま引き継ぐ(directedの強調語は本文に残っている側でのみ有効になる)。
    emotionTag: detectEmotionTag(firstTelopText),
    styleOverrideId: scene.styleOverrideId,
    directedStyleId: scene.directedStyleId,
    directedType: scene.directedType,
    directedHighlightWords: scene.directedHighlightWords,
    directedAnimationIn: scene.directedAnimationIn,
    videoEffectOverride: scene.videoEffectOverride,
    telopPosition: scene.telopPosition,
    speaker: scene.speaker,
    speed: scene.speed,
  };
  const secondScene: Scene = {
    id: `${scene.id}R`,
    sourceStartMs: boundaryMs,
    sourceEndMs: scene.sourceEndMs,
    sourceKeepRanges: normalizeSceneSourceKeepRanges(computeSceneKeptSubRanges(scene), boundaryMs, scene.sourceEndMs),
    words: secondWords,
    telopText: secondTelopText,
    // W10-4: 編集済みシーンの分割では後半もtelopEdited=trueを維持する(自動全文への巻き戻り防止)。
    telopEdited: scene.telopEdited,
    cutMarks: scene.cutMarks.filter((mark) => mark >= boundaryMs),
    emotionTag: detectEmotionTag(secondTelopText),
    styleOverrideId: scene.styleOverrideId,
    directedStyleId: scene.directedStyleId,
    directedType: scene.directedType,
    directedHighlightWords: scene.directedHighlightWords,
    directedAnimationIn: scene.directedAnimationIn,
    videoEffectOverride: scene.videoEffectOverride,
    telopPosition: scene.telopPosition,
    speaker: scene.speaker,
    speed: scene.speed,
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
export function splitSceneAtMs(
  scenes: Scene[],
  sceneId: string,
  ms: number,
  options: { allowEmptySpeechSide?: boolean } = {},
): Scene[] {
  const sceneIndex = scenes.findIndex((scene) => scene.id === sceneId);
  if (sceneIndex === -1) return scenes;
  const scene = scenes[sceneIndex];
  if (!Number.isFinite(ms) || ms <= scene.sourceStartMs || ms >= scene.sourceEndMs) return scenes;

  const firstWords: SceneWord[] = [];
  const secondWords: SceneWord[] = [];
  for (const word of scene.words) {
    // W28(2026-08-22 実機フィードバック): 分割点が無音チップの内部に落ちる場合は、チップを
    // 中点側へ丸ごと寄せず2つに割る(分割位置がズレない+両側が空にならない)。
    if (word.silence && word.startMs < ms && word.endMs > ms) {
      firstWords.push({ ...word, id: `${word.id}L`, endMs: ms });
      secondWords.push({ ...word, id: `${word.id}R`, startMs: ms });
      continue;
    }
    const midpointMs = (word.startMs + word.endMs) / 2;
    if (midpointMs < ms) firstWords.push(word);
    else secondWords.push(word);
  }
  // W28: シーン端の無音(ワードが存在しない区間)での分割は、空になる側へその区間を表す
  // 無音チップを生成して分割を成立させる(旧実装は「両側に単語必須」で分割不可だった)。
  // 分割点が音声ワードの内部に落ちて片側が空になるケースだけは従来どおり分割しない。
  if (!firstWords.length || !secondWords.length) {
    const insideSpeechWord = scene.words.some(
      (word) => !word.silence && word.startMs < ms && word.endMs > ms,
    );
    // 精密な映像分割/範囲カットでは、1語の途中でも映像と音声をmsどおり分割する。
    // 語は中点側だけへ渡し、空側は文言のないタイミングチップで尺を保持する。
    // 従来のチップ/切り込み経路は既定のガードを維持する。
    if (insideSpeechWord && !options.allowEmptySpeechSide) return scenes;
    if (!firstWords.length) {
      firstWords.push({
        id: `sil_edge_${scene.id}L`,
        text: "",
        startMs: scene.sourceStartMs,
        endMs: ms,
        deleted: false,
        silence: true,
      });
    }
    if (!secondWords.length) {
      secondWords.push({
        id: `sil_edge_${scene.id}R`,
        text: "",
        startMs: ms,
        endMs: scene.sourceEndMs,
        deleted: false,
        silence: true,
      });
    }
  }
  if (!firstWords.length || !secondWords.length) return scenes;

  // W10-4: splitSceneAtWordと同じくtelopEdited時は編集済みテキストを前後半へ分配する。
  const editedParts = scene.telopEdited ? splitEditedTelopText(scene.telopText, firstWords, secondWords) : null;
  const firstTelopText = editedParts ? editedParts.first : autoTelopTextFromWords(firstWords);
  const secondTelopText = editedParts ? editedParts.second : autoTelopTextFromWords(secondWords);
  const firstScene: Scene = {
    id: `${scene.id}L`,
    sourceStartMs: scene.sourceStartMs,
    sourceEndMs: ms,
    sourceKeepRanges: normalizeSceneSourceKeepRanges(computeSceneKeptSubRanges(scene), scene.sourceStartMs, ms),
    words: firstWords,
    telopText: firstTelopText,
    telopEdited: scene.telopEdited,
    cutMarks: scene.cutMarks.filter((mark) => mark < ms),
    emotionTag: detectEmotionTag(firstTelopText),
    styleOverrideId: scene.styleOverrideId,
    directedStyleId: scene.directedStyleId,
    directedType: scene.directedType,
    directedHighlightWords: scene.directedHighlightWords,
    directedAnimationIn: scene.directedAnimationIn,
    videoEffectOverride: scene.videoEffectOverride,
    telopPosition: scene.telopPosition,
    speaker: scene.speaker,
    speed: scene.speed,
  };
  const secondScene: Scene = {
    id: `${scene.id}R`,
    sourceStartMs: ms,
    sourceEndMs: scene.sourceEndMs,
    sourceKeepRanges: normalizeSceneSourceKeepRanges(computeSceneKeptSubRanges(scene), ms, scene.sourceEndMs),
    words: secondWords,
    telopText: secondTelopText,
    // W10-4: 編集済みシーンの分割では後半もtelopEdited=trueを維持する。
    telopEdited: scene.telopEdited,
    cutMarks: scene.cutMarks.filter((mark) => mark > ms),
    emotionTag: detectEmotionTag(secondTelopText),
    styleOverrideId: scene.styleOverrideId,
    directedStyleId: scene.directedStyleId,
    directedType: scene.directedType,
    directedHighlightWords: scene.directedHighlightWords,
    directedAnimationIn: scene.directedAnimationIn,
    videoEffectOverride: scene.videoEffectOverride,
    telopPosition: scene.telopPosition,
    speaker: scene.speaker,
    speed: scene.speed,
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

/**
 * W13-4: シーン結合時のテロップ連結。前シーンの表示テキスト+後シーンの表示テキストを
 * そのまま連結する(間に改行は入れない。境界の空白・改行だけ取り除く)。
 * splitEditedTelopText(W10-4のEnter分割)の逆操作として一貫させる。
 */
export function joinTelopTexts(firstText: string, secondText: string): string {
  const first = firstText.replace(/\s+$/u, "");
  const second = secondText.replace(/^\s+/u, "");
  if (!first) return second;
  if (!second) return first;
  return `${first}${second}`;
}

function nextAliveSceneIndex(scenes: Scene[], fromIndex: number): number {
  for (let index = fromIndex + 1; index < scenes.length; index += 1) {
    if (!isSceneFullyDeleted(scenes[index])) return index;
  }
  return -1;
}

function prevAliveSceneIndex(scenes: Scene[], fromIndex: number): number {
  for (let index = fromIndex - 1; index >= 0; index -= 1) {
    if (!isSceneFullyDeleted(scenes[index])) return index;
  }
  return -1;
}

/**
 * 現在シーンを次のシーンと結合する(⌘M相当。Phase 2でキー操作から呼ばれる想定)。
 * W28(2026-08-22 実機フィードバック):
 * - 直後に「丸ごと削除済み」シーンが挟まっていてもまたいで結合する(言い直しで間のブロックを
 *   消した後、前後のブロックをつなぐ操作)。削除済みシーンのwordsは削除状態のまま取り込む
 *   (チップから復元可能なまま残る)。テロップ本文には削除済みシーンのテキストを混ぜない。
 * - スタイル・アニメ・映像演出は「上(前半)のシーン」を全面的に優先する(前半が未設定なら
 *   未設定のまま=前半の見た目を維持する。旧実装の「前半になければ後半を引き継ぐ」は、
 *   エフェクト付きテロップを上とくっつけると下のエフェクトが残ってしまうため廃止)。
 * W29(2026-08-24 実機フィードバック):
 * - Bで2箇所切って間のテキストボックスを消した後、残った前後どちらから結合しても1つになる。
 *   再生ヘッドが削除済みの中間行に残っていても、手前の生きている行と次の生きている行をつなぐ。
 *   末尾の残存行から結合した場合は手前の生きている行とつなぐ。
 */
export function mergeSceneWithNext(scenes: Scene[], sceneId: string): Scene[] {
  let sceneIndex = scenes.findIndex((scene) => scene.id === sceneId);
  if (sceneIndex === -1) return scenes;
  if (isSceneFullyDeleted(scenes[sceneIndex])) {
    const previousAlive = prevAliveSceneIndex(scenes, sceneIndex);
    if (previousAlive >= 0) sceneIndex = previousAlive;
    else {
      const nextAlive = nextAliveSceneIndex(scenes, sceneIndex);
      if (nextAlive < 0) return scenes;
      sceneIndex = nextAlive;
    }
  }
  let lastIndex = nextAliveSceneIndex(scenes, sceneIndex);
  if (lastIndex === -1) {
    const previousAlive = prevAliveSceneIndex(scenes, sceneIndex);
    if (previousAlive < 0) return scenes;
    lastIndex = sceneIndex;
    sceneIndex = previousAlive;
  }
  const first = scenes[sceneIndex];
  const span = scenes.slice(sceneIndex, lastIndex + 1);
  const second = span[span.length - 1];
  const aliveSpan = span.filter((scene) => !isSceneFullyDeleted(scene));
  const words = span.flatMap((scene) => scene.words);
  // W13-4: 結合後のテロップは「いま表示されているテキスト同士の連結」にする。
  // 未編集シーンでも telopText はAI整形済みテキスト等で words 由来の自動生成と異なり得るため、
  // 旧実装(未編集は autoTelopTextFromWords で再生成)では表示が元テキストへ巻き戻っていた。
  const telopText = aliveSpan.reduce((acc, scene) => joinTelopTexts(acc, scene.telopText), "");
  // 連結結果が自動生成と一致するなら未編集のまま。異なる場合は編集済み扱いにして、
  // 以降の単語削除等で words から再生成されて巻き戻らないよう保護する
  const telopEdited = first.telopEdited || second.telopEdited || telopText !== autoTelopTextFromWords(words);
  const highlightSources = aliveSpan.filter((scene) => scene.directedHighlightWords);
  const merged: Scene = {
    id: `${first.id}_${second.id}`,
    sourceStartMs: first.sourceStartMs,
    sourceEndMs: second.sourceEndMs,
    sourceKeepRanges: normalizeSceneSourceKeepRanges(span.flatMap(computeSceneKeptSubRanges), first.sourceStartMs, second.sourceEndMs),
    words,
    telopText,
    telopEdited,
    cutMarks: span.flatMap((scene) => scene.cutMarks),
    // 結合後の本文で感情タグ(T-2)を再判定する。それ以外の見た目(スタイル・種類・アニメ・
    // 映像演出)は前半シーンの設定をそのまま使う(W28: 上のテロップの見た目を優先)。
    emotionTag: detectEmotionTag(telopText),
    styleOverrideId: first.styleOverrideId ?? null,
    directedStyleId: first.directedStyleId,
    directedType: first.directedType,
    directedAnimationIn: first.directedAnimationIn,
    videoEffectOverride: first.videoEffectOverride,
    telopPosition: first.telopPosition,
    speaker: first.speaker ?? second.speaker,
    speed: first.speed,
    directedHighlightWords: highlightSources.length
      ? [...new Set(highlightSources.flatMap((scene) => scene.directedHighlightWords || []))]
      : undefined,
  };
  return [...scenes.slice(0, sceneIndex), merged, ...scenes.slice(lastIndex + 1)];
}

/**
 * W10-1(シーン単位の削除・復元): シーンが「丸ごと削除済み」かどうか。
 * SceneRowListのスタブ行(「シーンN を削除しました」)への畳み込み判定と、
 * Delete連打時の連鎖選択(削除済みシーンをスキップ)に使う。明示区間がある場合は映像の
 * 残存状態を優先する。旧形式だけ全単語deletedで判定し、単語ゼロのシーンは対象外。
 */
export function isSceneFullyDeleted(scene: Scene): boolean {
  const explicit = normalizeSceneSourceKeepRanges(scene.sourceKeepRanges, scene.sourceStartMs, scene.sourceEndMs);
  if (explicit) return explicit.length === 0;
  return scene.words.length > 0 && scene.words.every((word) => word.deleted);
}

/**
 * W10-1(Delete連打で前のシーンへ連鎖): deletedIndexのシーンを丸ごと削除した直後に
 * 選択を移す先のシーンidを返す。直前の(上の)未削除シーンを優先し、先頭に達したら
 * 次の(下の)未削除シーンへ。どこにも無ければnull。scenesは削除前の配列でよい
 * (deletedIndex自身は候補から除外される)。
 */
export function findNextSelectionAfterSceneDelete(scenes: Scene[], deletedIndex: number): string | null {
  for (let index = deletedIndex - 1; index >= 0; index -= 1) {
    if (!isSceneFullyDeleted(scenes[index])) return scenes[index].id;
  }
  for (let index = deletedIndex + 1; index < scenes.length; index += 1) {
    if (!isSceneFullyDeleted(scenes[index])) return scenes[index].id;
  }
  return null;
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
 * 編集カーソル用。隣接境界は次の生存シーンを優先し、出力の最終終端だけ最後の生存
 * シーンへ解決する。再生・字幕表示用の半開区間判定はfindSceneIndexAtMsのまま保つ。
 * 削除された末尾シーンや区間の隙間へ、近いという理由だけで選択を移さない。
 */
export function findSceneIndexAtEditMs(scenes: Scene[], ms: number): number {
  if (!Number.isFinite(ms)) return -1;
  const index = findSceneIndexAtMs(scenes, ms);
  if (index >= 0 && !isSceneFullyDeleted(scenes[index])) return index;
  let finalEndMs = -Infinity;
  let finalIndex = -1;
  scenes.forEach((scene, sceneIndex) => {
    for (const range of computeSceneKeptSubRanges(scene)) {
      if (range.endMs > finalEndMs) {
        finalEndMs = range.endMs;
        finalIndex = sceneIndex;
      }
    }
  });
  return Math.abs(ms - finalEndMs) < 0.001 ? finalIndex : -1;
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
    // 改善21-B: ai_failure(AI校正未実行)は動画全体に関する項目で行アンカーを持たないため、
    // 先頭シーンに固定表示する(先頭シーンが0msから始まらないrunでも消えないように)。
    if (!sceneId && item.type === "ai_failure" && scenes.length) {
      sceneId = scenes[0].id;
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
