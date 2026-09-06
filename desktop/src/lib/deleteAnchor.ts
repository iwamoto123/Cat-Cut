// W16-4: Delete/Backspaceの削除アンカー解決。
// 実機フィードバック「Deleteキーで違うところが削除される」の根本対策として、
// 削除対象は「ユーザーが明示的に指定したもの」だけから解決する。
// ホバーで立つチップキャレット(chipCaret)・ホバースクラブで動いた再生ヘッドは
// この解決に一切関与しない(表示専用)。
//
// 優先順位:
//   1. chipSelection(ドラッグ/Shift選択)
//   2. confirmedCaret(チップ境界のクリック・←/→キーで確定したキャレット)
//   3. selectedScene(行番号チップのシーン選択)
//   4. 再生ヘッド。ただし「実際に再生中」または「明示的操作(クリックシーク・キーボード・
//      再生停止)で確定した位置(anchorMs)」のみ。ホバースクラブ後はanchorMsが無効化される
//      ため削除は発動しない(nullを返す)。
// W17: 確定キャレットを行番号選択より優先(別行の行番号選択が残っていても、クリックした
//      元テキスト行のDelete/結合が効くようにする)。

export type ConfirmedCaret = {
  sceneId: string;
  /** 0..groups.length のグループ境界インデックス(GroupCursor.groupIndexと同じ意味)。 */
  groupIndex: number;
};

export type DeleteAnchor =
  | { kind: "selection"; sceneId: string; start: number; end: number }
  | { kind: "scene"; sceneId: string }
  | { kind: "caret"; sceneId: string; groupIndex: number }
  | { kind: "playhead"; ms: number };

export type ResolveDeleteAnchorInput = {
  /** ドラッグ/Shift+クリックで作ったチップ範囲選択(最優先)。 */
  chipSelection: { sceneId: string; start: number; end: number } | null;
  /** 行番号チップでのシーン選択。 */
  selectedSceneId: string | null;
  /** クリック/←→キーで確定したキャレット。ホバー由来のchipCaretはここに入れない。 */
  confirmedCaret: ConfirmedCaret | null;
  /** <video>が実際に再生中か(play/pauseイベント由来)。再生中はいまの再生位置が対象になる。 */
  playbackActive: boolean;
  /** 現在の再生ヘッド位置(ms)。playbackActive時のみ削除対象の解決に使う。 */
  playheadMs: number;
  /**
   * 明示的操作(クリックシーク・キーボードシーク・再生停止)で最後に確定した再生ヘッド位置。
   * ホバースクラブで再生ヘッドが動いた場合はnullへ無効化されている。
   */
  anchorMs: number | null;
};

export function resolveDeleteAnchor(input: ResolveDeleteAnchorInput): DeleteAnchor | null {
  if (input.chipSelection) {
    return {
      kind: "selection",
      sceneId: input.chipSelection.sceneId,
      start: input.chipSelection.start,
      end: input.chipSelection.end,
    };
  }
  if (input.confirmedCaret) {
    return { kind: "caret", sceneId: input.confirmedCaret.sceneId, groupIndex: input.confirmedCaret.groupIndex };
  }
  if (input.selectedSceneId) return { kind: "scene", sceneId: input.selectedSceneId };
  if (input.playbackActive) return { kind: "playhead", ms: input.playheadMs };
  if (input.anchorMs != null) return { kind: "playhead", ms: input.anchorMs };
  return null;
}
