import { staticFile } from "remotion";

/**
 * 動画ファイルパスを解決する(CatCutComposition と OpSequence の共通処理)。
 * - http:// or https:// → そのまま (render-cli のHTTPサーバー経由)
 * - /segments/xxx.mp4 → staticFile() 経由 (Studio プレビュー用)
 * - 絶対パス → そのまま (レンダリング時)
 */
export const resolveVideoSrc = (filePath: string): string => {
  if (filePath.startsWith("http://") || filePath.startsWith("https://")) {
    return filePath;
  }
  if (filePath.startsWith("/segments/") || filePath.startsWith("segments/")) {
    const clean = filePath.startsWith("/") ? filePath.slice(1) : filePath;
    return staticFile(clean);
  }
  return filePath;
};
