import { useRef, useState } from "react";
import { GripVertical, Music, Trash2 } from "lucide-react";
import type { BgmClipData } from "../../lib/bgmAudio";
import {
  dragBgmVolume,
  moveBgmClip,
  removeBgmClip,
  replaceBgmClip,
  resizeBgmClip,
  setBgmFade,
  setBgmVolume,
} from "../../lib/bgmClips";
import { laneIndexForArrayIndex, laneIndexForOffsetY, moveClipToLane } from "../../lib/clipLanes";

/** ドラッグ中のスナップしきい値(px)。ms換算はズーム倍率(pxPerMs)で行う。 */
const SNAP_PX = 8;
/** クリップのレーン内上下インセット(px)。styles.css の .tlBgmClip top/bottom と一致させる。 */
const CLIP_INSET_PX = 6;
/** エンベロープ描画域の上余白(px、クリップ座標)。ファイル名ラベルと音量線の重なりを避ける。 */
const ENVELOPE_TOP_PX = 20;
/** エンベロープ描画域の下余白(px、クリップ座標)。 */
const ENVELOPE_BOTTOM_PX = 6;

export type BgmState = Awaited<ReturnType<typeof window.catcut.listBgm>>;
export type BgmUiClip = BgmState["clips"][number];

type DragState = {
  clipId: string;
  mode: "move" | "resize-start" | "resize-end" | "fade-in" | "fade-out" | "volume" | "lane";
  startClientX: number;
  startClientY: number;
  /** レーン入替え(mode=lane)用: トラック(.tlLane)上端のクライアントY。 */
  trackTopClientY: number;
  /** ドラッグ開始時点のクリップ(差分は常にこのスナップショットへ適用する)。 */
  snapshot: BgmUiClip;
};

