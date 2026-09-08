/**
 * Cat-Cut Remotion レンダリング CLI
 *
 * 使用方法:
 *   npx tsx scripts/render-cli.ts \
 *     --composition ../runs/test01/step08_composition/composition.json \
 *     --output ../runs/test01/output/final.mp4
 *
 * オプション:
 *   --composition  composition.json ファイルパス（必須）
 *   --output       出力MP4ファイルパス（デフォルト: ./out/video.mp4）
 *   --width        出力幅（デフォルト: meta.display_width or 1920）
 *   --height       出力高さ（デフォルト: meta.display_height or 1080）
 *   --concurrency  並列レンダリング数（デフォルト: 4。8以上はOffthreadVideoタイムアウトリスク）
 *   --crf          h264のCRF値 1〜51（未指定時はRemotion既定。小さいほど高画質・大容量）
 *   --hardware-acceleration  if-possible/disable（W11-1b。既定disable=従来のソフトウェアx264）
 *   --video-bitrate          映像ビットレート（例 10000k。W11-1b: HWエンコード時はcrf不可のためこちらを使う）
 */

import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import path from "path";
import fs from "fs";
import http from "http";
import os from "os";
import { computeBundleCacheKey } from "./bundleCache.ts";

function parseArgs(): {
  composition: string;
  output: string;
  width: number;
  height: number;
  concurrency: number;
  crf: number;
  hardwareAcceleration: "if-possible" | "disable";
  videoBitrate: string;
} {
  const args = process.argv.slice(2);
  const result = {
    composition: "",
    output: "./out/video.mp4",
    width: 0,
    height: 0,
    concurrency: 4, // 固定。8以上だと OffthreadVideo タイムアウト
    crf: 0, // 0=未指定(Remotion既定値)
    // W11-1b: 既定disable=従来動作。if-possibleでmacOSはVideoToolboxを使う
    hardwareAcceleration: "disable" as "if-possible" | "disable",
    videoBitrate: "", // 空=未指定(Remotion既定値)
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--composition":
        result.composition = args[++i];
        break;
      case "--output":
        result.output = args[++i];
        break;
      case "--width":
        result.width = parseInt(args[++i], 10);
        break;
      case "--height":
        result.height = parseInt(args[++i], 10);
        break;
      case "--concurrency":
        result.concurrency = parseInt(args[++i], 10);
        break;
      case "--crf":
        result.crf = parseInt(args[++i], 10) || 0;
        break;
      case "--hardware-acceleration":
        result.hardwareAcceleration = args[++i] === "if-possible" ? "if-possible" : "disable";
        break;
      case "--video-bitrate":
        result.videoBitrate = String(args[++i] || "").trim();
        break;
    }
  }

  return result;
}

// --- W11-1c: Remotion bundle キャッシュ ---

/** bundle() 出力の永続キャッシュ置き場(node_modules/.cache 配下=git管理外)。 */
const BUNDLE_CACHE_DIR = path.resolve(__dirname, "../node_modules/.cache/catcut-bundle");

/**
 * W25: public/ 配下の壊れたシンボリックリンク(リンク先が消えたもの)を除去する。
 * 開発時に張ったリンクの先(旧runのsegments等)が掃除で消えると、Remotionの bundle() が
 * realpath ENOENT で即失敗し書き出し全体が落ちるため(2026-08-21 実害あり)、事前に取り除く。
 */
function removeDanglingSymlinks(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      if (!fs.existsSync(full)) {
        console.warn(`Removing dangling symlink in public/: ${full}`);
        fs.unlinkSync(full);
      }
    } else if (entry.isDirectory()) {
      removeDanglingSymlinks(full);
    }
  }
}

/**
 * W11-1c: キー一致なら前回の bundle 出力を再利用し、不一致・初回のみ bundle() する。
 * キャッシュ判定に失敗しても通常の bundle() へフォールバックする(安全側)。
 */
