// フェーズU1-5(プレビュー忠実化): タイムラインms(書き出し後の時間軸)と元動画msの相互写像。
//
// composition.json の timeline.overlays / voice_data.cuts[].telops はタイムラインms基準だが、
// プレビューは元動画1本の<video>をkeep_segmentsシークで擬似カット再生しているため時間軸が異なる。
// timeline.cuts[i] は proposal.keep_segments[i] と同順・同尺(step08_composition.pyがstartMs昇順で
// cut_001, cut_002, ...を割り当てる)ことを利用し、
//   元動画ms → 該当keep_segmentを探す → timeline.start_ms + (ms - segment.start_ms)
// でタイムラインmsへ写像する(オーバーレイの表示判定は既存のisOverlayActiveをそのまま使える)。
//
// 実行時(値)importのため、node --experimental-strip-types でテストを直接実行できるよう拡張子を明示する。
import { isOverlayActive, type OverlayItem } from "./overlayItems.ts";

/** timeline.cuts[i] と keep_segments[i] の対応1件(main側 buildTimelineCutRanges が組み立てる)。 */
export type TimelineCutRange = {
  /** 元動画上の絶対ms(keep_segments[i])。 */
  sourceStartMs: number;
  sourceEndMs: number;
  /** 書き出し後タイムラインms(timeline.cuts[i].timeline)。 */
  timelineStartMs: number;
  timelineEndMs: number;
  /** 素材再生速度。省略時は等速。 */
  speed?: number;
  /**
   * フェーズW24 Phase A-2: cut単位のテロップ縦位置(timeline.cuts[i].telop_y。0〜1)。
   * orientation=vertical のとき step08 が顔回避配置で書き込む。無い既存run(横型・旧縦型)は
   * undefined=グローバル timeline.telop_y のまま(後方互換)。
   */
  telopY?: number;
  /**
   * フェーズW26: cut単位のパンチイン(交互ズーム。timeline.cuts[i].punch_scale / punch_origin)。
   * 縦型のとき step08 が交互に書き込む。無い既存run・横型は undefined=変形なし(後方互換)。
   */
  punchScale?: number;
  punchOriginX?: number;
  punchOriginY?: number;
};

/** IPC経由の未検証JSONを TimelineCutRange[] に正規化する(不正・区間ゼロの項目は除外)。 */
export function sanitizeTimelineCutRanges(raw: unknown): TimelineCutRange[] {
  if (!Array.isArray(raw)) return [];
  const ranges: TimelineCutRange[] = [];
  for (const entry of raw as Array<Record<string, unknown>>) {
    if (!entry || typeof entry !== "object") continue;
    const sourceStartMs = Number(entry.sourceStartMs);
    const sourceEndMs = Number(entry.sourceEndMs);
    const timelineStartMs = Number(entry.timelineStartMs);
    const timelineEndMs = Number(entry.timelineEndMs);
    const speed = Number(entry.speed);
    if (![sourceStartMs, sourceEndMs, timelineStartMs, timelineEndMs].every(Number.isFinite)) continue;
    if (sourceEndMs <= sourceStartMs || timelineEndMs <= timelineStartMs) continue;
    const telopY = Number(entry.telopY);
    const punchScale = Number(entry.punchScale);
    const punchOriginX = Number(entry.punchOriginX);
    const punchOriginY = Number(entry.punchOriginY);
    ranges.push({
      sourceStartMs,
      sourceEndMs,
      timelineStartMs,
      timelineEndMs,
      ...(Number.isFinite(speed) && speed > 0 ? { speed } : {}),
      // W24 Phase A-2: 0〜1の有効値のみ受ける(不正値はグローバルtelop_yへのフォールバック扱い)
      ...(Number.isFinite(telopY) && telopY >= 0 && telopY <= 1 ? { telopY } : {}),
      // W26: パンチイン(1.0超の有効値のみ。詳細な検証は punchIn.ts の normalizePunchIn)
      ...(Number.isFinite(punchScale) && punchScale > 1 ? { punchScale } : {}),
      ...(Number.isFinite(punchOriginX) ? { punchOriginX } : {}),
      ...(Number.isFinite(punchOriginY) ? { punchOriginY } : {}),
    });
  }
  return [...ranges].sort((a, b) => a.sourceStartMs - b.sourceStartMs);
}

/**
 * 元動画ms → タイムラインms。どのカット区間にも属さない(カットされた無音部など)場合は null。
 * 区間は [start, end) の半開区間として扱う(隣接カットの境界で二重ヒットしない)。
 */
export function sourceMsToTimelineMs(ranges: TimelineCutRange[], sourceMs: number): number | null {
  for (const range of ranges) {
    if (sourceMs >= range.sourceStartMs && sourceMs < range.sourceEndMs) {
      return range.timelineStartMs + (sourceMs - range.sourceStartMs) / (range.speed || 1);
    }
  }
  return null;
}

/**
 * タイムラインms → 元動画ms(逆写像)。オーバーレイ編集時のシーク位置算出などに使う。
 */
export function timelineMsToSourceMs(ranges: TimelineCutRange[], timelineMs: number): number | null {
  for (const range of ranges) {
    if (timelineMs >= range.timelineStartMs && timelineMs < range.timelineEndMs) {
      return range.sourceStartMs + (timelineMs - range.timelineStartMs) * (range.speed || 1);
    }
  }
  return null;
}

/**
 * プレビュー再生位置(元動画ms)で表示中のオーバーレイ一覧。
 * カット区間外(写像不能)の瞬間は非表示扱い(擬似カット再生では次カット先頭へ即シークされるため
 * 実際に見えるのは一瞬のみ)。
 */
export function activeOverlaysAtSourceMs(
  items: OverlayItem[],
  ranges: TimelineCutRange[],
  sourceMs: number,
): OverlayItem[] {
  const timelineMs = sourceMsToTimelineMs(ranges, sourceMs);
  if (timelineMs === null) return [];
  return items.filter((item) => isOverlayActive(item, timelineMs));
}

/** オーバーレイ文言のUI編集(保存前のローカル上書き)。 */
export type OverlayTextEdit = {
  text?: string;
  subtitle?: string;
};

/**
 * オーバーレイ一覧にUI編集を重ねる(U1-7: 保存前でもプレビューへ即時反映)。
 * text を編集した list_stack / cta_banner は lines を破棄して text 1行表示に切り替える
 * (main側の telop_directives 書き戻しと同じ解釈)。
 */
export function mergeOverlayEdits(
  items: OverlayItem[],
  edits: Record<string, OverlayTextEdit>,
): OverlayItem[] {
  return items.map((item) => {
    const edit = edits[item.id];
    if (!edit) return item;
    const next: OverlayItem = { ...item };
    if (typeof edit.text === "string") {
      next.text = edit.text;
      if (item.lines && item.lines.length > 0) {
        next.lines = edit.text.split("\n").filter((line) => line.length > 0);
      }
    }
    if (typeof edit.subtitle === "string") next.subtitle = edit.subtitle;
    return next;
  });
}
