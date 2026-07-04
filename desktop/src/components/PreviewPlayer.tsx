import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { KeepSegment, TranscriptWord } from "../lib/keepSegments";
import { findActiveWordIndex } from "../lib/keepSegments";
import type { TelopStyleDef } from "../lib/telopThemes";
import { computeContainedVideoBox, computeRelativeTelopFontPx, fitTelopTextToWidth } from "../lib/telopPreviewSize";
import { TelopStyledText } from "./TelopStyledText";

/**
 * 改善7-2(プレビューテロップの適正サイズ): telopFontSize/telopBaseWidthが未指定の場合の
 * フォールバック値(Remotion側の一般的な既定値に合わせる)。
 */
const FALLBACK_TELOP_FONT_SIZE = 52;
const FALLBACK_TELOP_BASE_WIDTH = 1920;
/** ResizeObserver未計測時(初回マウント直後)の最低フォントサイズ(px)。0px表示のちらつき防止用。 */
const MIN_TELOP_FONT_PX = 14;

/** telopStyle未指定時(旧UI互換)のプレースホルダースタイル(白文字のみ)。 */
const FALLBACK_TELOP_STYLE: TelopStyleDef = {
  font_family: '"Zen Kaku Gothic Antique", "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Meiryo", sans-serif',
  font_size: FALLBACK_TELOP_FONT_SIZE,
  font_weight: 900,
  fill: { type: "solid", color: "#FFFFFF" },
};

export type PreviewPlayerHandle = {
  play: () => void;
  pause: () => void;
  isPaused: () => boolean;
  getCurrentTimeMs: () => number;
  seekTo: (ms: number) => void;
};

type Props = {
  videoUrl: string;
  keepSegments: KeepSegment[];
  words: TranscriptWord[];
  seekMs: number | null;
  onSeekConsumed: () => void;
  onActiveWordChange: (wordId: string | null) => void;
  /** 再生速度（既定1.0）。追い読みモードでは1.5等に切り替える（B-3）。 */
  playbackRate?: number;
  /** 現在の再生位置(ms)。ハイライト更新と同じフレーム精度で追い読み進捗計算に使う（B-3）。 */
  onTimeUpdate?: (currentMs: number) => void;
  /**
   * シーン行UI(Phase 1)向け: 動画下部に焼き込み表示するテロップ本文。
   * 未指定またはundefinedならオーバーレイを描画しない(旧UIは影響を受けない)。
   */
  telopText?: string;
  /**
   * T-4(プレビュー反映): 現在シーンのテロップスタイル(色・縁取り・相対サイズ・背景帯)。
   * 未指定なら焼き込みテロップは既定スタイル(白文字)のまま描画する(旧UIは影響を受けない)。
   */
  telopStyle?: TelopStyleDef;
  /**
   * 改善7-2(プレビューテロップの適正サイズ): Remotion書き出し時のtelop_font_size(px、
   * 基準解像度=telopBaseWidth時の値)。未指定時はFALLBACK_TELOP_FONT_SIZEを使う。
   */
  telopFontSize?: number;
  /** 改善7-2: telopFontSizeの基準解像度幅(px)。未指定時はFALLBACK_TELOP_BASE_WIDTHを使う。 */
  telopBaseWidth?: number;
  /**
   * 改善5-1(ホバー自動スクロールの抑制): <video>要素が実際に再生中/停止中かを親へ通知する。
   * previewCurrentMsはホバースクラブ等でも(再生していなくても)更新されるため、
   * 「実際の再生中のみ自動追従スクロールする」判定にはこのコールバックを使う。
   */
  onPlayingChange?: (isPlaying: boolean) => void;
};

function findNextKeepStart(segments: KeepSegment[], currentMs: number) {
  for (const segment of segments) {
    if (segment.startMs > currentMs) return segment.startMs;
  }
  return null;
}

