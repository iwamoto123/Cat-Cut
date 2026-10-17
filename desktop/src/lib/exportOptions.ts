/**
 * フェーズW7: 書き出し設定モーダルとプロジェクト一覧の純粋ロジック。
 * UI(React)から切り離してテスト可能にする。
 */

export type ExportResolution = "source" | "1080" | "720";
export type ExportQuality = "standard" | "high" | "light";
export type ExportRenderSpeed = "standard" | "fast" | "max";

export const EXPORT_RENDER_SPEED_OPTIONS: Array<{ id: ExportRenderSpeed; label: string; description: string }> = [
  { id: "standard", label: "標準（4並列）", description: "バランスの取れた速度。通常はこちらをおすすめします。" },
  { id: "fast", label: "高速（6並列）", description: "ややPC負荷が上がります。書き出しを短縮したいとき向け。" },
  { id: "max", label: "最高（8並列）", description: "PC負荷が大きくなります。他の作業を控えて実行してください。" },
];

export const EXPORT_RESOLUTION_OPTIONS: Array<{ id: ExportResolution; label: string }> = [
  { id: "source", label: "元のサイズ" },
  { id: "1080", label: "1080p" },
  { id: "720", label: "720p" },
];

export const EXPORT_QUALITY_OPTIONS: Array<{ id: ExportQuality; label: string }> = [
  { id: "standard", label: "標準" },
  { id: "high", label: "高画質（ファイル大）" },
  { id: "light", label: "軽量（ファイル小）" },
];

/** 解像度選択→レンダリング短辺上限px(0=元のサイズのまま)。 */
export function targetShortSideForResolution(resolution: ExportResolution): number {
  if (resolution === "1080") return 1080;
  if (resolution === "720") return 720;
  return 0;
}

/** 書き出し速度選択→render-cli --concurrency(未指定時は4)。 */
export function concurrencyForRenderSpeed(speed: ExportRenderSpeed): number {
  if (speed === "fast") return 6;
  if (speed === "max") return 8;
  return 4;
}

/** 画質選択→h264のCRF値(0=Remotion既定)。小さいほど高画質・大容量。 */
export function crfForQuality(quality: ExportQuality): number {
  if (quality === "high") return 16;
  if (quality === "light") return 26;
  return 0;
}

/** W11-1b: ハードウェアエンコード(VideoToolbox)の既定はON(Apple Siliconで大幅高速化)。 */
export const EXPORT_HARDWARE_ENCODE_DEFAULT = true;

/**
 * W11-1b: 画質×解像度→HWエンコード時の映像ビットレート("NNNNk"表記)。
 * HW時は crf を指定できない(Remotionの制約)ため、画質選択をビットレートへマップする。
 * 1080p基準: 高16M / 標準10M / 軽量6M。720pは各60%。元のサイズ(source)は1080p扱い。
 */
export function videoBitrateForQuality(quality: ExportQuality, resolution: ExportResolution): string {
  const baseKbps = quality === "high" ? 16000 : quality === "light" ? 6000 : 10000;
  const scaledKbps = resolution === "720" ? Math.round(baseKbps * 0.6) : baseKbps;
  return `${scaledKbps}k`;
}

export function ensureMp4FileName(fileName: string): string {
  const trimmed = fileName.trim();
  if (!trimmed) return "";
  const dotIndex = trimmed.lastIndexOf(".");
  if (dotIndex < 1) return `${trimmed}.mp4`;
  const ext = trimmed.slice(dotIndex).toLowerCase();
  if (ext === ".mp4") return trimmed;
  return `${trimmed.slice(0, dotIndex)}.mp4`;
}

export function baseNameWithoutExtension(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() || "";
  const dotIndex = base.lastIndexOf(".");
  return dotIndex > 0 ? base.slice(0, dotIndex) : base;
}

export function defaultExportFileName(videoPath: string): string {
  const base = baseNameWithoutExtension(videoPath) || "catcut-output";
  return `${base}.mp4`;
}

/** パス比較用の正規化(区切りを/へ統一し末尾の区切りを落とす)。 */
function normalizePathForCompare(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** 現在の素材名を使用。保存場所が同じ場合も名前を変えず output/ に退避する。 */
export function initialExportFileName(videoPath: string, _directory: string): string {
  return defaultExportFileName(videoPath);
}

/** 保存場所未指定はバックエンドがプロジェクトの output/ に保存する。 */
export function buildExportOutputPath(directory: string, fileName: string, videoPath: string): string {
  if (!directory) return "";
  const resolvedName = ensureMp4FileName(fileName.trim() || defaultExportFileName(videoPath));
  const baseDirectory = directory.replace(/[\\/]+$/, "");
  const candidate = `${baseDirectory}/${resolvedName}`;
  if (normalizePathForCompare(candidate).normalize("NFC").toLowerCase() === normalizePathForCompare(videoPath).normalize("NFC").toLowerCase()) {
    return `${baseDirectory}/output/${resolvedName}`;
  }
  return candidate;
}

/** プロジェクト一覧の日時表示(例: 2026-07-08 18:35)。 */
export function formatProjectTimestamp(ms: number): string {
  if (!ms) return "";
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 動画の長さ表示(例: 3:05 / 1:02:30)。 */
export function formatProjectDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${minutes}:${pad(seconds)}`;
}
