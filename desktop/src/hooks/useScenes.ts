import { useMemo } from "react";
import { useEditHistory } from "./useEditHistory";
import {
  addCutMark,
  applyStyleOverrideToEmotionGroup,
  deriveKeepSegments,
  deriveTelopOverrides,
  mergeSceneWithNext,
  replaceTelopOccurrences,
  type TelopOccurrenceTarget,
  setChipDeleted,
  setChipsDeleted,
  setSceneEmotionTag,
  setSceneStyleOverride,
  setSceneTelopText,
  splitSceneAtMs,
  splitSceneAtWord,
  toggleChipDeleted,
  toggleChipsDeleted,
  type Scene,
} from "../lib/scenes";
import type { EmotionTag } from "../lib/emotionTag";
import { applyEdgeTrim, type EdgeTrimEdge, type EdgeTrimOptions } from "../lib/edgeTrim";

/**
 * scenes配列を唯一の編集源として管理するフック(検品UI v2 Phase 1)。
 * useEditHistoryをそのまま利用してUndo/Redoスタックに乗せる(useKeepSegmentsと同じ構成)。
 * keep_segmentsとテロップ上書きは、都度scenesから純関数で導出する(再計算による巻き戻りを防ぐ)。
 */
export function useScenes(initialScenes: Scene[] = []) {
  const history = useEditHistory<Scene[]>(initialScenes);

  const keepSegments = useMemo(() => deriveKeepSegments(history.present), [history.present]);
  const telopOverrides = useMemo(() => deriveTelopOverrides(history.present), [history.present]);

  const toggleChip = (sceneId: string, wordId: string) => {
    history.setPresent((current) => toggleChipDeleted(current, sceneId, wordId));
  };

  const setChipDeletedState = (sceneId: string, wordId: string, deleted: boolean) => {
    history.setPresent((current) => setChipDeleted(current, sceneId, wordId, deleted));
  };

  /** 改善1: 単語グループチップ単位の削除/復元。1呼び出し=1つのUndo操作。 */
  const toggleChipGroup = (sceneId: string, wordIds: string[]) => {
    history.setPresent((current) => toggleChipsDeleted(current, sceneId, wordIds));
  };

  /** 改善1: 単語グループチップ単位の削除/復元(状態を明示指定)。Delete/Fn+Deleteキーから使う。 */
  const setChipGroupDeletedState = (sceneId: string, wordIds: string[], deleted: boolean) => {
    history.setPresent((current) => setChipsDeleted(current, sceneId, wordIds, deleted));
  };

  const setTelopText = (sceneId: string, text: string) => {
    history.setPresent((current) => setSceneTelopText(current, sceneId, text));
  };

  /** T-2: バッジクリックによる感情タグの手動変更。 */
  const setEmotionTag = (sceneId: string, tag: EmotionTag) => {
    history.setPresent((current) => setSceneEmotionTag(current, sceneId, tag));
  };

  /** T-3: スウォッチ→パレットからの個別スタイルオーバーライド設定/解除(null=解除)。 */
  const setStyleOverride = (sceneId: string, styleId: string | null) => {
    history.setPresent((current) => setSceneStyleOverride(current, sceneId, styleId));
  };

  /** T-3: 「このスタイルを同じ感情の全シーンに適用」。1回の呼び出し=1つのUndo操作。 */
  const applyStyleToEmotionGroup = (sceneId: string, styleId: string) => {
    history.setPresent((current) => applyStyleOverrideToEmotionGroup(current, sceneId, styleId));
  };

  /**
   * 改善10-B-1(一括変更ポップアップ): 選択した出現箇所だけ telopText を置換する。
   * 1回の呼び出し=1つのUndo操作。
   */
  const replaceSelectedTelopOccurrences = (from: string, to: string, targets: TelopOccurrenceTarget[]) => {
    history.setPresent((current) => replaceTelopOccurrences(current, from, to, targets));
  };

  const splitAtWord = (sceneId: string, secondFirstWordId: string) => {
    history.setPresent((current) => splitSceneAtWord(current, sceneId, secondFirstWordId));
  };

  /** Phase 2: 切り込み(cutMark)位置での任意ms分割(Enterキー)。 */
  const splitAtMs = (sceneId: string, ms: number) => {
    history.setPresent((current) => splitSceneAtMs(current, sceneId, ms));
  };

  const mergeWithNext = (sceneId: string) => {
    history.setPresent((current) => mergeSceneWithNext(current, sceneId));
  };

  /** Phase 2: 波形右クリック「ここに切り込み」。 */
  const addCutMarkAt = (sceneId: string, ms: number) => {
    history.setPresent((current) => addCutMark(current, sceneId, ms));
  };

  /**
   * Phase 3: 行端の長押しスライド(端トリム)の確定コミット。
   * ドラッグ中のライブプレビューはこの関数を呼ばず(App側でapplyEdgeTrimを直接呼んで
   * 表示だけ差し替える)、ポインタを離した瞬間に一度だけこれを呼ぶことで
   * 「ドラッグ1回=1つのUndo操作」を保証する。
   */
  const applyEdgeTrimAt = (sceneId: string, edge: EdgeTrimEdge, targetMs: number, options?: EdgeTrimOptions) => {
    history.setPresent((current) => {
      const sceneIndex = current.findIndex((scene) => scene.id === sceneId);
      if (sceneIndex === -1) return current;
      return applyEdgeTrim(current, sceneIndex, edge, targetMs, options).scenes;
    });
  };

  return {
    scenes: history.present,
    keepSegments,
    telopOverrides,
    toggleChip,
    setChipDeletedState,
    toggleChipGroup,
    setChipGroupDeletedState,
    setTelopText,
    setEmotionTag,
    setStyleOverride,
    applyStyleToEmotionGroup,
    replaceSelectedTelopOccurrences,
    splitAtWord,
    splitAtMs,
    mergeWithNext,
    addCutMarkAt,
    applyEdgeTrimAt,
    reset: history.reset,
    undo: history.undo,
    redo: history.redo,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
  };
}
