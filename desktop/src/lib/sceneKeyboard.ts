/** DOM判定をAppに置き、キー操作を受け取ってよいかだけを純関数で検証する。 */
export type SceneKeyboardContext = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  defaultPrevented?: boolean;
  hasOpenDialog?: boolean;
  tagName?: string;
  inputType?: string;
  isContentEditable?: boolean;
  isSceneTelopInput?: boolean;
  /** 単語チップ・行番号など、クリック後も編集キーを続けて使う専用ボタン。 */
  isSceneEditingButton?: boolean;
  /** 編集ワークスペース内のボタン/スライダー。Space・A/B/Lのみ共通ツールへ渡す。 */
  isWorkspaceControl?: boolean;
  altKey?: boolean;
};

/** 既存モーダルの実在ルート。role未設定のAPI/キャッシュ/ライセンスとテーマ一覧も含む。 */
export const SCENE_KEYBOARD_DIALOG_SELECTOR = '[role="dialog"], .apiWizardBackdrop, .themeGalleryBackdrop';

/** 行内のメニューや演出・結合ボタンはネイティブのSpace/Enterを優先する。 */
export const SCENE_EDITING_BUTTON_SELECTOR = ".sceneChip, .sceneRowIndexButton";

export function isSceneToolShortcut(context: Pick<SceneKeyboardContext, "key" | "metaKey" | "ctrlKey" | "altKey">): boolean {
  return !context.metaKey && !context.ctrlKey && !context.altKey && [" ", "spacebar", "a", "b", "l"].includes(context.key.toLowerCase());
}

/** Holding a mode/play key must never toggle back, restart a row, or cycle speeds repeatedly. */
export function isRepeatedSceneCommand(key: string, repeat: boolean): boolean {
  return repeat && [" ", "Spacebar", "a", "b", "l", "Tab", "Enter"].includes(key.length === 1 ? key.toLowerCase() : key);
}

export function resolveSceneSpaceAction(paused: boolean, hoverArmed: boolean, hasDifferentHoveredScene: boolean): "pause" | "play" | "play-hovered" {
  return !paused ? "pause" : hoverArmed && hasDifferentHoveredScene ? "play-hovered" : "play";
}

export function shouldIgnoreSceneKeyboard(context: SceneKeyboardContext): boolean {
  if (context.defaultPrevented || context.isComposing || context.keyCode === 229 || context.hasOpenDialog) {
    return true;
  }
  const tagName = context.tagName?.toUpperCase();
  // controlledなシーンtextareaだけは従来のグローバルUndo/Redo・結合を維持する。
  const isTelopCommand = tagName === "TEXTAREA" && context.isSceneTelopInput &&
    (context.metaKey || context.ctrlKey) && ["z", "m"].includes(context.key.toLowerCase());
  if (isTelopCommand) return false;
  if (context.isWorkspaceControl && !context.isContentEditable &&
      (tagName === "BUTTON" || (tagName === "INPUT" && context.inputType === "range")) && isSceneToolShortcut(context)) return false;
  // Range controls have no native text Undo; only history commands leave the slider.
  if (tagName === "INPUT" && context.inputType === "range" && !context.isContentEditable &&
    (context.metaKey || context.ctrlKey) && context.key.toLowerCase() === "z") return false;
  if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT" || context.isContentEditable) {
    return true;
  }
  // Toolbar buttons keep native Space/Enter, while Undo/Redo remains a project command.
  const isHistoryCommand = (context.metaKey || context.ctrlKey) && context.key.toLowerCase() === "z";
  if (tagName === "BUTTON" && !context.isSceneEditingButton && !isHistoryCommand) return true;
  return false;
}
