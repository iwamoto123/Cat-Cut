// フェーズW23: ステージ別UI最小化の軸となるUIステージ導出。
// App.tsx はこの1関数で leftPane / stepsPanel / 検品全幅表示を切り替える。

export type UiStage = "home" | "analyzing" | "editing";

/**
 * 現在のUIステージを導出する。
 * - editing: 検品中(reviewState保持中)。書き出し中も reviewState は保持されるため
 *   running=true でも editing のまま(停止導線は検品ツールバーのコンパクトバーが担う)
 * - analyzing: 解析パイプライン実行中(検品前)
 * - home: 待機中(プロジェクト一覧)
 */
export function uiStageFor(input: { running: boolean; hasReview: boolean }): UiStage {
  if (input.hasReview) return "editing";
  if (input.running) return "analyzing";
  return "home";
}