type Props = {
  runDir: string;
  state: BgmState | null;
  /** ドラッグ中のライブ更新と保存後の反映(プレビュー並走のためAppが保持する)。 */
  onStateChange: (state: BgmState) => void;
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
 * - フェード角の丸つまみをドラッグ=フェード長変更、水平線の上下ドラッグ=音量変更(0〜100%)
 * - クリップ本体ドラッグ=移動、左右端=伸縮、削除ボタンは選択時に表示
 * - V6-5: 1クリップ=1レーンの段積み表示(時間の重なりはレーン分離で視覚的に解決。
 *   再生は従来どおりミックス)。左端グリップの上下ドラッグでレーン順を入替えられる
 * - 変更は操作確定(ポインタ解放)ごとに bgm.json へ即保存(書き出し時にstep08が転写)
 */
export function BgmTrackV2({ runDir, state, onStateChange, pxPerMs, laneHeightPx }: Props) {
  const dragRef = useRef<DragState | null>(null);
  const draggedRef = useRef(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);

  const clips = state?.clips ?? [];
  const selectedClip = clips.find((clip) => clip.id === selectedClipId) ?? null;
  // エンベロープ座標はすべて「クリップ要素内のpx」で計算する(SVG・つまみ・ヒットエリアで共通)
  const clipHeightPx = laneHeightPx - CLIP_INSET_PX * 2;
  const envelopeHeightPx = Math.max(8, clipHeightPx - ENVELOPE_TOP_PX - ENVELOPE_BOTTOM_PX);

  async function persist(nextClips: BgmUiClip[]) {
    if (!state) return;
    // ライブ状態を即時反映してから保存(保存結果=正規化済みで上書き)
    onStateChange({ ...state, clips: nextClips });
    try {
      const saved = await window.catcut.saveBgm({
        runDir,
        clips: nextClips.map(({ url: _url, audioDurationMs: _dur, ...data }) => data),
      });
      onStateChange(saved);
    } catch {
      // 保存失敗時もUI状態は維持する(次の操作で再保存される)
    }
  }

  function handlePointerDown(
    event: React.PointerEvent<HTMLElement>,
    clip: BgmUiClip,
    mode: DragState["mode"],
  ) {
    event.stopPropagation();
    event.preventDefault();
    const track = (event.currentTarget as HTMLElement).closest(".tlLane");
    dragRef.current = {
      clipId: clip.id,
      mode,
      startClientX: event.clientX,
      startClientY: event.clientY,
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
      // V6-5: レーン入替え。ポインタYの属するレーンへ配列位置を移す(配列順=レーン順)
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
    const deltaYPx = event.clientY - drag.startClientY;
    const deltaMs = deltaPx / pxPerMs;
    if (Math.abs(deltaPx) > 2 || Math.abs(deltaYPx) > 2) draggedRef.current = true;
    const bounds = {
      timelineDurationMs: state.timelineDurationMs,
      audioDurationMs: drag.snapshot.audioDurationMs,
      snapMs: SNAP_PX / pxPerMs,
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
        updated = dragBgmVolume(drag.snapshot, drag.snapshot.volume, deltaYPx, envelopeHeightPx);
        break;
    }
    const current = clips.find((clip) => clip.id === drag.clipId);
    if (!current) return;
    onStateChange({ ...state, clips: replaceBgmClip(clips, applyClipUpdate(current, updated)) as BgmUiClip[] });
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
    void persist(removeBgmClip(clips, clipId) as BgmUiClip[]);
  }

  return (
    <div className="tlLane tlBgmLane">
      {selectedClip && (
        <div
          className="tlBgmVolumeInspector"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <span>音量</span>
          <input
            aria-label="BGM音量（パーセント）"
            max={100}
            min={0}
            onBlur={() => void persist(clips)}
            onChange={(event) => {
              const percent = Number(event.target.value);
              if (!Number.isFinite(percent)) return;
              const updated = setBgmVolume(selectedClip, percent / 100);
              onStateChange({
                ...state!,
                clips: replaceBgmClip(clips, applyClipUpdate(selectedClip, updated)) as BgmUiClip[],
              });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            step={0.1}
            type="number"
            value={(selectedClip.volume * 100).toFixed(1)}
          />
          <span>%</span>
        </div>
      )}
      {clips.length === 0 && (
        <span className="tlLanePlaceholder">BGMはまだありません（左の「+ BGM」かファイルのドラッグ&ドロップで追加）</span>
      )}
      {clips.map((clip, arrayIndex) => {
        const durationMs = clip.end_ms - clip.start_ms;
        const widthPx = Math.max(8, durationMs * pxPerMs);
        const selected = selectedClipId === clip.id;
        const laneIndex = laneIndexForArrayIndex(clips.length, arrayIndex);
        // エンベロープ座標(クリップ内px): 音量線のy・フェード斜線の始点/終点x
        const bottomY = ENVELOPE_TOP_PX + envelopeHeightPx;
        const volumeY = ENVELOPE_TOP_PX + (1 - clip.volume) * envelopeHeightPx;
        const fadeInX = Math.min(widthPx, clip.fade_in_ms * pxPerMs);
        const fadeOutX = Math.max(0, widthPx - clip.fade_out_ms * pxPerMs);
        const volumeLineLeft = Math.min(fadeInX, widthPx);
        const volumeLineWidth = Math.max(0, fadeOutX - fadeInX);
        return (
          <div
            className={`tlBgmClip${selected ? " selected" : ""}`}
            key={clip.id}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => handlePointerDown(event, clip, "move")}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            style={{
              left: `${clip.start_ms * pxPerMs}px`,
              width: `${widthPx}px`,
              top: `${laneIndex * laneHeightPx + CLIP_INSET_PX}px`,
              height: `${clipHeightPx}px`,
            }}
            title={`${clip.file} / 音量${(clip.volume * 100).toFixed(1)}% / フェードイン${(clip.fade_in_ms / 1000).toFixed(1)}秒・アウト${(clip.fade_out_ms / 1000).toFixed(1)}秒`}
          >
            {/* 左端グリップ: 上下ドラッグでレーン順入替え */}
            <div
              className="tlLaneReorderHandle"
              onPointerDown={(event) => handlePointerDown(event, clip, "lane")}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              title="上下ドラッグでレーン順を入替え"
            >
              <GripVertical size={11} />
            </div>
            <span className="tlBgmClipLabel">
              <Music size={11} />
              {clip.file}
            </span>
            {/* 音量エンベロープ(水平線+フェード斜線)。preserveAspectRatio=noneにせず実px座標で描く */}
            <svg className="tlBgmEnvelope" height={clipHeightPx} width={widthPx}>
              <polyline
                fill="none"
                points={`0,${bottomY} ${fadeInX},${volumeY} ${fadeOutX},${volumeY} ${widthPx},${bottomY}`}
                stroke="#d97706"
                strokeWidth={2}
              />
            </svg>
            {/* 音量%ラベル(水平線の上) */}
            {volumeLineWidth >= 40 && (
              <span
                className="tlBgmVolumeLabel"
                style={{ left: `${volumeLineLeft + volumeLineWidth / 2}px`, top: `${volumeY - 16}px` }}
              >
                {(clip.volume * 100).toFixed(1)}%
              </span>
            )}
            {/* 音量線の上下ドラッグ用ヒットエリア */}
            {volumeLineWidth > 4 && (
              <div
                className="tlBgmVolumeHit"
                onPointerDown={(event) => handlePointerDown(event, clip, "volume")}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                style={{ left: `${volumeLineLeft}px`, width: `${volumeLineWidth}px`, top: `${volumeY - 5}px` }}
                title={`音量 ${(clip.volume * 100).toFixed(1)}%（上下ドラッグで変更。クリック選択後は固定入力もできます）`}
              />
            )}
            {/* フェード角の丸つまみ(ドラッグでフェード長変更) */}
            <div
              className="tlBgmFadeKnob"
              onPointerDown={(event) => handlePointerDown(event, clip, "fade-in")}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              style={{ left: `${fadeInX - 5}px`, top: `${volumeY - 5}px` }}
              title={`フェードイン ${(clip.fade_in_ms / 1000).toFixed(1)}秒（左右ドラッグ）`}
            />
            <div
              className="tlBgmFadeKnob"
              onPointerDown={(event) => handlePointerDown(event, clip, "fade-out")}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              style={{ left: `${fadeOutX - 5}px`, top: `${volumeY - 5}px` }}
              title={`フェードアウト ${(clip.fade_out_ms / 1000).toFixed(1)}秒（左右ドラッグ）`}
            />
            {/* 左右端: 伸縮ハンドル */}
            <div
              className="tlBgmResizeHandle tlBgmResizeHandleStart"
              onPointerDown={(event) => handlePointerDown(event, clip, "resize-start")}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              title="開始位置を伸縮"
            />
            <div
              className="tlBgmResizeHandle tlBgmResizeHandleEnd"
              onPointerDown={(event) => handlePointerDown(event, clip, "resize-end")}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              title="終了位置を伸縮"
            />
            {selected && (
              <button
                className="tlBgmDeleteButton"
                onClick={(event) => {
                  event.stopPropagation();
                  handleDelete(clip.id);
                }}
                onPointerDown={(event) => event.stopPropagation()}
                title="このBGMクリップを削除"
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
