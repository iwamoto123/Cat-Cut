import { useEffect, useRef, useState } from "react";
import type { Scene } from "../lib/scenes";
import { msFromScrubPosition } from "../lib/playhead";
import {
  interpolateWaveformHeights,
  scaleWaveformPeaksLocal,
  sliceWaveformPeaks,
  smoothWaveformHeights,
} from "../lib/waveform";
import type { EdgeTrimEdge } from "../lib/edgeTrim";

const HEIGHT = 40;
/**
 * 端ハンドルのヒット領域(波形ストリップ左右のpx幅)。改善3「端ドラッグ改善」節: 誤操作防止は
 * 300ms長押しではなく「当たり判定を広げてスクラブ領域と分離する」ことで担保するため、
 * Phase 3時点の8pxから拡大した。
 */
const EDGE_HANDLE_HIT_PX = 14;

export type EdgeDragTooltip = { edge: EdgeTrimEdge; label: string } | null;

type Props = {
  scene: Scene;
  peaks: number[];
  /** 改善2(波形の縦スケール改善): 録音全体のグローバルピーク(呼び出し側で1回だけ計算した値)。 */
  globalPeakMax: number;
  binMs: number;
  /** IntersectionObserverによる仮想化: falseのときはcanvas描画をスキップする(重い処理を間引く)。 */
  visible: boolean;
  /**
   * 改善3(再生バーの見た目変更): 現在シーンの場合のみ再生バー位置(ms)を渡す。null/undefinedの
   * 場合は描画しない。行を貫通する赤縦線は廃止し、再生バーはこのストリップ内にのみ描画する。
   */
  playheadMs?: number | null;
  onSeek: (ms: number) => void;
  /** Phase 2: 波形上のマウスホバーで再生バーを追従させる(スクラブ)。 */
  onHoverSeek?: (ms: number) => void;
  /**
   * 改善5-6(ハサミモード): B キーでトグルするハサミモード。ONの間は波形上のホバーで
   * 縦の切り込み線プレビューを表示し、クリックで即splitSceneAtMs相当の分割を行う
   * (onHoverSeek/onSeekは呼ばない)。旧「右クリック→切り込みメニュー→Enterで分割」の
   * 2段階操作はこのワンクリック方式に置き換えたため、右クリックメニューは廃止した。
   */
  scissorsMode?: boolean;
  /** 改善5-6(ハサミモード): 波形上をクリックした位置(ms)で即座に分割する。 */
  onScissorsCut?: (ms: number) => void;
  /** Phase 3: 端ハンドルのドラッグが開始した。改善3で300ms長押しを廃止し、押下即開始になった。 */
  onEdgeDragStart?: (edge: EdgeTrimEdge) => void;
  /** Phase 3: ドラッグ中、ポインタ位置から算出した絶対ms(スナップ・クランプ前の生値)。 */
  onEdgeDragMove?: (edge: EdgeTrimEdge, rawTargetMs: number, chipSnapToleranceMs: number) => void;
  /** Phase 3: ドラッグ終了(ポインタを離した)。この呼び出しでUndoスタックに1操作としてコミットする。 */
  onEdgeDragEnd?: (edge: EdgeTrimEdge, rawTargetMs: number, chipSnapToleranceMs: number) => void;
  /** Phase 3: このストリップが現在ドラッグ中の場合のツールチップ表示内容(「+0.24s」等)。 */
  dragTooltip?: EdgeDragTooltip;
  /** Phase 3: 連動ロール中、隣接シーンとして受動的にハイライトすべき端("start"|"end")。 */
  highlightEdge?: EdgeTrimEdge | null;
};

const COLOR_BG = "#f8fafc";
const COLOR_BAR = "rgba(69, 139, 195, 0.7)";
const COLOR_BAR_DELETED = "rgba(148, 163, 184, 0.55)";
const COLOR_HATCH = "rgba(107, 114, 128, 0.35)";
const COLOR_CUT_MARK = "#475467";

/**
 * 改善3(端ドラッグ改善): 300ms長押し判定を廃止したため、ポインタダウン時点で即座に
 * ドラッグを開始する(「activated」フラグやタイマーは不要になった)。
 */
