import { useState, type CSSProperties } from "react";
import { isEditorSelection, type EditorSelection } from "../../lib/editorSelection";
import { Pencil } from "lucide-react";
import type { SceneTimelineBlock } from "../../lib/timelineLayout";

type Props = {
  blocks: SceneTimelineBlock[];
  pxPerMs: number;
  currentSceneId: string | null;
  selection: EditorSelection;
  /** sceneId→プリセットの代表fill色(telopStyleSwatchColorsで解決済み)。 */
  colorBySceneId: Map<string, string>;
  onSelect: (block: SceneTimelineBlock) => void;
  /** U6のテロップスタイル詳細エディタを開く(directedモードのみ)。 */
  onEdit?: (sceneId: string) => void;
  onReorder?: (sceneId: string, beforeId: string | null) => void;
  onDragStart?: () => void;
  onDragSceneChange?: (id: string | null) => void;
};

/**
 * フェーズV1: テロップトラック。スロット(=シーン)単位の色付きブロック。
 * - 背景にプリセットのfill色を薄く反映し、文言の先頭を省略表示する
 * - クリックで選択(=再生ヘッド移動でシーン検品のシーン選択と連動)
 * - ダブルクリック or 選択中ブロックの編集ボタンで詳細エディタを開く
 */
export function TelopTrack({ blocks, pxPerMs, currentSceneId, selection, colorBySceneId, onSelect, onEdit, onReorder, onDragStart, onDragSceneChange }: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [insertion, setInsertion] = useState<{ beforeId: string | null; ms: number } | null>(null);
  return (
    <div className={`tlLane tlTelopLane${dragId ? " isReordering" : ""}`}
      onDragOver={(event) => {
        if (!dragId) return;
        event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move";
        const rect = event.currentTarget.getBoundingClientRect();
        const ms = (event.clientX - rect.left) / pxPerMs;
        const other = blocks.filter((block) => block.sceneId !== dragId);
        const next = other.find((block) => ms < (block.timelineStartMs + block.timelineEndMs) / 2);
        setInsertion({ beforeId: next?.sceneId ?? null, ms: next?.timelineStartMs ?? blocks.at(-1)?.timelineEndMs ?? 0 });
        const viewport = event.currentTarget.closest<HTMLElement>(".timelineViewport");
        if (viewport) {
          const bounds = viewport.getBoundingClientRect();
          if (event.clientX > bounds.right - 48) viewport.scrollLeft += 32;
          else if (event.clientX < bounds.left + 48) viewport.scrollLeft -= 32;
        }
      }}
      onDrop={(event) => {
        if (!dragId) return;
        event.preventDefault(); event.stopPropagation();
        if (insertion) onReorder?.(dragId, insertion.beforeId);
        setDragId(null); setInsertion(null); onDragSceneChange?.(null);
      }}
    >
      {blocks.map((block) => {
        const widthPx = (block.timelineEndMs - block.timelineStartMs) * pxPerMs;
        const color = colorBySceneId.get(block.sceneId) ?? "#94a3b8";
        const selected = isEditorSelection(selection, "telop", block.sceneId);
        const current = block.sceneId === currentSceneId;
        return (
          <div
            className={`tlTelopBlock${selected ? " selected" : ""}${current ? " current" : ""}`}
            key={block.sceneId}
            draggable={Boolean(onReorder)}
            onDragStart={(event) => {
              event.stopPropagation();
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("application/x-catcut-scene", block.sceneId);
              setDragId(block.sceneId); setInsertion(null); onDragStart?.(); onDragSceneChange?.(block.sceneId);
            }}
            onDragEnd={() => { setDragId(null); setInsertion(null); onDragSceneChange?.(null); }}
            data-dragging={dragId === block.sceneId || undefined}
            onClick={(event) => {
              event.stopPropagation();
              event.currentTarget.focus({ preventScroll: true });
              onSelect(block);
            }}
            tabIndex={-1}
            role="button"
            aria-label={`テロップ ${block.sceneIndex + 1}: ${block.telopText || "テロップなし"}`}
            aria-pressed={selected}
            onDoubleClick={
              onEdit
                ? (event) => {
                    event.stopPropagation();
                    onEdit(block.sceneId);
                  }
                : undefined
            }
            style={{
              left: `${block.timelineStartMs * pxPerMs}px`,
              width: `${Math.max(4, widthPx)}px`,
              "--clip-telop-color": color,
            } as CSSProperties}
            title={`${block.telopText}
ドラッグで映像とテロップを一緒に並べ替え`}
          >
            {widthPx >= 28 && <span className={`tlTelopBlockText${block.telopText ? "" : " empty"}`}>{block.telopText || "テロップなし"}</span>}
            {selected && onEdit && widthPx >= 48 && (
              <button
                className="tlTelopEditButton"
                onClick={(event) => {
                  event.stopPropagation();
                  onEdit(block.sceneId);
                }}
                title="テロップデザインを編集"
                type="button"
              >
                <Pencil size={11} />
              </button>
            )}
          </div>
        );
      })}
      {dragId && insertion && <div className="tlSceneInsertion" style={{ left: insertion.ms * pxPerMs }}>
        <span>映像＋テロップをここに挿入</span>
      </div>}
    </div>
  );
}
