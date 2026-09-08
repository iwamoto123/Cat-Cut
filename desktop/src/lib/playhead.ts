// 実行時(値)importのため、node --experimental-strip-types でテストを直接実行できるよう拡張子を明示する。
import type { Scene, SceneWord } from "./scenes.ts";
import { findSceneIndexAtEditMs } from "./scenes.ts";
import { buildWordGroups, findBoundaryGroupIndex, type WordGroup } from "./wordGroups.ts";

/**
 * シーン行UI(検品UI v2 Phase 2)のキーボード操作体系を支える純関数群。
 * `2026-07-03_catcut-scene-row-ui-spec.md` の「キーボード操作体系」節に準拠する。
 *
 * 「再生バー」は現在の再生位置(ms)そのものであり、独立した状態を持たない
 * (previewCurrentMsを唯一の情報源とし、常にそこから対象チップを導出する)。
 * これにより「再生中は滑らかに移動・停止中も位置を保持・全体ナビバーと同期」が
 * 自然に成立する(App.tsx側で previewCurrentMs を直接描画・操作に使うだけでよい)。
 */

/** 右クリック「切り込み」の一致判定などに使う既定の許容誤差(ms)。 */
export const CUT_MARK_TOLERANCE_MS = 40;

export type ChipCursor = {
  sceneIndex: number;
  /**
   * 0..words.length。「カーソルの右隣にある単語」のindexで境界を表現する
   * (テキストエディタのカーソル位置と同じ考え方)。0なら行頭(左隣の単語が無い)。
   * words.length ならシーン末尾(右隣の単語が無い)。
   */
  wordIndex: number;
};

export type ChipTarget = {
  sceneId: string;
  wordId: string;
};

/**
 * シーン内の単語配列から、指定ms位置の「境界カーソル」の右隣にあたる単語indexを返す。
 * ms が単語の途中(再生中でチップ境界と一致しない)場合は、その単語自体を左隣とみなす
 * (= 右隣indexはその次の単語)。ms がちょうど単語の開始時刻と一致する場合は、その単語を
 * 右隣とみなす(= 左隣は1つ前の単語)。これはテキストカーソルが「文字の直前」に位置する
 * のと同じ振る舞いで、←/→キーで単語境界にスナップした直後の操作と整合する。
 */
export function findBoundaryWordIndex(words: SceneWord[], ms: number): number {
  const index = words.findIndex((word) => word.startMs >= ms);
  return index === -1 ? words.length : index;
}

/** 現在の再生バー位置(ms)から、現在シーン内でのチップ境界カーソルを求める。 */
export function resolveChipCursor(scenes: Scene[], currentMs: number): ChipCursor | null {
  const sceneIndex = findSceneIndexAtEditMs(scenes, currentMs);
  if (sceneIndex === -1) return null;
  return { sceneIndex, wordIndex: findBoundaryWordIndex(scenes[sceneIndex].words, currentMs) };
}

type FlatWordRef = { sceneIndex: number; wordIndex: number; word: SceneWord };

/** 全シーンの単語を時系列順に並べたフラット配列(シーンをまたぐ←/→移動に使う)。 */
export function flattenSceneWords(scenes: Scene[]): FlatWordRef[] {
  const result: FlatWordRef[] = [];
  scenes.forEach((scene, sceneIndex) => {
    scene.words.forEach((word, wordIndex) => result.push({ sceneIndex, wordIndex, word }));
  });
  return result;
}

/**
 * ←/→キーで移動する先のms(音節=チップ単位、シーンをまたぐ移動も可)。
 * direction: 1 は次のチップへ、-1 は前のチップへ。移動先が無ければnullを返す
 * (先頭より前・末尾より後ろへは移動しない)。
 */
export function findAdjacentChipBoundaryMs(scenes: Scene[], currentMs: number, direction: 1 | -1): number | null {
  const flat = flattenSceneWords(scenes);
  if (!flat.length) return null;
  if (direction === 1) {
    const next = flat.find((ref) => ref.word.startMs > currentMs);
    return next ? next.word.startMs : null;
  }
  let result: number | null = null;
  for (const ref of flat) {
    if (ref.word.startMs < currentMs) result = ref.word.startMs;
    else break;
  }
  return result;
}

/**
 * Delete(Backspace)キー: 再生バー左隣の音節を削除する対象を求める。
 * 「行頭(シーン先頭)」にカーソルがある場合は削除対象が無いためnullを返す
 * (呼び出し側はこの場合「上の行と結合」に切り替えること。仕様書「行頭でDelete」節)。
 */
