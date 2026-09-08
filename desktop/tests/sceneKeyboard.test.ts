import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldIgnoreSceneKeyboard,
  isRepeatedSceneCommand,
  resolveSceneSpaceAction,
  type SceneKeyboardContext,
} from "../src/lib/sceneKeyboard.ts";

test("モーダル表示中はフォーカスが背後のチップやbodyでも編集しない", () => {
  for (const key of ["Delete", "Backspace", "Enter", " ", "ArrowDown", "z", "m"]) {
    for (const target of [
      { tagName: "BODY" },
      { tagName: "BUTTON", isSceneEditingButton: true },
      { tagName: "TEXTAREA", isSceneTelopInput: true },
    ]) {
      assert.equal(shouldIgnoreSceneKeyboard({ key, ...target, metaKey: true, hasOpenDialog: true }), true);
    }
  }
});

test("editor toolbar and transport slider retain Space and tool shortcuts after clicks", () => {
  for (const control of [{ tagName: "BUTTON" }, { tagName: "INPUT", inputType: "range" }]) {
    for (const key of [" ", "Spacebar", "b", "B", "a", "l"]) {
      assert.equal(shouldIgnoreSceneKeyboard({ ...control, key, isWorkspaceControl: true }), false);
      for (const guard of [{ isComposing: true }, { hasOpenDialog: true }, { defaultPrevented: true }, { isContentEditable: true }]) {
        assert.equal(shouldIgnoreSceneKeyboard({ ...control, key, isWorkspaceControl: true, ...guard }), true);
      }
    }
    for (const key of ["Enter", "ArrowLeft", "Delete"]) {
      assert.equal(shouldIgnoreSceneKeyboard({ ...control, key, isWorkspaceControl: true }), true);
    }
  }
  for (const control of [{ tagName: "INPUT", inputType: "text" }, { tagName: "TEXTAREA" }, { tagName: "SELECT" }]) {
    for (const key of [" ", "b"]) assert.equal(shouldIgnoreSceneKeyboard({ ...control, key, isWorkspaceControl: true }), true);
  }
});

test("Space always pauses playing video even when the pointer moved to another row", () => {
  assert.equal(resolveSceneSpaceAction(false, true, true), "pause");
  assert.equal(resolveSceneSpaceAction(false, false, false), "pause");
  assert.equal(resolveSceneSpaceAction(true, true, true), "play-hovered");
  assert.equal(resolveSceneSpaceAction(true, false, true), "play");
});

test("held Space/B keys do not repeatedly toggle, while arrows and Delete can repeat", () => {
  for (const key of [" ", "Spacebar", "b", "B", "l", "Tab", "Enter"]) {
    assert.equal(isRepeatedSceneCommand(key, true), true);
    assert.equal(isRepeatedSceneCommand(key, false), false);
  }
  for (const key of ["Delete", "Backspace", "ArrowLeft"]) assert.equal(isRepeatedSceneCommand(key, true), false);
});

test("行内select・設定ボタンの矢印/Enter/Spaceを編集操作が奪わない", () => {
  for (const tagName of ["SELECT", "BUTTON", "INPUT"]) {
    for (const key of ["ArrowUp", "ArrowDown", "Enter", " ", "Delete"]) {
      assert.equal(shouldIgnoreSceneKeyboard({ tagName, key }), true);
    }
  }
});

test("単語チップ・行番号の編集キーと通常の再生キーは維持する", () => {
  for (const key of ["Delete", "Backspace", "Enter", " ", "Tab", "ArrowRight", "b", "l", "z", "m"]) {
    assert.equal(shouldIgnoreSceneKeyboard({ key, tagName: "BUTTON", isSceneEditingButton: true }), false);
    assert.equal(shouldIgnoreSceneKeyboard({ key, tagName: "BODY" }), false);
  }
});

