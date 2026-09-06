import test from "node:test";
import assert from "node:assert/strict";
import { editOverridesForSilenceTightness } from "../src/lib/silenceTightness.ts";

test("normal と未指定は向き別YAMLを上書きしない", () => {
  assert.equal(editOverridesForSilenceTightness("normal"), null);
  assert.equal(editOverridesForSilenceTightness(undefined), null);
});

test("tight は無音と前後余白を短くする", () => {
  assert.deepEqual(editOverridesForSilenceTightness("tight"), {
    max_gap_ms: 180,
    lead_padding_ms: 70,
    tail_padding_ms: 50,
    min_internal_silence_ms: 280,
  });
});

test("loose は無音と前後余白を長くする", () => {
  assert.deepEqual(editOverridesForSilenceTightness("loose"), {
    max_gap_ms: 1000,
    lead_padding_ms: 280,
    tail_padding_ms: 200,
    min_internal_silence_ms: 800,
  });
});
