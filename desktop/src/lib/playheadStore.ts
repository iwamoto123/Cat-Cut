/**
 * W19-A3(再生ヘッドのApp state依存の根絶): 再生中に毎フレーム更新される再生ヘッド位置を
 * React state(App.tsxのuseState)から切り離すための極小外部ストア。
 * - sourceMs: 元動画ms(旧previewCurrentMs)。シーン行の波形プレイヘッド・チップハイライト等。
 * - timelineMs: OP込みタイムラインms(旧previewTimelineMs)。タイムラインViewの再生ヘッド。null=未報告。
 * 毎フレーム必要なコンポーネントだけが useSyncExternalStore で購読し、App全体は再レンダリングしない。
 * 低頻度でよい値(currentSceneId等)はApp側でストアを購読し「変わった時だけ」setStateして導出する。
 */
import { useSyncExternalStore } from "react";

export type PlayheadStore = {
  getSourceMs: () => number;
  getTimelineMs: () => number | null;
  /** 値が実際に変わった場合のみ購読者へ通知する。 */
  setSourceMs: (ms: number) => void;
  setTimelineMs: (ms: number | null) => void;
  /** run切替等でのリセット(sourceMs=0 / timelineMs=null)。 */
  reset: () => void;
  subscribe: (listener: () => void) => () => void;
};

export function createPlayheadStore(): PlayheadStore {
  let sourceMs = 0;
  let timelineMs: number | null = null;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  return {
    getSourceMs: () => sourceMs,
    getTimelineMs: () => timelineMs,
    setSourceMs(ms: number) {
      if (ms === sourceMs) return;
      sourceMs = ms;
      notify();
    },
    setTimelineMs(ms: number | null) {
      if (ms === timelineMs) return;
      timelineMs = ms;
      notify();
    },
    reset() {
      if (sourceMs === 0 && timelineMs === null) return;
      sourceMs = 0;
      timelineMs = null;
      notify();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** アプリ全体で共有するシングルトン(Appは1つしかマウントされない前提)。 */
export const playheadStore = createPlayheadStore();

/** 再生ヘッドの元動画msを購読する(毎フレーム再レンダリングされるので最小のコンポーネントで使う)。 */
export function usePlayheadSourceMs(): number {
  return useSyncExternalStore(playheadStore.subscribe, playheadStore.getSourceMs);
}

/** 再生ヘッドのタイムラインms(OP込み。null=未報告)を購読する。 */
export function usePlayheadTimelineMs(): number | null {
  return useSyncExternalStore(playheadStore.subscribe, playheadStore.getTimelineMs);
}
