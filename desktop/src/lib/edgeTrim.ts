// 実行時(値)importのため、node --experimental-strip-types でテストを直接実行できるよう拡張子を明示する。
import { autoTelopTextFromWords, type Scene, type SceneWord } from "./scenes.ts";
import { snapMsToGrid } from "./boundaryNudge.ts";

/**
 * シーン行UI(検品UI v2 Phase 3)の「行端の長押しスライド」を支える純関数群。
 * `2026-07-03_catcut-scene-row-ui-spec.md` の「行端の長押しスライド(動画幅の調整)」節に準拠する。
 *
 * 設計方針:
 * - UI(SceneWaveformStrip)はポインタ座標から「絶対ms」を計算するだけに徹し、
 *   スナップ・連動判定・クランプ・トリムアウト単語のdeleted化はすべてこの純関数側に閉じ込める。
 * - ドラッグ中のライブプレビューも、確定コミットも同じ applyEdgeTrim() を呼ぶだけにすることで、
 *   「見た目のプレビュー」と「確定結果」が常に一致する(WYSIWYG)ことを保証する。
 */

export type EdgeTrimEdge = "start" | "end";

/** 20msスナップ(仕様書「行端の長押しスライド」節)。 */
export const EDGE_SNAP_MS = 20;

/** 最小シーン長(仕様書「トリム限界」節)。 */
export const MIN_SCENE_DURATION_MS = 200;

export type EdgeTrimOptions = {
  /** グリッドスナップ単位(ms)。既定20ms。 */
  snapMs?: number;
  /** 移動後に確保する最小シーン長(ms)。既定200ms。 */
  minDurationMs?: number;
  /**
   * 単語チップ境界へのスナップ許容範囲(ms)。既定0(=チップスナップ無効)。
   * UI側で「15px」をシーンのms/px比に変換してからここに渡す。
   */
  chipSnapToleranceMs?: number;
  /** 元動画の全尺(ms)。隣接シーンが無い外側の端(先頭シーンの開始・末尾シーンの終了)のクランプに使う。既定Infinity(先頭は0)。 */
  sourceDurationMs?: number;
};

export type EdgeTrimResult = {
  /** 更新後のシーン配列(変更が無ければ元の配列をそのまま返す)。 */
  scenes: Scene[];
  /** スナップ・クランプ後に実際に適用された境界位置(ms)。 */
  appliedMs: number;
  /** 隣接シーンとの連動ロールが発生したか(false=独立トリム)。 */
  linked: boolean;
  /** 連動時、もう一方の境界が変わった隣接シーンのindex。連動していない場合はnull。 */
  neighborIndex: number | null;
};

function clamp(value: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return Math.min(hi, Math.max(lo, value));
}

function wordOverlapsRange(word: SceneWord, startMs: number, endMs: number): boolean {
  return word.endMs > startMs && word.startMs < endMs;
}

/**
 * 隣接シーンと時間的に連続しているか(前シーンのend == 次シーンのstart)を判定する。
 * 仕様書「連動(ロール編集)」節の判定条件そのもの。
 */
export function isEdgeLinked(scenes: Scene[], sceneIndex: number, edge: EdgeTrimEdge): boolean {
  const scene = scenes[sceneIndex];
  if (!scene) return false;
  if (edge === "end") {
    const next = scenes[sceneIndex + 1];
    return !!next && next.sourceStartMs === scene.sourceEndMs;
  }
  const prev = scenes[sceneIndex - 1];
  return !!prev && prev.sourceEndMs === scene.sourceStartMs;
}

/**
 * ドラッグ中の境界を単語チップ境界へスナップするための候補ms一覧を集める。
 * 連動時は隣接シーンのチップ境界も候補に含める(共有境界を相手側のチップにも合わせられるように)。
 */
