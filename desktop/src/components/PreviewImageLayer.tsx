import { useRef, type CSSProperties } from "react";
import type { ContainedBox } from "../lib/telopPreviewSize";
import type { ImageClipData } from "../lib/imageOverlay";
import { imageClipZIndex, imageOverlayStyle } from "../lib/imageOverlay";
import {
  activeImageClipsAtTimelineMs,
  dragImagePosition,
  dragImageScale,
  replaceImageClip,
} from "../lib/imageClips";

/**
 * フェーズV4: プレビュー上の画像オーバーレイ描画+直接操作。
 * - 現在タイムラインms(仮想プレイリスト基準)で表示中のクリップを判定し、
 *   contain矩形(実際に映像が描画される矩形)基準で imageOverlayStyle(Remotionと同一計算)を
 *   そのまま%配置する=書き出しMP4と同じ見た目
 * - 画像本体ドラッグ=中心位置(x,y)移動、クリック選択で四隅ハンドル=scale(画面幅比)変更。
 *   操作確定(ポインタ解放)で images.json へ保存(onClipsChange commit=true)
 * - レイヤーはDOM順で映像の上・テロップの下に置かれる(PreviewPlayer側の挿入位置)
 */

export type PreviewImageClip = ImageClipData & { url: string };

type DragState = {
  captureTarget: HTMLElement;
  pointerId: number;
  clipId: string;
  mode: "move" | "scale";
  /** scaleモード時: ハンドルが画像の右側(+1)か左側(-1)か(外向きドラッグ=拡大の符号)。 */
  horizontalSign: 1 | -1;
  /** scaleモード時: ハンドルが画像の下側(+1)か上側(-1)か(縦・斜めドラッグでも拡縮を効かせる)。 */
  verticalSign: 1 | -1;
  startClientX: number;
  startClientY: number;
  snapshot: PreviewImageClip;
  initialClips: PreviewImageClip[];
  latestClips: PreviewImageClip[];
};

type Props = {
  box: ContainedBox;
  clips: PreviewImageClip[];
  /** 現在のタイムラインms(OP込み。仮想プレイリスト基準)。null=写像不能(カット区間外)。 */
  timelineMs: number | null;
  /**
   * ドラッグによる編集の通知。commit=false はドラッグ中のライブ更新、
   * commit=true が操作確定(親がimages.jsonへ保存する)。未指定なら表示のみ(操作不可)。
   */
  onClipsChange?: (clips: PreviewImageClip[], commit: boolean) => void;
  selectedClipId?: string | null;
  onSelect?: (id: string | null) => void;
  /** Other preview tools retain images visually while routing pointers to their own handles. */
  interactive?: boolean;
};

/** 四隅ハンドルの配置定義。left側はhorizontalSign=-1、top側はverticalSign=-1(外へ引く=拡大)。 */
const SCALE_HANDLES: Array<{ corner: string; hSign: 1 | -1; vSign: 1 | -1; style: CSSProperties }> = [
  { corner: "nw", hSign: -1, vSign: -1, style: { left: -7, top: -7, cursor: "nwse-resize" } },
  { corner: "ne", hSign: 1, vSign: -1, style: { right: -7, top: -7, cursor: "nesw-resize" } },
  { corner: "sw", hSign: -1, vSign: 1, style: { left: -7, bottom: -7, cursor: "nesw-resize" } },
  { corner: "se", hSign: 1, vSign: 1, style: { right: -7, bottom: -7, cursor: "nwse-resize" } },
];

