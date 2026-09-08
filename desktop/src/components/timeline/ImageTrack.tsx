import { useEffect, useRef } from "react";
import { GripVertical, Image as ImageIcon } from "lucide-react";
import type { ImageClipData } from "../../lib/imageOverlay";
import {
  moveImageClip,
  replaceImageClip,
  resizeImageClip,
} from "../../lib/imageClips";
import { laneIndexForArrayIndex, laneIndexForOffsetY, moveClipToLane } from "../../lib/clipLanes";
import { isEditorSelection, type EditorSelection, type MediaEditPhase } from "../../lib/editorSelection";
import { formatPrecisionTime, snapMediaDelta } from "../../lib/precisionMedia";
import { playheadStore } from "../../lib/playheadStore";

/** クリップのレーン内上下インセット(px)。 */
const CLIP_INSET_PX = 5;

export type ImagesState = Awaited<ReturnType<typeof window.catcut.listImages>>;
export type ImageUiClip = ImagesState["clips"][number];

type DragState = {
  captureTarget: HTMLElement;
  pointerId: number;
  clipId: string;
  mode: "move" | "resize-start" | "resize-end" | "lane";
  startClientX: number;
  startScrollLeft: number;
  pxPerMs: number;
  scrollTarget: HTMLElement | null;
  /** レーン入替え(mode=lane)用: トラック(.tlLane)上端のクライアントY。 */
  trackTopClientY: number;
  /** ドラッグ開始時点のクリップ(差分は常にこのスナップショットへ適用する)。 */
  snapshot: ImageUiClip;
  initialState: ImagesState;
  latestState: ImagesState;
};

type Props = {
  disabled?: boolean;
  timelineDurationMs?: number;
  snapEnabled?: boolean;
  snapPointsMs?: number[];
  state: ImagesState | null;
  getState?: () => ImagesState | null;
  /** ライブ更新と操作確定を親へ通知。履歴・保存は親が管理する。 */
  onStateChange: (state: ImagesState, phase?: MediaEditPhase) => void;
  selection: EditorSelection;
  onSelectionChange: (selection: EditorSelection) => void;
  pxPerMs: number;
  /** V6-5: 1レーンあたりの高さ(px)。トラック全体の高さは親(TimelineView)がクリップ数×この値で確保する。 */
  laneHeightPx: number;
};

/** UI付加情報(url)を保ったまま純関数(ImageClipData操作)の結果を書き戻す。 */
function applyClipUpdate(clip: ImageUiClip, updated: ImageClipData): ImageUiClip {
  return { ...clip, ...updated };
}

/**
 * フェーズV4: タイムラインViewの画像トラック(BGMトラックと同じ操作感)。
 * - 緑系クリップバー(ファイル名表示)。本体ドラッグ=移動、左右端=伸縮(最小500ms・総尺クランプ・
 *   0ms/総尺端スナップ)、クリック選択で削除ボタン
 * - V6-5: 1クリップ=1レーンの段積み表示。配列順=前後関係(配列末尾=最前面=一番上のレーン)で、
 *   左端のグリップを上下ドラッグするとレーン順(=前後関係=images.jsonの配列順)を入替えられる
 * - 変更はライブ更新/操作確定に分けて親へ通知し、履歴と保存を全トラックで共有する
 * - 画像の位置(x,y)・大きさ(scale)の調整はプレビュー上のドラッグ/四隅ハンドルが担当する
 */