export function collectChipSnapCandidatesMs(scenes: Scene[], sceneIndex: number, edge: EdgeTrimEdge): number[] {
  const scene = scenes[sceneIndex];
  if (!scene) return [];
  const candidates: number[] = [];
  for (const word of scene.words) {
    candidates.push(word.startMs, word.endMs);
  }
  if (isEdgeLinked(scenes, sceneIndex, edge)) {
    const neighbor = edge === "end" ? scenes[sceneIndex + 1] : scenes[sceneIndex - 1];
    if (neighbor) {
      for (const word of neighbor.words) {
        candidates.push(word.startMs, word.endMs);
      }
    }
  }
  return candidates;
}

/**
 * targetMsを、まず単語チップ境界への吸着(chipSnapToleranceMs以内に候補があれば最近傍を採用)、
 * 無ければ20ms(既定)グリッドへスナップする。
 */
export function snapEdgeTargetMs(
  targetMs: number,
  chipSnapCandidatesMs: number[],
  options: { snapMs?: number; chipSnapToleranceMs?: number } = {},
): number {
  const tolerance = options.chipSnapToleranceMs ?? 0;
  if (tolerance > 0 && chipSnapCandidatesMs.length) {
    let nearest: number | null = null;
    let nearestDist = Infinity;
    for (const candidate of chipSnapCandidatesMs) {
      const dist = Math.abs(candidate - targetMs);
      if (dist <= tolerance && dist < nearestDist) {
        nearest = candidate;
        nearestDist = dist;
      }
    }
    if (nearest != null) return nearest;
  }
  return snapMsToGrid(targetMs, options.snapMs ?? EDGE_SNAP_MS);
}

/**
 * シーンの[sourceStartMs, sourceEndMs)を更新し、範囲外に出た単語を自動deleted化(戻れば復活)する。
 * telopTextは未編集の場合のみ自動再生成する(手動編集済みテキストは維持する、既存関数群と同じ方針)。
 * cutMarksは新しい範囲外のものを取り除く(splitSceneAtMs等と同じ後始末)。
 * W20-1: 範囲選択カット(rangeCut.ts)も同じ規則で両端をトリムするため公開する。
 */
export function withUpdatedBounds(scene: Scene, sourceStartMs: number, sourceEndMs: number): Scene {
  let wordsChanged = false;
  const words = scene.words.map((word) => {
    const inRange = wordOverlapsRange(word, sourceStartMs, sourceEndMs);
    if (!inRange && !word.deleted) {
      wordsChanged = true;
      return { ...word, deleted: true, autoTrimmed: true };
    }
    if (inRange && word.deleted && word.autoTrimmed) {
      wordsChanged = true;
      return { ...word, deleted: false, autoTrimmed: false };
    }
    return word;
  });
  const nextWords = wordsChanged ? words : scene.words;
  const telopText = scene.telopEdited ? scene.telopText : autoTelopTextFromWords(nextWords);
  const cutMarks = scene.cutMarks.filter((mark) => mark > sourceStartMs && mark < sourceEndMs);
  return {
    ...scene,
    sourceStartMs,
    sourceEndMs,
    words: nextWords,
    telopText,
    cutMarks,
  };
}

function replaceAt(scenes: Scene[], index: number, scene: Scene): Scene[] {
  const next = scenes.slice();
  next[index] = scene;
  return next;
}

/**
 * 行端の長押しスライド操作の本体。sceneIndexのedge(start|end)を絶対時刻targetMsへ動かす。
 *
 * - 隣接シーンと連続している(isEdgeLinkedがtrue)場合は「連動ロール」: 共有境界を動かし、
 *   両シーンの[sourceStartMs, sourceEndMs]を隙間なく更新する(欠落・重複が発生しない)。
 * - 連続していない場合は「独立トリム」: 動かした側のシーンだけを更新する(カット幅=隙間が変化する)。
 * - どちらも最小シーン長(minDurationMs)を下回らないよう、また隣接シーン・元動画の範囲を
 *   超えないようクランプしたうえで、20msグリッド or 単語チップ境界へスナップする。
 */
