// W13-1: キャッシュ管理モーダル。
//
// runs/ 配下の派生キャッシュ(step08_composition/segments/・preview_cut_sequence.mp4/.txt・
// .render_tmp_*.mp4)の合計サイズとrun別内訳を表示し、「古いキャッシュを削除」(最終利用7日超のみ)と
// 「すべてのキャッシュを削除」を提供する。プロジェクトデータ・書き出し済みMP4は削除されない。
import { useCallback, useEffect, useState } from "react";
import { HardDrive, Loader2, Trash2, X } from "lucide-react";
import { formatCacheAgeDays, formatCacheBytes } from "../lib/cacheManager";

type CacheManagerModalProps = {
  open: boolean;
  onClose: () => void;
};

/** run別内訳の表示上限(上位のみ)。 */
const RUN_BREAKDOWN_LIMIT = 8;

export function CacheManagerModal({ open, onClose }: CacheManagerModalProps) {
  const [stats, setStats] = useState<CatCutCacheStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refreshStats = useCallback(async () => {
    const next = await window.catcut.getCacheStats();
    setStats(next);
  }, []);

  useEffect(() => {
    if (!open) return;
    setMessage("");
    setError("");
    setStats(null);
    refreshStats().catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [open, refreshStats]);

  if (!open) return null;

  async function handleClean(mode: "old" | "all") {
    if (
      mode === "all" &&
      !window.confirm(
        "すべてのプロジェクトのキャッシュを削除しますか？\n\nプロジェクトデータ・書き出し済みMP4は消えません。削除したキャッシュは次回のプレビュー・書き出し時に自動で再生成されます（その分、処理に時間がかかります）。",
      )
    ) {
      return;
    }
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const result = await window.catcut.cleanCache({ mode });
      setMessage(
        result.cleanedRuns > 0
          ? `${result.cleanedRuns}件のプロジェクトから ${formatCacheBytes(result.freedBytes)} を解放しました`
          : "削除対象のキャッシュはありませんでした",
      );
      await refreshStats();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const nowMs = Date.now();
  const oldBytes = stats ? stats.runs.filter((run) => run.old).reduce((sum, run) => sum + run.bytes, 0) : 0;

  return (
    <div className="apiWizardBackdrop" onClick={onClose}>
      <div className="apiWizardDialog" onClick={(event) => event.stopPropagation()}>
        <div className="apiWizardHeader">
          <div>
            <h2>キャッシュ管理</h2>
            <p className="apiWizardConfiguredHint">
              プレビュー・書き出し用の一時ファイルです。削除しても次回利用時に自動で再生成されます
            </p>
          </div>
          <button className="apiWizardCloseButton" type="button" onClick={onClose} title="閉じる">
            <X size={18} />
          </button>
        </div>

        <div className="apiWizardBody">
          {!stats ? (
            <p className="apiWizardLead">
              <Loader2 size={16} className="spinIcon" /> キャッシュサイズを計測中…
            </p>
          ) : (
            <>
              <p className="apiWizardLead cacheTotalLine">
                <HardDrive size={16} />
                合計キャッシュ: <strong>{formatCacheBytes(stats.totalBytes)}</strong>
                {oldBytes > 0 && (
                  <span className="cacheOldHint">
                    （うち{stats.retentionDays}日以上未使用: {formatCacheBytes(oldBytes)}）
                  </span>
                )}
              </p>

              {stats.runs.length > 0 && (
                <ul className="cacheRunList">
                  {stats.runs.slice(0, RUN_BREAKDOWN_LIMIT).map((run) => (
                    <li key={run.runDir} className="cacheRunRow">
                      <span className="cacheRunName" title={run.runDir}>
                        {run.runName}
                      </span>
                      <span className="cacheRunMeta">
                        最終利用: {formatCacheAgeDays(run.lastUsedMs, nowMs)}
                        {run.old ? "（削除対象）" : ""}
                      </span>
                      <span className="cacheRunBytes">{formatCacheBytes(run.bytes)}</span>
                    </li>
                  ))}
                  {stats.runs.length > RUN_BREAKDOWN_LIMIT && (
                    <li className="cacheRunRow cacheRunMore">
                      ほか {stats.runs.length - RUN_BREAKDOWN_LIMIT} 件のプロジェクト
                    </li>
                  )}
                </ul>
              )}

              <div className="apiWizardActions">
                <button
                  className="secondaryButton"
                  type="button"
                  onClick={() => handleClean("old")}
                  disabled={busy}
                  title={`最終利用から${stats.retentionDays}日を超えたプロジェクトのキャッシュだけ削除します`}
                >
                  {busy ? <Loader2 size={14} className="spinIcon" /> : <Trash2 size={14} />}
                  古いキャッシュを削除
                </button>
                <button
                  className="secondaryButton cacheDangerButton"
                  type="button"
                  onClick={() => handleClean("all")}
                  disabled={busy || stats.totalBytes <= 0}
                  title="すべてのプロジェクトのキャッシュを削除します(プロジェクト自体は消えません)"
                >
                  <Trash2 size={14} />
                  すべてのキャッシュを削除
                </button>
              </div>

              <p className="apiWizardConfiguredHint">
                プロジェクトデータ・書き出し済みMP4は削除されません。古いキャッシュはアプリ起動時にも自動で掃除されます
              </p>
            </>
          )}

          {message && <p className="apiWizardConfiguredHint">{message}</p>}
          {error && <div className="apiWizardError">{error}</div>}
        </div>
      </div>
    </div>
  );
}
