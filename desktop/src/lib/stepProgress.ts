/**
 * 進行バー用: パイプラインステップ配列から進捗率(0〜100)を算出する。
 *
 * 書き出し中はメインプロセスから exportProgress(%) が届くのでそちらを優先し、
 * それ以外の区間はステップの完了数ベースで進捗を出す(実行中ステップは0.5歩扱い)。
 * バー幅の計算に使うため、後退しないよう単調増加は呼び出し側で保証しない
 * (ステップリセット時は0に戻ってよい)。
 */

export interface StepProgressInput {
  status: "pending" | "running" | "done" | "error";
  label: string;
}

export function computeStepProgressPercent(steps: StepProgressInput[]): number {
  if (!steps.length) return 0;
  const done = steps.filter((s) => s.status === "done").length;
  const hasRunning = steps.some((s) => s.status === "running");
  const value = (done + (hasRunning ? 0.5 : 0)) / steps.length;
  return Math.max(0, Math.min(100, Math.round(value * 100)));
}

/** 実行中ステップのラベル。無ければ null(完了直後や待機中)。 */
export function findRunningStepLabel(steps: StepProgressInput[]): string | null {
  const running = steps.find((s) => s.status === "running");
  return running ? running.label : null;
}

/**
 * 進行バーに渡す最終進捗。書き出し進捗(1〜99)が生きている間はそれを優先する。
 * exportProgress は 0=未開始 / 100=完了 なのでその範囲外はステップ進捗に委ねる。
 */
export function resolveCatProgressPercent(
  steps: StepProgressInput[],
  exportProgress: number
): number {
  if (exportProgress > 0 && exportProgress < 100) return exportProgress;
  return computeStepProgressPercent(steps);
}
