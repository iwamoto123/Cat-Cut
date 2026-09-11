import { useEffect, useMemo, useRef, useState } from "react";
import { computeSceneKeptSubRanges, type Scene } from "../lib/scenes";
import { msFromScrubPosition } from "../lib/playhead";
import {
  interpolateWaveformHeights,
  scaleWaveformPeaksLocal,
  sliceWaveformPeaks,
  smoothWaveformHeights,
} from "../lib/waveform";
import { type EdgeTrimEdge } from "../lib/edgeTrim";
import { cutSceneRangeMs, MIN_RANGE_CUT_MS, RANGE_CUT_ACTIVATE_PX } from "../lib/rangeCut";
import { previewClickCut } from "../lib/clickCut";
import {
  beginWaveformGesture,
  formatWaveformTime,
  moveWaveformGesture,
  sameWaveformEditScene,
  waveformGesturePosition,
  waveformSnapToleranceMs,
  type WaveformGesture,
  type WaveformPointer,
} from "../lib/waveformGesture";
import "./SceneWaveformPrecision.css";

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
   * Bキーでトグルするハサミモード。ONの間は端ハンドルより範囲ドラッグを優先し、
   * 8px超の横ドラッグで範囲カット。クリックは1点目に印、2点目で間をカットする。
   * 発話より外側の先頭/末尾余白は1クリックで端までカットする。
   */
  scissorsMode?: boolean;
  /** 旧ハサミクリック分割とのprops互換用。波形上のクリックでは呼び出さない。 */
  onScissorsCut?: (ms: number) => void;
  /** Phase 3: 端ハンドルのドラッグが開始した。改善3で300ms長押しを廃止し、押下即開始になった。 */
  onEdgeDragStart?: (edge: EdgeTrimEdge) => void;
  onEdgeDragCancel?: () => void;
  /** Pause playback and cancel pending hover seeks before taking the pointer. */
  onWaveformGestureStart?: () => void;
  /** Phase 3: ドラッグ中、ポインタ位置から算出した絶対ms(スナップ・クランプ前の生値)。 */
  onEdgeDragMove?: (edge: EdgeTrimEdge, rawTargetMs: number, chipSnapToleranceMs: number) => void;
  /** Phase 3: ドラッグ終了(ポインタを離した)。この呼び出しでUndoスタックに1操作としてコミットする。 */
  onEdgeDragEnd?: (edge: EdgeTrimEdge, rawTargetMs: number, chipSnapToleranceMs: number) => void;
  /** Phase 3: このストリップが現在ドラッグ中の場合のツールチップ表示内容(「+0.24s」等)。 */
  dragTooltip?: EdgeDragTooltip;
  /** Phase 3: 連動ロール中、隣接シーンとして受動的にハイライトすべき端("start"|"end")。 */
  highlightEdge?: EdgeTrimEdge | null;
  /**
   * W20-1(範囲選択カット): 通常モード(ハサミOFF)で波形本体(端ハンドル外)を横8px超ドラッグ
   * すると範囲選択モードになり、ポインタを離した時点でこのコールバックが発火する。
   * エッジトリムと同じく生のms(スナップ前)+チップスナップ許容msを渡し、
   * 確定側(cutSceneRangeMs)がドラッグ中プレビューと同一規則でスナップする(WYSIWYG)。
   */
  onRangeCut?: (rawStartMs: number, rawEndMs: number, chipSnapToleranceMs: number) => void;
};

