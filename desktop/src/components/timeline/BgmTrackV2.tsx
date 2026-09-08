import { useEffect, useRef } from "react";
import { GripVertical, Music } from "lucide-react";
import type { BgmClipData } from "../../lib/bgmAudio";
import {
  moveBgmClip,
  replaceBgmClip,
  resizeBgmClip,
  setBgmFade,
  setBgmVolume,
} from "../../lib/bgmClips";
import { laneIndexForArrayIndex, laneIndexForOffsetY, moveClipToLane } from "../../lib/clipLanes";
import { isEditorSelection, type EditorSelection, type MediaEditPhase } from "../../lib/editorSelection";
import { formatPrecisionTime, snapMediaDelta } from "../../lib/precisionMedia";
import { playheadStore } from "../../lib/playheadStore";
import { BgmWaveform } from "./BgmWaveform";
import "./BgmClipDesign.css";

/** クリップのレーン内上下インセット(px)。styles.css の .tlBgmClip top/bottom と一致させる。 */
const CLIP_INSET_PX = 6;
/** エンベロープ描画域の上余白(px、クリップ座標)。ファイル名ラベルと音量線の重なりを避ける。 */
const ENVELOPE_TOP_PX = 25;
/** エンベロープ描画域の下余白(px、クリップ座標)。 */
const ENVELOPE_BOTTOM_PX = 7;
const WAVEFORM_TOP_PX = 20;
const FADE_HANDLE_SIZE_PX = 14;

export type BgmState = Awaited<ReturnType<typeof window.catcut.listBgm>>;
export type BgmUiClip = BgmState["clips"][number];

type DragState = {
  captureTarget: HTMLElement;
  pointerId: number;
  clipId: string;
  mode: "move" | "resize-start" | "resize-end" | "fade-in" | "fade-out" | "volume" | "lane";
  startClientX: number;
  startScrollLeft: number;
  pxPerMs: number;
  scrollTarget: HTMLElement | null;
  startClientY: number;
  /** Shift at pointerdown keeps a whole volume gesture at 0.1% per pixel. */
  volumeDragPxPerUnit: number;
  /** レーン入替え(mode=lane)用: トラック(.tlLane)上端のクライアントY。 */
  trackTopClientY: number;
  /** ドラッグ開始時点のクリップ(差分は常にこのスナップショットへ適用する)。 */
  snapshot: BgmUiClip;
  initialState: BgmState;
  latestState: BgmState;
};

type Props = {
  runDir: string;
  disabled?: boolean;
  timelineDurationMs?: number;
  snapEnabled?: boolean;
  snapPointsMs?: number[];
  state: BgmState | null;
  /** Read edits committed by an inspector blur during this same pointer event. */
  getState?: () => BgmState | null;
  /** ライブ更新と操作確定を親へ通知。履歴・保存は親が管理する。 */
  onStateChange: (state: BgmState, phase?: MediaEditPhase) => void;
  selection: EditorSelection;
  onSelectionChange: (selection: EditorSelection) => void;
  pxPerMs: number;
  /** V6-5: 1レーンあたりの高さ(px)。エンベロープの音量→縦位置換算にも使う。 */
  laneHeightPx: number;
};

/** UI付加情報(url等)を保ったまま純関数(BgmClipData操作)の結果を書き戻す。 */
function applyClipUpdate(clip: BgmUiClip, updated: BgmClipData): BgmUiClip {
  return { ...clip, ...updated };
}

/**
 * フェーズV1: タイムラインViewのBGMトラック(U9のBgmTrackを移設・改良)。
 * - 音量エンベロープをクリップ上に直接描画: 音量%の高さの水平線+両端のフェード斜線
 * - 波形上端のつまみ=フェード長変更、水平線の上下ドラッグ=音量。Shift開始で0.1%/px。
 * - 本文ドラッグ=移動、選択したクリップの左右端=伸縮。削除は専用調整欄またはDelete。
 * - V6-5: 1クリップ=1レーンの段積み表示(時間の重なりはレーン分離で視覚的に解決。
 *   再生は従来どおりミックス)。左端グリップの上下ドラッグでレーン順を入替えられる
 * - 変更はライブ更新/操作確定に分けて親へ通知し、履歴と保存を全トラックで共有する
 */
