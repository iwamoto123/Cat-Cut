import { useEffect, useRef, useState, type CSSProperties } from "react";
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
  clipId: string;
  mode: "move" | "scale";
  /** scaleモード時: ハンドルが画像の右側(+1)か左側(-1)か(外向きドラッグ=拡大の符号)。 */
  horizontalSign: 1 | -1;
  /** scaleモード時: ハンドルが画像の下側(+1)か上側(-1)か(縦・斜めドラッグでも拡縮を効かせる)。 */
  verticalSign: 1 | -1;
  /** pointerdown時点で既に選択済みだったか(動かさず離した=クリックの選択解除トグル判定)。 */
  wasSelected: boolean;
  startClientX: number;
  startClientY: number;
  snapshot: PreviewImageClip;
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
};

/** 四隅ハンドルの配置定義。left側はhorizontalSign=-1、top側はverticalSign=-1(外へ引く=拡大)。 */
const SCALE_HANDLES: Array<{ corner: string; hSign: 1 | -1; vSign: 1 | -1; style: CSSProperties }> = [
  { corner: "nw", hSign: -1, vSign: -1, style: { left: -7, top: -7, cursor: "nwse-resize" } },
  { corner: "ne", hSign: 1, vSign: -1, style: { right: -7, top: -7, cursor: "nesw-resize" } },
  { corner: "sw", hSign: -1, vSign: 1, style: { left: -7, bottom: -7, cursor: "nesw-resize" } },
  { corner: "se", hSign: 1, vSign: 1, style: { right: -7, bottom: -7, cursor: "nwse-resize" } },
];

export function PreviewImageLayer({ box, clips, timelineMs, onClipsChange }: Props) {
  const dragRef = useRef<DragState | null>(null);
  const draggedRef = useRef(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);

  const activeClips = activeImageClipsAtTimelineMs(clips, timelineMs);

  // 表示区間外へ出た(再生が進んだ等)クリップの選択は解除する
  useEffect(() => {
    if (selectedClipId && !activeClips.some((clip) => clip.id === selectedClipId)) {
      setSelectedClipId(null);
    }
  }, [selectedClipId, activeClips]);

  if (!activeClips.length || box.width <= 0 || box.height <= 0) return null;
  const editable = Boolean(onClipsChange);

  function handlePointerDown(
    event: React.PointerEvent<HTMLElement>,
    clip: PreviewImageClip,
    mode: DragState["mode"],
    horizontalSign: 1 | -1 = 1,
    verticalSign: 1 | -1 = 1,
  ) {
    if (!editable) return;
    event.stopPropagation();
    event.preventDefault();
    dragRef.current = {
      clipId: clip.id,
      mode,
      horizontalSign,
      verticalSign,
      wasSelected: selectedClipId === clip.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      snapshot: clip,
    };
    draggedRef.current = false;
    // 押した瞬間に選択してハンドルを出す(「クリック→離す→ハンドル」の1手を省き直感的にする)
    setSelectedClipId(clip.id);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || !onClipsChange) return;
    const deltaXPx = event.clientX - drag.startClientX;
    const deltaYPx = event.clientY - drag.startClientY;
    if (Math.abs(deltaXPx) > 2 || Math.abs(deltaYPx) > 2) draggedRef.current = true;
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
    onClipsChange(replaceImageClip(clips, { ...current, ...updated }) as PreviewImageClip[], false);
  }

  function handlePointerUp(event: React.PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    if (draggedRef.current) {
      onClipsChange?.(clips, true);
      setSelectedClipId(drag.clipId);
    } else if (drag.mode === "move" && drag.wasSelected) {
      // 選択済みの画像本体を動かさずクリック=選択解除(ハンドルを隠す)。
      // 未選択だった場合はpointerdownで選択済みなのでそのまま(ワンクリックでハンドルが出る)
      setSelectedClipId(null);
    }
  }

  return (
    <div
      className="previewImageLayer"
      style={{
        position: "absolute",
        left: `${box.offsetX}px`,
        top: `${box.offsetY}px`,
        width: `${box.width}px`,
        height: `${box.height}px`,
        overflow: "hidden",
        pointerEvents: "none",
      }}
    >
      {activeClips.map((clip) => {
        const selected = selectedClipId === clip.id;
        // V6-5: 画像同士の前後関係は元配列(images.json)のindex基準のzIndexで明示する
        // (Remotionの imageClipZIndex と同一計算=プレビューと書き出しの重なりが一致する)
        const arrayIndex = clips.findIndex((candidate) => candidate.id === clip.id);
        return (
          <div
            className={`previewImageClip${selected ? " selected" : ""}${editable ? " editable" : ""}`}
            key={clip.id}
            onPointerDown={(event) => handlePointerDown(event, clip, "move")}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            style={{ ...imageOverlayStyle(clip), zIndex: imageClipZIndex(arrayIndex) } as CSSProperties}
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
