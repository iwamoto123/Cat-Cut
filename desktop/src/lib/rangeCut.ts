// 実行時(値)importのため、node --experimental-strip-types でテストを直接実行できるよう拡張子を明示する。
import { autoTelopTextFromWords, computeSceneKeptSubRanges, normalizeSceneSourceKeepRanges, subtractSourceRanges, splitSceneAtMs, type Scene } from "./scenes.ts";
import { snapEdgeTargetMs, withUpdatedBounds } from "./edgeTrim.ts";

/**
 * W20-1(波形の途中区間カット): シーン波形上の横ドラッグで選択した範囲をワンアクションで
 * カットするための純関数群。`2026-07-28_catcut-w20-mid-range-cut-and-fixes-spec.md` W20-1節に準拠。
 *
 * 設計方針:
 * - データ操作は既存プリミティブの合成に徹する: splitSceneAtMs(分割規則) +
 *   withUpdatedBounds(トリムアウト単語のdeleted化・telopText再生成・cutMarks後始末)。
 * - スナップはエッジトリムと同一規則(チップ境界吸着 chipSnapToleranceMs → 20msグリッド)。
 * - 分割直後の2シーンは時間的に連続しているため、applyEdgeTrimを素通しすると連動ロールが
 *   発生してしまう。範囲カットでは両シーンの端を withUpdatedBounds で独立に更新する。
 * - UI(SceneWaveformStrip)のドラッグ判定・px→ms換算もここに置き、テスト可能にする。
 */

/** 横ドラッグがこのpxを超えたら範囲選択モードを発動する(未満で離せば従来のクリック)。 */
export const RANGE_CUT_ACTIVATE_PX = 8;

/** スナップ後の範囲がこの幅(ms)未満なら何もしない(誤操作ガード)。 */
export const MIN_RANGE_CUT_MS = 80;

export type RangeCutOptions = {
  /** グリッドスナップ単位(ms)。既定20ms(EDGE_SNAP_MS)。 */
  snapMs?: number;
  /** 旧呼び出しとの互換用。明示範囲カットでは短い残りも保持し、範囲外へ広げない。 */
  minDurationMs?: number;
  /** 単語チップ境界へのスナップ許容範囲(ms)。既定0(=チップスナップ無効)。 */
  chipSnapToleranceMs?: number;
  /** 元動画の全尺(ms)。シーン終端のクランプ上限に使う。既定Infinity。 */
  sourceDurationMs?: number;
  /**
   * 中央範囲を分割せず、選択した映像区間を除外して1シーンのまま維持する。
   * テキストは単語中点で削除し、音声・映像は単語の有無に依存せず選択msどおりに切る。
   * 先頭・末尾に接する範囲は従来どおり端トリムする。既定false。
   */
  keepSingleScene?: boolean;
};

export type RangeCutMode =
  /** 変更なし(範囲が狭すぎる・シーンが見つからない等)。 */
  | "none"
  /** 通常ケース: 分割して両側を範囲端へトリム。 */
  | "split"
  /** 単一シーン維持: 正確な映像範囲を除外し、範囲内の単語をdeleted化。 */
  | "deleteWords"
  /** 先頭まで選択: シーン開始を範囲終端へ動かすstartエッジトリム相当。 */
  | "trimStart"
  /** 末尾まで選択: シーン終了を範囲始端へ動かすendエッジトリム相当。 */
  | "trimEnd"
  /** 全域を選択: 全動画区間を除外し、全単語deleted化。 */
  | "deleteAll";

export type RangeCutResult = {
  /** 更新後のシーン配列(変更が無ければ元の配列をそのまま返す)。 */
  scenes: Scene[];
  /** 実際にカットされた範囲の始端(ms)。スナップした明示選択の範囲。UIラベル用。 */
  appliedStartMs: number;
  /** 実際にカットされた範囲の終端(ms)。 */
  appliedEndMs: number;
  /** 適用されたケース。 */
  mode: RangeCutMode;
};

function clamp(value: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return Math.min(hi, Math.max(lo, value));
}