export function BgmTrackV2({ runDir, disabled = false, state, getState, onStateChange, selection, onSelectionChange, pxPerMs, laneHeightPx, timelineDurationMs, snapEnabled = true, snapPointsMs = [] }: Props) {
  const laneRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const draggedRef = useRef(false);
  const suppressGestureClickRef = useRef(false);
  const previewFrameRef = useRef<number | null>(null);
  function cancelPreviewFrame() {
    if (previewFrameRef.current !== null) cancelAnimationFrame(previewFrameRef.current);
    previewFrameRef.current = null;
  }
  useEffect(() => cancelPreviewFrame, []);

  const clips = state?.clips ?? [];
  // エンベロープ座標はすべて「クリップ要素内のpx」で計算する(SVG・つまみ・ヒットエリアで共通)
  const clipHeightPx = laneHeightPx - CLIP_INSET_PX * 2;
  const envelopeHeightPx = Math.max(8, clipHeightPx - ENVELOPE_TOP_PX - ENVELOPE_BOTTOM_PX);

  function preview(nextClips: BgmUiClip[]) {
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
    clip: BgmUiClip,
    mode: DragState["mode"],
  ) {
    if (disabled || event.button !== 0 || !state || dragRef.current) return;
    event.stopPropagation();
    event.preventDefault();
    // Keep capture on the keyed clip, not a width-dependent leaf control.
    // Trimming may replace a handle's siblings while live previews re-render.
    const captureTarget = event.currentTarget.closest<HTMLElement>(".tlBgmClip") ?? event.currentTarget;
    captureTarget.focus({ preventScroll: true });
    const currentState = getState?.() ?? state;
    const currentClip = currentState.clips.find((candidate) => candidate.id === clip.id);
    if (!currentClip) return;
    const track = (event.currentTarget as HTMLElement).closest(".tlLane");
    const scrollTarget = event.currentTarget.closest<HTMLElement>(".timelineBody");
    dragRef.current = {
      captureTarget,
      pointerId: event.pointerId,
      clipId: clip.id,
      mode,
      startClientX: event.clientX,
      startScrollLeft: scrollTarget?.scrollLeft ?? 0,
      scrollTarget,
      pxPerMs,
      startClientY: event.clientY,
      volumeDragPxPerUnit: event.shiftKey ? 1000 : 100,
      trackTopClientY: track ? track.getBoundingClientRect().top : 0,
      snapshot: currentClip,
      initialState: currentState,
      latestState: currentState,
    };
    draggedRef.current = false;
    onSelectionChange({ kind: "bgm", id: clip.id });
    captureTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !state || drag.pxPerMs <= 0) return;
    event.stopPropagation();
    const clips = drag.latestState.clips;
    if (drag.mode === "lane") {
      // V6-5: レーン入替え。ポインタYの属するレーンへ配列位置を移す(配列順=レーン順)
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
    const deltaYPx = event.clientY - drag.startClientY;
    let deltaMs = deltaPx / drag.pxPerMs;
    if (Math.abs(deltaPx) > 2 || Math.abs(deltaYPx) > 2) draggedRef.current = true;
    if (!draggedRef.current) return;
    if (drag.mode === "move" || drag.mode === "resize-start" || drag.mode === "resize-end") {
      const playheadMs = playheadStore.getTimelineMs();
      const targets = [...snapPointsMs, ...clips.filter((clip) => clip.id !== drag.clipId).flatMap((clip) => [clip.start_ms, clip.end_ms])];
      if (playheadMs !== null) targets.push(playheadMs);
      deltaMs = snapMediaDelta(drag.snapshot, deltaMs, drag.mode, targets, drag.pxPerMs, snapEnabled && !event.altKey);
    }
    const bounds = {
      timelineDurationMs: timelineDurationMs ?? state.timelineDurationMs,
      audioDurationMs: drag.snapshot.audioDurationMs,
      snapMs: 0,
    };
    let updated: BgmClipData;
    switch (drag.mode) {
      case "move":
        updated = moveBgmClip(drag.snapshot, deltaMs, bounds);
        break;
      case "resize-start":
        updated = resizeBgmClip(drag.snapshot, "start", deltaMs, bounds);
        break;
      case "resize-end":
        updated = resizeBgmClip(drag.snapshot, "end", deltaMs, bounds);
        break;
      case "fade-in":
        updated = setBgmFade(drag.snapshot, "start", drag.snapshot.fade_in_ms + deltaMs);
        break;
      case "fade-out":
        // フェードアウトつまみは左へ動かすほどフェードが長くなる
        updated = setBgmFade(drag.snapshot, "end", drag.snapshot.fade_out_ms - deltaMs);
        break;
      case "volume":
        updated = setBgmVolume(drag.snapshot, drag.snapshot.volume - deltaYPx / drag.volumeDragPxPerUnit);
        break;
    }
    const current = clips.find((clip) => clip.id === drag.clipId);
    if (!current) return;
    preview(replaceBgmClip(clips, applyClipUpdate(current, updated)) as BgmUiClip[]);
  }

  function finishGesture(event: React.PointerEvent<HTMLElement>, cancelled = false) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    cancelPreviewFrame();
    event.stopPropagation();
    suppressGestureClickRef.current = draggedRef.current;
    if (drag.captureTarget.hasPointerCapture?.(event.pointerId)) {
      drag.captureTarget.releasePointerCapture(event.pointerId);
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
    suppressGestureClickRef.current = draggedRef.current;
    if (drag.captureTarget.hasPointerCapture?.(drag.pointerId)) drag.captureTarget.releasePointerCapture(drag.pointerId);
    if (draggedRef.current) onStateChange(drag.initialState, "commit");
  }

  return (
    <div
      className="tlLane tlBgmLane"
      ref={laneRef}
      onKeyDown={handleGestureKeyDown}
      onPointerDownCapture={() => { if (!dragRef.current) suppressGestureClickRef.current = false; }}
      onClick={(event) => {
        // A release beyond a clamped clip can target the lane. It must not seek
        // or clear the selection after the completed/cancelled edit gesture.
        if (suppressGestureClickRef.current) {
          suppressGestureClickRef.current = false;
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      tabIndex={-1}
    >
      {clips.length === 0 && (
        <span className="tlLanePlaceholder">BGMはまだありません（左の「+ BGM」かファイルのドラッグ&ドロップで追加）</span>
      )}
      {clips.map((clip, arrayIndex) => {
        const durationMs = clip.end_ms - clip.start_ms;
        const widthPx = Math.max(8, durationMs * pxPerMs);
        const trimming = dragRef.current?.clipId === clip.id && (dragRef.current.mode === "resize-start" || dragRef.current.mode === "resize-end");
        const selected = isEditorSelection(selection, "bgm", clip.id);
        const laneIndex = laneIndexForArrayIndex(clips.length, arrayIndex);
        // エンベロープ座標(クリップ内px): 音量線のy・フェード斜線の始点/終点x
        const bottomY = ENVELOPE_TOP_PX + envelopeHeightPx;
        const volumeY = ENVELOPE_TOP_PX + (1 - clip.volume) * envelopeHeightPx;
        const fadeInX = Math.min(widthPx, clip.fade_in_ms * pxPerMs);
        const fadeOutX = Math.max(0, widthPx - clip.fade_out_ms * pxPerMs);
        const fadeHandlesClose = Math.abs(fadeOutX - fadeInX) < FADE_HANDLE_SIZE_PX + 2;
        const fadeInHandleY = WAVEFORM_TOP_PX + FADE_HANDLE_SIZE_PX / 2;
        const fadeOutHandleY = fadeHandlesClose ? fadeInHandleY + FADE_HANDLE_SIZE_PX + 1 : fadeInHandleY;
        // Keep volume hits clear of the two fade handles, including when a fade is zero.
        // These intervals stay stable throughout a volume drag, preserving pointer capture.
        const volumeSegments: Array<{ start: number; end: number }> = [];
        let volumeSegmentStart = 12;
        for (const fadeX of [fadeInX, fadeOutX].sort((a, b) => a - b)) {
          const blockedStart = Math.max(12, Math.min(widthPx - 12, fadeX - FADE_HANDLE_SIZE_PX / 2 - 1));
          if (blockedStart - volumeSegmentStart >= 4) volumeSegments.push({ start: volumeSegmentStart, end: blockedStart });
          volumeSegmentStart = Math.max(volumeSegmentStart, fadeX + FADE_HANDLE_SIZE_PX / 2 + 1);
        }
        if (widthPx - 12 - volumeSegmentStart >= 4) volumeSegments.push({ start: volumeSegmentStart, end: widthPx - 12 });
        const longestVolumeSegment = volumeSegments.reduce((longest, segment, index) => (
          segment.end - segment.start > volumeSegments[longest].end - volumeSegments[longest].start ? index : longest
        ), 0);
        const volumeText = `${Number((clip.volume * 100).toFixed(1))}%`;
        const decibelText = clip.volume > 0 ? `${(20 * Math.log10(clip.volume)).toFixed(1)} dB` : "−∞ dB";
        // The real mix uses the minimum of the two fades when they overlap.
        // Draw that intersection rather than a backwards, self-crossing line.
        const fadeIntersectionX = fadeInX > fadeOutX
          ? widthPx * clip.fade_in_ms / (clip.fade_in_ms + clip.fade_out_ms)
          : null;
        const fadeIntersectionY = fadeIntersectionX === null ? volumeY
          : bottomY - clip.volume * envelopeHeightPx * fadeIntersectionX / fadeInX;
        const envelopePoints = fadeIntersectionX === null
          ? `${clip.fade_in_ms > 0 ? `0,${bottomY}` : `0,${volumeY}`} ${fadeInX},${volumeY} ${fadeOutX},${volumeY} ${widthPx},${clip.fade_out_ms > 0 ? bottomY : volumeY}`
          : `0,${bottomY} ${fadeIntersectionX},${fadeIntersectionY} ${widthPx},${bottomY}`;
        return (
          <div
            className={`tlBgmClip tlBgmAudioClip${selected ? " selected" : ""}${widthPx < 90 ? " compact" : ""}`}
            key={clip.id}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => handlePointerDown(event, clip, "move")}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onLostPointerCapture={handlePointerCancel}
            tabIndex={-1}
            aria-label={`BGM ${clip.file}`}
            aria-pressed={selected}
            role="button"
            style={{
              left: `${clip.start_ms * pxPerMs}px`,
              width: `${widthPx}px`,
              top: `${laneIndex * laneHeightPx + CLIP_INSET_PX}px`,
              height: `${clipHeightPx}px`,
            }}
            title={`${clip.file} / 音量${(clip.volume * 100).toFixed(1)}% / フェードイン${(clip.fade_in_ms / 1000).toFixed(1)}秒・アウト${(clip.fade_out_ms / 1000).toFixed(1)}秒`}
          >
            {/* 左端グリップ: 上下ドラッグでレーン順入替え */}
            {widthPx >= 48 && <div
              className="tlLaneReorderHandle"
              onPointerDown={(event) => handlePointerDown(event, clip, "lane")}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              onLostPointerCapture={handlePointerCancel}
              title="上下ドラッグでレーン順を入替え"
            >
              <GripVertical size={11} />
            </div>}
            <span className="tlBgmClipLabel" style={{ left: widthPx >= 48 ? 26 : 8, right: widthPx >= 220 ? 106 : widthPx >= 140 ? 64 : 8 }}>
              <Music size={11} />
              <span className="tlBgmFilename">{clip.file}</span>
            </span>
            <div className="tlBgmWaveformArea" style={{ top: WAVEFORM_TOP_PX, height: clipHeightPx - WAVEFORM_TOP_PX - 3 }}>
              <BgmWaveform runDir={runDir} file={clip.file} durationMs={durationMs} widthPx={Math.max(1, widthPx - 2)} heightPx={clipHeightPx - WAVEFORM_TOP_PX - 3} volume={clip.volume} fadeInMs={clip.fade_in_ms} fadeOutMs={clip.fade_out_ms} />
            </div>
            {/* 音量エンベロープ(水平線+フェード斜線)。preserveAspectRatio=noneにせず実px座標で描く */}
            <svg className="tlBgmEnvelope" height={clipHeightPx} width={widthPx}>
              <polygon points={`0,${bottomY} ${envelopePoints} ${widthPx},${bottomY}`} className="tlBgmEnvelopeFill" />
              <line x1={0} x2={widthPx} y1={volumeY} y2={volumeY} className="tlBgmVolumeLine" />
              <polyline
                fill="none"
                points={envelopePoints}
                className="tlBgmEnvelopeCurve"
              />
            </svg>
            {widthPx >= 140 && <span className="tlBgmVolumeLabel">{decibelText}{widthPx >= 220 && <span> · {volumeText}</span>}</span>}
            {selected && widthPx >= 90 && volumeSegments.map((segment, index) => <div
              className="tlBgmVolumeHit"
              key={index}
              onPointerDown={(event) => handlePointerDown(event, clip, "volume")}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              onLostPointerCapture={handlePointerCancel}
              style={{ left: segment.start, width: segment.end - segment.start, top: volumeY - 5 }}
              title={`音量 ${decibelText} / ${volumeText}（上下ドラッグ・Shiftを押しながら開始で微調整）`}
              aria-label="BGM音量を上下ドラッグで調整"
            >{index === longestVolumeSegment && <span />}</div>)}
            {/* フェード角の丸つまみ(ドラッグでフェード長変更) */}
            {selected && widthPx >= 90 && <div
              className="tlBgmFadeKnob tlBgmFadeKnobIn"
              onPointerDown={(event) => handlePointerDown(event, clip, "fade-in")}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              onLostPointerCapture={handlePointerCancel}
              style={{ left: fadeInX - FADE_HANDLE_SIZE_PX / 2, top: fadeInHandleY - FADE_HANDLE_SIZE_PX / 2 }}
              title={`フェードイン ${formatPrecisionTime(clip.fade_in_ms)}（左右ドラッグ）`}
            />}
            {selected && widthPx >= 90 && <div
              className="tlBgmFadeKnob tlBgmFadeKnobOut"
              onPointerDown={(event) => handlePointerDown(event, clip, "fade-out")}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              onLostPointerCapture={handlePointerCancel}
              style={{ left: fadeOutX - FADE_HANDLE_SIZE_PX / 2, top: fadeOutHandleY - FADE_HANDLE_SIZE_PX / 2 }}
              title={`フェードアウト ${formatPrecisionTime(clip.fade_out_ms)}（左右ドラッグ）`}
            />}
            {/* 左右端: 伸縮ハンドル */}
            {selected && (widthPx >= 28 || trimming) && <div
              className="tlBgmResizeHandle tlBgmResizeHandleStart"
              onPointerDown={(event) => handlePointerDown(event, clip, "resize-start")}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              onLostPointerCapture={handlePointerCancel}
              title="開始位置を伸縮"
            />}
            {selected && (widthPx >= 28 || trimming) && <div
              className="tlBgmResizeHandle tlBgmResizeHandleEnd"
              onPointerDown={(event) => handlePointerDown(event, clip, "resize-end")}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              onLostPointerCapture={handlePointerCancel}
              title="終了位置を伸縮"
            />}

          </div>
        );
      })}
    </div>
  );
}
