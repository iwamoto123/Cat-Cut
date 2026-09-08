import { isEditorSelection, type EditorSelection } from "../../lib/editorSelection";
import { useEffect, useRef, useState } from "react";
import type { TimelineCutRange } from "../../lib/previewTimeline";
import { timelineBladePoint } from "../../lib/timelineBladeCut";
import { formatPrecisionTime } from "../../lib/precisionMedia";
import "./BladeCut.css";
import { Pencil } from "lucide-react";
import { nearestFilmstripFrame, type SceneTimelineBlock, type TimelineOpInfo } from "../../lib/timelineLayout";

type Props = {
  blocks: SceneTimelineBlock[];
  pxPerMs: number;
  currentSceneId: string | null;
  selection: EditorSelection;
  scissorsMode?: boolean;
  fps?: number;
  timelineCutRanges?: TimelineCutRange[];
  onBladeCut?: (sceneId: string, sourceMs: number) => void;
  /** U9のfilmstripキャッシュ由来のフレーム(元動画ms+配信URL)。 */
  frames: Array<{ ms: number; url: string }>;
  op: TimelineOpInfo | null;
  onSelect: (block: SceneTimelineBlock) => void;
  /** フェーズV2: OP編集モーダルを開く(V3からは✎ボタン/ダブルクリック)。 */
  onOpClick?: () => void;
  /** フェーズV3: OPブロッククリック=OP区間内のタイムラインmsへシーク。 */
  onOpSeek?: (timelineMs: number) => void;
};

/** シーン番号の丸数字表示(①〜㊿)。範囲外は "(n)" にフォールバック。 */
function circledNumber(oneBasedIndex: number): string {
  if (oneBasedIndex >= 1 && oneBasedIndex <= 20) return String.fromCodePoint(0x2460 + oneBasedIndex - 1);
  if (oneBasedIndex >= 21 && oneBasedIndex <= 35) return String.fromCodePoint(0x3251 + oneBasedIndex - 21);
  if (oneBasedIndex >= 36 && oneBasedIndex <= 50) return String.fromCodePoint(0x32b1 + oneBasedIndex - 36);
  return `(${oneBasedIndex})`;
}

/**
 * フェーズV1: 映像トラック。シーンごとの分割ブロック(連続フィルムストリップではない)。
 * - 各ブロック=左に先頭フレームのサムネ1枚(filmstripキャッシュから最も近い時刻を流用)
 *   +シーン番号+テロップ文言ラベル(省略表示)
 * - クリックで選択+再生ヘッド移動(シーン検品と連動)
 * - OPがある場合は先頭に紫系グループブロック(内部にOPクリップごとのサブブロック)。
 *   フェーズV3: クリック=OP区間へのシーク(プレビューでOPを再生できるようになったため)。
 *   OP編集は右上の✎ボタンまたはダブルクリック。
 */
