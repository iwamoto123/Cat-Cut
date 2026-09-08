import { useRef, useState } from "react";
import { Move, RotateCcw, Check } from "lucide-react";
import type { TelopPosition } from "../lib/telopPosition";
import "./telopPosition.css";

function PositionField({ axis, value, onCommit }: { axis: "X" | "Y"; value: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const rawRef = useRef<string | null>(null);
  const update = (raw: string | null) => { rawRef.current = raw; setDraft(raw); };
  const commit = () => {
    const raw = rawRef.current;
    update(null);
    if (raw === null || !raw.trim() || !Number.isFinite(Number(raw))) return;
    const next = Math.max(0, Math.min(100, Number(raw))) / 100;
    if (Math.abs(next - value) > 0.00001) onCommit(next);
  };
  return <label className="telopPositionField"><span>{axis === "X" ? "横" : "縦"}</span><input
    type="number" min={0} max={100} step={0.1} aria-label={`テロップ${axis === "X" ? "横" : "縦"}位置（%）`}
    value={draft ?? Number((value * 100).toFixed(1))}
    onFocus={() => update(String(Number((value * 100).toFixed(1))))}
    onChange={(event) => update(event.target.value)} onBlur={commit}
    onKeyDown={(event) => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") { event.preventDefault(); commit(); event.currentTarget.blur(); }
      if (event.key === "Escape") { event.preventDefault(); update(null); event.currentTarget.blur(); }
    }}
  /><span>%</span></label>;
}

export function TelopPositionControls({ position, manual, editing, disabled, onEditingChange, onChange, onApplyAll }: {
  position: TelopPosition;
  manual: boolean;
  editing: boolean;
  disabled?: boolean;
  onEditingChange: (editing: boolean) => void;
  onChange: (position: TelopPosition | null) => void;
  onApplyAll?: (position: TelopPosition | null) => void;
}) {
  return <div className={`telopPositionControls${editing ? " isEditing" : ""}`}>
    <div className="telopPositionHeading"><button type="button" disabled={disabled} aria-pressed={editing}
      className="telopPositionToggle" onClick={() => onEditingChange(!editing)} title="テロップを上下左右にドラッグ／数値で位置を調整">
      {editing ? <Check size={13} /> : <Move size={13} />}<span>{editing ? "位置調整を完了" : "テロップ位置"}</span>
    </button><span className="telopPositionStatus">{disabled ? "本編のテロップを表示して調整" : editing ? "文字をドラッグして移動" : manual ? `横 ${(position.x * 100).toFixed(1)}%・縦 ${(position.y * 100).toFixed(1)}%` : "自動配置"}</span></div>
    {editing && !disabled && <div className="telopPositionBody">
      <div className="telopPositionFields"><PositionField axis="X" value={position.x} onCommit={(x) => onChange({ ...position, x })} />
        <PositionField axis="Y" value={position.y} onCommit={(y) => onChange({ ...position, y })} />
        <button type="button" onClick={() => onChange({ x: 0.5, y: 0.5 })}>中央</button>
        <button type="button" onClick={() => onChange({ x: 0.5, y: 0.8 })}>下</button>
        <button type="button" title="顔回避とデザインの既定位置に戻す" disabled={!manual} onClick={() => onChange(null)}><RotateCcw size={12} />自動</button>
      </div>
      <div className="telopPositionFooter"><span>左上が0%・文字が画面に収まる範囲で移動</span>{onApplyAll && <button type="button" onClick={() => onApplyAll(manual ? position : null)}>{manual ? "この位置を全シーンに適用" : "全シーンを自動配置に戻す"}</button>}</div>
    </div>}
  </div>;
}
