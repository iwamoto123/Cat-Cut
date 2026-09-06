/**
 * W19-A4(チップホバーの過剰setState抑制): ホバーキャレットの「前回と同じ位置か」判定。
 * SceneRow.handleChipHover は mousemove ごとに呼ばれるため、境界インデックスと描画x位置が
 * 前回と変わらない限り setChipCaret を呼ばない(チップ内の数pxの移動で再レンダーしない)。
 */
export type ChipCaretPosition = {
  /** 0..groups.length のグループ境界インデックス。 */
  groupIndex: number;
  /** `.sceneChips` コンテナ基準の描画x位置(px)。 */
  leftPx: number;
};

/** 前回位置(null=キャレット非表示)と次の位置を比べ、setStateが必要な場合のみtrue。 */
export function chipCaretPositionChanged(
  prev: ChipCaretPosition | null,
  next: ChipCaretPosition,
): boolean {
  if (!prev) return true;
  return prev.groupIndex !== next.groupIndex || prev.leftPx !== next.leftPx;
}
