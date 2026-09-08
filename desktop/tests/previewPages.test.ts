import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildPreviewPagesFromComposition } = require("../main/previewPages.cjs");
const compositionPath = path.resolve("fixture", "step08_composition", "composition.json");

test("旧プレビューのページ情報: 各カットの動画URLとローカル時刻を使う", () => {
  const registered: string[] = [];
  const absoluteVideo = path.resolve("fixture", "absolute-cut.mp4");
  const pages = buildPreviewPagesFromComposition({
    meta: { display_width: 1080, display_height: 1920 },
    timeline: { cuts: [
      { cut_id: "a", video: { file_path: "segments/a.mp4", start_ms: 500, end_ms: 4500 }, telop: { pages: [{ id: "a1" }, { id: "a2" }] } },
      { cut_id: "b", video: { file_path: absoluteVideo, start_ms: 0, end_ms: 6000 }, telop: { pages: [{ id: "b1" }] } },
    ] },
  }, compositionPath, (file: string) => { registered.push(file); return `preview:${file}`; });
  assert.deepEqual(registered, [path.resolve(path.dirname(compositionPath), "segments/a.mp4"), absoluteVideo]);
  assert.deepEqual(pages, [
    { pageId: "a1", cutId: "a", videoUrl: `preview:${registered[0]}`, startMs: 500, endMs: 2500, displayWidth: 1080, displayHeight: 1920 },
    { pageId: "a2", cutId: "a", videoUrl: `preview:${registered[0]}`, startMs: 2500, endMs: 4500, displayWidth: 1080, displayHeight: 1920 },
    { pageId: "b1", cutId: "b", videoUrl: `preview:${absoluteVideo}`, startMs: 0, endMs: 6000, displayWidth: 1080, displayHeight: 1920 },
  ]);
});

test("旧プレビューのページ情報: 明示テロップ時刻を維持する", () => {
  const pages = buildPreviewPagesFromComposition({
    timeline: { cuts: [{ cut_id: "a", video: { file_path: "a.mp4", start_ms: 500, end_ms: 9500 }, telop: { pages: [{ id: "a1" }] } }] },
    voice_data: { cuts: [{ id: "a", telops: [{ start: 1.25, end: 2.5 }] }] },
  }, compositionPath, () => "preview:a");
  assert.equal(pages[0].startMs, 1750);
  assert.equal(pages[0].endMs, 3000);
  assert.equal(pages[0].displayWidth, 1280);
  assert.equal(pages[0].displayHeight, 720);
});

test("旧プレビューのページ情報: 単語境界と次ページの開始時刻を維持する", () => {
  const pages = buildPreviewPagesFromComposition({
    timeline: { cuts: [{ cut_id: "a", video: { file_path: "a.mp4", start_ms: 0, end_ms: 6000 }, telop: { pages: [{ id: "a1" }, { id: "a2" }] } }] },
    voice_data: { cuts: [{ id: "a", voice: { words: [
      { start: 0.25, end: 0.75 }, { start: 1.25, end: 1.75 }, { start: 2.25, end: 2.75 },
    ] }, telops: [{ word_indices: [0, 1] }, { word_indices: [2] }] }] },
  }, compositionPath, () => "preview:a");
  assert.deepEqual(pages.map((page: { startMs: number; endMs: number }) => [page.startMs, page.endMs]), [[250, 2250], [2250, 2750]]);
});

test("旧プレビューのページ情報: キャッシュ欠損・空カットをスキップする", () => {
  const registered: string[] = [];
  const pages = buildPreviewPagesFromComposition({
    timeline: { cuts: [
      { cut_id: "no-pages", video: { file_path: "a.mp4" }, telop: { pages: [] } },
      { cut_id: "no-path", telop: { pages: [{ id: "b1" }] } },
      { cut_id: "missing", video: { file_path: "missing.mp4" }, telop: { pages: [{ id: "c1" }] } },
    ] },
  }, compositionPath, (file: string) => { registered.push(file); return null; });
  assert.deepEqual(pages, []);
  assert.deepEqual(registered, [path.resolve(path.dirname(compositionPath), "missing.mp4")]);
  assert.deepEqual(buildPreviewPagesFromComposition({}, compositionPath, () => ""), []);
});

test("旧プレビューのページ情報: 映像尺がない旧runではタイムライン尺へフォールバックする", () => {
  const pages = buildPreviewPagesFromComposition({
    timeline: { cuts: [{ cut_id: "a", video: { file_path: "a.mp4" }, timeline: { start_ms: 12000, end_ms: 16000 }, telop: { pages: [{ id: "a1" }, { id: "a2" }] } }] },
  }, compositionPath, () => "preview:a");
  assert.deepEqual(pages.map((page: { startMs: number; endMs: number }) => [page.startMs, page.endMs]), [[0, 2000], [2000, 4000]]);
});
