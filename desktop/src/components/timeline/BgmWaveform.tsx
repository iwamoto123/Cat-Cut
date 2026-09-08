import { memo, useEffect, useMemo, useState } from "react";
import { bgmWaveformHeights, bgmWaveformPath, createBgmWaveformLoader, type BgmWaveformData } from "../../lib/bgmWaveform";

const acquireWaveform = createBgmWaveformLoader((input) => window.catcut.getBgmWaveform(input));

type Props = {
  runDir: string;
  file: string;
  durationMs: number;
  widthPx: number;
  heightPx: number;
  volume: number;
  fadeInMs: number;
  fadeOutMs: number;
};

/** Decoded once per source; moving, trimming and volume drags only redraw bounded peaks. */
export const BgmWaveform = memo(function BgmWaveform({
  runDir, file, durationMs, widthPx, heightPx, volume, fadeInMs, fadeOutMs,
}: Props) {
  const [source, setSource] = useState<{ key: string; data: BgmWaveformData | null; error: string | null } | null>(null);
  const [retry, setRetry] = useState(0);
  const sourceKey = JSON.stringify([runDir, file]);
  useEffect(() => {
    let active = true;
    setSource({ key: sourceKey, data: null, error: null });
    const request = acquireWaveform(runDir, file);
    void request.promise.then((data) => {
      if (active) setSource({ key: sourceKey, data, error: null });
    }, (error: unknown) => {
      if (active) setSource({ key: sourceKey, data: null, error: error instanceof Error ? error.message : "波形を取得できませんでした" });
    });
    return () => { active = false; request.release(); };
  }, [runDir, file, sourceKey, retry]);
  const data = source?.key === sourceKey ? source.data : null;
  const error = source?.key === sourceKey ? source.error : null;
  const needsRestart = Boolean(error && /getBgmWaveform|No handler registered.*bgm:waveform/.test(error));
  const waveformPath = useMemo(() => data ? bgmWaveformPath(
    bgmWaveformHeights(data, durationMs, widthPx, volume, fadeInMs, fadeOutMs), widthPx, heightPx,
  ) : "", [data, durationMs, widthPx, heightPx, volume, fadeInMs, fadeOutMs]);

  if (!data) return (
    <span className="tlBgmWaveformStatus" title={needsRestart ? "編集内容を保存してアプリを再起動すると、BGM波形が表示されます" : error ?? "音源の波形を準備しています"} style={{ pointerEvents: "none" }}>
      {needsRestart ? "再起動で波形を表示" : error ? "波形未取得" : "波形を読み込み中"}
      {error && !needsRestart && <button type="button" title="BGM波形を再読み込み" aria-label="BGM波形を再読み込み"
        style={{ pointerEvents: "auto" }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => { event.stopPropagation(); setRetry((value) => value + 1); }}>再試行</button>}
    </span>
  );
  return (
    <svg className="tlBgmWaveform" width="100%" height="100%" viewBox={`0 0 ${Math.max(1, widthPx)} ${Math.max(1, heightPx)}`}
      preserveAspectRatio="none" aria-hidden="true" focusable="false" style={{ pointerEvents: "none" }}>
      <path d={waveformPath} fill="currentColor" />
    </svg>
  );
});
