import { useEffect, useRef, useState } from "react";

/** 境界だけを更新し、ドラッグ中の動画・タイムラインの再レンダーを避ける。 */
export function WorkspaceResizeHandle({ axis, vertical = false }: { axis: "width" | "height"; vertical?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; start: number; value: number } | null>(null);
  const latestValue = useRef<number | undefined>();
  const [value, setValue] = useState<number | undefined>();
  const variable = axis === "width" ? "--preview-width" : "--preview-height";
  const defaultValue = axis === "width" ? (vertical ? 30 : 65) : 55;
  const storageKey = `catcut.workspace.${vertical ? "vertical" : "horizontal"}.${axis}`;
  const workspace = () => ref.current?.closest<HTMLElement>(".sceneMainAreaTimeline");
  const apply = (next: number, persist = false) => {
    const bounded = Math.max(axis === "width" ? 25 : 30, Math.min(axis === "width" ? 75 : 70, next));
    workspace()?.style.setProperty(variable, `${bounded}%`);
    latestValue.current = bounded;
    setValue(Math.round(bounded));
    if (persist) { try { localStorage.setItem(storageKey, String(bounded)); } catch { /* 保存不可でも操作可能 */ } }
  };
  useEffect(() => {
    workspace()?.style.removeProperty(variable);
    setValue(undefined); latestValue.current = undefined;
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved !== null && Number.isFinite(Number(saved))) apply(Number(saved));
    } catch { /* 保存不可でも既定サイズを使用 */ }
  }, [storageKey]);
  const finish = (event: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    if (!drag.current || drag.current.id !== event.pointerId) return;
    if (cancelled) apply(drag.current.value);
    else if (latestValue.current !== undefined) apply(latestValue.current, true);
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <div ref={ref} className={`workspaceResizeHandle workspaceResizeHandle-${axis}`}
    role="separator" tabIndex={0} aria-label={axis === "width" ? "プレビューの幅" : "プレビューの高さ"}
    aria-orientation={axis === "width" ? "vertical" : "horizontal"} aria-valuemin={axis === "width" ? 25 : 30}
    aria-valuemax={axis === "width" ? 75 : 70} aria-valuenow={value ?? defaultValue}
    title="ドラッグでサイズ変更・ダブルクリックでリセット（矢印キーでも調整）"
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      const root = workspace();
      const preview = root?.querySelector<HTMLElement>(axis === "width" ? ".scenePreviewColumn" : ".editorPreviewDock");
      if (!root || !preview) return;
      event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
      const size = axis === "width" ? root.clientWidth : root.clientHeight;
      drag.current = { id: event.pointerId, start: axis === "width" ? event.clientX : event.clientY,
        value: 100 * (axis === "width" ? preview.clientWidth : preview.clientHeight) / size };
    }}
    onPointerMove={(event) => {
      const root = workspace();
      if (!root || !drag.current || drag.current.id !== event.pointerId) return;
      const delta = (axis === "width" ? event.clientX : event.clientY) - drag.current.start;
      apply(drag.current.value + 100 * delta / (axis === "width" ? root.clientWidth : root.clientHeight));
    }}
    onPointerUp={(event) => finish(event)} onPointerCancel={(event) => finish(event, true)}
    onLostPointerCapture={() => { drag.current = null; }}
    onDoubleClick={() => {
      workspace()?.style.removeProperty(variable); setValue(undefined); latestValue.current = undefined;
      try { localStorage.removeItem(storageKey); } catch { /* 保存不可 */ }
    }}
    onKeyDown={(event) => {
      const decrease = axis === "width" ? "ArrowLeft" : "ArrowUp";
      const increase = axis === "width" ? "ArrowRight" : "ArrowDown";
      if (event.key !== decrease && event.key !== increase) return;
      event.preventDefault(); event.stopPropagation();
      apply((value ?? defaultValue) + (event.key === decrease ? -2 : 2), true);
    }} />;
}