export function resolveDeleteLeftTarget(scenes: Scene[], currentMs: number): ChipTarget | null {
  const cursor = resolveChipCursor(scenes, currentMs);
  if (!cursor) return null;
  if (cursor.wordIndex <= 0) return null;
  const scene = scenes[cursor.sceneIndex];
  const word = scene.words[cursor.wordIndex - 1];
  return word ? { sceneId: scene.id, wordId: word.id } : null;
}

/**
 * Fn+Delete(Forward Delete)キー: 再生バー右隣の音節を削除する対象を求める。
 * シーン末尾(右隣の単語が無い)場合はnullを返す(シーンをまたいだ削除は行わない)。
 */
export function resolveDeleteRightTarget(scenes: Scene[], currentMs: number): ChipTarget | null {
  const cursor = resolveChipCursor(scenes, currentMs);
  if (!cursor) return null;
  const scene = scenes[cursor.sceneIndex];
  const word = scene.words[cursor.wordIndex];
  return word ? { sceneId: scene.id, wordId: word.id } : null;
}

/** カーソルが行頭(シーン先頭、左隣の単語が無い)かどうかを判定する。 */
export function isChipCursorAtLineStart(scenes: Scene[], currentMs: number): boolean {
  const cursor = resolveChipCursor(scenes, currentMs);
  return !!cursor && cursor.wordIndex <= 0;
}

/**
 * Enterキー: チップ境界での分割対象を求める(splitSceneAtWordへ渡す単語)。
 * カーソルがシーン先頭/末尾にある(境界がチップ間ではなく行の外側の場合)はnullを返す。
 */
export function resolveSplitWordTarget(scenes: Scene[], currentMs: number): ChipTarget | null {
  const cursor = resolveChipCursor(scenes, currentMs);
  if (!cursor) return null;
  const scene = scenes[cursor.sceneIndex];
  if (cursor.wordIndex <= 0 || cursor.wordIndex >= scene.words.length) return null;
  const word = scene.words[cursor.wordIndex];
  return word ? { sceneId: scene.id, wordId: word.id } : null;
}

// --- 改善1(単語グループチップ): 上記と同じ考え方をグループ(WordGroup)単位に適用する関数群 ---
// App.tsxのキーボード操作(←→/Delete/Fn+Delete/Enter/行頭判定)はこちらのグループ版を使う
// (従来の1文字チップ単位ではなく「単語のまとまり」単位で動く)。上記の文字単位ChipCursor/ChipTarget系は
// 引き続きexport/テストされる汎用プリミティブとして残す(edgeTrim.tsのチップスナップ等、文字精度が
// 必要な処理は今後もscene.wordsを直接参照する)。

export type GroupCursor = {
  sceneIndex: number;
  /** ChipCursor.wordIndexのグループ版。0..groups.length。 */
  groupIndex: number;
};

export type GroupChipTarget = {
  sceneId: string;
  /** 対象グループに属する全ての文字wordId(setChipsDeleted/toggleChipsDeletedにそのまま渡せる)。 */
  wordIds: string[];
};

/** 現在の再生バー位置(ms)から、現在シーン内でのグループ境界カーソルを求める。 */
export function resolveGroupCursor(scenes: Scene[], currentMs: number): GroupCursor | null {
  const sceneIndex = findSceneIndexAtEditMs(scenes, currentMs);
  if (sceneIndex === -1) return null;
  const groups = buildWordGroups(scenes[sceneIndex]);
  return { sceneIndex, groupIndex: findBoundaryGroupIndex(groups, currentMs) };
}

type FlatGroupRef = { sceneIndex: number; groupIndex: number; group: WordGroup };

/** 全シーンのグループを時系列順に並べたフラット配列(シーンをまたぐ←/→移動に使う)。 */
export function flattenSceneGroups(scenes: Scene[]): FlatGroupRef[] {
  const result: FlatGroupRef[] = [];
  scenes.forEach((scene, sceneIndex) => {
    buildWordGroups(scene).forEach((group, groupIndex) => result.push({ sceneIndex, groupIndex, group }));
  });
  return result;
}

/**
 * ←/→キーで移動する先のms(グループ単位、シーンをまたぐ移動も可)。
 * `findAdjacentChipBoundaryMs`のグループ版。direction: 1 は次のグループへ、-1 は前のグループへ。
 */
