// 実行時(値)importのため、node --experimental-strip-types でテストを直接実行できるよう拡張子を明示する。
import { isSceneFullyDeleted, type Scene } from "./scenes.ts";
import type { SuspicionItem } from "./suspicionQueue.ts";

/**
 * W16-7(AI最終チェック): 検品最終段階で現在の表示テキスト全シーンをLLMで一括再チェックする
 * (python/step06d_final_text_review.py)。このモジュールはその入出力の純関数部
 * (送信ペイロード構築・指摘のSuspicionItem変換)を担う。
 */

export type FinalCheckIssue = {
  sceneId: string;
  surface: string;
  suggestion?: string;
  reason: string;
};

/** main(final-check:run)へ送る全シーンの表示テキスト。丸ごと削除済み・空テキストのシーンは除外する。 */
export function buildFinalCheckScenesPayload(scenes: Scene[]): Array<{ sceneId: string; text: string }> {
  return scenes
    .filter((scene) => !isSceneFullyDeleted(scene) && scene.telopText.trim().length > 0)
    .map((scene) => ({ sceneId: scene.id, text: scene.telopText }));
}

/** issues.json(snake_case)の指摘をレンダラー型へ正規化する。不正エントリは捨てる。 */
export function normalizeFinalCheckIssues(rawIssues: unknown): FinalCheckIssue[] {
  if (!Array.isArray(rawIssues)) return [];
  const results: FinalCheckIssue[] = [];
  for (const raw of rawIssues) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const sceneId = typeof entry.scene_id === "string" ? entry.scene_id : "";
    const surface = typeof entry.surface === "string" ? entry.surface : "";
    if (!sceneId || !surface) continue;
    const issue: FinalCheckIssue = {
      sceneId,
      surface,
      reason: typeof entry.reason === "string" && entry.reason ? entry.reason : "表記の疑い",
    };
    if (typeof entry.suggestion === "string" && entry.suggestion) issue.suggestion = entry.suggestion;
    results.push(issue);
  }
  return results;
}

export function finalCheckIssueId(issue: FinalCheckIssue): string {
  return `final_check:${issue.sceneId}:${issue.surface}`;
}

/**
 * W19-B2(step06dの自動実行): パイプライン自動実行の issues.json はレンダラーのシーンIDを
 * 知らない(auto_0001..の仮ID)ため、実行時入力(scenes_input.json)の本文と現在のシーン本文の
 * 一致で現在のシーンIDへ再マップする。
 * - issue.sceneId が現在のシーンに実在する場合はそのまま通す(手動実行の結果)
 * - 同一本文のシーンが複数ある場合は出現順(入力側のn番目→現在側のn番目)で対応付ける
 * - 対応が取れない指摘は捨てる(シーン分割・本文編集後などは再実行すればよい)
 */
export function remapFinalCheckIssues(
  issues: FinalCheckIssue[],
  inputScenes: Array<{ sceneId: string; text: string }>,
  scenes: Scene[],
): FinalCheckIssue[] {
  const currentSceneIds = new Set(scenes.map((scene) => scene.id));
  const normalize = (text: string) => text.replace(/\s+/gu, "");

  const currentIdsByText = new Map<string, string[]>();
  for (const scene of scenes) {
    const key = normalize(scene.telopText);
    if (!key) continue;
    const list = currentIdsByText.get(key) || [];
    list.push(scene.id);
    currentIdsByText.set(key, list);
  }

  // 入力側の同一本文シーンの出現順(何番目か)を控える
  const inputTextById = new Map<string, string>();
  const inputOrdinalById = new Map<string, number>();
  const inputTextCounts = new Map<string, number>();
  for (const input of inputScenes) {
    const key = normalize(input.text);
    inputTextById.set(input.sceneId, key);
    const ordinal = inputTextCounts.get(key) || 0;
    inputOrdinalById.set(input.sceneId, ordinal);
    inputTextCounts.set(key, ordinal + 1);
  }

  const results: FinalCheckIssue[] = [];
  for (const issue of issues) {
    if (currentSceneIds.has(issue.sceneId)) {
      results.push(issue);
      continue;
    }
    const textKey = inputTextById.get(issue.sceneId);
    if (!textKey) continue;
    const candidates = currentIdsByText.get(textKey) || [];
    const mapped = candidates[inputOrdinalById.get(issue.sceneId) ?? 0] ?? candidates[0];
    if (!mapped) continue;
    results.push({ ...issue, sceneId: mapped });
  }
  return results;
}

/**
 * 指摘を要確認パネル用のSuspicionItemへ変換する(シーンid → items)。
 * - 現在のtelopTextにsurfaceが含まれない指摘は落とす(適用済み・編集済みは自然に消える)
 * - ignoredIds(「無視」済み)の指摘は落とす
 * suggestion付きの指摘は既存の「候補: ○○ [適用]」ボタンがそのまま使える。
 */
export function buildFinalCheckSuspicions(
  issues: FinalCheckIssue[],
  scenes: Scene[],
  ignoredIds: Set<string>,
): Map<string, SuspicionItem[]> {
  const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));
  const result = new Map<string, SuspicionItem[]>();
  for (const issue of issues) {
    const id = finalCheckIssueId(issue);
    if (ignoredIds.has(id)) continue;
    const scene = sceneById.get(issue.sceneId);
    if (!scene || isSceneFullyDeleted(scene)) continue;
    if (!scene.telopText.includes(issue.surface)) continue;
    const item: SuspicionItem = {
      id,
      type: "final_check",
      severity: "medium",
      label: "AI最終チェック",
      text: issue.surface,
      timestampMs: scene.sourceStartMs,
      wordIds: [],
      detail: issue.reason,
    };
    if (issue.suggestion) item.suggestion = issue.suggestion;
    const list = result.get(issue.sceneId) || [];
    list.push(item);
    result.set(issue.sceneId, list);
  }
  return result;
}
