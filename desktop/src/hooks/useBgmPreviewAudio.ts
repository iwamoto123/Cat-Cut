import { useEffect, useRef } from "react";
import { bgmVolumeAtTimelineMs, type BgmClipData } from "../lib/bgmAudio";

/** プレビュー同期の許容ズレ(秒)。これを超えたらHTMLAudioをシークし直す。 */
const BGM_SYNC_TOLERANCE_S = 0.75;

/** シーン切替時にvideo側の再生状態が一瞬途切れてもBGMを止めない猶予。 */
const BGM_TRANSITION_GRACE_MS = 180;

/** W16-6: 停止中(仮想再生していない間)の低頻度ポーリング間隔(ms)。rAF常時ループをやめてCPUを解放する。 */
const BGM_IDLE_POLL_MS = 300;

export type BgmPreviewClip = BgmClipData & {
  /** プレビューサーバー配信URL(空なら再生しない)。 */
  url: string;
};

/** 再生エンジン(PreviewPlayer)が返す現在の再生状態。 */
export type PreviewPlaybackState = {
  /** 出力タイムラインms(OP込み)。カット区間外など写像不能はnull。 */
  timelineMs: number | null;
  /** 仮想再生中かどうか(OPの静止エントリ=videoは停止中でもtrueになり得る)。 */
  playing: boolean;
  /** 映像・静止OPと同じ再生速度。BGM側HTMLAudioにも同期する。 */
  playbackRate: number;
};

type Options = {
  clips: BgmPreviewClip[];
  muted: boolean;
  /**
   * フェーズV3(仮想プレイリスト): 現在のタイムラインms・再生中フラグの取得。
   * <video>のcurrentTime/pausedを直接読む代わりにこれを使うことで、
   * OP区間(クリップ再生・静止エントリのタイマー再生)でもBGMが正しく並走する。
   */
  getPlayback: () => PreviewPlaybackState;
};

/**
 * フェーズU9: プレビュー再生にBGMをHTMLAudioで並走させるフック。
 * - rAFループ内で「現在のタイムラインms」を求め、BGMクリップ区間内なら
 *   該当位置を再生・音量にフェードカーブ(bgmVolumeAtTimelineMs=Remotionと同一関数)を反映
 * - シーク・一時停止・再生に追従(区間外・写像不能は停止)
 * - フェーズV3: 位置・再生状態は getPlayback(仮想プレイリスト基準)から取得するため、
 *   OP区間(タイムライン先頭)のBGMも鳴る。ループはマウント中常時回す
 *   (静止エントリ再生中は<video>のplayイベントが発生しないため、イベント駆動にできない)
 */
export function useBgmPreviewAudio({ clips, muted, getPlayback }: Options) {
  const audioMapRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const lastActiveAtRef = useRef<Map<string, number>>(new Map());
  // rAFループは張りっぱなしのため、最新のclips/muted/getPlaybackはrefで読む
  const stateRef = useRef({ clips, muted, getPlayback });
  stateRef.current = { clips, muted, getPlayback };

  // クリップの増減・音源URL変更に合わせてHTMLAudio要素を作り直す
  useEffect(() => {
    const map = audioMapRef.current;
    const nextKeys = new Set(clips.filter((clip) => clip.url).map((clip) => `${clip.id}|${clip.url}`));
    for (const [key, audio] of map) {
      if (!nextKeys.has(key)) {
        audio.pause();
        audio.src = "";
        map.delete(key);
        lastActiveAtRef.current.delete(key);
      }
    }
    for (const clip of clips) {
      if (!clip.url) continue;
      const key = `${clip.id}|${clip.url}`;
      if (!map.has(key)) {
        const audio = new Audio(clip.url);
        audio.preload = "auto";
        map.set(key, audio);
      }
    }
  }, [clips]);

  useEffect(() => {
    let rafId: number | null = null;
    let timerId: number | null = null;
    let cancelled = false;

    /** 現在の再生状態にBGMを同期し、「いま再生中(=高頻度同期が必要)か」を返す。 */
    function sync(): boolean {
      const { clips: currentClips, muted: currentMuted, getPlayback: playback } = stateRef.current;
      const { timelineMs, playing, playbackRate } = playback();
      let holdingTransition = false;
      const now = performance.now();
      for (const clip of currentClips) {
        const key = `${clip.id}|${clip.url}`;
        const audio = audioMapRef.current.get(key);
        if (!audio) continue;
        const active =
          !currentMuted &&
          playing &&
          timelineMs !== null &&
          timelineMs >= clip.start_ms &&
          timelineMs < clip.end_ms;
        if (!active) {
          const lastActiveAt = lastActiveAtRef.current.get(key) ?? Number.NEGATIVE_INFINITY;
          if (!currentMuted && !audio.paused && now - lastActiveAt < BGM_TRANSITION_GRACE_MS) {
            holdingTransition = true;
            continue;
          }
          if (!audio.paused) audio.pause();
          continue;
        }
        lastActiveAtRef.current.set(key, now);
        audio.playbackRate = Math.max(0.25, Math.min(4, playbackRate || 1));
        const desiredS = (timelineMs - clip.start_ms) / 1000;
        if (Math.abs(audio.currentTime - desiredS) > BGM_SYNC_TOLERANCE_S) {
          audio.currentTime = desiredS;
        }
        audio.volume = Math.max(0, Math.min(1, bgmVolumeAtTimelineMs(clip, timelineMs)));
        if (audio.paused) audio.play().catch(() => {});
      }
      return playing || holdingTransition;
    }

    // W16-6(CPU対策): 旧実装はrAFをマウント中無条件で回し続けており、アイドル・スリープ中も
    // レンダラーのCPUを消費していた。再生中のみrAFで高頻度同期し、停止中はsetTimeoutの
    // 低頻度ポーリング(300ms)へ落とす(静止エントリ再生は<video>イベントが無いため、
    // 完全なイベント駆動にはせずポーリングで再生開始を検知する)。
    function loop() {
      if (cancelled) return;
      const playing = sync();
      if (playing) {
        rafId = requestAnimationFrame(loop);
      } else {
        rafId = null;
        timerId = window.setTimeout(loop, BGM_IDLE_POLL_MS);
      }
    }
    loop();

    return () => {
      cancelled = true;
      if (rafId != null) cancelAnimationFrame(rafId);
      if (timerId != null) window.clearTimeout(timerId);
      for (const audio of audioMapRef.current.values()) audio.pause();
    };
  }, []);

  // ミュート切替は再生ループを待たず即時反映する(一時停止中でも次回再生に備えて停止)
  useEffect(() => {
    if (!muted) return;
    for (const audio of audioMapRef.current.values()) audio.pause();
  }, [muted]);

  // アンマウント時に全音源を破棄
  useEffect(() => {
    const map = audioMapRef.current;
    return () => {
      for (const audio of map.values()) {
        audio.pause();
        audio.src = "";
      }
      map.clear();
    };
  }, []);
}