async function bundleWithCache(): Promise<string> {
  removeDanglingSymlinks(path.resolve(__dirname, "../public"));
  const bundleDir = path.join(BUNDLE_CACHE_DIR, "bundle");
  const keyPath = path.join(BUNDLE_CACHE_DIR, "key.json");
  let cacheKey = "";
  try {
    cacheKey = computeBundleCacheKey(path.resolve(__dirname, ".."));
    if (fs.existsSync(keyPath) && fs.existsSync(path.join(bundleDir, "index.html"))) {
      const saved = JSON.parse(fs.readFileSync(keyPath, "utf-8")) as { key?: string };
      if (saved.key === cacheKey) {
        console.log(`Bundle cache hit: ${bundleDir}`);
        return bundleDir;
      }
    }
  } catch {
    // キー計算・キャッシュ読み込みの失敗は無視して bundle() で続行
  }

  console.log("Bundling Remotion project...");
  fs.rmSync(bundleDir, { recursive: true, force: true });
  fs.mkdirSync(bundleDir, { recursive: true });
  const bundleLocation = await bundle({
    entryPoint: path.resolve(__dirname, "../src/index.ts"),
    outDir: bundleDir,
    webpackOverride: (config) => config,
  });
  if (cacheKey) {
    fs.writeFileSync(keyPath, JSON.stringify({ key: cacheKey }), "utf-8");
  }
  return bundleLocation;
}

function loadJson(filePath: string): unknown {
  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`File not found: ${absolutePath}`);
  }
  const content = fs.readFileSync(absolutePath, "utf-8");
  return JSON.parse(content);
}

/**
 * ローカル動画ファイルを配信するHTTPサーバーを起動する。
 * Remotion の OffthreadVideo は HTTP(S) URL のみ対応し、
 * さらにシンボリックリンクもデフォルトで拒否するため、
 * 別ポートでHTTPサーバーを起動してローカルファイルを配信する。
 */
function startVideoServer(
  localFiles: Map<string, string> // name -> absPath
): Promise<{ port: number; server: http.Server }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url || "");
      const name = urlPath.replace(/^\//, "");
      const absPath = localFiles.get(name);

      if (!absPath || !fs.existsSync(absPath)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const stat = fs.statSync(absPath);
      const range = req.headers.range;
      // フェーズU9: BGM音源(mp3/wav等)も同じサーバーで配信するため拡張子でContent-Typeを解決する
      const contentType = MEDIA_CONTENT_TYPES[path.extname(absPath).toLowerCase()] || "video/mp4";

      if (range) {
        // Range request (Remotion uses this for seeking)
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        const chunkSize = end - start + 1;

        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunkSize,
          "Content-Type": contentType,
          "Access-Control-Allow-Origin": "*",
        });

        fs.createReadStream(absPath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          "Content-Length": stat.size,
          "Content-Type": contentType,
          "Access-Control-Allow-Origin": "*",
        });

        fs.createReadStream(absPath).pipe(res);
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve({ port: addr.port, server });
      } else {
        reject(new Error("Failed to get server port"));
      }
    });
  });
}

/** フェーズU9: 配信ファイルのContent-Type(拡張子ベース)。BGMの音声形式を追加。 */
const MEDIA_CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  // フェーズV4: 画像挿入トラック(timeline.images)の画像形式
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/**
 * timeline 内でメディアファイルを参照するオブジェクトを「参照オブジェクト+パスのキー名」で列挙する。
 * フェーズU8: OP(highlight_teaser)の抜粋クリップもカットと同じ経路でHTTP配信する必要がある
 * (OffthreadVideoはローカル絶対パスを直接読めないため)。
 * フェーズU9: BGM音源(timeline.bgm[].file)も<Audio>から参照されるため同経路で配信する。
 * フェーズV4: 挿入画像(timeline.images[].file)も<Img>から参照されるため同経路で配信する。
 */
function collectMediaRefs(timeline: any): Array<{ ref: any; key: string }> {
  const refs: Array<{ ref: any; key: string }> = [];
  for (const cut of timeline.cuts || []) {
    if (cut.video) refs.push({ ref: cut.video, key: "file_path" });
  }
  for (const clip of timeline.op?.highlight_cuts || []) {
    if (clip) refs.push({ ref: clip, key: "file_path" });
  }
  for (const clip of timeline.bgm || []) {
    if (clip) refs.push({ ref: clip, key: "file" });
  }
  for (const clip of timeline.images || []) {
    if (clip) refs.push({ ref: clip, key: "file" });
  }
  return refs;
}

/**
 * ローカル動画パスを収集して HTTP URL に変換する。
 */