export function ImageTrack({ disabled = false, state, getState, onStateChange, selection, onSelectionChange, pxPerMs, laneHeightPx, timelineDurationMs, snapEnabled = true, snapPointsMs = [] }: Props) {
  const laneRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const draggedRef = useRef(false);
  const previewFrameRef = useRef<number | null>(null);
  function cancelPreviewFrame() {
    if (previewFrameRef.current !== null) cancelAnimationFrame(previewFrameRef.current);
    previewFrameRef.current = null;
  }
  useEffect(() => cancelPreviewFrame, []);

  const clips = state?.clips ?? [];

  function preview(nextClips: ImageUiClip[]) {
    const drag = dragRef.current;
    if (!drag) return;
    drag.latestState = { ...drag.latestState, clips: nextClips };
    // Keep pointer samples locally; publish at most once per animation frame.
    // Pointerup commits latestState synchronously, including a sample not yet painted.
    if (previewFrameRef.current === null) previewFrameRef.current = requestAnimationFrame(() => {
      previewFrameRef.current = null;
      if (dragRef.current === drag) onStateChange(drag.latestState, "preview");
    });
  }

  function handlePointerDown(
    event: React.PointerEvent<HTMLElement>,
    clip: ImageUiClip,
    mode: DragState["mode"],
  ) {
    if (disabled || event.button !== 0 || !state || dragRef.current) return;
    event.stopPropagation();
    event.preventDefault();
    // preventDefaultで以前の映像側フォーカスが残らないよう、操作対象へ明示的に移す。
    event.currentTarget.closest<HTMLElement>(".tlImageClip")?.focus({ preventScroll: true });
    const currentState = getState?.() ?? state;
    const currentClip = currentState.clips.find((candidate) => candidate.id === clip.id);
    if (!currentClip) return;
    const track = (event.currentTarget as HTMLElement).closest(".tlLane");
    const scrollTarget = event.currentTarget.closest<HTMLElement>(".timelineBody");
    dragRef.current = {
      captureTarget: event.currentTarget,
      pointerId: event.pointerId,
      clipId: clip.id,
      mode,
      startClientX: event.clientX,
      startScrollLeft: scrollTarget?.scrollLeft ?? 0,
      scrollTarget,
      pxPerMs,
      trackTopClientY: track ? track.getBoundingClientRect().top : 0,
      snapshot: currentClip,
      initialState: currentState,
      latestState: currentState,
    };
    draggedRef.current = false;
    onSelectionChange({ kind: "image", id: clip.id });
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !state || drag.pxPerMs <= 0) return;
    event.stopPropagation();
    const clips = drag.latestState.clips;
    if (drag.mode === "lane") {
      // V6-5: レーン入替え。ポインタYの属するレーンへ配列位置を移す(配列順=前後関係)
      draggedRef.current = true;
      const targetLane = laneIndexForOffsetY(
        event.clientY - drag.trackTopClientY,
        laneHeightPx,
        clips.length,
      );
      const next = moveClipToLane(clips, drag.clipId, targetLane);
      if (next !== clips) preview(next);
      return;
    }
    const deltaPx = event.clientX - drag.startClientX + (drag.scrollTarget?.scrollLeft ?? 0) - drag.startScrollLeft;
    let deltaMs = deltaPx / drag.pxPerMs;
    if (Math.abs(deltaPx) > 2) draggedRef.current = true;
    if (!draggedRef.current) return;
    if (drag.mode === "move" || drag.mode === "resize-start" || drag.mode === "resize-end") {
      const playheadMs = playheadStore.getTimelineMs();
      const targets = [...snapPointsMs, ...clips.filter((clip) => clip.id !== drag.clipId).flatMap((clip) => [clip.start_ms, clip.end_ms])];
      if (playheadMs !== null) targets.push(playheadMs);
      deltaMs = snapMediaDelta(drag.snapshot, deltaMs, drag.mode, targets, drag.pxPerMs, snapEnabled && !event.altKey);
    }
    const bounds = {
      timelineDurationMs: timelineDurationMs ?? state.timelineDurationMs,
      snapMs: 0,
    };
    let updated: ImageClipData;
    switch (drag.mode) {
      case "move":
        updated = moveImageClip(drag.snapshot, deltaMs, bounds);
        break;
      case "resize-start":
        updated = resizeImageClip(drag.snapshot, "start", deltaMs, bounds);
        break;
      case "resize-end":
        updated = resizeImageClip(drag.snapshot, "end", deltaMs, bounds);
        break;
    }
    const current = clips.find((clip) => clip.id === drag.clipId);
    if (!current) return;
    preview(replaceImageClip(clips, applyClipUpdate(current, updated)) as ImageUiClip[]);
  }

  function finishGesture(event: React.PointerEvent<HTMLElement>, cancelled = false) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    cancelPreviewFrame();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (draggedRef.current) {
      onStateChange(cancelled ? drag.initialState : drag.latestState, "commit");
    }
  }

  function handlePointerUp(event: React.PointerEvent<HTMLElement>) {
    handlePointerMove(event);
    finishGesture(event);
  }

  function handlePointerCancel(event: React.PointerEvent<HTMLElement>) {
    finishGesture(event, true);
  }

  function handleGestureKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key !== "Escape" && !((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z")) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = null;
    cancelPreviewFrame();
    if (drag.captureTarget.hasPointerCapture?.(drag.pointerId)) drag.captureTarget.releasePointerCapture(drag.pointerId);
    if (draggedRef.current) onStateChange(drag.initialState, "commit");
  }

  return (
    <div
      className="tlLane tlImageLane"
      ref={laneRef}
      onKeyDown={handleGestureKeyDown}
      tabIndex={-1}
    >
      {clips.length === 0 && (
        <span className="tlLanePlaceholder">画像はまだありません（左の「+ 画像」かファイルのドラッグ&ドロップで追加）</span>
      )}
      {clips.map((clip, arrayIndex) => {
        const durationMs = clip.end_ms - clip.start_ms;
        const widthPx = Math.max(8, durationMs * pxPerMs);
        const trimming = dragRef.current?.clipId === clip.id && (dragRef.current.mode === "resize-start" || dragRef.current.mode === "resize-end");
        const selected = isEditorSelection(selection, "image", clip.id);
        const laneIndex = laneIndexForArrayIndex(clips.length, arrayIndex);
        return (
          <div
            className={`tlImageClip${selected ? " selected" : ""}`}
            key={clip.id}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => handlePointerDown(event, clip, "move")}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onLostPointerCapture={handlePointerCancel}
            tabIndex={-1}
            aria-label={`画像 ${clip.file}`}
            aria-pressed={selected}
            role="button"
            style={{
              left: `${clip.start_ms * pxPerMs}px`,
              width: `${widthPx}px`,
              top: `${laneIndex * laneHeightPx + CLIP_INSET_PX}px`,
              height: `${laneHeightPx - CLIP_INSET_PX * 2}px`,
            }}
            title={`${clip.file} / ${(durationMs / 1000).toFixed(1)}秒（上のレーンほど手前に表示。位置・大きさはプレビュー上でドラッグ）`}
          >
            {/* 左端グリップ: 上下ドラッグでレーン順(=前後関係)入替え */}
            {widthPx >= 48 && <div
              className="tlLaneReorderHandle"
              onPointerDown={(event) => handlePointerDown(event, clip, "lane")}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              onLostPointerCapture={handlePointerCancel}
              title="上下ドラッグでレーン順を入替え（上のレーン=手前に表示）"
            >
              <GripVertical size={11} />
            </div>}
            <span className="tlImageClipLabel">
              <ImageIcon size={11} />
              <span>{clip.file}</span>
            </span>
            {/* 左右端: 伸縮ハンドル */}
            {selected && (widthPx >= 28 || trimming) && <div
              className="tlImageResizeHandle tlImageResizeHandleStart"
              onPointerDown={(event) => handlePointerDown(event, clip, "resize-start")}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              onLostPointerCapture={handlePointerCancel}
              title="表示開始を伸縮"
            />}
            {selected && (widthPx >= 28 || trimming) && <div
              className="tlImageResizeHandle tlImageResizeHandleEnd"
              onPointerDown={(event) => handlePointerDown(event, clip, "resize-end")}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              onLostPointerCapture={handlePointerCancel}
              title="表示終了を伸縮"
            />}

          </div>
        );
      })}
    </div>
  );
}
