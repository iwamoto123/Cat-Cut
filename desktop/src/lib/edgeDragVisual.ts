/**
 * W19-A5(端ドラッグプレビューの局所化): ドラッグ中の見た目状態の導出。
 * 旧実装は全シーン分の SceneEdgeVisual オブジェクトをドラッグmoveごとに作り直していたため、
 * memo化したシーン行が全行崩れてしまう。ここでは
 * - linkedNext(🔗連動アイコン): scenes だけから導出(ドラッグ中は変わらない)
 * - ドラッグ固有の見た目(ツールチップ・隣接行ハイライト): 対象2行分だけのオブジェクト
 * に分離し、ドラッグ中に見た目propが変わる行を「対象シーン+連動する隣接シーン」に限定する。
 */
import type { Scene } from "./scenes.ts";
import {
  formatEdgeTrimDelta,
  isEdgeLinked,
  type EdgeTrimEdge,
  type EdgeTrimResult,
} from "./edgeTrim.ts";

/** ドラッグ中の生ポインタ状態(App側のedgeDrag stateと同形)。 */
export type EdgeDragState = {
  sceneId: string;
  edge: EdgeTrimEdge;
  rawTargetMs: number;
  chipSnapToleranceMs: number;
};

/** ドラッグ中だけ存在する、対象行+隣接行の見た目状態。 */
export type EdgeDragVisual = {
  /** ドラッグ対象のシーンid(ツールチップを表示する行)。 */
  sceneId: string;
  /** ツールチップ表示内容(「+0.24s」等)。 */
  tooltip: { edge: EdgeTrimEdge; label: string };
  /** 連動ロール中の隣接シーンid(受動ハイライトする行)。連動なしはnull。 */
  neighborSceneId: string | null;
  /** 隣接行がハイライトすべき端。連動なしはnull。 */
  neighborHighlightEdge: EdgeTrimEdge | null;
};

/** 次の行と時間的に連続している(端ドラッグで連動する)シーンidの集合。scenesのみから導出。 */
export function computeLinkedNextSceneIds(scenes: Scene[]): Set<string> {
  const ids = new Set<string>();
  scenes.forEach((scene, index) => {
    if (isEdgeLinked(scenes, index, "end")) ids.add(scene.id);
  });
  return ids;
}

/**
 * ドラッグ中に内容(波形・チップ)がライブ追従すべきシーンの差し替えMap(sceneId→プレビュー版Scene)。
 * 対象シーンと連動する隣接シーンの最大2件のみを含む。ドラッグしていなければnull。
 * 全scenes配列を作り直さないことで、他の行のsceneプロップ同一性を保つ(W19-A5)。
 */
export function computeEdgeDragSceneOverrides(
  edgeDrag: EdgeDragState | null,
  edgeTrimPreview: EdgeTrimResult | null,
): Map<string, Scene> | null {
  if (!edgeDrag || !edgeTrimPreview) return null;
  const overrides = new Map<string, Scene>();
  const dragged = edgeTrimPreview.scenes.find((scene) => scene.id === edgeDrag.sceneId);
  if (dragged) overrides.set(dragged.id, dragged);
  if (edgeTrimPreview.neighborIndex != null) {
    const neighbor = edgeTrimPreview.scenes[edgeTrimPreview.neighborIndex];
    if (neighbor) overrides.set(neighbor.id, neighbor);
  }
  return overrides.size > 0 ? overrides : null;
}

/** ドラッグ中の対象行ツールチップ+隣接行ハイライトを導出する(ドラッグしていなければnull)。 */
export function computeEdgeDragVisual(
  scenes: Scene[],
  edgeDrag: EdgeDragState | null,
  edgeTrimPreview: EdgeTrimResult | null,
): EdgeDragVisual | null {
  if (!edgeDrag || !edgeTrimPreview) return null;
  const draggedScene = scenes.find((scene) => scene.id === edgeDrag.sceneId);
  if (!draggedScene) return null;
  const originalMs = edgeDrag.edge === "end" ? draggedScene.sourceEndMs : draggedScene.sourceStartMs;
  const neighborScene =
    edgeTrimPreview.linked && edgeTrimPreview.neighborIndex != null
      ? (scenes[edgeTrimPreview.neighborIndex] ?? null)
      : null;
  return {
    sceneId: edgeDrag.sceneId,
    tooltip: { edge: edgeDrag.edge, label: formatEdgeTrimDelta(edgeTrimPreview.appliedMs - originalMs) },
    neighborSceneId: neighborScene ? neighborScene.id : null,
    neighborHighlightEdge: neighborScene ? (edgeDrag.edge === "end" ? "start" : "end") : null,
  };
}
