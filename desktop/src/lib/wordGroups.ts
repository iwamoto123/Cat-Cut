// 実行時(値)importのため、node --experimental-strip-types でテストを直接実行できるよう拡張子を明示する。
import type { Scene, SceneWord } from "./scenes.ts";

/**
 * シーン行UI(検品UI v2 改善1)の「単語グループチップ」を支える純関数群。
 * `2026-07-03_catcut-scene-row-ui-spec.md` の「改善1」節に準拠する。
 *
 * 内部データ(SceneWord、STT出力そのままの一文字単位)は一切変更せず、表示・操作の単位だけを
 * `Intl.Segmenter('ja', { granularity: 'word' })` による形態素的なまとまり(WordGroup)にする。
 * タイミング精度・疑義マッピング・切り込み分割は引き続き文字単位のwordで行える。
 */

export type WordGroup = {
  id: string;
  text: string;
  /** グループを構成する文字SceneWordのid列(シーン内での出現順)。 */
  wordIds: string[];
  /** 先頭文字wordのstartMs。 */
  startMs: number;
  /** 末尾文字wordのendMs。 */
  endMs: number;
  /** メンバー全員がdeletedのときtrue。 */
  deleted: boolean;
  /** メンバー全員がdeleted かつ autoTrimmed(端トリムによる自動削除)のときtrue。 */
  autoTrimmed: boolean;
};

const segmenter = new Intl.Segmenter("ja", { granularity: "word" });

/**
 * scene.words(文字単位)を実際にグループ化する純粋な計算本体。
 * 句読点・記号など非単語トークン(isWordLike=false)は直前の単語グループへ結合する
 * (例: 「です」+「。」→「です。」)。直前グループが無い場合(文頭の記号等)は単独のグループにする。
 *
 * 削除済み(deleted)の単語も含めて全文字wordを対象にグループ化する。これにより、チップの
 * 削除/復元を繰り返してもグループ境界が変化しない(常に元の文構造からグループを作る)。
 */
function computeWordGroups(scene: Scene): WordGroup[] {
  const words = scene.words;
  if (!words.length) return [];

  // 文字位置 -> 所属word indexの対応表を作る(1つのwordが複数文字を持つ場合にも対応できるよう汎用化)。
  let concatText = "";
  const charOwnerWordIndex: number[] = [];
  words.forEach((word, wordIndex) => {
    for (const _ch of word.text) {
      concatText += _ch;
      charOwnerWordIndex.push(wordIndex);
    }
  });

  const groups: WordGroup[] = [];
  let currentWordIndices: number[] = [];
  let groupCounter = 0;
  // wordを1度どこかのグループに割り当てたら二度と別のグループへ入れない(排他的な分割を保証する)。
  // 通常SceneWordは1文字単位のため発生しないが、万一複数文字のwordがセグメント境界をまたいでも
  // チップの重複所属(1つのwordが2つのグループに現れる)を防ぐ安全策。
  const consumedWordIndices = new Set<number>();

  function flushCurrentGroup() {
    if (!currentWordIndices.length) return;
    const memberWords: SceneWord[] = currentWordIndices.map((index) => words[index]);
    groups.push({
      id: `${scene.id}_g${groupCounter}`,
      text: memberWords.map((word) => word.text).join(""),
      wordIds: memberWords.map((word) => word.id),
      startMs: memberWords[0].startMs,
      endMs: memberWords[memberWords.length - 1].endMs,
      deleted: memberWords.every((word) => word.deleted),
      autoTrimmed: memberWords.every((word) => word.deleted && word.autoTrimmed === true),
    });
    groupCounter += 1;
    currentWordIndices = [];
  }

  if (!concatText.length) {
    // 全wordが空文字テキストの場合(通常は起きない)、word単位でグループを作るフォールバック。
    words.forEach((_word, wordIndex) => {
      currentWordIndices = [wordIndex];
      flushCurrentGroup();
    });
    return groups;
  }

  for (const segment of segmenter.segment(concatText)) {
    const startChar = segment.index;
    const endChar = segment.index + segment.segment.length;
    const memberWordIndices = new Set<number>();
    for (let charIndex = startChar; charIndex < endChar; charIndex += 1) {
      const ownerIndex = charOwnerWordIndex[charIndex];
      if (!consumedWordIndices.has(ownerIndex)) memberWordIndices.add(ownerIndex);
    }
    const sortedIndices = [...memberWordIndices].sort((a, b) => a - b);
    if (!sortedIndices.length) continue;
    for (const index of sortedIndices) consumedWordIndices.add(index);

    if (segment.isWordLike) {
      flushCurrentGroup();
      currentWordIndices = sortedIndices;
    } else if (currentWordIndices.length) {
      currentWordIndices.push(...sortedIndices);
    } else {
      currentWordIndices = sortedIndices;
      flushCurrentGroup();
    }
  }
  flushCurrentGroup();

  return groups;
}

/**
 * シーンごとにIntl.Segmenterの結果をメモ化するキャッシュ。
 * scenes配列は不変更新(immutable)されるため、内容が変わっていないSceneは同一の
 * オブジェクト参照を保ち続ける。WeakMapで参照をキーにすることで、レンダリング毎の
 * 再セグメント(重い処理ではないが、フォーカス毎に配列を作り直すとReactの再描画コストが増える)を避ける。
 */
