import React from "react";

/**
 * 処理中の進行バー。上段に実行中ステップ名と%、下段にシマー入りのスリムなバー。
 * (旧: 絵文字ねこが歩く遊びUI。仕事道具としての落ち着きを優先してモダンなバーに刷新)
 */
interface CatProgressBarProps {
  /** 0〜100 */
  percent: number;
  /** true の間はバーにシマーを流す */
  active: boolean;
  /** 実行中ステップ名などの補足。null なら非表示 */
  label?: string | null;
}

export function CatProgressBar({ percent, active, label }: CatProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, percent));
  const finished = clamped >= 100;
  return (
    <div className="jobProgress" role="progressbar" aria-valuenow={clamped} aria-valuemin={0} aria-valuemax={100}>
      <div className="jobProgressMeta">
        <span className="jobProgressLabel">{finished ? "完了" : (label ?? "処理中…")}</span>
        <span className="jobProgressPercent">{Math.round(clamped)}%</span>
      </div>
      <div className="jobProgressTrack">
        <div
          className={`jobProgressFill ${active && !finished ? "animated" : ""} ${finished ? "finished" : ""}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}