/** Keep exact media timing independently from the midpoint-based transcript allocation. */
function withRetainedRangeBounds(original: Scene, fragment: Scene, startMs: number, endMs: number): Scene {
  const trimmed = withUpdatedBounds(fragment, startMs, endMs);
  return {
    ...trimmed,
    sourceKeepRanges: normalizeSceneSourceKeepRanges(computeSceneKeptSubRanges(original), startMs, endMs),
  };
}

/** UI: 横方向の移動量が発動しきい値を超えたか(左右どちら向きでもよい)。 */
export function isRangeDragActivated(deltaXPx: number, thresholdPx: number = RANGE_CUT_ACTIVATE_PX): boolean {
  return Math.abs(deltaXPx) > thresholdPx;
}

/**
 * UI: ドラッグの2点(px)を正規化(順序整列+[0, widthPx]へクランプ)し、
 * シーン内の絶対msレンジへ変換する(スナップ前の生値)。
 */
export function rangeSelectionFromPx(
  scene: Pick<Scene, "sourceStartMs" | "sourceEndMs">,
  x1Px: number,
  x2Px: number,
  widthPx: number,
): { startPx: number; endPx: number; startMs: number; endMs: number } {
  const safeWidth = Math.max(1, widthPx);
  const startPx = clamp(Math.min(x1Px, x2Px), 0, safeWidth);
  const endPx = clamp(Math.max(x1Px, x2Px), 0, safeWidth);
  const spanMs = scene.sourceEndMs - scene.sourceStartMs;
  const startMs = scene.sourceStartMs + (startPx / safeWidth) * spanMs;
  const endMs = scene.sourceStartMs + (endPx / safeWidth) * spanMs;
  return { startPx, endPx, startMs, endMs };
}

/**
 * 範囲の両端をエッジトリムと同一規則でスナップ(チップ境界吸着→グリッド)し、
 * シーン範囲内へクランプして正規化(start<=end)する。
 * ドラッグ中のプレビューと確定処理(cutSceneRangeMs)の両方がこれを使うことでWYSIWYGを保証する。
 */
export function snapRangeCutBounds(
  scene: Scene,
  rangeStartMs: number,
  rangeEndMs: number,
  options: RangeCutOptions = {},
): { startMs: number; endMs: number } {
  const lo = scene.sourceStartMs;
  const hi = Math.min(scene.sourceEndMs, options.sourceDurationMs ?? Infinity);
  const rawStart = Math.min(rangeStartMs, rangeEndMs);
  const rawEnd = Math.max(rangeStartMs, rangeEndMs);
  const chipCandidates: number[] = [];
  for (const word of scene.words) {
    chipCandidates.push(word.startMs, word.endMs);
  }
  const snapOptions = { snapMs: options.snapMs, chipSnapToleranceMs: options.chipSnapToleranceMs };
  const startMs = clamp(snapEdgeTargetMs(rawStart, chipCandidates, snapOptions), lo, hi);
  const endMs = clamp(snapEdgeTargetMs(rawEnd, chipCandidates, snapOptions), startMs, hi);
  return { startMs, endMs };
}

/**
 * シーン波形の範囲選択カット本体。sceneIdのシーンから[rangeStartMs, rangeEndMs]区間を取り除く。
 *
 * - 通常ケース(範囲の左右両側に映像が残る):
 *   splitSceneAtMs(境界=範囲の中間点)で分割し、前半end=範囲始端・後半start=範囲終端へ
 *   withUpdatedBoundsで独立に更新する(連動ロールは発生させない)。
 * - 範囲がシーン先頭に接する:
 *   分割せずシーン開始を範囲終端へ動かす(startエッジトリム相当)。末尾側も同様。
 * - 範囲がシーン全域を覆う: 全動画区間を除外し、全単語deleted化する。
 * - 200ms未満の断片でも、選択外なら保持する。トリム操作の最小長を削除拡張に使わない。
 * - スナップ後の範囲がMIN_RANGE_CUT_MS未満なら何もしない(元の配列をそのまま返す)。
 */
