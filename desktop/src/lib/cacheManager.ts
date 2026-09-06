// W13-1: キャッシュ管理UIの表示用純関数(CacheManagerModalから使う)。

/** バイト数を人が読める表記にする(1024基数。小数1桁・Bのみ整数)。 */
export function formatCacheBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return unitIndex === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${units[unitIndex]}`;
}

/** 最終利用日時を「今日 / N日前」表記にする(キャッシュ一覧のメタ表示用)。 */
export function formatCacheAgeDays(lastUsedMs: number, nowMs: number): string {
  if (!Number.isFinite(lastUsedMs) || lastUsedMs <= 0) return "不明";
  const days = Math.floor((nowMs - lastUsedMs) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "今日";
  return `${days}日前`;
}