export function PreviewImageLayer({ box, clips, timelineMs, onClipsChange, selectedClipId = null, onSelect, interactive = true }: Props) {
  const dragRef = useRef<DragState | null>(null);
  const draggedRef = useRef(false);

  const activeClips = activeImageClipsAtTimelineMs(clips, timelineMs);

  if (!activeClips.length || box.width <= 0 || box.height <= 0) return null;
  const editable = interactive && Boolean(onClipsChange);

  function handlePointerDown(
    event: React.PointerEvent<HTMLElement>,
    clip: PreviewImageClip,
    mode: DragState["mode"],
    horizontalSign: 1 | -1 = 1,
    verticalSign: 1 | -1 = 1,
  ) {
    if (!editable || event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    dragRef.current = {
      captureTarget: event.currentTarget,
      pointerId: event.pointerId,
      clipId: clip.id,
      mode,
      horizontalSign,
      verticalSign,
      startClientX: event.clientX,
      startClientY: event.clientY,
      snapshot: clip,
      initialClips: clips,
      latestClips: clips,
    };
    draggedRef.current = false;
    // 押した瞬間に選択してハンドルを出す(「クリック→離す→ハンドル」の1手を省き直感的にする)
    event.currentTarget.closest<HTMLElement>(".previewImageClip")?.focus({ preventScroll: true });
    onSelect?.(clip.id);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || !onClipsChange) return;
    event.stopPropagation();
    const clips = drag.latestClips;
    const deltaXPx = event.clientX - drag.startClientX;
    const deltaYPx = event.clientY - drag.startClientY;
    if (Math.abs(deltaXPx) > 2 || Math.abs(deltaYPx) > 2) draggedRef.current = true;
    if (!draggedRef.current) return;
    const updated =
      drag.mode === "move"
        ? dragImagePosition(
            drag.snapshot,
            drag.snapshot.x,
            drag.snapshot.y,
            deltaXPx,
            deltaYPx,
            box.width,
            box.height,
          )
        : dragImageScale(
            drag.snapshot,
            drag.snapshot.scale,
            deltaXPx,
            deltaYPx,
            drag.horizontalSign,
            drag.verticalSign,
            box.width,
          );
    const current = clips.find((clip) => clip.id === drag.clipId);
    if (!current) return;
    drag.latestClips = replaceImageClip(clips, { ...current, ...updated }) as PreviewImageClip[];
    onClipsChange(drag.latestClips, false);
  }

  function finishGesture(event: React.PointerEvent<HTMLElement>, cancelled = false) {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (draggedRef.current) onClipsChange?.(cancelled ? drag.initialClips : drag.latestClips, true);
  }

  function handlePointerUp(event: React.PointerEvent<HTMLElement>) {
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
    if (drag.captureTarget.hasPointerCapture?.(drag.pointerId)) drag.captureTarget.releasePointerCapture(drag.pointerId);
    if (draggedRef.current) onClipsChange?.(drag.initialClips, true);
  }

  return (
    <div
      className="previewImageLayer"
      onKeyDown={handleGestureKeyDown}
      style={{
        position: "absolute",
        left: `${box.offsetX}px`,
        top: `${box.offsetY}px`,
        width: `${box.width}px`,
        height: `${box.height}px`,
        overflow: "hidden",
        pointerEvents: "none",
        // Child z-indices order images only. Keep this layer below later caption/overlay layers.
        isolation: "isolate",
      }}
    >
      {activeClips.map((clip) => {
        const selected = interactive && selectedClipId === clip.id;
        // V6-5: 画像同士の前後関係は元配列(images.json)のindex基準のzIndexで明示する
        // (Remotionの imageClipZIndex と同一計算=プレビューと書き出しの重なりが一致する)
        const arrayIndex = clips.findIndex((candidate) => candidate.id === clip.id);
        return (
          <div
            className={`previewImageClip${selected ? " selected" : ""}${editable ? " editable" : ""}`}
            key={clip.id}
            tabIndex={editable ? -1 : undefined}
            role={editable ? "button" : undefined}
            aria-label={`画像 ${clip.file}`}
            aria-pressed={editable ? selected : undefined}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => handlePointerDown(event, clip, "move")}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onLostPointerCapture={handlePointerCancel}
            style={{ ...imageOverlayStyle(clip), zIndex: imageClipZIndex(arrayIndex), ...(!interactive ? { pointerEvents: "none" } : {}) } as CSSProperties}
            title={editable ? "ドラッグで位置を移動（選択で四隅ハンドル=大きさ変更）" : undefined}
          >
            <img alt={clip.file} draggable={false} src={clip.url} />
            {selected &&
              editable &&
              SCALE_HANDLES.map((handle) => (
                <div
                  className="previewImageHandle"
                  key={handle.corner}
                  onPointerDown={(event) => handlePointerDown(event, clip, "scale", handle.hSign, handle.vSign)}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerCancel}
                  onLostPointerCapture={handlePointerCancel}
                  style={handle.style}
                  title="ドラッグで大きさを変更（縦・斜めのドラッグでも効きます）"
                />
              ))}
          </div>
        );
      })}
    </div>
  );
}