export function findAdjacentGroupBoundaryMs(scenes: Scene[], currentMs: number, direction: 1 | -1): number | null {
  const flat = flattenSceneGroups(scenes);
  if (!flat.length) return null;
  if (direction === 1) {
    const next = flat.find((ref) => ref.group.startMs > currentMs);
    return next ? next.group.startMs : null;
  }
  let result: number | null = null;
  for (const ref of flat) {
    if (ref.group.startMs < currentMs) result = ref.group.startMs;
    else break;
  }
  return result;
}

/**
 * Delete(Backspace)キー: 再生バー左隣のグループを削除する対象を求める(グループ内の全wordId)。
 * 行頭(シーン先頭)にカーソルがある場合はnullを返す(呼び出し側は「上の行と結合」に切り替える)。
 */
export function resolveGroupDeleteLeftTarget(scenes: Scene[], currentMs: number): GroupChipTarget | null {
  const cursor = resolveGroupCursor(scenes, currentMs);
  if (!cursor) return null;
  if (cursor.groupIndex <= 0) return null;
  const scene = scenes[cursor.sceneIndex];
  const group = buildWordGroups(scene)[cursor.groupIndex - 1];
  return group ? { sceneId: scene.id, wordIds: group.wordIds } : null;
}

/** Fn+Delete(Forward Delete)キー: 再生バー右隣のグループを削除する対象を求める。 */
export function resolveGroupDeleteRightTarget(scenes: Scene[], currentMs: number): GroupChipTarget | null {
  const cursor = resolveGroupCursor(scenes, currentMs);
  if (!cursor) return null;
  const scene = scenes[cursor.sceneIndex];
  const group = buildWordGroups(scene)[cursor.groupIndex];
  return group ? { sceneId: scene.id, wordIds: group.wordIds } : null;
}

/** カーソルが行頭(シーン先頭、左隣のグループが無い)かどうかを判定する。 */
export function isGroupCursorAtLineStart(scenes: Scene[], currentMs: number): boolean {
  const cursor = resolveGroupCursor(scenes, currentMs);
  return !!cursor && cursor.groupIndex <= 0;
}

/**
 * Enterキー: グループ境界での分割対象を求める。splitSceneAtWord()はチップ(文字word)単位のAPIの
 * ままなので、分割対象グループの先頭文字wordIdを返す(グループの構成要素は連続した文字wordなので、
 * その先頭で割ればグループ境界での分割と等価になる)。
 * カーソルがシーン先頭/末尾にある場合はnullを返す。
 */
export function resolveGroupSplitTarget(scenes: Scene[], currentMs: number): ChipTarget | null {
  const cursor = resolveGroupCursor(scenes, currentMs);
  if (!cursor) return null;
  const scene = scenes[cursor.sceneIndex];
  const groups = buildWordGroups(scene);
  if (cursor.groupIndex <= 0 || cursor.groupIndex >= groups.length) return null;
  const firstWordId = groups[cursor.groupIndex].wordIds[0];
  return firstWordId ? { sceneId: scene.id, wordId: firstWordId } : null;
}

/**
 * Enterキー: 再生バー位置が切り込み(cutMark)と一致するシーン・ms値を求める(任意ms分割用)。
 * 一致しなければnull。許容誤差 toleranceMs 以内を「一致」とみなす。
 */
export function resolveMatchingCutMark(
  scenes: Scene[],
  currentMs: number,
  toleranceMs: number = CUT_MARK_TOLERANCE_MS,
): { sceneId: string; ms: number } | null {
  const sceneIndex = findSceneIndexAtEditMs(scenes, currentMs);
  if (sceneIndex === -1) return null;
  const scene = scenes[sceneIndex];
  const match = scene.cutMarks.find((mark) => Math.abs(mark - currentMs) <= toleranceMs);
  return match === undefined ? null : { sceneId: scene.id, ms: match };
}

/**
 * ↑/↓キー: 表示中のシーン一覧の中で、現在行から前後に隣接する行のidを返す。
 * 移動先が無ければnull(W5-6: 要確認フィルタは廃止され、常に全シーンが対象)。
 */
export function findAdjacentSceneId(
  displayedScenes: Scene[],
  currentSceneId: string | null,
  direction: 1 | -1,
): string | null {
  if (!displayedScenes.length) return null;
  if (!currentSceneId) return displayedScenes[0].id;
  const index = displayedScenes.findIndex((scene) => scene.id === currentSceneId);
  if (index === -1) return displayedScenes[0].id;
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= displayedScenes.length) return null;
  return displayedScenes[nextIndex].id;
}