export const PreviewPlayer = forwardRef<PreviewPlayerHandle, Props>(function PreviewPlayer(
  {
    videoUrl,
    keepSegments,
    words,
    seekMs,
    onSeekConsumed,
    onActiveWordChange,
    playbackRate = 1,
    onTimeUpdate,
    telopText,
    telopStyle,
    telopFontSize,
    telopBaseWidth,
    onPlayingChange,
  },
  forwardedRef,
) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // 改善7-2(プレビューテロップの適正サイズ): video要素の実表示幅(ResizeObserver計測)と
  // 動画の実寸(loadedmetadata由来)から、object-fit:containで実際に映像が描画される矩形を求め、
  // Remotionと同じ相対比率でテロップのフォントサイズ・中央配置を計算する。
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [videoIntrinsicSize, setVideoIntrinsicSize] = useState({ width: 0, height: 0 });
  const onPlayingChangeRef = useRef(onPlayingChange);
  onPlayingChangeRef.current = onPlayingChange;
  const sortedSegments = useMemo(
    () => [...keepSegments].sort((a, b) => a.startMs - b.startMs),
    [keepSegments],
  );
  const sortedSegmentsRef = useRef(sortedSegments);
  sortedSegmentsRef.current = sortedSegments;
  const wordsRef = useRef(words);
  wordsRef.current = words;
  const onActiveWordChangeRef = useRef(onActiveWordChange);
  onActiveWordChangeRef.current = onActiveWordChange;
  const onTimeUpdateRef = useRef(onTimeUpdate);
  onTimeUpdateRef.current = onTimeUpdate;
  const lastActiveWordIdRef = useRef<string | null>(null);

  useImperativeHandle(
    forwardedRef,
    () => ({
      play: () => {
        videoRef.current?.play().catch(() => {});
      },
      pause: () => {
        videoRef.current?.pause();
      },
      isPaused: () => videoRef.current?.paused ?? true,
      getCurrentTimeMs: () => (videoRef.current ? videoRef.current.currentTime * 1000 : 0),
      seekTo: (ms: number) => {
        if (!videoRef.current) return;
        videoRef.current.currentTime = Math.max(0, ms / 1000);
      },
    }),
    [],
  );

  useEffect(() => {
    if (seekMs == null || !videoRef.current) return;
    videoRef.current.currentTime = Math.max(0, seekMs / 1000);
    onSeekConsumed();
  }, [onSeekConsumed, seekMs]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = playbackRate;
  }, [playbackRate, videoUrl]);

  // 改善7-2: video要素自身の表示ボックス(clientWidth/clientHeight)をResizeObserverで追従する。
  useEffect(() => {
    const video = videoRef.current;
    if (!video || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setContainerSize({ width, height });
    });
    observer.observe(video);
    return () => observer.disconnect();
  }, [videoUrl]);

  // 改善7-2: 動画の実寸(intrinsic width/height)をloadedmetadataから取得する。
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    function updateIntrinsicSize() {
      if (!video) return;
      if (video.videoWidth && video.videoHeight) {
        setVideoIntrinsicSize({ width: video.videoWidth, height: video.videoHeight });
      }
    }
    updateIntrinsicSize();
    video.addEventListener("loadedmetadata", updateIntrinsicSize);
    return () => video.removeEventListener("loadedmetadata", updateIntrinsicSize);
  }, [videoUrl]);

  const containedBox = useMemo(
    () =>
      computeContainedVideoBox(
        containerSize.width,
        containerSize.height,
        videoIntrinsicSize.width,
        videoIntrinsicSize.height,
      ),
    [containerSize.width, containerSize.height, videoIntrinsicSize.width, videoIntrinsicSize.height],
  );

  const previewTelopBaseFontPx =
    computeRelativeTelopFontPx(
      containedBox.width || containerSize.width,
      telopFontSize ?? FALLBACK_TELOP_FONT_SIZE,
      telopBaseWidth ?? FALLBACK_TELOP_BASE_WIDTH,
    ) || MIN_TELOP_FONT_PX;

  const effectiveTelopStyle = telopStyle ?? FALLBACK_TELOP_STYLE;
  // 改善8-B-4(プレビューのテロップ描画をプリセット忠実に): Remotion側(Telop.tsx)はstyle.font_size
  // (プリセット定義の絶対px、composition基準解像度=telopBaseWidthでの値)をそのまま使うため、
  // プレビューでも「動画の実表示幅 × (style.font_size / telopBaseWidth)」で同じ相対比率に換算した
  // ものをクランプ前の希望サイズ(preferredFontSizePx)とする(改善7-2のcomputeRelativeTelopFontPxと
  // 同じ考え方をtelopFontSizeの代わりにstyle.font_sizeへ適用)。そのうえで「1行が動画表示幅の90%に
  // 収まる」よう逆算でフォントサイズをクランプする。
  // 手動で改行(\n)を含むテロップ本文は、ユーザーの明示的な行分けを尊重しそのまま各行の幅で
  // フォントサイズだけクランプする(自動2行折り返しは行わない)。
  const manualLines = telopText ? telopText.split("\n") : [];
  const videoDisplayWidthPx = containedBox.width || containerSize.width;
  const preferredTelopFontPx =
    computeRelativeTelopFontPx(
      videoDisplayWidthPx,
      effectiveTelopStyle.font_size || telopFontSize || FALLBACK_TELOP_FONT_SIZE,
      telopBaseWidth ?? FALLBACK_TELOP_BASE_WIDTH,
    ) || previewTelopBaseFontPx;
  const telopFit = useMemo(() => {
    if (!telopText) return { fontSizePx: preferredTelopFontPx, lines: [] as string[] };
    const fontFamily = effectiveTelopStyle.font_family || FALLBACK_TELOP_STYLE.font_family!;
    const fontWeight = effectiveTelopStyle.font_weight ?? 900;
    const letterSpacing = effectiveTelopStyle.letter_spacing;
    if (manualLines.length > 1) {
      // 複数行それぞれについて90%幅に収まるフォントサイズを求め、最小値(=最も制約が厳しい行)を採用する。
      const fittedSizes = manualLines.map(
        (line) =>
          fitTelopTextToWidth(line, {
            videoDisplayWidthPx,
            preferredFontSizePx: preferredTelopFontPx,
            fontFamily,
            fontWeight,
            letterSpacing,
            minFontSizePx: preferredTelopFontPx * 0.4,
          }).fontSizePx,
      );
      return { fontSizePx: Math.min(...fittedSizes), lines: manualLines };
    }
    return fitTelopTextToWidth(telopText, {
      videoDisplayWidthPx,
      preferredFontSizePx: preferredTelopFontPx,
      fontFamily,
      fontWeight,
      letterSpacing,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [telopText, videoDisplayWidthPx, preferredTelopFontPx, effectiveTelopStyle]);

  // B-3: ハイライト更新はrequestVideoFrameCallback（利用不可ならrAF）で
  // timeupdate（〜250ms間隔）より滑らかに追従させる。videoUrl変更時（<video>の再マウント）に
  // 新しいDOM要素へ再接続する。
  useEffect(() => {
    const maybeVideo = videoRef.current;
    if (!maybeVideo) return undefined;
    const video: HTMLVideoElement = maybeVideo;
    const supportsRvfc = typeof video.requestVideoFrameCallback === "function";
    let rafId: number | null = null;
    let rvfcId: number | null = null;

    function update() {
      const currentMs = video.currentTime * 1000;
      const segments = sortedSegmentsRef.current;
      const toleranceMs = 100;
      const inside = segments.some(
        (segment) => currentMs >= segment.startMs - toleranceMs && currentMs < segment.endMs - toleranceMs,
      );
      if (!inside) {
        const nextStartMs = findNextKeepStart(segments, currentMs);
        if (nextStartMs != null) {
          video.currentTime = nextStartMs / 1000;
        }
      }

      const activeIndex = findActiveWordIndex(wordsRef.current, currentMs);
      const activeWordId = activeIndex >= 0 ? wordsRef.current[activeIndex].id : null;
      if (activeWordId !== lastActiveWordIdRef.current) {
        lastActiveWordIdRef.current = activeWordId;
        onActiveWordChangeRef.current(activeWordId);
      }
      onTimeUpdateRef.current?.(currentMs);
    }

    function stopLoop() {
      if (rvfcId != null && supportsRvfc) video.cancelVideoFrameCallback(rvfcId);
      if (rafId != null) cancelAnimationFrame(rafId);
      rvfcId = null;
      rafId = null;
    }

    function loop() {
      update();
      if (supportsRvfc) {
        rvfcId = video.requestVideoFrameCallback(loop);
      } else {
        rafId = requestAnimationFrame(loop);
      }
    }

    function handlePlay() {
      stopLoop();
      loop();
      onPlayingChangeRef.current?.(true);
    }
    function handlePauseOrEnded() {
      stopLoop();
      update();
      onPlayingChangeRef.current?.(false);
    }
    function handleSeeked() {
      update();
    }

    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePauseOrEnded);
    video.addEventListener("ended", handlePauseOrEnded);
    video.addEventListener("seeked", handleSeeked);
    update();
    onPlayingChangeRef.current?.(!video.paused);
    if (!video.paused) loop();

    return () => {
      stopLoop();
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePauseOrEnded);
      video.removeEventListener("ended", handlePauseOrEnded);
      video.removeEventListener("seeked", handleSeeked);
    };
  }, [videoUrl]);

  return (
    <div className="transcriptPreviewPanel">
      <video
        className="transcriptPreviewVideo"
        controls
        key={videoUrl}
        preload="metadata"
        ref={videoRef}
        src={videoUrl}
      />
      {telopText != null && telopText !== "" && (
        <div
          className="previewTelopOverlay"
          style={{
            left: `${containedBox.offsetX}px`,
            width: containedBox.width ? `${containedBox.width}px` : "100%",
            bottom: `${Math.max(8, containedBox.offsetY + 10)}px`,
          }}
        >
          <TelopStyledText
            lines={telopFit.lines.length ? telopFit.lines : [telopText]}
            style={effectiveTelopStyle}
            fontSizePx={Math.max(MIN_TELOP_FONT_PX, Math.round(telopFit.fontSizePx))}
          />
        </div>
      )}
    </div>
  );
});
