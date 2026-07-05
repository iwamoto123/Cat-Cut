import React from "react";
import {
  AbsoluteFill,
  Audio,
  OffthreadVideo,
  Sequence,
  staticFile,
  useVideoConfig,
} from "remotion";
import { Overlays } from "../components/Overlays";
import { Telop } from "../components/Telop";
import { computeSfxEvents, sanitizeSfxVolume } from "../lib/telopSfx";

/**
 * 動画ファイルパスを解決する。
 * - http:// or https:// → そのまま (render-cli のHTTPサーバー経由)
 * - /segments/xxx.mp4 → staticFile() 経由 (Studio プレビュー用)
 * - 絶対パス → そのまま (レンダリング時)
 */
const resolveVideoSrc = (filePath: string): string => {
  if (filePath.startsWith("http://") || filePath.startsWith("https://")) {
    return filePath;
  }
  if (filePath.startsWith("/segments/") || filePath.startsWith("segments/")) {
    const clean = filePath.startsWith("/") ? filePath.slice(1) : filePath;
    return staticFile(clean);
  }
  return filePath;
};

interface Cut {
  cut_id: string;
  type: string;
  video: {
    file_path: string;
    start_ms: number;
    end_ms: number;
  };
  timeline: {
    start_ms: number;
    end_ms: number;
  };
  telop: {
    pages: Array<{
      id: string;
      lines: string[];
    }>;
  };
  layout: string;
  scene_id: string | null;
}

interface VoiceCut {
  id: string;
  narration: string;
  voice: {
    duration_ms: number;
    words: Array<{
      text: string;
      /** 秒単位 */
      start: number;
      /** 秒単位 */
      end: number;
    }>;
  };
  telops: Array<{
    id: string;
    text: string;
    word_indices: number[];
    start?: number;
    end?: number;
    style?: string;
    /** フェーズT1-2: 部分ハイライト対象の部分文字列(省略可) */
    highlight_words?: string[];
    /** フェーズT3: 登場アニメの個別上書き(プリセット既定より優先) */
    animation_in?: string | null;
    /** フェーズT3: 退場アニメの個別上書き */
    animation_out?: string | null;
    /** フェーズT3: 効果音の個別指定(文字列=ID / null=鳴らさない明示 / 省略=プリセット既定) */
    sfx?: string | null;
    segments: Array<{
      text: string;
      word_indices: number[];
    }>;
  }>;
}

interface CatCutCompositionProps {
  timeline: {
    version: string;
    total_duration_ms: number;
    video_fit: string;
    fps: number;
    framing?: { scale: number; offset_y: number };
    telop_y?: number;
    telop_font_size?: number;
    /** 改善20-B: 1行の文字数バジェット。超過行はwrapTelopLineの語境界で折り返す。 */
    telop_max_chars_per_line?: number;
    animation_in?: string;
    animation_out?: string;
    /** フェーズT3: テロップ効果音の音量(0〜1。省略時0.25≒-12dB)。 */
    sfx_volume?: number;
    cuts: Cut[];
    telop_styles?: Record<string, import("../components/Telop").TelopStyle>;
    default_telop_style?: string;
    /**
     * フェーズT1-3: 演出オーバーレイトラック(タイムライン基準ms)。
     * 省略・空なら描画なし(既存compositionは無変更で従来通り動く)。
     */
    overlays?: unknown;
  };
  voice_data: {
    version: string;
    cuts: VoiceCut[];
  };
  meta: Record<string, unknown>;
}

export const CatCutComposition: React.FC<CatCutCompositionProps> = ({
  timeline,
  voice_data,
}) => {
  const { fps } = useVideoConfig();

  const voiceCutMap = new Map<string, VoiceCut>();
  for (const vc of voice_data.cuts) {
    voiceCutMap.set(vc.id, vc);
  }

  const framing = timeline.framing ?? { scale: 1.0, offset_y: 0 };
  const telopY = timeline.telop_y ?? 0.5;
  const telopFontSize = timeline.telop_font_size ?? 52;
  // フェーズT3: プリセット/telop個別のアニメが無いテロップのフォールバック(従来のグローバル設定)
  const animationIn = timeline.animation_in ?? "none";
  const animationOut = timeline.animation_out ?? "none";

  // フェーズT3: テロップ効果音。表示開始フレームで<Audio>再生(最小間隔5秒のガード済み・決定的)
  const sfxVolume = sanitizeSfxVolume(timeline.sfx_volume);
  const sfxEvents = computeSfxEvents({
    cuts: timeline.cuts,
    voiceCuts: voice_data.cuts,
    styles: timeline.telop_styles ?? {},
    defaultStyleName: timeline.default_telop_style ?? "default",
    fps,
  });

  // 累積フレーム計算: 隙間ゼロ保証
  const totalFrames = Math.round(
    (timeline.total_duration_ms / 1000) * fps
  );
  const startFrames = timeline.cuts.map((c) =>
    Math.round((c.timeline.start_ms / 1000) * fps)
  );

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {timeline.cuts.map((cut, i) => {
        const startFrame = startFrames[i];
        const durationFrames =
          i < startFrames.length - 1
            ? startFrames[i + 1] - startFrame
            : totalFrames - startFrame;
        const voiceCut = voiceCutMap.get(cut.cut_id);

        return (
          <Sequence
            key={cut.cut_id}
            from={startFrame}
            durationInFrames={durationFrames}
          >
            <AbsoluteFill>
              {/* 動画 */}
              <OffthreadVideo
                src={resolveVideoSrc(cut.video.file_path)}
                startFrom={Math.round((cut.video.start_ms / 1000) * fps)}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit:
                    timeline.video_fit === "contain" ? "contain" : "cover",
                  transform:
                    framing.scale !== 1.0 || framing.offset_y !== 0
                      ? `scale(${framing.scale}) translateY(${framing.offset_y * 100}%)`
                      : undefined,
                  transformOrigin: "center center",
                }}
              />

              {/* テロップ */}
              {voiceCut && voiceCut.telops.length > 0 && (
                <Telop
                  telops={voiceCut.telops}
                  words={voiceCut.voice.words}
                  cutStartFrame={startFrame}
                  fps={fps}
                  animationIn={animationIn}
                  animationOut={animationOut}
                  telopY={telopY}
                  fontSize={telopFontSize}
                  styles={timeline.telop_styles ?? {}}
                  defaultStyleName={timeline.default_telop_style ?? "default"}
                  maxCharsPerLine={timeline.telop_max_chars_per_line}
                />
              )}
            </AbsoluteFill>
          </Sequence>
        );
      })}

      {/* オーバーレイ(フェーズT1-3): カットの Sequence の外に置くことで、
          タイムライン基準msのままカットを跨いで連続表示できる */}
      <Overlays overlays={timeline.overlays} styles={timeline.telop_styles} />

      {/* 効果音(フェーズT3): テロップ表示開始フレームで再生。wavは remotion/public/sfx/
          (generate_sfx.py が assets/sfx/ からコピー)をバンドル同梱する */}
      {sfxVolume > 0 &&
        sfxEvents.map((event) => (
          <Sequence
            durationInFrames={Math.max(1, Math.ceil(fps * 1.2))}
            from={event.frame}
            key={`sfx_${event.telopId}_${event.frame}`}
          >
            <Audio src={staticFile(`sfx/${event.sfxId}.wav`)} volume={sfxVolume} />
          </Sequence>
        ))}
    </AbsoluteFill>
  );
};