const groupCache = new WeakMap<Scene, WordGroup[]>();

/** シーンの単語グループ一覧を返す(メモ化あり)。表示・操作(チップ列)はこの関数の結果を使う。 */
export function buildWordGroups(scene: Scene): WordGroup[] {
  const cached = groupCache.get(scene);
  if (cached) return cached;
  const computed = computeWordGroups(scene);
  groupCache.set(scene, computed);
  return computed;
}

/** テスト用: キャッシュを介さず常に再計算する(メモ化の副作用を受けたくない検証で使う)。 */
export function buildWordGroupsUncached(scene: Scene): WordGroup[] {
  return computeWordGroups(scene);
}

/**
 * グループ配列から、指定ms位置の「境界カーソル」の右隣にあたるグループindexを返す。
 * `findBoundaryWordIndex`(playhead.ts)のグループ版で、同じ「テキストカーソル」の考え方に従う。
 */
export function findBoundaryGroupIndex(groups: WordGroup[], ms: number): number {
  const index = groups.findIndex((group) => group.startMs >= ms);
  return index === -1 ? groups.length : index;
}

/** 指定した文字wordIdを含むグループを返す(見つからなければnull)。疑義ハイライトのグループ判定等に使う。 */
export function findGroupByWordId(groups: WordGroup[], wordId: string): WordGroup | null {
  return groups.find((group) => group.wordIds.includes(wordId)) || null;
}

/**
 * チップ列ホバー/クリックの境界判定(改善3): ホバー中のチップ内でのX位置(0..widthPx)が
 * 左半分か右半分かで、最寄りの境界インデックスを返す(左半分ならそのチップ自身の左境界=chipIndex、
 * 右半分なら右境界=chipIndex+1)。この「0..groups.length」のインデックスは、キーボード←→で移動する
 * 既存の`GroupCursor.groupIndex`(playhead.ts)と全く同じ意味を持つため、マウスホバーのキャレット表示と
 * キーボードカーソルを同一の描画・同一の操作系(Enter分割/Delete削除)に統一できる。
 *
 * 旧実装(改善1)の`nearestGroupBoundaryMs`+`msFromGroupHoverPosition`
 * (クリック時にそのグループの端へシーク/ホバー中はグループ内を時間軸で線形補間してシーク)は、
 * 改善3でチップ間キャレット方式に置き換えられたため廃止した。
 */
export function nearestGroupBoundaryIndex(chipIndex: number, offsetX: number, widthPx: number): number {
  const safeWidth = Math.max(1, widthPx);
  return offsetX < safeWidth / 2 ? chipIndex : chipIndex + 1;
}

/**
 * 境界インデックス(0..groups.length)からms値を求める(`nearestGroupBoundaryIndex`の逆変換)。
 * クリック確定時に再生バーを送る位置、およびキャレットの論理位置のms表現に使う。
 * `findAdjacentGroupBoundaryMs`(playhead.ts)が返す値と同じ規則(「右隣グループの先頭ms」を
 * 境界の代表値とする)に揃えてあるため、キーボード移動後の位置と矛盾しない。
 */
export function msFromGroupBoundaryIndex(groups: WordGroup[], groupIndex: number): number {
  if (!groups.length) return 0;
  if (groupIndex <= 0) return groups[0].startMs;
  if (groupIndex >= groups.length) return groups[groups.length - 1].endMs;
  return groups[groupIndex].startMs;
}

/**
 * 再生位置(ms)が属するチップ(グループ)のidを返す(改善3: 再生中チップハイライト用)。
 * 該当区間が無い場合(シーン外・カット間の隙間等)はnull。
 */
export function findActiveGroupId(groups: WordGroup[], ms: number): string | null {
  const found = groups.find((group) => ms >= group.startMs && ms < group.endMs);
  return found ? found.id : null;
}

/**
 * 改善5-2(チップのドラッグ複数選択): ドラッグ開始位置(anchorIndex)と現在位置(currentIndex)から
 * 「開始チップ〜現在チップの連続範囲」を正規化する(順序が前後どちらでも小さい方をstartにする)。
 */
export function normalizeChipDragRange(anchorIndex: number, currentIndex: number): { start: number; end: number } {
  return { start: Math.min(anchorIndex, currentIndex), end: Math.max(anchorIndex, currentIndex) };
}

/**
 * 改善5-2(チップのドラッグ複数選択): 連続するグループ範囲(start..end、両端含む)に属する
 * 全ての文字wordIdを出現順で返す(範囲は配列の境界にクランプする)。
 * `setChipsDeleted`/`toggleChipsDeleted`にそのまま渡せば「選択グループ全部を1回の操作で削除」
 * (1操作=Undo1回)が実現できる。
 */
export function wordIdsForGroupRange(groups: WordGroup[], startIndex: number, endIndex: number): string[] {
  if (!groups.length) return [];
  const lo = Math.max(0, Math.min(startIndex, endIndex));
  const hi = Math.min(groups.length - 1, Math.max(startIndex, endIndex));
  const result: string[] = [];
  for (let index = lo; index <= hi; index += 1) result.push(...groups[index].wordIds);
  return result;
}
