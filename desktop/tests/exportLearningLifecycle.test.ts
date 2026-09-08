import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const learning = require("../main/editingLearning.cjs");
const mainSource = fs.readFileSync(new URL("../main/index.cjs", import.meta.url), "utf8");
// Run the real IPC/export orchestration in isolation; only renderer/process IO is replaced.
const functionSource = (name: string, end: string) => {
  const begin = mainSource.indexOf(`async function ${name}(`);
  assert.ok(begin >= 0);
  const finish = mainSource.indexOf(end, begin);
  assert.ok(finish > begin);
  return mainSource.slice(begin, finish);
};

test("export IPC forwards the exact applied scene snapshot", async () => {
  const begin = mainSource.indexOf('ipcMain.handle("export:start"');
  const end = mainSource.indexOf('ipcMain.handle("job:cancel"', begin);
  let handler: any, received: any;
  const context = vm.createContext({
    activeJob: null, ipcMain: { handle: (_name: string, fn: any) => { handler = fn; } },
    resolveRunDir: (value: string) => value,
    applyTelopAndExport: async (options: any) => { received = options; }, sendJobEvent: () => {},
  });
  vm.runInContext(mainSource.slice(begin, end), context);
  const snapshot = { scenes: [{ telopText: "書き出す版" }], keepSegments: [{ startMs: 0, endMs: 1000 }] };
  assert.equal((await handler(null, { runDir: "/synthetic", renderFinal: true, learningSnapshot: snapshot })).ok, true);
  assert.equal(received.learningSnapshot, snapshot);
});

for (const mode of ["success", "render-failure", "apply-only"] as const) {
  test(`export learning lifecycle: ${mode}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "catcut-export-learning-"));
    const runDir = path.join(root, "run"), corpusPath = path.join(root, "corpus.json");
    const before = [{ id: "s", sourceStartMs: 0, sourceEndMs: 1000, words: [], telopText: "校性", sourceKeepRanges: [{ startMs: 0, endMs: 1000 }] }];
    const scenes = [{ ...before[0], telopText: "校正" }];
    const snapshot = { scenes, keepSegments: [{ startMs: 0, endMs: 1000 }] };
    const events: any[] = [];
    let prepared = 0, outputRecorded = false;
    try {
      learning.ensureBaseline({ runDir, transcript: { initialScenes: before, keepSegments: snapshot.keepSegments, originalDurationMs: 1000 }, provenance: "ai_original" });
      const context = vm.createContext({
        repoRoot: () => root, resolveRunDir: () => runDir, path,
        apiKeys: { buildPipelineEnv: () => ({}) }, fs: { existsSync: () => true },
        prepareEditingLearningExport: (value: string, applied: any) => {
          prepared++; assert.equal(value, runDir); assert.equal(applied, snapshot);
          learning.recordCurrent({ runDir, ...applied });
          return learning.captureForExport(runDir);
        },
        editingLearning: learning, editingCorpusPath: () => corpusPath,
        sendJobEvent: (event: any) => events.push(event),
        spawnCommand: async ({ stepId }: { stepId: string }) => {
          if (stepId === "render") {
            assert.equal(fs.existsSync(corpusPath), false, "no evidence before successful rendering");
            // Autosave during rendering must not become the exported correction.
            learning.recordCurrent({ runDir, scenes: [{ ...scenes[0], telopText: "後で入力した文章" }] });
            if (mode === "render-failure") throw new Error("synthetic render failure");
          }
        },
        applyFontDirectivesForRun: async () => {},
        applyStoredSceneTelopPositions: () => {},
        readJson: () => ({ display_width: 640, display_height: 360, video_path: "/source.mp4" }),
        resolveRenderOutputPath: () => path.join(root, "final.mp4"), avoidSourceOverwrite: (value: string) => value,
        writeRenderOutputPath: () => { outputRecorded = true; },
        buildOutputs: () => ({ runDir, finalVideo: path.join(root, "final.mp4") }),
      });
      vm.runInContext(functionSource("applyTelopAndExport", "\n/**\n * W19-B2"), context);
      const execute = vm.runInContext("applyTelopAndExport", context);
      const result = execute({ runDir, renderFinal: mode !== "apply-only", learningSnapshot: snapshot });
      if (mode === "render-failure") {
        await assert.rejects(result, /synthetic render failure/);
        assert.equal(fs.existsSync(corpusPath), false);
        assert.equal(events.some((event) => event.type === "job:done"), false);
        assert.equal(outputRecorded, false);
      } else {
        const outputs = await result;
        if (mode === "apply-only") {
          assert.equal(prepared, 0); assert.equal(fs.existsSync(corpusPath), false);
          assert.equal(outputs.learning, undefined);
        } else {
          assert.equal(prepared, 1); assert.equal(outputRecorded, true);
          const corpus = learning.loadCorpus(corpusPath);
          assert.equal(corpus.projects[0].examples[0].after.text, "校正");
          assert.equal(learning.loadState(runDir).current.scenes[0].text, "後で入力した文章");
          assert.equal(outputs.learning.examples, 1);
          assert.equal(events.at(-1).outputs.learning.examples, 1);
        }
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