const COLOR_BG = "#f8fafc";
const COLOR_BAR = "rgba(69, 139, 195, 0.7)";
const COLOR_BAR_DELETED = "rgba(148, 163, 184, 0.55)";
const COLOR_HATCH = "rgba(107, 114, 128, 0.35)";
const COLOR_CUT_MARK = "#475467";

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
  onEdgeDragStart,
  onEdgeDragCancel,
  onWaveformGestureStart,
  onEdgeDragMove,
  onEdgeDragEnd,
  dragTooltip,
  highlightEdge,
  onRangeCut,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(320);
  const gestureRef = useRef<WaveformGesture | null>(null);
  const [gestureView, setGestureView] = useState<WaveformGesture | null>(null);
  const justDraggedRef = useRef(false);
  const [hoverEdge, setHoverEdge] = useState<EdgeTrimEdge | null>(null);
  const [clickAnchor, setClickAnchor] = useState<{ scene: Scene; rawMs: number; toleranceMs: number } | null>(null);
  const clickAnchorRef = useRef(clickAnchor);
  clickAnchorRef.current = clickAnchor;
  const [clickHover, setClickHover] = useState<{ rawMs: number; altKey: boolean } | null>(null);
  const hasClickInteraction = clickAnchor != null || clickHover != null;
  const sceneRef = useRef(scene);
  const lastAnchorSceneRef = useRef(scene);
  sceneRef.current = scene;
  const keptRanges = useMemo(() => computeSceneKeptSubRanges(scene), [scene]);
  const frameRef = useRef<number | null>(null);
  const removeGestureListenersRef = useRef<(() => void) | null>(null);
  const callbacksRef = useRef({ onEdgeDragStart, onEdgeDragMove, onEdgeDragEnd, onEdgeDragCancel, onRangeCut });
  callbacksRef.current = { onEdgeDragStart, onEdgeDragMove, onEdgeDragEnd, onEdgeDragCancel, onRangeCut };
  const activeEdge = gestureView?.kind !== "range" && gestureView?.activated ? gestureView.kind : null;

  function clearClickAnchor() {
    clickAnchorRef.current = null;
    setClickAnchor(null);
  }

  useEffect(() => {
    if (!scissorsMode || !visible || !sameWaveformEditScene(lastAnchorSceneRef.current, scene)) {
      clearClickAnchor();
      setClickHover(null);
    }
    lastAnchorSceneRef.current = scene;
  }, [scene, scissorsMode, visible]);

  useEffect(() => {
    if (!scissorsMode || !hasClickInteraction) return;
    const cancel = () => { clearClickAnchor(); setClickHover(null); };
    const handleKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape" || event.key === "Tab" || event.key.toLowerCase() === "b" ||
        ["ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key) ||
        ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z")) cancel();
      if (event.key === "Alt") setClickHover((current) => current ? { ...current, altKey: event.type === "keydown" } : null);
    };
    const handleOutsidePointer = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) cancel();
    };
    window.addEventListener("keydown", handleKey, true);
    window.addEventListener("keyup", handleKey, true);
    window.addEventListener("pointerdown", handleOutsidePointer, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", handleKey, true);
      window.removeEventListener("keyup", handleKey, true);
      window.removeEventListener("pointerdown", handleOutsidePointer, true);
      window.removeEventListener("blur", cancel);
    };
  }, [scissorsMode, hasClickInteraction]);

  useEffect(() => () => {
    if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
    removeGestureListenersRef.current?.();
    if (gestureRef.current?.activated && gestureRef.current.kind !== "range") {
      callbacksRef.current.onEdgeDragCancel?.();
    }
    gestureRef.current = null;
  }, []);

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
    const scaledPeaks = scaleWaveformPeaksLocal(slicedPeaks, { globalMax: globalPeakMax, preserveQuietPeaks: true });
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

    if (peaks.length) {
      // A silent interval has a visible baseline; an unloaded canvas must not look like silence.
      ctx.fillStyle = "rgba(69, 139, 195, 0.4)";
      ctx.fillRect(0, HEIGHT - 1, width, 1);
      const status = !slicedPeaks.length ? "この範囲の音声がありません"
        : slicedPeaks.every((peak) => peak === 0) ? "無音" : null;
      if (status) {
        ctx.font = "10px sans-serif";
        ctx.fillStyle = "#667085";
        ctx.textAlign = "center";
        ctx.fillText(status, width / 2, HEIGHT / 2 + 3, Math.max(1, width - 32));
      }
    }

    // The authoritative retained intervals also show wordless cuts after text boxes merge.
    // Draw their complement once, avoiding overlapping deleted-word hatches.
    const removedRanges: Array<{ startMs: number; endMs: number }> = [];
    let keptCursorMs = rangeStartMs;
    for (const range of keptRanges) {
      if (range.startMs > keptCursorMs) removedRanges.push({ startMs: keptCursorMs, endMs: range.startMs });
      keptCursorMs = Math.max(keptCursorMs, range.endMs);
    }
    if (keptCursorMs < rangeEndMs) removedRanges.push({ startMs: keptCursorMs, endMs: rangeEndMs });
    for (const range of removedRanges) {
      const x1 = Math.max(0, msToX(range.startMs));
      const x2 = Math.min(width, msToX(range.endMs));
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
  }, [visible, width, peaks, globalPeakMax, binMs, scene, keptRanges]);

  function xFromEvent(event: { clientX: number }): number {
    const rect = canvasRef.current?.getBoundingClientRect();
    return rect ? event.clientX - rect.left : 0;
  }

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
    if (event.button !== 0 || scissorsMode || edgeAtX(xFromEvent(event))) return;
    onSeek(msFromScrubPosition(scene, xFromEvent(event), width));
  }

  function handleMouseMove(event: React.MouseEvent<HTMLCanvasElement>) {
    // Suppress hover from the press, including the small movement before activation.
    if (gestureRef.current || event.buttons || scissorsMode || edgeAtX(xFromEvent(event))) return;
    onHoverSeek?.(msFromScrubPosition(scene, xFromEvent(event), width));
  }

  function cancelFrame() {
    if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }

  function previewGesture() {
    const gesture = gestureRef.current;
    if (!gesture?.activated) return;
    setGestureView(gesture);
    if (gesture.kind !== "range") {
      const position = waveformGesturePosition(gesture);
      if (position.moved) callbacksRef.current.onEdgeDragMove?.(gesture.kind, position.rawTargetMs, position.chipSnapToleranceMs);
      else callbacksRef.current.onEdgeDragCancel?.();
    }
  }

  function schedulePreview() {
    if (frameRef.current != null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      previewGesture();
    });
  }

  function updateGesture(pointer: WaveformPointer) {
    const previous = gestureRef.current;
    if (!previous || pointer.pointerId !== previous.pointerId) return;
    const next = moveWaveformGesture(previous, pointer);
    gestureRef.current = next;
    if (next.activated && !previous.activated) clearClickAnchor();
    if (next.activated && !previous.activated && next.kind !== "range") {
      callbacksRef.current.onEdgeDragStart?.(next.kind);
    }
    if (next.activated) schedulePreview();
  }

  function finishGesture(commit: boolean, pointer?: WaveformPointer) {
    let gesture = gestureRef.current;
    if (!gesture || (pointer && pointer.pointerId !== gesture.pointerId)) return;
    if (pointer) gesture = moveWaveformGesture(gesture, pointer);
    // Clear before releasePointerCapture: lostpointercapture must not commit/cancel twice.
    gestureRef.current = null;
    cancelFrame();
    removeGestureListenersRef.current?.();
    removeGestureListenersRef.current = null;
    setGestureView(null);
    setHoverEdge(null);
    const canvas = canvasRef.current;
    if (canvas?.hasPointerCapture(gesture.pointerId)) canvas.releasePointerCapture(gesture.pointerId);
    justDraggedRef.current = !commit || gesture.activated || gesture.kind !== "range";
    if (gesture.kind === "range") {
      if (!commit || !sameWaveformEditScene(gesture.scene, sceneRef.current)) {
        clearClickAnchor();
        setClickHover(null);
        return;
      }
      if (!gesture.activated) {
        if (scissorsMode && sameWaveformEditScene(gesture.scene, sceneRef.current) &&
          Math.abs(gesture.current.clientX - gesture.startClientX) <= RANGE_CUT_ACTIVATE_PX &&
          Math.abs(gesture.current.clientY - gesture.startClientY) <= RANGE_CUT_ACTIVATE_PX) {
          const x = gesture.startX + gesture.current.clientX - gesture.startClientX;
          const rawMs = msFromScrubPosition(gesture.scene, x, gesture.widthPx);
          const tolerance = waveformSnapToleranceMs((gesture.scene.sourceEndMs - gesture.scene.sourceStartMs) / gesture.widthPx, gesture.current.altKey);
          const anchor = clickAnchorRef.current && sameWaveformEditScene(clickAnchorRef.current.scene, gesture.scene) ? clickAnchorRef.current.rawMs : null;
          const preview = previewClickCut(gesture.scene, rawMs, anchor, { chipSnapToleranceMs: tolerance });
          if (preview.kind === "cut") {
            clearClickAnchor();
            setClickHover(null);
            callbacksRef.current.onRangeCut?.(preview.rawStartMs, preview.rawEndMs, tolerance);
          } else if (preview.kind === "anchor") {
            const nextAnchor = { scene: gesture.scene, rawMs, toleranceMs: tolerance };
            clickAnchorRef.current = nextAnchor;
            setClickAnchor(nextAnchor);
            setClickHover(null);
          }
        }
        return;
      }
      clearClickAnchor();
      setClickHover(null);
      const position = waveformGesturePosition(gesture);
      const preview = cutSceneRangeMs([gesture.scene], gesture.scene.id, position.range.startMs, position.range.endMs, {
        chipSnapToleranceMs: position.chipSnapToleranceMs,
      });
      if (preview.mode !== "none") {
        callbacksRef.current.onRangeCut?.(position.range.startMs, position.range.endMs, position.chipSnapToleranceMs);
      }
      return;
    }
    const position = waveformGesturePosition(gesture);
    if (commit && gesture.activated && position.moved) {
      callbacksRef.current.onEdgeDragEnd?.(gesture.kind, position.rawTargetMs, position.chipSnapToleranceMs);
    } else {
      callbacksRef.current.onEdgeDragCancel?.();
    }
  }

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0 || !event.isPrimary || gestureRef.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const edge = scissorsMode ? null : edgeAtX(x);
    if (edge ? !onEdgeDragMove || !onEdgeDragEnd : !onRangeCut) return;
    event.preventDefault();
    event.stopPropagation();
    justDraggedRef.current = false;
    gestureRef.current = beginWaveformGesture(edge ?? "range", scene, rect.width, x, event);
    // Capture at press: starting near an edge and leaving before 8 px must still finish reliably.
    event.currentTarget.setPointerCapture(event.pointerId);
    setHoverEdge(edge);
    onWaveformGestureStart?.();
    const handleKey = (keyEvent: KeyboardEvent) => {
      if (keyEvent.isComposing) return;
      if (keyEvent.type === "keydown" && (
        keyEvent.key === "Escape" || ((keyEvent.metaKey || keyEvent.ctrlKey) && keyEvent.key.toLowerCase() === "z")
      )) {
        keyEvent.preventDefault();
        keyEvent.stopImmediatePropagation();
        finishGesture(false);
      } else if (keyEvent.key === "Alt") {
        const active = gestureRef.current;
        if (active) updateGesture({ ...active.current, altKey: keyEvent.type === "keydown" });
      } else if (keyEvent.key !== "Shift" && keyEvent.key !== "Meta" && keyEvent.key !== "Control") {
        // Editing/playback shortcuts cannot mutate the scene underneath a held pointer.
        keyEvent.preventDefault();
        keyEvent.stopImmediatePropagation();
      }
    };
    const handleBlur = () => finishGesture(false);
    window.addEventListener("keydown", handleKey, true);
    window.addEventListener("keyup", handleKey, true);
    window.addEventListener("blur", handleBlur);
    removeGestureListenersRef.current = () => {
      window.removeEventListener("keydown", handleKey, true);
      window.removeEventListener("keyup", handleKey, true);
      window.removeEventListener("blur", handleBlur);
    };
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const gesture = gestureRef.current;
    if (!gesture) {
      const x = xFromEvent(event);
      setHoverEdge(scissorsMode ? null : edgeAtX(x));
      if (scissorsMode) setClickHover({ rawMs: msFromScrubPosition(scene, x, width), altKey: event.altKey });
      return;
    }
    if (event.pointerId !== gesture.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    updateGesture(event);
  }

  function handlePointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!gestureRef.current || event.pointerId !== gestureRef.current.pointerId) return;
    event.stopPropagation();
    finishGesture(true, event);
  }

  function handlePointerCancel(event: React.PointerEvent<HTMLCanvasElement>) {
    if (event.pointerId === gestureRef.current?.pointerId) finishGesture(false);
  }

  function handlePointerLeave() {
    if (!gestureRef.current) {
      setHoverEdge(null);
      setClickHover(null);
    }
  }

  const showStartHandle = activeEdge === "start" || hoverEdge === "start" || highlightEdge === "start";
  const showEndHandle = activeEdge === "end" || hoverEdge === "end" || highlightEdge === "end";
  const edgeCursor = hoverEdge || activeEdge ? "ew-resize" : "pointer";
  const sceneSpanMs = Math.max(1, scene.sourceEndMs - scene.sourceStartMs);
  const playheadPercent = playheadMs != null
    ? Math.max(0, Math.min(100, ((playheadMs - scene.sourceStartMs) / sceneSpanMs) * 100))
    : null;
  const validAnchor = scissorsMode && clickAnchor && sameWaveformEditScene(clickAnchor.scene, scene) ? clickAnchor : null;
  const clickPreview = scissorsMode && !gestureView && clickHover
    ? previewClickCut(scene, clickHover.rawMs, validAnchor?.rawMs ?? null, {
      chipSnapToleranceMs: waveformSnapToleranceMs(sceneSpanMs / width, clickHover.altKey),
    })
    : null;
  const anchorMs = validAnchor ? (clickPreview?.anchorMs ?? previewClickCut(scene, validAnchor.rawMs, null, {
    chipSnapToleranceMs: validAnchor.toleranceMs,
  }).pointMs) : null;
  const clickReadout = clickPreview?.kind === "cut"
    ? `${formatWaveformTime(clickPreview.appliedStartMs)} → ${formatWaveformTime(clickPreview.appliedEndMs)}  −${(clickPreview.removedDurationMs / 1000).toFixed(3)} 秒`
    : clickPreview?.unavailableReason === "removed"
      ? "カット済みの区間です"
      : clickPreview?.kind === "none" && validAnchor ? "2点目をもう少し離して選択 · 最小 0.080 秒"
        : validAnchor ? `${formatWaveformTime(anchorMs!)} に切り込み · 反対側をクリック`
        : clickPreview?.kind === "none" ? "もう少し内側へ · 最小 0.080 秒"
          : clickPreview ? `${formatWaveformTime(clickPreview.pointMs)} に1点目の切り込み` : null;

  let rangeCutOverlay: { leftPx: number; widthPx: number; label: string; valid: boolean } | null = null;
  if (gestureView?.kind === "range") {
    const position = waveformGesturePosition(gestureView);
    const preview = cutSceneRangeMs([gestureView.scene], gestureView.scene.id, position.range.startMs, position.range.endMs, {
      chipSnapToleranceMs: position.chipSnapToleranceMs,
    });
    const valid = preview.mode !== "none";
    const removedDurationMs = computeSceneKeptSubRanges(gestureView.scene).reduce((sum, range) => sum + Math.max(0,
      Math.min(range.endMs, preview.appliedEndMs) - Math.max(range.startMs, preview.appliedStartMs)), 0);
    const leftPx = ((preview.appliedStartMs - scene.sourceStartMs) / sceneSpanMs) * width;
    const rightPx = ((preview.appliedEndMs - scene.sourceStartMs) / sceneSpanMs) * width;
    rangeCutOverlay = {
      leftPx,
      widthPx: Math.max(1, rightPx - leftPx),
      valid,
      label: valid
        ? `${formatWaveformTime(preview.appliedStartMs)} → ${formatWaveformTime(preview.appliedEndMs)}  −${(removedDurationMs / 1000).toFixed(3)} 秒`
        : preview.appliedEndMs - preview.appliedStartMs >= MIN_RANGE_CUT_MS && removedDurationMs === 0
          ? "この範囲はカット済みです"
          : "もう少し広げて選択 · 最小 0.080 秒",
    };
  }

  return (
    <div className={`sceneWaveformWrap sceneWaveformPrecision ${gestureView ? "isGesturing" : ""}`} ref={wrapRef}>
      {visible ? (
        <canvas
          className="sceneWaveformCanvas"
          onClick={handleClick}
          onMouseMove={handleMouseMove}
          onPointerCancel={handlePointerCancel}
          onLostPointerCapture={handlePointerCancel}
          aria-label="波形。Bで2点クリックして間をカット、発話より外側は1クリックで端までカット。ドラッグで範囲カット、左右端でトリム。Optionで単語吸着解除、Escapeで取消"
          title="B: 2点クリックで間をカット · 発話より外側は1クリックで端までカット · ドラッグで範囲カット · Optionで単語吸着解除 · Escで取消"
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
      {visible && !gestureView && clickPreview?.kind === "cut" && (
        <div
          className="sceneRangeCutOverlay sceneClickCutOverlay"
          style={{ left: (clickPreview.appliedStartMs - scene.sourceStartMs) / sceneSpanMs * width,
            width: (clickPreview.appliedEndMs - clickPreview.appliedStartMs) / sceneSpanMs * width }}
        />
      )}
      {visible && !gestureView && anchorMs != null && (
        <div className="sceneClickCutAnchor" style={{ left: (anchorMs - scene.sourceStartMs) / sceneSpanMs * width }}>
          <span>1</span>
        </div>
      )}
      {visible && !gestureView && (clickReadout || validAnchor) && (
        <div className="sceneWaveformGestureReadout sceneClickCutReadout" role="status">
          <strong>{clickReadout ?? `${formatWaveformTime(anchorMs!)} に切り込み · 反対側をクリック`}</strong>
          <span>{clickPreview?.kind === "cut"
            ? `${clickPreview.intent === "start" ? "先頭まで" : clickPreview.intent === "end" ? "末尾まで" : "2点の間を"}クリックでカット`
            : clickPreview?.kind === "none" ? "この位置ではカットしません"
              : validAnchor ? "2点目でカット" : "1点目ではまだカットしません"} · Esc 取消</span>
        </div>
      )}
      {/* W20-1(範囲選択カット): ドラッグ中の選択範囲ハイライト+カット尺ラベル(「-1.24s」)。 */}
      {visible && rangeCutOverlay && (
        <div
          className={`sceneRangeCutOverlay ${rangeCutOverlay.valid ? "" : "invalid"}`}
          style={{ left: rangeCutOverlay.leftPx, width: rangeCutOverlay.widthPx }}
        >

        </div>
      )}
      {visible && rangeCutOverlay && (
        <div className="sceneWaveformGestureReadout" role="status">
          <strong>{rangeCutOverlay.label}</strong>
          <span>{gestureView?.current.altKey ? "20 ms グリッド" : "単語に吸着"} · 離して確定 · Esc 取消</span>
        </div>
      )}
      {visible && !gestureView && !dragTooltip && !clickReadout && !validAnchor && (
        <div aria-hidden="true" className="sceneWaveformTimeRange">
          <span>{formatWaveformTime(scene.sourceStartMs)}</span><span>{formatWaveformTime(scene.sourceEndMs)}</span>
        </div>
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
        <div className={`sceneEdgeTooltip ${dragTooltip.edge}`}>
          {dragTooltip.edge === "start" ? "開始 " : "終了 "}
          {formatWaveformTime(dragTooltip.edge === "start" ? scene.sourceStartMs : scene.sourceEndMs)}
          <strong>{dragTooltip.label}</strong>
          <span>{gestureView?.current.altKey ? "20 ms グリッド" : "単語に吸着"} · Esc 取消</span>
        </div>
      )}
    </div>
  );
}
