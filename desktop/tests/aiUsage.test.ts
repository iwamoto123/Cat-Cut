import test from "node:test";
import assert from "node:assert/strict";
import { formatAiUsageSummary, type AiUsage } from "../src/lib/aiUsage.ts";

const transcriptUsage: AiUsage = {
  calls: 8,
  input_tokens: 45200,
  output_tokens: 8900,
  estimated_cost_usd: 0.13,
  provider: "anthropic",
  model: "claude-sonnet-5",
};

const telopUsage: AiUsage = {
  calls: 4,
  input_tokens: 30100,
  output_tokens: 5200,
  estimated_cost_usd: 0.08,
  provider: "anthropic",
  model: "claude-sonnet-5",
};

test("formatAiUsageSummary: 両パスあり・コストあり", () => {
  const summary = formatAiUsageSummary(transcriptUsage, telopUsage);
  assert.equal(
    summary,
    "AI校正コスト（目安）: パス1 45,200→8,900tok / パス2 30,100→5,200tok ・ 合計 $0.21（約32円）",
  );
});

test("formatAiUsageSummary: パス1のみ", () => {
  const summary = formatAiUsageSummary(transcriptUsage, null);
  assert.equal(summary, "AI校正コスト（目安）: パス1 45,200→8,900tok ・ 合計 $0.13（約20円）");
});

test("formatAiUsageSummary: パス2のみ", () => {
  const summary = formatAiUsageSummary(null, telopUsage);
  assert.equal(summary, "AI校正コスト（目安）: パス2 30,100→5,200tok ・ 合計 $0.08（約12円）");
});

test("formatAiUsageSummary: 両方null", () => {
  assert.equal(formatAiUsageSummary(null, null), null);
  assert.equal(formatAiUsageSummary(undefined, undefined), null);
});

test("formatAiUsageSummary: コストNone時はトークンのみ", () => {
  const noCost: AiUsage = {
    calls: 1,
    input_tokens: 1000,
    output_tokens: 200,
    estimated_cost_usd: null,
    provider: "unknown",
    model: "unknown-model",
  };
  const summary = formatAiUsageSummary(noCost, null);
  assert.equal(summary, "AI校正コスト（目安）: パス1 1,000→200tok");
});

test("formatAiUsageSummary: 片方コストNone・片方あり", () => {
  const noCost: AiUsage = {
    calls: 1,
    input_tokens: 500,
    output_tokens: 100,
    estimated_cost_usd: null,
    provider: "unknown",
    model: "unknown-model",
  };
  const summary = formatAiUsageSummary(noCost, telopUsage);
  assert.equal(
    summary,
    "AI校正コスト（目安）: パス1 500→100tok / パス2 30,100→5,200tok ・ 合計 $0.08（約12円）",
  );
});