function prepareLocalVideos(
  compositionData: any,
  serverPort: number
): {
  timeline: any;
  localFiles: Map<string, string>; // name -> absPath (server用)
} {
  const timeline = JSON.parse(JSON.stringify(compositionData.timeline));
  const localFiles = new Map<string, string>();
  let fileIdx = 0;

  for (const { ref, key } of collectMediaRefs(timeline)) {
    const fp = ref[key];
    if (fp && typeof fp === "string" && !fp.startsWith("http://") && !fp.startsWith("https://")) {
      const absPath = path.resolve(fp);
      const ext = path.extname(absPath);
      let name: string;

      // 同じファイルは同じ名前を再利用
      const existing = [...localFiles.entries()].find(
        ([, v]) => v === absPath
      );
      if (existing) {
        name = existing[0];
      } else {
        name = `video_${fileIdx}${ext}`;
        localFiles.set(name, absPath);
        fileIdx++;
      }

      ref[key] = `http://127.0.0.1:${serverPort}/${name}`;
    }
  }

  return { timeline, localFiles };
}

async function main() {
  const args = parseArgs();

  if (!args.composition) {
    console.error("Error: --composition is required");
    process.exit(1);
  }

  console.log("=== Cat-Cut Remotion Renderer ===");
  console.log(`Composition: ${args.composition}`);
  console.log(`Output:      ${args.output}`);
  if (args.width && args.height) {
    console.log(`Resolution:  ${args.width}x${args.height}`);
  }
  console.log("");

  // composition.json 読み込み
  console.log("Loading composition.json...");
  const compositionData = loadJson(args.composition) as {
    timeline: { total_duration_ms: number; fps: number; cuts: unknown[] };
    voice_data: unknown;
    meta: {
      display_width?: number;
      display_height?: number;
      rotation?: number;
      [key: string]: unknown;
    };
  };

  // metaから解像度を自動取得 (CLI引数が優先)
  const meta = compositionData.meta || {};
  if (!args.width && meta.display_width) {
    args.width = meta.display_width as number;
  }
  if (!args.height && meta.display_height) {
    args.height = meta.display_height as number;
  }

  console.log(
    `Total duration: ${(compositionData.timeline.total_duration_ms / 1000).toFixed(1)}s`
  );
  console.log(`FPS: ${compositionData.timeline.fps}`);
  console.log(`Cuts: ${compositionData.timeline.cuts?.length ?? 0}`);
  console.log("");

  // 出力ディレクトリ作成
  const outputDir = path.dirname(path.resolve(args.output));
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // W11-4b: 最終パスへ直接書かず、同ディレクトリの一時ファイルへ書いて完了時に rename する
  // (Finderの「追加日」=完了時刻になり、書き込み途中の不完全ファイルが保存先に見えない)。
  // 過去の中断で残った一時ファイルはここで掃除する
  for (const entry of fs.readdirSync(outputDir)) {
    if (/^\.render_tmp_.*\.mp4$/.test(entry)) {
      try {
        fs.unlinkSync(path.join(outputDir, entry));
      } catch {
        // 掃除失敗は無視(レンダリング自体は続行できる)
      }
    }
  }
  const finalOutput = path.resolve(args.output);
  const tempOutput = path.join(outputDir, `.render_tmp_${Date.now()}.mp4`);

  // ローカル動画ファイルサーバー起動 (一時的にポート0で起動)
  // 先にファイルリストを集めるため仮のポートで準備
  const tempTimeline = JSON.parse(
    JSON.stringify(compositionData.timeline)
  );
  const tempLocalFiles = new Map<string, string>();
  let tempIdx = 0;
  for (const { ref, key } of collectMediaRefs(tempTimeline)) {
    const fp = ref[key];
    if (fp && typeof fp === "string" && !fp.startsWith("http://") && !fp.startsWith("https://")) {
      const absPath = path.resolve(fp);
      const ext = path.extname(absPath);
      const existing = [...tempLocalFiles.entries()].find(
        ([, v]) => v === absPath
      );
      if (!existing) {
        tempLocalFiles.set(`video_${tempIdx}${ext}`, absPath);
        tempIdx++;
      }
    }
  }

  let videoServer: http.Server | null = null;
  let timeline: any;

  if (tempLocalFiles.size > 0) {
    console.log("Starting video file server...");
    const { port, server } = await startVideoServer(tempLocalFiles);
    videoServer = server;
    console.log(`  Video server on port ${port}`);

    const result = prepareLocalVideos(compositionData, port);
    timeline = result.timeline;

    for (const [name, absPath] of tempLocalFiles) {
      console.log(`  ${name}: ${path.basename(absPath)}`);
    }
  } else {
    timeline = compositionData.timeline;
  }
  console.log("");

  try {
    // Remotion バンドル: ソース・public素材・依存lock・設定が同じなら前回出力を再利用
    const bundleLocation = await bundleWithCache();
    console.log(`Bundle location: ${bundleLocation}`);

    // inputProps 構築
    const inputProps: Record<string, unknown> = {
      timeline,
      voice_data: compositionData.voice_data,
      meta: compositionData.meta || {},
    };
    if (args.width && args.height) {
      inputProps.width = args.width;
      inputProps.height = args.height;
    }

    // Composition 取得
    console.log("Selecting composition...");
    const composition = await selectComposition({
      serveUrl: bundleLocation,
      id: "CatCut",
      inputProps,
      // W32: フォント全ローカル化で起動時に全書体を読むため、既定28秒では
      // 低速ディスク・高並列時に間に合わないことがある。余裕を持たせる
      timeoutInMilliseconds: 120000,
    });

    console.log(`Composition: ${composition.id}`);
    console.log(
      `Duration: ${composition.durationInFrames} frames (${(composition.durationInFrames / composition.fps).toFixed(1)}s)`
    );
    console.log(`Resolution: ${composition.width}x${composition.height}`);
    console.log("");

    // レンダリング
    // W11-1b: HWエンコード(VideoToolbox)時は crf を渡してはいけない(Remotionの制約)
    // → 画質は videoBitrate で指定する。videoBitrate と crf の併用も不可のため排他にする
    const useHwAccel = args.hardwareAcceleration === "if-possible";
    console.log(
      `Rendering video... (concurrency: ${args.concurrency}, hwAccel: ${args.hardwareAcceleration}` +
        `${args.videoBitrate ? `, bitrate: ${args.videoBitrate}` : ""})`
    );
    const startTime = Date.now();

    await renderMedia({
      composition,
      serveUrl: bundleLocation,
      codec: "h264",
      outputLocation: tempOutput,
      inputProps,
      concurrency: args.concurrency,
      hardwareAcceleration: args.hardwareAcceleration,
      // W32: ローカルフォント一括ロードに合わせて delayRender の猶予を延長
      timeoutInMilliseconds: 120000,
      logLevel: (process.env.CATCUT_RENDER_LOG as "verbose" | undefined) || undefined,
      ...(args.videoBitrate
        ? { videoBitrate: args.videoBitrate }
        : !useHwAccel && args.crf >= 1 && args.crf <= 51
          ? { crf: args.crf }
          : {}),
      // W11-1c: OffthreadVideoのフレームキャッシュを2GBへ明示(フレーム再抽出を削減)
      offthreadVideoCacheSizeInBytes: 2 * 1024 * 1024 * 1024,
      onProgress: ({ progress }) => {
        const percent = Math.round(progress * 100);
        process.stdout.write(`\rProgress: ${percent}%`);
      },
    });

    // W11-4b: 完了した一時ファイルを最終パスへ移動(同ディレクトリなので通常はrename一発。
    // 万一の別ボリューム(EXDEV)は copy+unlink でフォールバック)
    try {
      fs.renameSync(tempOutput, finalOutput);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        fs.copyFileSync(tempOutput, finalOutput);
        fs.unlinkSync(tempOutput);
      } else {
        throw err;
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\nRendering complete in ${elapsed}s`);
    console.log(`Output: ${finalOutput}`);
  } finally {
    // サーバーシャットダウン
    if (videoServer) {
      videoServer.close();
    }
    // W11-4b: 失敗・中断時に一時ファイルを残さない(成功時はrename済みで存在しない)
    try {
      if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
    } catch {
      // 後始末の失敗は無視
    }
  }
}

main().catch((err) => {
  console.error("Rendering failed:", err);
  process.exit(1);
});
