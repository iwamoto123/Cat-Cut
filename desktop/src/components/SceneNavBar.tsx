import { useEffect, useRef, useState } from "react";
import { usePlayheadSourceMs } from "../lib/playheadStore";
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
  flagMarkers: NavFlagMarker[];
  onSeek: (ms: number) => void;
  /** W11-3: ドラッグスクラブ開始時に呼ぶ(再生中なら親が一時停止する)。 */
  onScrubStart?: () => void;
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

/** ドラッグスクラブ扱いにするまでのポインタ移動しきい値(px)。クリックとの区別に使う。 */
const SCRUB_DRAG_THRESHOLD_PX = 3;

/**
 * 画面最下部の全体ナビバー: 全編の片側波形＋疑義フラグの色マーカー＋再生ヘッド。クリックでジャンプする。
 * W11-3: ドラッグでスクラブ(pointermove中は都度シークして追従、pointerupで確定)。
 * 単クリックの挙動は従来どおり(再生中でも一時停止しない)。ドラッグと判定した時点で
 * onScrubStart を呼び、再生中なら親が一時停止する。
 * W19-A3: 再生ヘッド位置はpropではなくplayheadStoreを直接購読する(Appを再レンダリングさせない。
 * このコンポーネント自体は毎フレーム再レンダリングされるが、canvasはdeps外なので再描画されない)。
 */
export function SceneNavBar({ peaks, binMs, durationMs, flagMarkers, onSeek, onScrubStart }: Props) {
  const currentMs = usePlayheadSourceMs();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(800);
  // W11-3: ドラッグスクラブ中の状態(startX=クリックとの区別用、scrubbed=しきい値超過済みか)
  const scrubRef = useRef<{ startX: number; scrubbed: boolean } | null>(null);

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
    // W19-A1: 再生ヘッドはcanvasに描かない(CSSオーバーレイに分離)。currentMsをdepsから外し、
    // 再生中の毎フレーム再描画(全編波形+フラグの描き直し)を根絶する。
  }, [width, peaks, binMs, durationMs, flagMarkers]);

  /** クリック・スクラブ共通のシーク(clientX→全編ms)。 */
  function seekForClientX(clientX: number) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = (clientX - rect.left) / Math.max(1, rect.width);
    onSeek(Math.max(0, Math.min(durationMs, ratio * durationMs)));
  }

  // W11-3: pointerdownで即シーク(従来クリックより反応が早い)＋キャプチャしてドラッグ追従。
  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    scrubRef.current = { startX: event.clientX, scrubbed: false };
    seekForClientX(event.clientX);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const scrub = scrubRef.current;
    if (!scrub) return;
    if (!scrub.scrubbed) {
      // クリックの微小ブレはドラッグ扱いしない(単クリック時に再生を止めないため)
      if (Math.abs(event.clientX - scrub.startX) < SCRUB_DRAG_THRESHOLD_PX) return;
      scrub.scrubbed = true;
      onScrubStart?.();
    }
    seekForClientX(event.clientX);
  }

  function handlePointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    const scrub = scrubRef.current;
    if (!scrub) return;
    scrubRef.current = null;
    if (scrub.scrubbed) seekForClientX(event.clientX);
  }

  // W19-A1: 再生ヘッドはSceneWaveformStripと同方式のCSSオーバーレイ(left:%)で描画する。
  const playheadPercent = Math.max(0, Math.min(100, (currentMs / Math.max(1, durationMs)) * 100));

  return (
    <div className="sceneNavBar">
      <span className="sceneNavBarTime">
        {formatTime(currentMs)} / {formatTime(durationMs)}
      </span>
      <div className="sceneNavBarWaveformWrap" ref={wrapRef}>
        <canvas
          className="sceneNavBarCanvas"
          onPointerCancel={handlePointerUp}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          ref={canvasRef}
        />
        <div className="sceneNavBarPlayhead" style={{ left: `${playheadPercent}%` }} />
      </div>
    </div>
  );
}
