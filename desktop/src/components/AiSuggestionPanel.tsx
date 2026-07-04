import { RotateCcw, Scissors, Volume2, VolumeX } from "lucide-react";

type SummaryStat = {
  count: number;
  durationMs: number;
};

type Props = {
  silence: SummaryStat;
  filler: SummaryStat;
  canUndo: boolean;
  canRedo: boolean;
  applying: boolean;
  onRestoreFiller: () => void;
  onApplyFiller: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onApply: () => void;
};

function formatDuration(ms: number) {
  const sec = Math.max(0, Math.round(ms / 1000));
  const mm = Math.floor(sec / 60);
  const ss = sec % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

export function AiSuggestionPanel({
  silence,
  filler,
  canUndo,
  canRedo,
  applying,
  onRestoreFiller,
  onApplyFiller,
  onUndo,
  onRedo,
  onApply,
}: Props) {
  return (
    <aside className="aiSuggestionPanel">
      <h3>AI提案</h3>
      <div className="aiStatItem">
        <span>
          <VolumeX size={14} />
          無音カット
        </span>
        <strong>
          {silence.count}箇所 / -{formatDuration(silence.durationMs)}
        </strong>
      </div>
      <div className="aiStatItem">
        <span>
          <Scissors size={14} />
          フィラーカット
        </span>
        <strong>
          {filler.count}箇所 / -{formatDuration(filler.durationMs)}
        </strong>
      </div>
      <div className="aiActions">
        <button onClick={onRestoreFiller} type="button">
          <RotateCcw size={14} />
          フィラーカットを全て解除
        </button>
        <button onClick={onApplyFiller} type="button">
          <Volume2 size={14} />
          フィラーカットを適用
        </button>
      </div>
      <div className="aiActions">
        <button disabled={!canUndo} onClick={onUndo} type="button">
          Undo
        </button>
        <button disabled={!canRedo} onClick={onRedo} type="button">
          Redo
        </button>
      </div>
      <button className="primaryButton transcriptApplyButton" disabled={applying} onClick={onApply} type="button">
        {applying ? "適用中..." : "適用して再計算"}
      </button>
    </aside>
  );
}
