// 実行時(値)importのため、node --experimental-strip-types でテストを直接実行できるよう拡張子を明示する。
import { isSceneFullyDeleted, type Scene } from "./scenes.ts";
import type { SuspicionItem } from "./suspicionQueue.ts";

/**
 * W19-B1(弱い区間の再文字起こし): step05b_retranscribe が出力した retranscribe.json の
 * 差分候補を、要確認パネル(ReviewHotspotsPanel)の項目(種別: retranscribe)へ変換する純関数群。
 * 自動置換はしない。suggestion付きなので既存の「候補: ○○ [適用]」ワンクリック適用が使える。
 */

export type RetranscribeItem = {
  startMs: number;
  endMs: number;
  wordIds: string[];
  /** 元テキスト(区間内STT単語の連結)。置換元(surface)として使う。 */
  oldText: string;
  /** 再文字起こしテキスト。 */
  newText: string;
  /** LLM裁定後の置換候補。 */
  suggestion: string;
  reason: string;
};

/** retranscribe.json(snake_case)の items をレンダラー型へ正規化する。不正エントリは捨てる。 */
export function normalizeRetranscribeItems(rawItems: unknown): RetranscribeItem[] {
  if (!Array.isArray(rawItems)) return [];
  const results: RetranscribeItem[] = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const wordIds = Array.isArray(entry.word_ids) ? entry.word_ids.map(String).filter(Boolean) : [];
    const oldText = typeof entry.old_text === "string" ? entry.old_text : "";
    const suggestion = typeof entry.suggestion === "string" ? entry.suggestion : "";
    if (!wordIds.length || !oldText || !suggestion) continue;
    results.push({
      startMs: Number(entry.start_ms) || 0,
      endMs: Number(entry.end_ms) || 0,
      wordIds,
      oldText,
      newText: typeof entry.new_text === "string" ? entry.new_text : "",
      suggestion,
      reason: typeof entry.reason === "string" && entry.reason ? entry.reason : "再文字起こしで差分",
    });
  }
  return results;
}

/** 「無視」ボタン用の安定ID(runロード間で不変。word_ids由来)。 */
export function retranscribeItemId(item: RetranscribeItem): string {
  return `retranscribe:${item.wordIds.join("_")}`;
}

/**
 * 差分候補を要確認パネル用のSuspicionItemへ変換する(シーンid → items)。
 * - word_ids が最も多く属するシーンへ解決する(パディングで隣接シーンの単語を含み得るため
 *   過半一致ではなく最多一致)。どのシーンにも属さない項目は破棄する
 * - 丸ごと削除済みシーン・ignoredIds(「無視」済み)の項目は落とす
 * suggestionの適用可否(surfaceが現在本文に実在するか)はパネル側の既存判定に任せる。
 */
export function buildRetranscribeSuspicions(
  items: RetranscribeItem[],
  scenes: Scene[],
  ignoredIds: Set<string>,
): Map<string, SuspicionItem[]> {
  const sceneIdByWordId = new Map<string, string>();
  for (const scene of scenes) {
    for (const word of scene.words) sceneIdByWordId.set(word.id, scene.id);
  }
  const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));

  const result = new Map<string, SuspicionItem[]>();
  for (const item of items) {
    const id = retranscribeItemId(item);
    if (ignoredIds.has(id)) continue;

    const matchCounts = new Map<string, number>();
    for (const wordId of item.wordIds) {
      const sceneId = sceneIdByWordId.get(wordId);
      if (!sceneId) continue;
      matchCounts.set(sceneId, (matchCounts.get(sceneId) || 0) + 1);
    }
    let bestSceneId = "";
    let bestCount = 0;
    for (const [sceneId, count] of matchCounts) {
      if (count > bestCount) {
        bestSceneId = sceneId;
        bestCount = count;
      }
    }
    const scene = bestSceneId ? sceneById.get(bestSceneId) : undefined;
    if (!scene || isSceneFullyDeleted(scene)) continue;

    const list = result.get(scene.id) || [];
    list.push({
      id,
      type: "retranscribe",
      severity: "medium",
      label: "再文字起こしで差分",
      text: item.oldText,
      timestampMs: item.startMs || scene.sourceStartMs,
      wordIds: item.wordIds,
      detail: `${item.reason}（再文字起こし: ${item.newText || item.suggestion}）`,
      suggestion: item.suggestion,
    });
    result.set(scene.id, list);
  }
  return result;
}
