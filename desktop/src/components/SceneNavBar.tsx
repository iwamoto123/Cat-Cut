import { useEffect, useRef, useState } from "react";
import { scaleWaveformPeaksGlobal, sliceWaveformPeaks } from "../lib/waveform";

const HEIGHT = 56;

export type NavFlagMarker = {
  ms: number;
  severity: "high" | "medium" | "low";
};

type Props = {
  peaks: number[];
  binMs: number;
  durationMs: number;
  currentMs: number;
  flagMarkers: NavFlagMarker[];
  onSeek: (ms: number) => void;
};

function formatTime(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

const SEVERITY_COLOR: Record<string, string> = {
  high: "#d92d20",
  medium: "#f79009",
  low: "#98a2b3",
};

/** 画面最下部の全体ナビバー: 全編の片側波形＋疑義フラグの色マーカー＋再生ヘッド。クリックでジャンプする。 */
export function SceneNavBar({ peaks, binMs, durationMs, currentMs, flagMarkers, onSeek }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(800);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(Math.max(80, entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(HEIGHT * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${HEIGHT}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, HEIGHT);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, HEIGHT);

    const safeDuration = Math.max(1, durationMs);
    const msToX = (ms: number) => (ms / safeDuration) * width;

    const slicedPeaks = sliceWaveformPeaks(peaks, binMs, 0, safeDuration);
    // 改善2(波形の縦スケール改善): 全体ナビバーはグローバル正規化のまま(ローカル再正規化はしない)、
    // 非線形カーブだけをシーン行ミニ波形と同じ考え方で適用する。
    const scaledPeaks = scaleWaveformPeaksGlobal(slicedPeaks);
    if (scaledPeaks.length) {
      const barWidth = Math.max(1, width / scaledPeaks.length);
      for (let i = 0; i < scaledPeaks.length; i += 1) {
        const barHeight = scaledPeaks[i] > 0 ? Math.max(1, scaledPeaks[i] * (HEIGHT - 14)) : 0;
        const x = (i / scaledPeaks.length) * width;
        ctx.fillStyle = "rgba(69, 139, 195, 0.55)";
        ctx.fillRect(x, HEIGHT - 8 - barHeight, Math.max(1, barWidth), barHeight);
      }
    }

    for (const marker of flagMarkers) {
      const x = msToX(marker.ms);
      ctx.fillStyle = SEVERITY_COLOR[marker.severity] || SEVERITY_COLOR.low;
      ctx.fillRect(x - 1.5, 0, 3, 6);
    }

    const playheadX = msToX(currentMs);
    ctx.strokeStyle = "#d92d20";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, HEIGHT);
    ctx.stroke();
  }, [width, peaks, binMs, durationMs, currentMs, flagMarkers]);

  function handleClick(event: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / Math.max(1, rect.width);
    onSeek(Math.max(0, Math.min(durationMs, ratio * durationMs)));
  }

  return (
    <div className="sceneNavBar">
      <span className="sceneNavBarTime">
        {formatTime(currentMs)} / {formatTime(durationMs)}
      </span>
      <div className="sceneNavBarWaveformWrap" ref={wrapRef}>
        <canvas className="sceneNavBarCanvas" onClick={handleClick} ref={canvasRef} />
      </div>
    </div>
  );
}