type ActiveEdgeDrag = {
  edge: EdgeTrimEdge;
  pointerId: number;
  startClientX: number;
  startMs: number;
  msPerPx: number;
};

/** 片側(ベースラインから上方向のみ)のミニ波形。シーン行カード・全体ナビバー共通の描画方針。 */
export function SceneWaveformStrip({
  scene,
  peaks,
  globalPeakMax,
  binMs,
  visible,
  playheadMs,
  onSeek,
  onHoverSeek,
  scissorsMode,
  onScissorsCut,
  onEdgeDragStart,
  onEdgeDragMove,
  onEdgeDragEnd,
  dragTooltip,
  highlightEdge,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(320);
  const dragRef = useRef<ActiveEdgeDrag | null>(null);
  const justDraggedRef = useRef(false);
  const [activeEdge, setActiveEdge] = useState<EdgeTrimEdge | null>(null);
  const [hoverEdge, setHoverEdge] = useState<EdgeTrimEdge | null>(null);
  /** 改善5-6(ハサミモード): 波形上ホバー中の切り込み線プレビュー位置(px)。ホバー解除でnull。 */
  const [scissorsHoverX, setScissorsHoverX] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(Math.max(40, entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!scissorsMode) setScissorsHoverX(null);
  }, [scissorsMode]);

  useEffect(() => {
    if (!visible) return;
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
    ctx.fillStyle = COLOR_BG;
    ctx.fillRect(0, 0, width, HEIGHT);

    const rangeStartMs = scene.sourceStartMs;
    const rangeEndMs = scene.sourceEndMs;
    const spanMs = Math.max(1, rangeEndMs - rangeStartMs);
    const msToX = (ms: number) => ((ms - rangeStartMs) / spanMs) * width;

    const slicedPeaks = sliceWaveformPeaks(peaks, binMs, rangeStartMs, rangeEndMs);
    // 改善2(波形の縦スケール改善): 表示範囲内(このシーンのストリップ内)のローカル最大値を基準に
    // 正規化し、非線形カーブで小音量を持ち上げる。ノイズフロアの判定だけは録音全体の
    // グローバルピーク(globalPeakMax、呼び出し側で1回だけ計算済み)を基準にすることで、
    // 録音全体で見れば無音同然の区間がローカル内で相対的に「最大」になって持ち上がるのを防ぐ。
    const scaledPeaks = scaleWaveformPeaksLocal(slicedPeaks, { globalMax: globalPeakMax });
    if (scaledPeaks.length) {
      // 改善3(波形の描画改善): ビン単位(20msなど粗い間隔)の棒グラフではなく、1pxごとに
      // 補間・平滑化した高さで面グラフ的に塗る。棒同士の隙間が無いため「細く高密度」に見え、
      // 平滑化により輪郭の角が立たずなめらかになる。
      const heights = smoothWaveformHeights(interpolateWaveformHeights(scaledPeaks, width), 2);
      const barHeightAt = (value: number) => (value > 0 ? Math.max(1, value * (HEIGHT - 4)) : 0);
      const areaPath = new Path2D();
      areaPath.moveTo(0, HEIGHT);
      for (let x = 0; x < heights.length; x += 1) {
        areaPath.lineTo(x, HEIGHT - barHeightAt(heights[x]));
      }
      areaPath.lineTo(heights.length - 1, HEIGHT);
      areaPath.closePath();
      ctx.fillStyle = COLOR_BAR;
      ctx.fill(areaPath);
      // 上端の輪郭をわずかにストロークし、角を柔らかく見せる(fillだけだとジャギーが目立つため)。
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.lineWidth = 1;
      ctx.strokeStyle = COLOR_BAR;
      ctx.stroke(areaPath);
    }

    // 削除済みチップの区間はハッチング風の斜線オーバーレイで示す(モックアップの網掛け表現の近似)。
    for (const word of scene.words) {
      if (!word.deleted) continue;
      const x1 = Math.max(0, msToX(Math.max(word.startMs, rangeStartMs)));
      const x2 = Math.min(width, msToX(Math.min(word.endMs, rangeEndMs)));
      if (x2 <= x1) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x1, 0, x2 - x1, HEIGHT);
      ctx.clip();
      ctx.fillStyle = COLOR_BAR_DELETED;
      ctx.fillRect(x1, 0, x2 - x1, HEIGHT);
      ctx.strokeStyle = COLOR_HATCH;
      ctx.lineWidth = 1;
      for (let x = x1 - HEIGHT; x < x2 + HEIGHT; x += 6) {
        ctx.beginPath();
        ctx.moveTo(x, HEIGHT);
        ctx.lineTo(x + HEIGHT, 0);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Phase 2: 右クリックで置いた切り込み(cutMark)を点線＋ハサミ表示する。
    for (const mark of scene.cutMarks) {
      const x = msToX(mark);
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = COLOR_CUT_MARK;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, HEIGHT);
      ctx.stroke();
      ctx.restore();
      ctx.font = "11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = COLOR_CUT_MARK;
      ctx.fillText("✂", x, 11);
    }
  }, [visible, width, peaks, globalPeakMax, binMs, scene]);

  function xFromEvent(event: { clientX: number }): number {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    return event.clientX - rect.left;
  }

  /** ポインタのx位置が端ハンドルのヒット領域内にあれば該当edgeを返す。 */
  function edgeAtX(x: number): EdgeTrimEdge | null {
    if (x <= EDGE_HANDLE_HIT_PX) return "start";
    if (x >= width - EDGE_HANDLE_HIT_PX) return "end";
    return null;
  }

  function handleClick(event: React.MouseEvent<HTMLCanvasElement>) {
    if (justDraggedRef.current) {
      justDraggedRef.current = false;
      return;
    }
    // 改善3(端ドラッグ改善): 端ハンドル領域は「つまみ」専用とし、波形本体のシーク領域とは
    // 分離する(誤操作防止)。ハンドル上のクリックはシークを発生させない。
    if (edgeAtX(xFromEvent(event))) return;
    const ms = msFromScrubPosition(scene, xFromEvent(event), width);
    // 改善5-6(ハサミモード): ONの間はクリックで即分割する(通常のシークは発生させない)。
    if (scissorsMode) {
      onScissorsCut?.(ms);
      return;
    }
    onSeek(ms);
  }

  function handleMouseMove(event: React.MouseEvent<HTMLCanvasElement>) {
    if (dragRef.current) return;
    if (edgeAtX(xFromEvent(event))) {
      setScissorsHoverX(null);
      return;
    }
    if (scissorsMode) {
      setScissorsHoverX(xFromEvent(event));
      return;
    }
    if (!onHoverSeek) return;
    onHoverSeek(msFromScrubPosition(scene, xFromEvent(event), width));
  }

  function handleMouseLeaveCanvas() {
    setScissorsHoverX(null);
  }

  function computeChipSnapToleranceMs(msPerPx: number): number {
    const SNAP_PX = 15;
    return SNAP_PX * msPerPx;
  }

  /**
   * 改善3(端ドラッグ改善): 300ms長押しを廃止し、端ハンドル領域を押した時点で即座にドラッグを
   * 開始する。誤操作防止は「長押し」ではなく「当たり判定の分離(edgeAtX)」で担保する。
   */
  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    // 改善5-6(ハサミモード): ONの間は端トリムのドラッグを無効化し、クリック分割に専念させる。
    if (scissorsMode) return;
    if (!onEdgeDragMove || !onEdgeDragEnd) return;
    const x = xFromEvent(event);
    const edge = edgeAtX(x);
    setHoverEdge(edge);
    if (!edge) return;
    event.preventDefault();
    const canvas = canvasRef.current;
    canvas?.setPointerCapture(event.pointerId);
    const startMs = edge === "start" ? scene.sourceStartMs : scene.sourceEndMs;
    const spanMs = Math.max(1, scene.sourceEndMs - scene.sourceStartMs);
    const msPerPx = spanMs / Math.max(1, width);
    dragRef.current = { edge, pointerId: event.pointerId, startClientX: event.clientX, startMs, msPerPx };
    setActiveEdge(edge);
    onEdgeDragStart?.(edge);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current;
    if (!drag) {
      // ホバー中の端ハンドル表示切り替えのみ担当する(再生バー追従は既存のonMouseMoveに任せ、二重発火を避ける)。
      setHoverEdge(edgeAtX(xFromEvent(event)));
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const deltaPx = event.clientX - drag.startClientX;
    const rawTargetMs = drag.startMs + deltaPx * drag.msPerPx;
    onEdgeDragMove?.(drag.edge, rawTargetMs, computeChipSnapToleranceMs(drag.msPerPx));
  }

  function endActiveDrag(event: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    canvasRef.current?.releasePointerCapture(event.pointerId);
    const deltaPx = event.clientX - drag.startClientX;
    const rawTargetMs = drag.startMs + deltaPx * drag.msPerPx;
    justDraggedRef.current = true;
    setActiveEdge(null);
    onEdgeDragEnd?.(drag.edge, rawTargetMs, computeChipSnapToleranceMs(drag.msPerPx));
    dragRef.current = null;
  }

  function handlePointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    endActiveDrag(event);
  }

  function handlePointerCancel(event: React.PointerEvent<HTMLCanvasElement>) {
    endActiveDrag(event);
  }

  function handlePointerLeave() {
    if (!dragRef.current) setHoverEdge(null);
  }

  const showStartHandle = activeEdge === "start" || hoverEdge === "start" || highlightEdge === "start";
  const showEndHandle = activeEdge === "end" || hoverEdge === "end" || highlightEdge === "end";
  const edgeCursor = hoverEdge || activeEdge ? "ew-resize" : "pointer";

  const sceneSpanMs = Math.max(1, scene.sourceEndMs - scene.sourceStartMs);
  const playheadPercent =
    playheadMs != null
      ? Math.max(0, Math.min(100, ((playheadMs - scene.sourceStartMs) / sceneSpanMs) * 100))
      : null;

  return (
    <div className="sceneWaveformWrap" ref={wrapRef}>
      {visible ? (
        <canvas
          className="sceneWaveformCanvas"
          onClick={handleClick}
          onMouseLeave={handleMouseLeaveCanvas}
          onMouseMove={handleMouseMove}
          onPointerCancel={handlePointerCancel}
          onPointerDown={handlePointerDown}
          onPointerLeave={handlePointerLeave}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          ref={canvasRef}
          style={{ cursor: scissorsMode ? "crosshair" : edgeCursor }}
        />
      ) : (
        <div className="sceneWaveformPlaceholder" style={{ height: HEIGHT }} />
      )}
      {/* 改善5-6(ハサミモード): 実際の再生バーとは独立した、ホバー位置の切り込み線プレビュー。 */}
      {visible && scissorsMode && scissorsHoverX != null && (
        <div className="sceneScissorsPreviewLine" style={{ left: scissorsHoverX }} />
      )}
      {/* 改善3(再生バーの見た目変更): 行貫通の赤縦線は廃止し、波形ストリップ内だけに薄め・細めの
          縦線で表示する。全体ナビバー(SceneNavBar)側の再生ヘッドは別コンポーネントのため維持される。 */}
      {visible && playheadPercent != null && (
        <div className="sceneWaveformPlayhead" style={{ left: `${playheadPercent}%` }} />
      )}
      {visible && (
        <>
          <div
            className={[
              "sceneEdgeHandle",
              "start",
              activeEdge === "start" ? "dragging" : "",
              highlightEdge === "start" ? "linkedHighlight" : "",
              showStartHandle ? "visible" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          />
          <div
            className={[
              "sceneEdgeHandle",
              "end",
              activeEdge === "end" ? "dragging" : "",
              highlightEdge === "end" ? "linkedHighlight" : "",
              showEndHandle ? "visible" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          />
        </>
      )}
      {dragTooltip && (
        <div className={`sceneEdgeTooltip ${dragTooltip.edge}`}>{dragTooltip.label}</div>
      )}
    </div>
  );
}