test("シーンtextareaはCmd/Ctrl+Z/Mだけ通し、その他のテキスト編集を保護する", () => {
  const sceneTextarea: SceneKeyboardContext = { key: "Enter", tagName: "TEXTAREA", isSceneTelopInput: true };
  assert.equal(shouldIgnoreSceneKeyboard(sceneTextarea), true);
  for (const key of ["z", "Z", "m", "M"]) {
    assert.equal(shouldIgnoreSceneKeyboard({ ...sceneTextarea, key }), true);
    assert.equal(shouldIgnoreSceneKeyboard({ ...sceneTextarea, key, metaKey: true }), false);
    assert.equal(shouldIgnoreSceneKeyboard({ ...sceneTextarea, key, ctrlKey: true }), false);
    assert.equal(shouldIgnoreSceneKeyboard({ ...sceneTextarea, key, metaKey: true, isSceneTelopInput: false }), true);
    assert.equal(shouldIgnoreSceneKeyboard({ ...sceneTextarea, key, metaKey: true, tagName: "INPUT" }), true);
  }
  assert.equal(shouldIgnoreSceneKeyboard({ key: "Delete", tagName: "DIV", isContentEditable: true }), true);
});

test("IMEと子コンポーネントで処理済みのキーは例外コマンドより優先して保護する", () => {
  const command: SceneKeyboardContext = {
    key: "m", metaKey: true, tagName: "TEXTAREA", isSceneTelopInput: true,
  };
  assert.equal(shouldIgnoreSceneKeyboard({ ...command, isComposing: true }), true);
  assert.equal(shouldIgnoreSceneKeyboard({ ...command, keyCode: 229 }), true);
  assert.equal(shouldIgnoreSceneKeyboard({ ...command, defaultPrevented: true }), true);
});

test("ツールバーボタン上でもCmd/Ctrl+ZとShift+ZによるUndo/Redoを通す", () => {
  for (const key of ["z", "Z"]) {
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      assert.equal(shouldIgnoreSceneKeyboard({ key, tagName: "BUTTON", ...modifier }), false);
      assert.equal(shouldIgnoreSceneKeyboard({ key, tagName: "button", ...modifier }), false);
    }
  }
  for (const key of ["z", "Z", "m", "M", "Enter", " ", "Delete"]) {
    assert.equal(shouldIgnoreSceneKeyboard({ key, tagName: "BUTTON" }), true);
  }
  assert.equal(shouldIgnoreSceneKeyboard({ key: "m", tagName: "BUTTON", metaKey: true }), true);
});

test("ツールバーUndoの例外よりもモーダル・IME・入力欄・処理済みキーを優先する", () => {
  const undo: SceneKeyboardContext = { key: "z", tagName: "BUTTON", metaKey: true };
  for (const guard of [
    { hasOpenDialog: true }, { isComposing: true }, { keyCode: 229 },
    { defaultPrevented: true }, { isContentEditable: true },
    { tagName: "INPUT" }, { tagName: "TEXTAREA" }, { tagName: "SELECT" },
  ]) {
    assert.equal(shouldIgnoreSceneKeyboard({ ...undo, ...guard }), true);
  }
});

test("タイムラインとプレビューのクリップは共通の編集キーを受け取れる", () => {
  for (const key of ["Delete", "Backspace", "Enter", "z", "m"]) {
    assert.equal(shouldIgnoreSceneKeyboard({ key, tagName: "DIV", metaKey: true }), false);
  }
});

test("range controls keep native adjustment keys but pass project Undo/Redo", () => {
  const range = { tagName: "INPUT", inputType: "range" };
  for (const key of ["ArrowRight", "ArrowDown", "Enter", "Delete", " "]) {
    assert.equal(shouldIgnoreSceneKeyboard({ ...range, key }), true);
  }
  for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
    assert.equal(shouldIgnoreSceneKeyboard({ ...range, ...modifier, key: "z" }), false);
    for (const guard of [{ isComposing: true }, { defaultPrevented: true }, { hasOpenDialog: true }, { isContentEditable: true }]) {
      assert.equal(shouldIgnoreSceneKeyboard({ ...range, ...modifier, ...guard, key: "z" }), true);
    }
  }
});