export function cutSceneRangeMs(
  scenes: Scene[],
  sceneId: string,
  rangeStartMs: number,
  rangeEndMs: number,
  options: RangeCutOptions = {},
): RangeCutResult {
  const sceneIndex = scenes.findIndex((scene) => scene.id === sceneId);
  if (sceneIndex === -1) {
    return { scenes, appliedStartMs: rangeStartMs, appliedEndMs: rangeEndMs, mode: "none" };
  }
  const scene = scenes[sceneIndex];
  const { startMs, endMs } = snapRangeCutBounds(scene, rangeStartMs, rangeEndMs, options);
  if (endMs - startMs < MIN_RANGE_CUT_MS) {
    return { scenes, appliedStartMs: startMs, appliedEndMs: endMs, mode: "none" };
  }

  const originalKept = computeSceneKeptSubRanges(scene);
  if (!originalKept.some((range) => range.startMs < endMs && range.endMs > startMs)) {
    return { scenes, appliedStartMs: startMs, appliedEndMs: endMs, mode: "none" };
  }
  if (
    options.keepSingleScene &&
    startMs > scene.sourceStartMs &&
    endMs < scene.sourceEndMs
  ) {
    const words = scene.words.map((word) => {
      const midpoint = (word.startMs + word.endMs) / 2;
      const insideRange = midpoint >= startMs && midpoint < endMs;
      if (!insideRange || (word.deleted && !word.autoTrimmed)) return word;
      return { ...word, deleted: true, autoTrimmed: false };
    });
    const telopText = scene.telopEdited ? scene.telopText : autoTelopTextFromWords(words);
    const next = scenes.slice();
    next[sceneIndex] = {
      ...scene,
      words,
      telopText,
      sourceKeepRanges: subtractSourceRanges(originalKept, [{ startMs, endMs }]),
    };
    return { scenes: next, appliedStartMs: startMs, appliedEndMs: endMs, mode: "deleteWords" };
  }

  // Video margins remain editable even where the transcript has no word midpoint.
  const leftOk = startMs > scene.sourceStartMs;
  const rightOk = endMs < scene.sourceEndMs;

  if (leftOk && rightOk) {
    // The split only distributes text; the following independent trims determine the exact cut.
    const boundaryMs = Math.round((startMs + endMs) / 2);
    const splitScenes = splitSceneAtMs(scenes, sceneId, boundaryMs, { allowEmptySpeechSide: true });
    if (splitScenes === scenes) {
      // 理論上到達しない(分割不成立)。安全のため変更なしで返す。
      return { scenes, appliedStartMs: startMs, appliedEndMs: endMs, mode: "none" };
    }
    const next = splitScenes.slice();
    const first = splitScenes[sceneIndex];
    const second = splitScenes[sceneIndex + 1];
    next[sceneIndex] = withRetainedRangeBounds(scene, first, first.sourceStartMs, startMs);
    next[sceneIndex + 1] = withRetainedRangeBounds(scene, second, endMs, second.sourceEndMs);
    return { scenes: next, appliedStartMs: startMs, appliedEndMs: endMs, mode: "split" };
  }

  if (rightOk) {
    // 選択範囲が先頭に接する場合だけ開始端を動かす。
    const next = scenes.slice();
    next[sceneIndex] = withRetainedRangeBounds(scene, scene, endMs, scene.sourceEndMs);
    return { scenes: next, appliedStartMs: scene.sourceStartMs, appliedEndMs: endMs, mode: "trimStart" };
  }

  if (leftOk) {
    // 選択範囲が末尾に接する場合だけ終了端を動かす。
    const next = scenes.slice();
    next[sceneIndex] = withRetainedRangeBounds(scene, scene, scene.sourceStartMs, startMs);
    return { scenes: next, appliedStartMs: startMs, appliedEndMs: scene.sourceEndMs, mode: "trimEnd" };
  }

  // 全域を選択: 残存区間を空にし、全単語deleted化する。
  const words = scene.words.map((word) => {
    if (word.deleted && !word.autoTrimmed) return word;
    return { ...word, deleted: true, autoTrimmed: false };
  });
  const telopText = scene.telopEdited ? scene.telopText : autoTelopTextFromWords(words);
  const next = scenes.slice();
  next[sceneIndex] = { ...scene, words, telopText, sourceKeepRanges: [] };
  return { scenes: next, appliedStartMs: scene.sourceStartMs, appliedEndMs: scene.sourceEndMs, mode: "deleteAll" };
}
