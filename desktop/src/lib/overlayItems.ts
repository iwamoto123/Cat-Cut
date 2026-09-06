// フェーズT1-3(オーバーレイトラック): composition.json v2 の timeline.overlays の型と
// 正規化・表示区間判定ロジック。描画(Overlays.tsx)から独立した純関数として置き、
// node --experimental-strip-types のユニットテストで直接検証できるようにする。
//
// OverlayItem はテロップ(下部字幕)と独立した表示レイヤーで、タイムライン基準ms
// (timeline.cuts[].timeline.start_ms/end_ms と同じ軸)で表示区間を制御する。
// カット単位ではないため、カットを跨いで連続表示できる。

export const OVERLAY_TYPES = [
  "chapter_title",
  "profile_card",
  "list_stack",
  "cta_banner",
  "caption",
] as const;

export type OverlayType = (typeof OVERLAY_TYPES)[number];

export const OVERLAY_POSITIONS = ["top_left", "bottom_left", "center", "bottom"] as const;

export type OverlayPosition = (typeof OVERLAY_POSITIONS)[number];

export interface OverlayItem {
  id: string;
  type: OverlayType;
  /** タイムライン基準ms (書き出し後タイムライン。カットを跨げる) */
  start_ms: number;
  end_ms: number;
  text?: string;
  /** list_stack の列挙行、cta_banner の複数行など */
  lines?: string[];
  /** profile_card の肩書き等。"\n" で複数行 */
  subtitle?: string;
  position: OverlayPosition;
  /** overlay用presetの参照(省略時はtype既定のスタイル) */
  style?: string;
}

/** type ごとの既定表示位置(position 省略時に補完する)。 */
export const DEFAULT_OVERLAY_POSITION: Record<OverlayType, OverlayPosition> = {
  chapter_title: "top_left",
  profile_card: "bottom_left",
  list_stack: "center",
  cta_banner: "bottom",
  caption: "bottom",
};

const isOverlayType = (value: unknown): value is OverlayType =>
  typeof value === "string" && (OVERLAY_TYPES as readonly string[]).includes(value);

const isOverlayPosition = (value: unknown): value is OverlayPosition =>
  typeof value === "string" && (OVERLAY_POSITIONS as readonly string[]).includes(value);

/**
 * timeline.overlays (未検証のJSON) を OverlayItem[] に正規化する。
 * - 配列でない/未定義なら空扱い(overlays無しの既存compositionは描画なし)
 * - type不正・区間不正(end<=start)の項目は除外
 * - position 省略・不正時は type 既定へ補完
 */
export function normalizeOverlays(raw: unknown): OverlayItem[] {
  if (!Array.isArray(raw)) return [];
  const items: OverlayItem[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i] as Record<string, unknown> | null;
    if (!entry || typeof entry !== "object") continue;
    if (!isOverlayType(entry.type)) continue;
    const startMs = entry.start_ms;
    const endMs = entry.end_ms;
    if (typeof startMs !== "number" || typeof endMs !== "number" || endMs <= startMs) continue;

    items.push({
      id: typeof entry.id === "string" && entry.id ? entry.id : `overlay_${i}`,
      type: entry.type,
      start_ms: startMs,
      end_ms: endMs,
      text: typeof entry.text === "string" ? entry.text : undefined,
      lines: Array.isArray(entry.lines)
        ? entry.lines.filter((line): line is string => typeof line === "string")
        : undefined,
      subtitle: typeof entry.subtitle === "string" ? entry.subtitle : undefined,
      position: isOverlayPosition(entry.position)
        ? entry.position
        : DEFAULT_OVERLAY_POSITION[entry.type],
      style: typeof entry.style === "string" ? entry.style : undefined,
    });
  }
  return items;
}

/** タイムライン時刻ms時点でオーバーレイが表示中か([start_ms, end_ms) の半開区間)。 */
export function isOverlayActive(item: OverlayItem, timelineMs: number): boolean {
  return timelineMs >= item.start_ms && timelineMs < item.end_ms;
}

/** オーバーレイの表示行(list_stack/cta_bannerの本文)。lines 優先、無ければ text を1行として返す。 */
export function overlayLines(item: OverlayItem): string[] {
  if (item.lines && item.lines.length > 0) return item.lines;
  return item.text ? [item.text] : [];
}
