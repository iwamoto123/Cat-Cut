// 実行時(値)importのため、node --experimental-strip-types でテストを直接実行できるよう拡張子を明示する。
import type { ReviewHotspot } from "./reviewHotspots.ts";
import type { SuspicionItem, SuspicionType } from "./suspicionQueue.ts";

/**
 * W19-B3(AI修正を一括適用): 要確認パネルの suggestion付き項目をまとめて適用する計画を
 * 純関数で組み立てる。適用自体はApp側が計画を1回のUndoエントリとしてコミットする。
 */

/** 一括適用の対象になる疑義種別(suggestion=置換候補を持ち得るもの)。 */
export const BULK_APPLY_TYPES: ReadonlySet<SuspicionType> = new Set<SuspicionType>([
  "suspect_word",
  "final_check",
  "correction_history",
  "retranscribe",
]);

export type BulkApplySceneEdit = {
  sceneId: string;
  beforeText: string;
  afterText: string;
  /** このシーンで適用された項目(残件計算・学習記録のログ用)。 */
  appliedItems: SuspicionItem[];
};

export type BulkApplyPlan = {
  sceneEdits: BulkApplySceneEdit[];
  /** 適用される項目の総数(ボタンの「N件」表示に使う)。 */
  appliedCount: number;
};

/** 単発の「候補: ○○ [適用]」ボタンと同じ置換規則(全出現置換)。 */
function applySuggestionToText(text: string, surface: string, suggestion: string): string {
  return text.split(surface).join(suggestion);
}

/**
 * 一括適用の計画を立てる。各シーンの項目を順に適用し、surface(置換元)が
 * 「その時点の本文」に実在する項目だけを採用する(先行置換で消えた項目は自然にスキップ
 * =同一surfaceの重複項目も1回だけ適用される)。適用できなかった項目は計画に含まれず、
 * パネルの残件としてそのまま残る。
 */
export function planBulkApplyAiFixes(hotspots: ReviewHotspot[]): BulkApplyPlan {
  const sceneEdits: BulkApplySceneEdit[] = [];
  let appliedCount = 0;
  for (const hotspot of hotspots) {
    const beforeText = hotspot.scene.telopText;
    let text = beforeText;
    const appliedItems: SuspicionItem[] = [];
    for (const item of hotspot.items) {
      if (!BULK_APPLY_TYPES.has(item.type)) continue;
      if (!item.suggestion || !item.text) continue;
      if (item.suggestion === item.text) continue;
      if (!text.includes(item.text)) continue;
      text = applySuggestionToText(text, item.text, item.suggestion);
      appliedItems.push(item);
    }
    if (!appliedItems.length || text === beforeText) continue;
    sceneEdits.push({ sceneId: hotspot.scene.id, beforeText, afterText: text, appliedItems });
    appliedCount += appliedItems.length;
  }
  return { sceneEdits, appliedCount };
}
