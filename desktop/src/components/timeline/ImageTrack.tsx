import { useRef, useState } from "react";
import { GripVertical, Image as ImageIcon, Trash2 } from "lucide-react";
import type { ImageClipData } from "../../lib/imageOverlay";
import {
  moveImageClip,
  removeImageClip,
  replaceImageClip,
  resizeImageClip,
} from "../../lib/imageClips";
import { laneIndexForArrayIndex, laneIndexForOffsetY, moveClipToLane } from "../../lib/clipLanes";

/** ドラッグ中のスナップしきい値(px)。ms換算はズーム倍率(pxPerMs)で行う(BGMトラックと同値)。 */
const SNAP_PX = 8;
/** クリップのレーン内上下インセット(px)。 */
const CLIP_INSET_PX = 5;

export type ImagesState = Awaited<ReturnType<typeof window.catcut.listImages>>;
export type ImageUiClip = ImagesState["clips"][number];

type DragState = {
  clipId: string;
  mode: "move" | "resize-start" | "resize-end" | "lane";
  startClientX: number;
  /** レーン入替え(mode=lane)用: トラック(.tlLane)上端のクライアントY。 */
  trackTopClientY: number;
  /** ドラッグ開始時点のクリップ(差分は常にこのスナップショットへ適用する)。 */
  snapshot: ImageUiClip;
};

type Props = {
  runDir: string;
  state: ImagesState | null;
  /** ドラッグ中のライブ更新と保存後の反映(プレビュー反映のためAppが保持する)。 */
  onStateChange: (state: ImagesState) => void;
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
 * - 変更は操作確定(ポインタ解放)ごとに images.json へ即保存(書き出し時にstep08が転写)
 * - 画像の位置(x,y)・大きさ(scale)の調整はプレビュー上のドラッグ/四隅ハンドルが担当する
 */
export function ImageTrack({ runDir, state, onStateChange, pxPerMs, laneHeightPx }: Props) {
  const dragRef = useRef<DragState | null>(null);
  const draggedRef = useRef(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);

  const clips = state?.clips ?? [];

  async function persist(nextClips: ImageUiClip[]) {
    if (!state) return;
    // ライブ状態を即時反映してから保存(保存結果=正規化済みで上書き)
    onStateChange({ ...state, clips: nextClips });
    try {
      const saved = await window.catcut.saveImages({
        runDir,
        clips: nextClips.map(({ url: _url, ...data }) => data),
      });
      onStateChange(saved);
    } catch {
      // 保存失敗時もUI状態は維持する(次の操作で再保存される)
    }
  }

  function handlePointerDown(
    event: React.PointerEvent<HTMLElement>,
    clip: ImageUiClip,
    mode: DragState["mode"],
  ) {
    event.stopPropagation();
    event.preventDefault();
    const track = (event.currentTarget as HTMLElement).closest(".tlLane");
    dragRef.current = {
      clipId: clip.id,
      mode,
      startClientX: event.clientX,
      trackTopClientY: track ? track.getBoundingClientRect().top : 0,
      snapshot: clip,
    };
    draggedRef.current = false;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || !state || pxPerMs <= 0) return;
    if (drag.mode === "lane") {
      // V6-5: レーン入替え。ポインタYの属するレーンへ配列位置を移す(配列順=前後関係)
      draggedRef.current = true;
      const targetLane = laneIndexForOffsetY(
        event.clientY - drag.trackTopClientY,
        laneHeightPx,
        clips.length,
      );
      const next = moveClipToLane(clips, drag.clipId, targetLane);
      if (next !== clips) onStateChange({ ...state, clips: next });
      return;
    }
    const deltaPx = event.clientX - drag.startClientX;
    const deltaMs = deltaPx / pxPerMs;
    if (Math.abs(deltaPx) > 2) draggedRef.current = true;
    const bounds = {
      timelineDurationMs: state.timelineDurationMs,
      snapMs: SNAP_PX / pxPerMs,
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
    onStateChange({ ...state, clips: replaceImageClip(clips, applyClipUpdate(current, updated)) as ImageUiClip[] });
  }

  function handlePointerUp(event: React.PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || !state) return;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    if (draggedRef.current) {
      void persist(clips);
      setSelectedClipId(drag.clipId);
    } else {
      // 動かさずに離した=クリック選択のトグル
      setSelectedClipId((current) => (current === drag.clipId ? null : drag.clipId));
    }
  }

  function handleDelete(clipId: string) {
    setSelectedClipId(null);
    void persist(removeImageClip(clips, clipId) as ImageUiClip[]);
  }

  return (
    <div className="tlLane tlImageLane">
      {clips.length === 0 && (
        <span className="tlLanePlaceholder">画像はまだありません（左の「+ 画像」かファイルのドラッグ&ドロップで追加）</span>
      )}
      {clips.map((clip, arrayIndex) => {
        const durationMs = clip.end_ms - clip.start_ms;
        const widthPx = Math.max(8, durationMs * pxPerMs);
        const selected = selectedClipId === clip.id;
        const laneIndex = laneIndexForArrayIndex(clips.length, arrayIndex);
        return (
          <div
            className={`tlImageClip${selected ? " selected" : ""}`}
            key={clip.id}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => handlePointerDown(event, clip, "move")}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            style={{
              left: `${clip.start_ms * pxPerMs}px`,
              width: `${widthPx}px`,
              top: `${laneIndex * laneHeightPx + CLIP_INSET_PX}px`,
              height: `${laneHeightPx - CLIP_INSET_PX * 2}px`,
            }}
            title={`${clip.file} / ${(durationMs / 1000).toFixed(1)}秒（上のレーンほど手前に表示。位置・大きさはプレビュー上でドラッグ）`}
          >
            {/* 左端グリップ: 上下ドラッグでレーン順(=前後関係)入替え */}
            <div
              className="tlLaneReorderHandle"
              onPointerDown={(event) => handlePointerDown(event, clip, "lane")}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              title="上下ドラッグでレーン順を入替え（上のレーン=手前に表示）"
            >
              <GripVertical size={11} />
            </div>
            <span className="tlImageClipLabel">
              <ImageIcon size={11} />
              {clip.file}
            </span>
            {/* 左右端: 伸縮ハンドル */}
            <div
              className="tlImageResizeHandle tlImageResizeHandleStart"
              onPointerDown={(event) => handlePointerDown(event, clip, "resize-start")}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              title="表示開始を伸縮"
            />
            <div
              className="tlImageResizeHandle tlImageResizeHandleEnd"
              onPointerDown={(event) => handlePointerDown(event, clip, "resize-end")}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              title="表示終了を伸縮"
            />
            {selected && (
              <button
                className="tlImageDeleteButton"
                onClick={(event) => {
                  event.stopPropagation();
                  handleDelete(clip.id);
                }}
                onPointerDown={(event) => event.stopPropagation()}
                title="この画像クリップを削除"
                type="button"
              >
                <Trash2 size={11} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