export function VideoTrack({ blocks, pxPerMs, currentSceneId, selection, frames, op, onSelect, onOpClick, onOpSeek, scissorsMode = false, fps = 30, timelineCutRanges = [], onBladeCut }: Props) {
  const [bladeHover, setBladeHover] = useState<{ sceneId: string; timelineMs: number; sourceMs: number } | null>(null);
  const bladePress = useRef<{ sceneId: string; x: number; y: number } | null>(null);
  useEffect(() => { bladePress.current = null; setBladeHover(null); }, [blocks, scissorsMode]);
  return (
    <div className={`tlLane tlVideoLane${scissorsMode ? " isBladeMode" : ""}`}>
      {op && (
        <div
          className={`tlOpBlock${onOpSeek || onOpClick ? " clickable" : ""}`}
          onClick={
            onOpSeek
              ? (event) => {
                  event.stopPropagation();
                  // ブロック左端=タイムライン0。クリック位置をOP区間内のmsへ写像してシークする
                  const rect = event.currentTarget.getBoundingClientRect();
                  const ms = pxPerMs > 0 ? (event.clientX - rect.left) / pxPerMs : 0;
                  onOpSeek(Math.max(0, Math.min(op.durationMs - 1, ms)));
                }
              : onOpClick
                ? (event) => {
                    event.stopPropagation();
                    onOpClick();
                  }
                : undefined
          }
          onDoubleClick={
            onOpClick
              ? (event) => {
                  event.stopPropagation();
                  onOpClick();
                }
              : undefined
          }
          style={{ left: 0, width: `${Math.max(8, op.durationMs * pxPerMs)}px` }}
          title={
            onOpSeek
              ? `オープニング（${op.title || "タイトル未設定"}）: クリックでOPをプレビュー再生${onOpClick ? "・✎でオープニング編集" : ""}`
              : `オープニング（${op.title || "タイトル未設定"}）: オープニング編集から変更できます`
          }
        >
          <span className="tlOpBlockLabel">OP</span>
          {onOpClick && (
            <button
              className="tlOpEditButton"
              onClick={(event) => {
                event.stopPropagation();
                onOpClick();
              }}
              title="オープニングを編集"
              type="button"
            >
              <Pencil size={10} />
            </button>
          )}
          <div className="tlOpClips">
            {op.clips.map((clip, index) => (
              <div
                className="tlOpClip"
                key={`${clip.label}-${index}`}
                style={{
                  left: `${clip.startMs * pxPerMs}px`,
                  width: `${Math.max(4, (clip.endMs - clip.startMs) * pxPerMs - 2)}px`,
                }}
              >
                {(clip.endMs - clip.startMs) * pxPerMs >= 30 && (
                  <span className="tlOpClipLabel">{clip.label}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {blocks.map((block) => {
        const widthPx = (block.timelineEndMs - block.timelineStartMs) * pxPerMs;
        const selected = isEditorSelection(selection, "video", block.sceneId);
        const current = block.sceneId === currentSceneId;
        const frame = nearestFilmstripFrame(frames, block.sourceStartMs);
        return (
          <div
            className={`tlVideoBlock${selected ? " selected" : ""}${current ? " current" : ""}`}
            key={block.sceneId}
            onClick={(event) => {
              event.stopPropagation();
              event.currentTarget.focus({ preventScroll: true });
              if (scissorsMode) {
                const press = bladePress.current;
                bladePress.current = null;
                if (!onBladeCut || event.detail > 1 || press?.sceneId !== block.sceneId || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) return;
                const point = timelineBladePoint(block, event.clientX - event.currentTarget.getBoundingClientRect().left, pxPerMs, timelineCutRanges, fps);
                if (point) onBladeCut(block.sceneId, point.sourceMs);
                return;
              }
              onSelect(block);
            }}
            onPointerDown={(event) => {
              if (!scissorsMode || event.button !== 0 || !event.isPrimary) return;
              event.preventDefault();
              event.stopPropagation();
              bladePress.current = { sceneId: block.sceneId, x: event.clientX, y: event.clientY };
            }}
            onPointerMove={(event) => {
              if (!scissorsMode) return;
              const point = timelineBladePoint(block, event.clientX - event.currentTarget.getBoundingClientRect().left, pxPerMs, timelineCutRanges, fps);
              setBladeHover(point ? { ...point, sceneId: block.sceneId } : null);
            }}
            onPointerCancel={() => { bladePress.current = null; setBladeHover(null); }}
            onPointerLeave={() => { bladePress.current = null; setBladeHover(null); }}
            tabIndex={-1}
            role="button"
            aria-label={`映像 ${block.sceneIndex + 1}: ${block.telopText || "テロップなし"}${scissorsMode ? "。クリック位置で分割" : ""}`}
            aria-pressed={selected}
            style={{ left: `${block.timelineStartMs * pxPerMs}px`, width: `${Math.max(4, widthPx)}px` }}
            title={scissorsMode ? "B: クリック位置で映像を分割 · 範囲削除はシーン検品の波形 · Aで選択に戻る" : `${circledNumber(block.sceneIndex + 1)} ${block.telopText}`}
          >
            {frame && widthPx >= 44 && (
              <img alt="" className="tlVideoThumb" draggable={false} src={frame.url} />
            )}
            {widthPx >= 30 && (
              <span className="tlVideoLabel">
                <span className="tlVideoIndex">{circledNumber(block.sceneIndex + 1)}</span>
                {block.speed !== 1 && <span className="tlVideoSpeed">{block.speed}x</span>}
                {widthPx >= 76 && <span className="tlVideoText">{block.telopText}</span>}
              </span>
            )}
          </div>
        );
      })}
      {scissorsMode && bladeHover && <div className={`tlVideoBlade${bladeHover.timelineMs * pxPerMs > 210 ? " isRight" : ""}`} data-source-ms={bladeHover.sourceMs} data-timeline-ms={bladeHover.timelineMs} style={{ left: bladeHover.timelineMs * pxPerMs }}>
        <span>{formatPrecisionTime(bladeHover.timelineMs)} · クリックで分割</span>
      </div>}
    </div>
  );
}
