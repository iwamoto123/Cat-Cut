import { useEffect, useRef } from "react";
import { AlertTriangle, Pencil } from "lucide-react";
import type { SuspicionItem } from "../lib/suspicionQueue";

type Props = {
  items: SuspicionItem[];
  resolvedIds: Set<string>;
  activeItemId: string | null;
  aiReviewEnabled?: boolean;
  onSelectItem: (item: SuspicionItem) => void;
  onToggleResolved: (item: SuspicionItem) => void;
  onFixItem: (item: SuspicionItem) => void;
};

function formatTimestamp(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function SuspicionQueuePanel({
  items,
  resolvedIds,
  activeItemId,
  aiReviewEnabled = false,
  onSelectItem,
  onToggleResolved,
  onFixItem,
}: Props) {
  const resolvedCount = items.filter((item) => resolvedIds.has(item.id)).length;
  const remainingCount = items.length - resolvedCount;
  const activeItemRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!activeItemRef.current) return;
    activeItemRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeItemId]);

  return (
    <section className="suspicionQueuePanel">
      <div className="suspicionQueueHeader">
        <h3>要確認リスト</h3>
        <span className="suspicionQueueProgress">
          {aiReviewEnabled
            ? items.length === 0
              ? "AI校正済み・確認事項なし"
              : `AI校正済み・残り${remainingCount}件を確認すれば完了です`
            : items.length === 0
              ? "確認事項なし"
              : `要確認 ${items.length}件中 ${resolvedCount}件確認済み`}
        </span>
      </div>
      {items.length === 0 ? (
        <div className="suspicionEmpty">
          AIチェックでは問題が見つかりませんでした。追い読みで最終確認してください。
        </div>
      ) : (
        <div className="suspicionList">
          {items.map((item) => {
            const resolved = resolvedIds.has(item.id);
            const isActive = activeItemId === item.id;
            return (
              <div
                className={`suspicionItem ${item.severity} ${isActive ? "active" : ""} ${resolved ? "resolved" : ""}`}
                key={item.id}
                onClick={() => onSelectItem(item)}
                ref={isActive ? activeItemRef : undefined}
              >
                <div className="suspicionItemMeta">
                  <AlertTriangle size={13} />
                  <span>{item.label}</span>
                  <time>{formatTimestamp(item.timestampMs)}</time>
                </div>
                <div className="suspicionItemText">{item.text}</div>
                {item.detail && <div className="suspicionItemDetail">{item.detail}</div>}
                <div className="suspicionItemActions" onClick={(event) => event.stopPropagation()}>
                  <label>
                    <input checked={resolved} onChange={() => onToggleResolved(item)} type="checkbox" />
                    解決済み
                  </label>
                  <button disabled={!item.wordIds.length} onClick={() => onFixItem(item)} type="button">
                    <Pencil size={12} />
                    <span>修正する</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
