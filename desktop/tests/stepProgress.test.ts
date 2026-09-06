import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  computeStepProgressPercent,
  findRunningStepLabel,
  resolveCatProgressPercent,
  type StepProgressInput,
} from "../src/lib/stepProgress.ts";

const makeSteps = (statuses: StepProgressInput["status"][]): StepProgressInput[] =>
  statuses.map((status, i) => ({ status, label: `step${i}` }));

test("stepProgress: 空配列は0%", () => {
  assert.equal(computeStepProgressPercent([]), 0);
});

test("stepProgress: 完了数ベース+実行中は0.5歩", () => {
  assert.equal(computeStepProgressPercent(makeSteps(["pending", "pending", "pending", "pending"])), 0);
  assert.equal(computeStepProgressPercent(makeSteps(["done", "running", "pending", "pending"])), 38);
  assert.equal(computeStepProgressPercent(makeSteps(["done", "done", "done", "done"])), 100);
});

test("stepProgress: errorはカウントしない(進捗が止まって見える)", () => {
  assert.equal(computeStepProgressPercent(makeSteps(["done", "error", "pending", "pending"])), 25);
});

test("stepProgress: 実行中ステップのラベル取得", () => {
  assert.equal(findRunningStepLabel(makeSteps(["done", "running", "pending"])), "step1");
  assert.equal(findRunningStepLabel(makeSteps(["done", "done"])), null);
});

test("stepProgress: 書き出し進捗(1〜99)はステップ進捗より優先", () => {
  const steps = makeSteps(["done", "running", "pending", "pending"]);
  assert.equal(resolveCatProgressPercent(steps, 72), 72);
  // 0と100はステップ進捗に委ねる
  assert.equal(resolveCatProgressPercent(steps, 0), 38);
  assert.equal(resolveCatProgressPercent(steps, 100), 38);
});
