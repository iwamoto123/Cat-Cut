// フェーズV8-5: オーバーレイのUI用語。開発用語(chapter_title等)をユーザー語彙の
// 日本語名へ写像する。UI表示専用のためdesktop側のみ(remotionコピー共有ではない)。
import type { OverlayType } from "./overlayItems.ts";

/** 種類別のユーザー向け名称(仕様書V8-5で確定した語彙)。 */
export const OVERLAY_TYPE_LABELS: Record<OverlayType, string> = {
  chapter_title: "左上タイトル",
  profile_card: "プロフィールカード",
  cta_banner: "CTAバナー",
  list_stack: "箇条書き",
  caption: "キャプション",
};

/** typeのユーザー向け名称(未知typeはそのまま返す保険)。 */
export function overlayTypeLabel(type: OverlayType | string): string {
  return OVERLAY_TYPE_LABELS[type as OverlayType] ?? String(type);
}

/** タイムラインmsを m:ss 表示にする(表示時間帯の見出し用)。 */
export function formatOverlayClockMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** オーバーレイの表示時間帯ラベル(例: 0:12〜0:17)。 */
export function overlayTimeRangeLabel(startMs: number, endMs: number): string {
  return `${formatOverlayClockMs(startMs)}〜${formatOverlayClockMs(endMs)}`;
}