export function applyEdgeTrim(
  scenes: Scene[],
  sceneIndex: number,
  edge: EdgeTrimEdge,
  targetMs: number,
  options: EdgeTrimOptions = {},
): EdgeTrimResult {
  const scene = scenes[sceneIndex];
  if (!scene) return { scenes, appliedMs: targetMs, linked: false, neighborIndex: null };

  const snapMs = options.snapMs ?? EDGE_SNAP_MS;
  const minDurationMs = Math.max(1, options.minDurationMs ?? MIN_SCENE_DURATION_MS);
  const sourceDurationMs = options.sourceDurationMs ?? Infinity;
  const linked = isEdgeLinked(scenes, sceneIndex, edge);
  const chipCandidates = collectChipSnapCandidatesMs(scenes, sceneIndex, edge);
  const snapped = snapEdgeTargetMs(targetMs, chipCandidates, {
    snapMs,
    chipSnapToleranceMs: options.chipSnapToleranceMs,
  });

  if (edge === "end") {
    const next = scenes[sceneIndex + 1];
    if (linked && next) {
      const lowerBound = scene.sourceStartMs + minDurationMs;
      const upperBound = next.sourceEndMs - minDurationMs;
      const appliedMs = clamp(snapped, lowerBound, Math.max(lowerBound, upperBound));
      const updatedScene = withUpdatedBounds(scene, scene.sourceStartMs, appliedMs);
      const updatedNext = withUpdatedBounds(next, appliedMs, next.sourceEndMs);
      const nextScenes = replaceAt(replaceAt(scenes, sceneIndex, updatedScene), sceneIndex + 1, updatedNext);
      return { scenes: nextScenes, appliedMs, linked: true, neighborIndex: sceneIndex + 1 };
    }
    const lowerBound = scene.sourceStartMs + minDurationMs;
    const upperBound = next ? next.sourceStartMs : sourceDurationMs;
    const appliedMs = clamp(snapped, lowerBound, Math.max(lowerBound, upperBound));
    const updatedScene = withUpdatedBounds(scene, scene.sourceStartMs, appliedMs);
    const nextScenes = replaceAt(scenes, sceneIndex, updatedScene);
    return { scenes: nextScenes, appliedMs, linked: false, neighborIndex: null };
  }

  const prev = scenes[sceneIndex - 1];
  if (linked && prev) {
    const upperBound = scene.sourceEndMs - minDurationMs;
    const lowerBound = prev.sourceStartMs + minDurationMs;
    const appliedMs = clamp(snapped, Math.min(lowerBound, upperBound), upperBound);
    const updatedScene = withUpdatedBounds(scene, appliedMs, scene.sourceEndMs);
    const updatedPrev = withUpdatedBounds(prev, prev.sourceStartMs, appliedMs);
    const nextScenes = replaceAt(replaceAt(scenes, sceneIndex - 1, updatedPrev), sceneIndex, updatedScene);
    return { scenes: nextScenes, appliedMs, linked: true, neighborIndex: sceneIndex - 1 };
  }
  const upperBound = scene.sourceEndMs - minDurationMs;
  const lowerBound = prev ? prev.sourceEndMs : 0;
  const appliedMs = clamp(snapped, lowerBound, Math.max(lowerBound, upperBound));
  const updatedScene = withUpdatedBounds(scene, appliedMs, scene.sourceEndMs);
  const nextScenes = replaceAt(scenes, sceneIndex, updatedScene);
  return { scenes: nextScenes, appliedMs, linked: false, neighborIndex: null };
}

/**
 * ツールチップ表示用の「+0.24s」形式の文字列を作る(仕様書「ドラッグ中のフィードバック」節)。
 */
export function formatEdgeTrimDelta(deltaMs: number): string {
  const seconds = deltaMs / 1000;
  const sign = seconds > 0 ? "+" : seconds < 0 ? "-" : "±";
  return `${sign}${Math.abs(seconds).toFixed(2)}s`;
}
