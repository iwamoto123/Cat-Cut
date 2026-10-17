import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
const source = fs.readFileSync(new URL("../main/index.cjs", import.meta.url), "utf8");
const resolve = source.slice(source.indexOf("function resolveRenderOutputPath("), source.indexOf("function buildPreviewPages("));
for (const video of ["物理 2.MOV", "素材.mp4", "素材.MP4"]) {
  test(`バックエンド保存名と素材保護: ${video}`, () => {
    const context = vm.createContext({path, fs: {existsSync: () => true}, readJson: () => ({video_path: `/素材/${video}`}), ensureMp4OutputPath: (v: string) => v, sendJobEvent: () => {}});
    vm.runInContext(resolve, context);
    const expected = `${path.basename(video, path.extname(video))}.mp4`;
    assert.equal(context.resolveRenderOutputPath("/run", {}), `/run/output/${expected}`);
    const target = `/素材/${expected}`;
    assert.equal(context.avoidSourceOverwrite(target, `/素材/${video}`), video.endsWith("MOV") ? target : `/素材/output/${expected}`);
  });
}
