import { Pencil } from "lucide-react";
import { nearestFilmstripFrame, type SceneTimelineBlock, type TimelineOpInfo } from "../../lib/timelineLayout";

type Props = {
  blocks: SceneTimelineBlock[];
  pxPerMs: number;
  currentSceneId: string | null;
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
export function VideoTrack({ blocks, pxPerMs, currentSceneId, frames, op, onSelect, onOpClick, onOpSeek }: Props) {
  return (
    <div className="tlLane tlVideoLane">
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
        const selected = block.sceneId === currentSceneId;
        const frame = nearestFilmstripFrame(frames, block.sourceStartMs);
        return (
          <div
            className={`tlVideoBlock${selected ? " selected" : ""}`}
            key={block.sceneId}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(block);
            }}
            style={{ left: `${block.timelineStartMs * pxPerMs}px`, width: `${Math.max(4, widthPx)}px` }}
            title={`${circledNumber(block.sceneIndex + 1)} ${block.telopText}`}
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
    </div>
  );
}
