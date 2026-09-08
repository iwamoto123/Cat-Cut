import { useCallback, useRef } from "react";

/** Fit the editing area below its actual toolbar, without publishing resize state through App. */
export function useWorkspaceViewport(enabled: boolean) {
  const dispose = useRef<(() => void) | null>(null);
  return useCallback((node: HTMLDivElement | null) => {
    dispose.current?.();
    dispose.current = null;
    if (!node || !enabled) return;
    let previous = -1;
    const update = () => {
      const top = node.getBoundingClientRect().top + window.scrollY;
      const available = Math.max(280, Math.floor(window.innerHeight - top - 18));
      if (available === previous) return;
      previous = available;
      node.style.setProperty("--workspace-height", `${available}px`);
    };
    update();
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => { frame = null; update(); });
    };
    const observer = new ResizeObserver(schedule);
    if (node.parentElement) observer.observe(node.parentElement);
    window.addEventListener("resize", schedule);
    dispose.current = () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame !== null) cancelAnimationFrame(frame);
      node.style.removeProperty("--workspace-height");
    };
  }, [enabled]);
}