/** 倍速巡回(L キー): rates配列を順に巡回する次の値を返す。現在値がrates内に無ければ先頭に戻す。 */
export function cyclePlaybackRate(current: number, rates: readonly number[]): number {
  if (!rates.length) return current;
  const index = rates.indexOf(current);
  const nextIndex = index === -1 ? 0 : (index + 1) % rates.length;
  return rates[nextIndex];
}

/** L キーで巡回する倍速。仕様書の通り 1.0x → 1.5x → 2.0x の3段階。 */
export const SCENE_PLAYBACK_RATES = [1, 1.5, 2] as const;

// --- 改善3(チップ間ホバーキャレット): マウスホバー中は再生バー(previewCurrentMs)を動かさず、
// 「どのシーンのどの境界インデックスにキャレットが立っているか」だけを一時状態として保持する
// (App.tsx側でrefに乗せ、再描画を伴わずに最新値を追う。previewCurrentMsRefと同じ方針)。
// 以下はそのキャレット位置(scene + groupIndex)から削除/分割対象を直接求める純関数群。
// resolveGroupDeleteLeftTarget/resolveGroupSplitTargetと考え方は同じだが、あちらは
// 「scenes配列 + ms」から現在シーンを逆引きするのに対し、こちらは「対象シーンが既知」という
// キャレットの性質上、scene単体 + groupIndexを直接受け取る(scenes全体を検索し直さない)。

export type GroupChipCaretTarget = GroupChipTarget;

/** キャレット左隣のグループを削除する対象を求める(groupIndex<=0の行頭はnull。呼び出し側で行結合に切り替える)。 */
export function resolveCaretDeleteLeftTarget(scene: Scene, groupIndex: number): GroupChipTarget | null {
  if (groupIndex <= 0) return null;
  const groups = buildWordGroups(scene);
  if (groupIndex > groups.length) return null;
  // W18: Delete連打では削除済みグループを飛ばし、さらに左の未削除グループへ進む。
  for (let index = Math.min(groupIndex - 1, groups.length - 1); index >= 0; index -= 1) {
    const group = groups[index];
    if (!group.deleted) return { sceneId: scene.id, wordIds: group.wordIds };
  }
  return null;
}

/** W16-4: キャレット右隣のグループを削除する対象を求める(行末=右隣が無い場合はnull)。 */
export function resolveCaretDeleteRightTarget(scene: Scene, groupIndex: number): GroupChipTarget | null {
  const groups = buildWordGroups(scene);
  if (groupIndex < 0 || groupIndex >= groups.length) return null;
  for (let index = Math.max(0, groupIndex); index < groups.length; index += 1) {
    const group = groups[index];
    if (!group.deleted) return { sceneId: scene.id, wordIds: group.wordIds };
  }
  return null;
}

/** キャレット位置でシーンを分割する対象(分割対象グループの先頭文字wordId)を求める。行頭/行末はnull。 */
export function resolveCaretSplitTarget(scene: Scene, groupIndex: number): ChipTarget | null {
  const groups = buildWordGroups(scene);
  if (groupIndex <= 0 || groupIndex >= groups.length) return null;
  const firstWordId = groups[groupIndex].wordIds[0];
  return firstWordId ? { sceneId: scene.id, wordId: firstWordId } : null;
}

/** キャレットが行頭(シーン先頭、左隣のグループが無い)かどうかを判定する。 */
export function isCaretAtLineStart(groupIndex: number): boolean {
  return groupIndex <= 0;
}

/**
 * 改善5-6(ハサミモード): チップ列上でのワンクリック分割は、最寄りのグループ境界にスナップして
 * 分割する(`resolveCaretSplitTarget`と全く同じ規則)。呼び出し意図(ハサミクリックによる分割)を
 * 名前で明確にするためのエイリアスとして公開する(行頭/行末はnull=分割不可)。
 */
export function resolveScissorsChipSplitTarget(scene: Scene, boundaryIndex: number): ChipTarget | null {
  return resolveCaretSplitTarget(scene, boundaryIndex);
}

/**
 * ミニ波形・行カード上でのマウスX位置(0..widthのpx)から、シーン内の再生バー位置(ms)を
 * 求める(ホバースクラブ用)。scrub中は常にシーン範囲内にクランプする。
 */
export function msFromScrubPosition(scene: Scene, offsetX: number, widthPx: number): number {
  const safeWidth = Math.max(1, widthPx);
  const ratio = Math.max(0, Math.min(1, offsetX / safeWidth));
  const ms = scene.sourceStartMs + ratio * (scene.sourceEndMs - scene.sourceStartMs);
  return Math.max(scene.sourceStartMs, Math.min(scene.sourceEndMs, ms));
}
