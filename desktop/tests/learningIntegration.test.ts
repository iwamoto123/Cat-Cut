import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { mediaLearningIdentity, combineEditingCorpora, summarizeEditingCorpus } = require("../main/learningIntegration.cjs");

const project = (revision: string, confirmedAt: string, ids: string[]) => ({ projectId: "project", sourceId: "source", revision, confirmedAt,
  examples: ids.map((exampleId) => ({ exampleId, kind: "cut", confirmedAt })) });

test("local/shared snapshots deduplicate and newer empty export withdraws prior contribution", () => {
  const old = { projects: [project("a", "2026-09-01", ["cut"])] };
  const latest = { projects: [project("b", "2026-09-02", [])] };
  assert.deepEqual(combineEditingCorpora(old, latest), combineEditingCorpora(latest, old));
  assert.equal(combineEditingCorpora(old, old).projects[0].examples.length, 1);
  assert.equal(combineEditingCorpora(old, latest).projects[0].examples.length, 0);
});

test("excluded examples stay excluded when a shared snapshot contains them again", () => {
  const shared = { projects: [project("a", "2026-09-01", ["cut"])] };
  const result = combineEditingCorpora({ excludedExampleIds: ["cut"], projects: [] }, shared);
  assert.equal(summarizeEditingCorpus(result).examples, 0);
  assert.deepEqual(result.excludedExampleIds, ["cut"]);
});

test("newest confirmed instant wins across timezone formats", () => {
  const old = { projects: [project("old", "2026-09-08T13:00:00+09:00", ["cut"])] };
  const latest = { projects: [project("new", "2026-09-08T05:00:00Z", [])] };
  assert.equal(combineEditingCorpora(old, latest).projects[0].revision, "new");
  assert.deepEqual(combineEditingCorpora(old, latest), combineEditingCorpora(latest, old));
});

test("sampled identity survives path changes and detects size/tail differences", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catcut-learning-identity-"));
  try {
    const a = path.join(root, "first.mp4"), b = path.join(root, "renamed.mp4");
    fs.writeFileSync(a, Buffer.alloc(200000, 7)); fs.copyFileSync(a, b);
    assert.equal(mediaLearningIdentity(a), mediaLearningIdentity(b));
    fs.appendFileSync(b, "changed");
    assert.notEqual(mediaLearningIdentity(a), mediaLearningIdentity(b));
    assert.equal(mediaLearningIdentity(path.join(root, "missing")), undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
