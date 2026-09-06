// フェーズW23: UIステージ導出(uiStageFor)のテスト。
import test from "node:test";
import assert from "node:assert/strict";

import { uiStageFor } from "../src/lib/uiStage.ts";

test("待機中(run無し・検品無し)は home", () => {
  assert.equal(uiStageFor({ running: false, hasReview: false }), "home");
});

test("解析パイプライン実行中(検品前)は analyzing", () => {
  assert.equal(uiStageFor({ running: true, hasReview: false }), "analyzing");
});

test("検品中は editing", () => {
  assert.equal(uiStageFor({ running: false, hasReview: true }), "editing");
});

test("書き出し中(running=true だが reviewState 保持)は editing のまま", () => {
  // 書き出し(export:start)は running=true になるが reviewState は保持される。
  // 検品レイアウト(全幅)を維持し、停止導線はコンパクト進捗バー側が担う。
  assert.equal(uiStageFor({ running: true, hasReview: true }), "editing");
});
