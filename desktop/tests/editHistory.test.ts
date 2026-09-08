import test from "node:test";
import assert from "node:assert/strict";
import {
  EDIT_HISTORY_LIMIT,
  createEditHistory,
  redoEditHistory,
  replaceHistoryPresent,
  setHistoryPresent,
  undoEditHistory,
} from "../src/lib/editHistory.ts";

test("Undo/Redoは元の値と同じ参照を復元し、端では何もしない", () => {
  const first = { text: "元のテロップ" };
  const second = { text: "修正したテロップ" };
  const initial = createEditHistory(first);
  assert.equal(undoEditHistory(initial), initial);
  assert.equal(redoEditHistory(initial), initial);
  const edited = setHistoryPresent(initial, second);
  assert.equal(edited.present, second);
  assert.deepEqual(edited.past, [first]);
  const undone = undoEditHistory(edited);
  assert.equal(undone.present, first);
  assert.deepEqual(undone.future, [second]);
  const redone = redoEditHistory(undone);
  assert.equal(redone.present, second);
  assert.deepEqual(redone.future, []);
});

test("200超の編集は古い履歴だけを落とし、最新200操作をUndo/Redoできる", () => {
  let history = createEditHistory(0);
  for (let value = 1; value <= 205; value += 1) history = setHistoryPresent(history, value);
  assert.equal(EDIT_HISTORY_LIMIT, 200);
  assert.equal(history.past.length, 200);
  assert.equal(history.past[0], 5);
  assert.equal(history.present, 205);
  for (let step = 0; step < 200; step += 1) {
    history = undoEditHistory(history);
    assert.equal(history.present, 204 - step);
    assert.equal(history.past.length + history.future.length, 200);
  }
  assert.equal(undoEditHistory(history), history);
  assert.equal(history.present, 5);
  for (let step = 0; step < 200; step += 1) history = redoEditHistory(history);
  assert.equal(history.present, 205);
  assert.equal(history.past.length, 200);
  assert.equal(redoEditHistory(history), history);
});

test("同値のset/replaceは履歴を消費せず、Redoも消さない", () => {
  const value = { text: "同じ値" };
  const edited = setHistoryPresent(createEditHistory(value), { text: "変更" });
  const history = undoEditHistory(edited);
  assert.equal(setHistoryPresent(history, value), history);
  assert.equal(replaceHistoryPresent(history, value), history);
  assert.equal(history.future.length, 1);
});

test("replacePresentは編集セッションのUndo単位を保ち、再編集はRedoを破棄する", () => {
  let history = setHistoryPresent(createEditHistory("元"), "編");
  history = replaceHistoryPresent(history, "編集中");
  history = replaceHistoryPresent(history, "編集完了");
  assert.deepEqual(history.past, ["元"]);
  history = undoEditHistory(history);
  assert.equal(history.present, "元");
  assert.deepEqual(history.future, ["編集完了"]);
  const replaced = replaceHistoryPresent(history, "別の編集");
  assert.equal(replaced.past, history.past);
  assert.deepEqual(replaced.future, []);
  const branched = setHistoryPresent(history, "分岐した編集");
  assert.deepEqual(branched.future, []);
  assert.equal(undoEditHistory(branched).present, "元");
});

test("上限での置換は履歴を捨てず、分岐編集を続けても200操作に収まる", () => {
  let history = createEditHistory(0);
  for (let value = 1; value <= 200; value += 1) history = setHistoryPresent(history, value);
  const past = history.past;
  history = replaceHistoryPresent(history, 201);
  assert.equal(history.past, past);
  history = undoEditHistory(history);
  history = setHistoryPresent(history, 202);
  assert.equal(history.future.length, 0);
  assert.equal(history.past.length, 200);
  history = setHistoryPresent(history, 203);
  assert.equal(history.past.length, 200);
  assert.equal(history.past[0], 1);
});

test("run切替のresetは過去と未来を捨て、新しい現在値だけを保持する", () => {
  const newRun = { scenes: [] };
  const reset = createEditHistory(newRun);
  assert.equal(reset.present, newRun);
  assert.deepEqual(reset.past, []);
  assert.deepEqual(reset.future, []);
  assert.equal(undoEditHistory(reset), reset);
  assert.equal(redoEditHistory(reset), reset);
});
