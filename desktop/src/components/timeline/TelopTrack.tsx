import { Pencil } from "lucide-react";
import type { SceneTimelineBlock } from "../../lib/timelineLayout";

type Props = {
  blocks: SceneTimelineBlock[];
  pxPerMs: number;
  currentSceneId: string | null;
  /** sceneId→プリセットの代表fill色(telopStyleSwatchColorsで解決済み)。 */
  colorBySceneId: Map<string, string>;
  onSelect: (block: SceneTimelineBlock) => void;
  /** U6のテロップスタイル詳細エディタを開く(directedモードのみ)。 */
  onEdit?: (sceneId: string) => void;
};

/**
 * フェーズV1: テロップトラック。スロット(=シーン)単位の色付きブロック。
 * - 背景にプリセットのfill色を薄く反映し、文言の先頭を省略表示する
 * - クリックで選択(=再生ヘッド移動でシーン検品のシーン選択と連動)
 * - ダブルクリック or 選択中ブロックの編集ボタンで詳細エディタを開く
 */
export function TelopTrack({ blocks, pxPerMs, currentSceneId, colorBySceneId, onSelect, onEdit }: Props) {
  return (
    <div className="tlLane tlTelopLane">
      {blocks.map((block) => {
        const widthPx = (block.timelineEndMs - block.timelineStartMs) * pxPerMs;
        const color = colorBySceneId.get(block.sceneId) ?? "#94a3b8";
        const selected = block.sceneId === currentSceneId;
        return (
          <div
            className={`tlTelopBlock${selected ? " selected" : ""}`}
            key={block.sceneId}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(block);
            }}
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
              // fill色を白へ7割混ぜたパステル背景+同系のボーダー(モックアップの色付きブロック)
              background: `color-mix(in srgb, ${color} 30%, #ffffff)`,
              borderColor: selected ? undefined : `color-mix(in srgb, ${color} 55%, #ffffff)`,
            }}
            title={block.telopText}
          >
            {widthPx >= 28 && <span className="tlTelopBlockText">{block.telopText}</span>}
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
    </div>
  );
}
