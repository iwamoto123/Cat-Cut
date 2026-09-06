// W13-1: runs/ 配下の派生キャッシュ(再生成可能なファイル)の統計とクリーンアップ。
//
// クリーン対象は以下の「派生キャッシュ」のみ:
//   - step08_composition/segments/   (W11-1a 差分キャッシュ。manifest.json 含む)
//   - step08_composition/preview_cut_sequence.mp4 / .txt (ensureCutPreviewVideo の結合プレビュー)
//   - .render_tmp_*.mp4              (書き出し中断の残骸。runDir直下と step08_composition 配下)
// いずれも書き出し/適用時の step08 再抽出・プレビューのオンデマンド再生成で復元できる。
// run フォルダ自体・プロジェクトデータ(composition.json 等)・書き出し済みMP4 は絶対に削除しない
// (プロジェクト削除はユーザー操作のみ)。
//
// electron に依存しない純Node実装(desktop/tests/cacheClean.test.ts から直接テストする)。
const fs = require("fs");
const path = require("path");

/** 「古いキャッシュ」とみなす最終利用からの日数。 */
const CACHE_RETENTION_DAYS = 7;

const RENDER_TMP_RE = /^\.render_tmp_.*\.mp4$/;

/** runの最終利用日時の判定に使う主要編集ファイル(相対パス)。 */
const LAST_USED_FILES = [
  path.join("step07_cut_proposal", "cut_proposal.json"),
  path.join("step08_composition", "composition.json"),
  "scene_edits_draft.json",
  "project_meta.json",
];

/** run内の派生キャッシュのパス一覧(存在するもののみ)。 */
function runCacheEntryPaths(runDir) {
  const step08Dir = path.join(runDir, "step08_composition");
  const entries = [];
  const segmentsDir = path.join(step08Dir, "segments");
  if (fs.existsSync(segmentsDir)) entries.push(segmentsDir);
  for (const name of ["preview_cut_sequence.mp4", "preview_cut_sequence.txt"]) {
    const filePath = path.join(step08Dir, name);
    if (fs.existsSync(filePath)) entries.push(filePath);
  }
  for (const dir of [runDir, step08Dir]) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (RENDER_TMP_RE.test(name)) entries.push(path.join(dir, name));
    }
  }
  return entries;
}

/** ファイル or ディレクトリの合計サイズ(バイト)。読めないものは0。 */
function pathSizeBytes(targetPath) {
  let stat;
  try {
    stat = fs.statSync(targetPath);
  } catch {
    return 0;
  }
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  let names = [];
  try {
    names = fs.readdirSync(targetPath);
  } catch {
    return 0;
  }
  for (const name of names) {
    total += pathSizeBytes(path.join(targetPath, name));
  }
  return total;
}

/**
 * runの最終利用日時(ms): 主要編集ファイル(cut_proposal / composition / scene_edits_draft /
 * project_meta)の mtime の最大。どれも無ければ runDir 自体の mtime にフォールバックする。
 */
function runLastUsedMs(runDir) {
  let latest = 0;
  for (const relPath of LAST_USED_FILES) {
    try {
      const mtime = fs.statSync(path.join(runDir, relPath)).mtimeMs || 0;
      if (mtime > latest) latest = mtime;
    } catch {
      // 存在しないファイルは無視
    }
  }
  if (latest > 0) return latest;
  try {
    return fs.statSync(runDir).mtimeMs || 0;
  } catch {
    return 0;
  }
}

/** run 1件分のキャッシュ統計。キャッシュが無いrunは bytes=0。 */
function runCacheStats(runDir, nowMs) {
  const now = nowMs ?? Date.now();
  const entries = runCacheEntryPaths(runDir);
  const bytes = entries.reduce((sum, entry) => sum + pathSizeBytes(entry), 0);
  const lastUsedMs = runLastUsedMs(runDir);
  const old = now - lastUsedMs > CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return { runDir, runName: path.basename(runDir), bytes, lastUsedMs, old };
}

/** runsRoot直下のrunディレクトリ一覧。 */
function listRunDirs(runsRoot) {
  if (!fs.existsSync(runsRoot)) return [];
  const dirs = [];
  for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) dirs.push(path.join(runsRoot, entry.name));
  }
  return dirs;
}

/**
 * 全runのキャッシュ統計(cache:stats)。bytes降順。
 * totalBytes は全runの合計。runs にはキャッシュを持つrunだけ入れる(UIのrun別内訳用)。
 */
function collectCacheStats(runsRoot, options = {}) {
  const now = options.nowMs ?? Date.now();
  const runs = [];
  let totalBytes = 0;
  for (const runDir of listRunDirs(runsRoot)) {
    const stats = runCacheStats(runDir, now);
    totalBytes += stats.bytes;
    if (stats.bytes > 0) runs.push(stats);
  }
  runs.sort((a, b) => b.bytes - a.bytes);
  return { totalBytes, retentionDays: CACHE_RETENTION_DAYS, runs };
}

/** run 1件の派生キャッシュを削除し、解放バイト数を返す(runフォルダ自体は残す)。 */
function cleanRunCache(runDir) {
  let freedBytes = 0;
  for (const entry of runCacheEntryPaths(runDir)) {
    const bytes = pathSizeBytes(entry);
    try {
      fs.rmSync(entry, { recursive: true, force: true });
      freedBytes += bytes;
    } catch {
      // 個別の削除失敗は無視(他のrunの掃除を続ける)
    }
  }
  return freedBytes;
}

/**
 * キャッシュクリーン本体(cache:clean と起動時自動クリーンの共通実装)。
 * mode: "old"=最終利用が CACHE_RETENTION_DAYS 超のrunのみ / "all"=全run。
 * activeRunDir(実行中ジョブのrun)は常にスキップする。
 */
function cleanCaches(runsRoot, options = {}) {
  const mode = options.mode === "all" ? "all" : "old";
  const now = options.nowMs ?? Date.now();
  const activeRunDir = options.activeRunDir || null;
  const cutoffMs = now - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  let freedBytes = 0;
  let cleanedRuns = 0;
  for (const runDir of listRunDirs(runsRoot)) {
    if (activeRunDir && path.resolve(runDir) === path.resolve(activeRunDir)) continue;
    if (mode === "old" && runLastUsedMs(runDir) >= cutoffMs) continue;
    const freed = cleanRunCache(runDir);
    if (freed > 0) {
      freedBytes += freed;
      cleanedRuns += 1;
    }
  }
  return { ok: true, mode, freedBytes, cleanedRuns };
}

module.exports = {
  CACHE_RETENTION_DAYS,
  runCacheEntryPaths,
  pathSizeBytes,
  runLastUsedMs,
  runCacheStats,
  collectCacheStats,
  cleanRunCache,
  cleanCaches,
};
