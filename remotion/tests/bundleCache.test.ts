import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { computeBundleCacheKey } from "../scripts/bundleCache.ts";

function fixture(t: { after: (fn: () => void) => void }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catcut-bundle-cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "public"));
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export const value = 1;");
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture"}');
  return root;
}

test("unchanged inputs reuse the key; source edits invalidate it even with preserved mtime", (t) => {
  const root = fixture(t);
  const source = path.join(root, "src", "index.ts");
  const before = computeBundleCacheKey(root);
  assert.equal(computeBundleCacheKey(root), before);
  const stat = fs.statSync(source);
  fs.writeFileSync(source, "export const value = 2;");
  fs.utimesSync(source, stat.atime, stat.mtime);
  assert.notEqual(computeBundleCacheKey(root), before);
});

test("public asset addition, replacement, and removal invalidate the bundle", (t) => {
  const root = fixture(t);
  const asset = path.join(root, "public", "font.woff2");
  const absent = computeBundleCacheKey(root);
  fs.writeFileSync(asset, "font-one");
  const present = computeBundleCacheKey(root);
  assert.notEqual(present, absent);
  fs.writeFileSync(asset, "font-two-longer");
  assert.notEqual(computeBundleCacheKey(root), present);
  fs.unlinkSync(asset);
  assert.equal(computeBundleCacheKey(root), absent);
});

test("dependency lock and bundler configuration changes invalidate the key", (t) => {
  const root = fixture(t);
  for (const config of ["package-lock.json", "npm-shrinkwrap.json", "tsconfig.json", "remotion.config.ts"]) {
    const before = computeBundleCacheKey(root);
    const file = path.join(root, config);
    fs.writeFileSync(file, "first");
    const added = computeBundleCacheKey(root);
    assert.notEqual(added, before, config);
    fs.writeFileSync(file, "other");
    assert.notEqual(computeBundleCacheKey(root), added, config);
  }
});

test("linked assets track target changes and retargeting", (t) => {
  const root = fixture(t);
  const target = path.join(root, "external-font.woff2");
  const other = path.join(root, "other-font.woff2");
  const link = path.join(root, "public", "font.woff2");
  fs.writeFileSync(target, "font");
  fs.writeFileSync(other, "other");
  fs.symlinkSync(target, link);
  const before = computeBundleCacheKey(root);
  fs.appendFileSync(target, "updated");
  const updated = computeBundleCacheKey(root);
  assert.notEqual(updated, before);
  fs.unlinkSync(link);
  fs.symlinkSync(other, link);
  assert.notEqual(computeBundleCacheKey(root), updated);
});

test("public media is checked without reading its contents", (t) => {
  const root = fixture(t);
  const media = path.join(root, "public", "long-video.mp4");
  fs.writeFileSync(media, "video");
  const readFile = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (file: fs.PathOrFileDescriptor, ...options: any[]) => {
    assert.notEqual(String(file), media, "cache validation must not load media into RAM");
    return (readFile as Function)(file, ...options);
  });
  assert.equal(computeBundleCacheKey(root), computeBundleCacheKey(root));
});

test("circular linked directories fail safely instead of recursing forever", (t) => {
  const root = fixture(t);
  fs.symlinkSync(path.join(root, "public"), path.join(root, "public", "loop"));
  assert.throws(() => computeBundleCacheKey(root), /Circular bundle input/);
});
