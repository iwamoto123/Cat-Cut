import { buildRulerTicks, formatTimelineMs } from "../../lib/timelineLayout";

type Props = {
  totalMs: number;
  pxPerMs: number;
};

/**
 * フェーズV1: タイムライン上部の時間ルーラー(mm:ss)。
 * 主目盛り(ラベル付き)はズーム倍率に応じて間隔を自動選択し、補助目盛りを1/5間隔で敷く。
 * クリックシークは親(TimelineView)のキャンバスクリックハンドラに任せる。
 */
export function TimelineRuler({ totalMs, pxPerMs }: Props) {
  const { ticks } = buildRulerTicks(totalMs, pxPerMs);
  return (
    <div className="tlRuler">
      {ticks.map((tick) => (
        <div
          className={tick.major ? "tlRulerTick tlRulerTickMajor" : "tlRulerTick"}
          key={tick.ms}
          style={{ left: `${tick.ms * pxPerMs}px` }}
        >
          {tick.major && <span className="tlRulerLabel">{formatTimelineMs(tick.ms)}</span>}
        </div>
      ))}
    </div>
  );
}
