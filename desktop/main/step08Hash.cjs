"use strict";

// W19-C2: 「編集差分ゼロなら step08 を完全スキップ」のための入力合成ハッシュ。
//
// rerunCompositionAndTelop(transcript:apply経路)は編集差分が無くても毎回 step08 を
// 再実行していた。step08 の出力を決める入力一式のハッシュを runs/<run>/step08_input_hash.json
// に保存し、次回ハッシュ一致かつ composition.json と全セグメントファイルが実在すれば
// step08・extract_telop・review_telop を丸ごとスキップする。
// 旧run(ハッシュファイル無し)・不一致・ファイル欠損は従来どおり実行(完全後方互換)。

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const STEP08_INPUT_HASH_FILENAME = "step08_input_hash.json";

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

/**
 * JSONファイルの内容ハッシュ。存在しなければ "absent"。
 *
 * telop_directives.json や type-mapping ランタイムファイルは、内容が同一でも書き込みの
 * たびに updated_at だけが更新される(applyDirectedSlotEditsToDirectives 等)。タイムスタンプ
 * 差分で毎回「変更あり」になるとスキップが一度も効かないため、トップレベルの updated_at を
 * 除外してからハッシュする。JSONとして読めないファイルは生内容をそのままハッシュする。
 */
function hashJsonFileStable(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return "absent";
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const { updated_at: _ignored, ...rest } = parsed;
      return sha1(JSON.stringify(rest));
    }
    return sha1(JSON.stringify(parsed));
  } catch {
    return sha1(raw);
  }
}

/** ファイルの実体シグネチャ(サイズ+mtime)。存在しなければ "absent"。 */
function fileStatSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${Math.round(stat.mtimeMs)}`;
  } catch {
    return "absent";
  }
}

/**
 * step08 の入力を決めるものの合成ハッシュを計算する(純関数的: 引数のパスだけを読む)。
 *
 * ハッシュ対象:
 * - keep_segments(cut_proposal.json の該当部分。cut_proposal.json は毎回全体が
 *   書き直されるためファイルではなく内容を対象にする)
 * - telop_directives.json / orientation.json / video_framing.json / op_config.json /
 *   images/images.json / bgm/bgm.json の内容(存在しないファイルは "absent")
 * - 元動画パス + mtime + size
 * - step08 へ渡す引数(--orientation / --op-config 等)
 * - 追加の安全弁: STTファイルと review.json の実体シグネチャ(単語修正・レビュー再実行を
 *   拾う)、--type-mapping で渡すランタイムファイルの内容(テーマ切替を拾う)
 * - telopOverrides(非directedモードのシーン本文上書き)。step08自体の入力ではないが、
 *   step08スキップ時は extract_telop の telop.txt 再生成も走らないため、「上書きをauto
 *   (null)へ戻す」変更が telop.txt に残留する。上書き配列の変化で再実行させて防ぐ
 */
function computeStep08InputHash({
  runDir,
  keepSegments,
  step08Args,
  sourceVideoPath,
  sttPath,
  reviewPath,
  typeMappingPath,
  telopOverrides,
}) {
  const runFile = (...parts) => path.join(runDir, ...parts);
  const components = {
    version: 1,
    keep_segments: sha1(JSON.stringify(Array.isArray(keepSegments) ? keepSegments : [])),
    telop_directives: hashJsonFileStable(runFile("telop_directives.json")),
    orientation: hashJsonFileStable(runFile("orientation.json")),
    video_framing: hashJsonFileStable(runFile("video_framing.json")),
    op_config: hashJsonFileStable(runFile("op_config.json")),
    images: hashJsonFileStable(runFile("images", "images.json")),
    bgm: hashJsonFileStable(runFile("bgm", "bgm.json")),
    source_video: sourceVideoPath
      ? `${sourceVideoPath}:${fileStatSignature(sourceVideoPath)}`
      : "absent",
    stt: sttPath ? fileStatSignature(sttPath) : "absent",
    review: reviewPath ? fileStatSignature(reviewPath) : "absent",
    type_mapping: typeMappingPath ? hashJsonFileStable(typeMappingPath) : "absent",
    telop_overrides: sha1(JSON.stringify(Array.isArray(telopOverrides) ? telopOverrides : null)),
    args: sha1(JSON.stringify(Array.isArray(step08Args) ? step08Args : [])),
  };
  return { hash: sha1(JSON.stringify(components)), components };
}

function step08InputHashPath(runDir) {
  return path.join(runDir, STEP08_INPUT_HASH_FILENAME);
}

function readStoredStep08Hash(runDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(step08InputHashPath(runDir), "utf-8"));
    return parsed && typeof parsed === "object" && typeof parsed.hash === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function writeStep08InputHash(runDir, { hash, components }) {
  const payload = {
    version: 1,
    hash,
    components,
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(step08InputHashPath(runDir), `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

/**
 * composition.json が参照するセグメント(等)の動画ファイルパスを集める。
 * timeline.cuts[].video.file_path が正本。OPクリップ(timeline.op.clips[].file_path)も
 * カットのセグメントを参照するため念のため含める(純関数。存在チェックは呼び出し側)。
 */
function collectCompositionVideoPaths(composition) {
  const paths = [];
  const cuts = Array.isArray(composition?.timeline?.cuts) ? composition.timeline.cuts : [];
  for (const cut of cuts) {
    const filePath = cut?.video?.file_path;
    if (typeof filePath === "string" && filePath) paths.push(filePath);
  }
  const opClips = Array.isArray(composition?.timeline?.op?.clips) ? composition.timeline.op.clips : [];
  for (const clip of opClips) {
    const filePath = clip?.file_path;
    if (typeof filePath === "string" && filePath) paths.push(filePath);
  }
  return paths;
}

/**
 * step08 をスキップできるか判定する。条件:
 * 1. 保存済みハッシュが存在し、今回のハッシュと一致する
 * 2. composition.json が実在して読める
 * 3. composition が参照する全セグメントファイルが実在する(キャッシュ掃除等での欠損を拾う)
 */
function canSkipStep08(runDir, currentHash) {
  const stored = readStoredStep08Hash(runDir);
  if (!stored || stored.hash !== currentHash) return false;

  const compositionPath = path.join(runDir, "step08_composition", "composition.json");
  let composition;
  try {
    composition = JSON.parse(fs.readFileSync(compositionPath, "utf-8"));
  } catch {
    return false;
  }

  const videoPaths = collectCompositionVideoPaths(composition);
  if (!videoPaths.length) return false;
  return videoPaths.every((filePath) => fs.existsSync(filePath));
}

module.exports = {
  STEP08_INPUT_HASH_FILENAME,
  computeStep08InputHash,
  hashJsonFileStable,
  fileStatSignature,
  step08InputHashPath,
  readStoredStep08Hash,
  writeStep08InputHash,
  collectCompositionVideoPaths,
  canSkipStep08,
};
