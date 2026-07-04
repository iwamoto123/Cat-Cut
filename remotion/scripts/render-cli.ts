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
 */

import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import path from "path";
import fs from "fs";
import http from "http";
import os from "os";

function parseArgs(): {
  composition: string;
  output: string;
  width: number;
  height: number;
  concurrency: number;
} {
  const args = process.argv.slice(2);
  const result = {
    composition: "",
    output: "./out/video.mp4",
    width: 0,
    height: 0,
    concurrency: 4, // 固定。8以上だと OffthreadVideo タイムアウト
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
    }
  }

  return result;
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
          "Content-Type": "video/mp4",
          "Access-Control-Allow-Origin": "*",
        });

        fs.createReadStream(absPath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          "Content-Length": stat.size,
          "Content-Type": "video/mp4",
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
  const cuts = timeline.cuts || [];
  const localFiles = new Map<string, string>();
  let fileIdx = 0;

  for (const cut of cuts) {
    const fp = cut.video?.file_path;
    if (fp && !fp.startsWith("http://") && !fp.startsWith("https://")) {
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

      cut.video.file_path = `http://127.0.0.1:${serverPort}/${name}`;
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

  // ローカル動画ファイルサーバー起動 (一時的にポート0で起動)
  // 先にファイルリストを集めるため仮のポートで準備
  const tempTimeline = JSON.parse(
    JSON.stringify(compositionData.timeline)
  );
  const tempLocalFiles = new Map<string, string>();
  let tempIdx = 0;
  for (const cut of (tempTimeline.cuts || []) as any[]) {
    const fp = cut.video?.file_path;
    if (fp && !fp.startsWith("http://") && !fp.startsWith("https://")) {
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
    // Remotion バンドル
    console.log("Bundling Remotion project...");
    const bundleLocation = await bundle({
      entryPoint: path.resolve(__dirname, "../src/index.ts"),
      webpackOverride: (config) => config,
    });
    console.log(`Bundle created at: ${bundleLocation}`);

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
    });

    console.log(`Composition: ${composition.id}`);
    console.log(
      `Duration: ${composition.durationInFrames} frames (${(composition.durationInFrames / composition.fps).toFixed(1)}s)`
    );
    console.log(`Resolution: ${composition.width}x${composition.height}`);
    console.log("");

    // レンダリング
    console.log(`Rendering video... (concurrency: ${args.concurrency})`);
    const startTime = Date.now();

    await renderMedia({
      composition,
      serveUrl: bundleLocation,
      codec: "h264",
      outputLocation: path.resolve(args.output),
      inputProps,
      concurrency: args.concurrency,
      onProgress: ({ progress }) => {
        const percent = Math.round(progress * 100);
        process.stdout.write(`\rProgress: ${percent}%`);
      },
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\nRendering complete in ${elapsed}s`);
    console.log(`Output: ${path.resolve(args.output)}`);
  } finally {
    // サーバーシャットダウン
    if (videoServer) {
      videoServer.close();
    }
  }
}

main().catch((err) => {
  console.error("Rendering failed:", err);
  process.exit(1);
});
