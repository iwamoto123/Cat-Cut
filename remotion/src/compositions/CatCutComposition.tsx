import React from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Overlays } from "../components/Overlays";
import { Telop } from "../components/Telop";
import { effectiveCutTelopY } from "../lib/adSafeZone";
import { bgmVolumeAtMs, normalizeBgmTrack } from "../lib/bgmAudio";
import { cutFrameRanges } from "../lib/cutTimeline";
import {
  imageClipZIndex,
  imageOverlayStyle,
  normalizeImageTrack,
  OVERLAY_LAYER_Z,
  TELOP_LAYER_Z,
} from "../lib/imageOverlay";
import { normalizeOpData, opSfxVolume } from "../lib/opTimeline";
import { normalizePunchIn, punchInStyle } from "../lib/punchIn";
import { computeSfxEvents, sanitizeSfxVolume } from "../lib/telopSfx";
import {
  activeVideoEffectAt,
  normalizeVideoEffects,
  VIDEO_EFFECT_SFX_VOLUME,
  videoEffectStyle,
  type VideoEffect,
} from "../lib/videoEffects";
import {
  isIdentityFraming,
  normalizeVideoFraming,
  videoFramingLayout,
  type VideoFraming,
} from "../lib/videoFraming";
import { resolveVideoSrc } from "../lib/videoSrc";
import { OpSequence, type OpVideoFramingContext } from "./OpSequence";

interface Cut {
  cut_id: string;
  type: string;
  video: {
    file_path: string;
    start_ms: number;
    end_ms: number;
    speed?: number;
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
  /**
   * フェーズW24 Phase A-2: カット単位のテロップ縦位置(0〜1)。orientation=vertical のとき
   * step08 が顔回避配置(telop_placement.py)で書き込む。無い既存compositionは
   * グローバル timeline.telop_y へフォールバック(後方互換)。
   */
  telop_y?: number;
  /** フェーズW24 Phase A-1: カットの代表顔box(正規化0〜1)。顔なし・横型は null/省略。 */
  face_box?: { x: number; y: number; w: number; h: number } | null;
  /**
   * フェーズW26: パンチイン(交互ズーム)。縦型のとき step08 が交互に書き込む
   * (ジャンプカットを演出に見せる)。無い既存run・横型は省略=変形なし(後方互換)。
   */
  punch_scale?: number;
  /** フェーズW26: パンチインの注視点(正規化0〜1。顔中心 or 既定0.5/0.42)。 */
  punch_origin?: { x: number; y: number } | null;
}

interface VoiceCut {
  id: string;
  telop_position_ranges?: Array<{ start: number; end: number; position: { x: number; y: number } | null }>;
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
    telop_position?: { x: number; y: number };
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
    /**
     * フェーズU8: OP(オープニング)。step08が --op-config から生成し、
     * total_duration_ms と cuts/overlays のタイムラインはOP尺分オフセット済み。
     * 省略・不正なら描画なし(既存compositionは無変更で従来通り動く)。
     */
    op?: unknown;
    /**
     * フェーズU9: BGMトラック(タイムライン基準ms)。step08 が runs/<run>/bgm/bgm.json から転写する。
     * 省略・空なら音なし(bgm.jsonの無い既存compositionは従来と同一)。
     */
    bgm?: unknown;
    /**
     * フェーズV4: 画像挿入トラック(タイムライン基準ms)。step08 が runs/<run>/images/images.json
     * から転写する。省略・空なら描画なし(images.jsonの無い既存compositionは従来と同一)。
     */
    images?: unknown;
    /**
     * フェーズW2: シーン映像ギミックトラック(タイムライン基準ms)。step08 が semantic type
     * から決定的に選定する(pinch=縮小+暗転+teen SFX / zoom=強調ズーム)。
     * 省略・空なら効果なし(video_effectsの無い既存compositionは従来と同一)。
     */
    video_effects?: unknown;
    /**
     * フェーズW9: 映像フレーミング(変形・クロップ。全カット共通のグローバル1件)。
     * step08 が runs/<run>/video_framing.json から identity でない場合のみ転写する。
     * 省略なら従来の cover 描画(video_framingの無い既存compositionは従来と同一)。
     */
    video_framing?: unknown;
  };
  voice_data: {
    version: string;
    cuts: VoiceCut[];
  };
  meta: Record<string, unknown>;
}

/**
 * フェーズW2: 本編カット映像+シーン映像ギミック。
 * カットSequence内で現在フレームからタイムラインmsを求め、区間中の効果を
 * videoEffectStyle(remotion/desktop共通の純関数)で wrapper に適用する。
 * グローバルframingは内側の<OffthreadVideo>に残し、ネストで乗算合成する。
 * pinchの縮小で見える背景は最背面AbsoluteFillの黒。
 */
const CutVideoWithEffects: React.FC<{
  cut: Cut;
  fps: number;
  videoFit: string;
  framing: { scale: number; offset_y: number };
  effects: readonly VideoEffect[];
  /** フェーズW9: 映像フレーミング(null=従来のcover描画)。 */
  videoFraming: VideoFraming | null;
  /** フェーズW9: ソース動画の表示解像度(meta.source_width/height)。 */
  sourceWidth: number;
  sourceHeight: number;
}> = ({ cut, fps, videoFit, framing, effects, videoFraming, sourceWidth, sourceHeight }) => {
  // Sequence内の相対フレーム→タイムラインms(カットのtimeline開始+経過)
  const frame = useCurrentFrame();
  const { width: canvasWidth, height: canvasHeight } = useVideoConfig();
  const tMs = cut.timeline.start_ms + (frame / fps) * 1000;
  const active = activeVideoEffectAt(effects, tMs);
  const style = active ? videoEffectStyle(active, tMs) : null;

  // フェーズW26: パンチイン(交互ズーム)。映像ギミック(zoom等)のtransformとは別レイヤーで
  // ネストして乗算合成する(ギミックは時間変化、パンチインはカット固定のフレーミング)。
  const punch = normalizePunchIn(cut.punch_scale, cut.punch_origin);

  return (
    <AbsoluteFill
      style={
        style
          ? {
              transform: style.transform,
              transformOrigin: style.transformOrigin,
              filter: style.filter,
            }
          : undefined
      }
    >
      <AbsoluteFill style={punch ? punchInStyle(punch) : undefined}>
      {videoFraming ? (
        // フェーズW9: クロップラッパー(cropRect, overflow hidden) > フル映像(videoRect絶対配置)。
        // 座標はキャンバス座標系の純関数(videoFramingLayout。プレビューと同一計算)で求める
        (() => {
          const layout = videoFramingLayout({
            canvasWidth,
            canvasHeight,
            // 旧run等でsource寸法が無い場合はキャンバス寸法とみなす(同アスペクトのcover相当)
            sourceWidth: sourceWidth > 0 ? sourceWidth : canvasWidth,
            sourceHeight: sourceHeight > 0 ? sourceHeight : canvasHeight,
            framing: videoFraming,
          });
          return (
            <div
              style={{
                position: "absolute",
                left: layout.cropRect.left,
                top: layout.cropRect.top,
                width: layout.cropRect.width,
                height: layout.cropRect.height,
                overflow: "hidden",
              }}
            >
              <OffthreadVideo
                playbackRate={cut.video.speed || 1}
                src={resolveVideoSrc(cut.video.file_path)}
                startFrom={Math.round((cut.video.start_ms / 1000) * fps)}
                style={{
                  position: "absolute",
                  left: layout.videoRect.left - layout.cropRect.left,
                  top: layout.videoRect.top - layout.cropRect.top,
                  width: layout.videoRect.width,
                  height: layout.videoRect.height,
                }}
              />
            </div>
          );
        })()
      ) : (
        <OffthreadVideo
          playbackRate={cut.video.speed || 1}
          src={resolveVideoSrc(cut.video.file_path)}
          startFrom={Math.round((cut.video.start_ms / 1000) * fps)}
          style={{
            width: "100%",
            height: "100%",
            objectFit: videoFit === "contain" ? "contain" : "cover",
            transform:
              framing.scale !== 1.0 || framing.offset_y !== 0
                ? `scale(${framing.scale}) translateY(${framing.offset_y * 100}%)`
                : undefined,
            transformOrigin: "center center",
          }}
        />
      )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const CatCutComposition: React.FC<CatCutCompositionProps> = ({
  timeline,
  voice_data,
  meta,
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
  const renderCuts = cutFrameRanges(timeline.cuts, timeline.total_duration_ms, fps);

  // フェーズT3: テロップ効果音。表示開始フレームで<Audio>再生(最小間隔5秒のガード済み・決定的)
  const sfxVolume = sanitizeSfxVolume(timeline.sfx_volume);
  const sfxEvents = computeSfxEvents({
    cuts: renderCuts.map(({ cut }) => cut),
    voiceCuts: voice_data.cuts,
    styles: timeline.telop_styles ?? {},
    defaultStyleName: timeline.default_telop_style ?? "default",
    fps,
  });

  // フェーズU8: OP。cuts の timeline.start_ms は step08 がOP尺分オフセット済みのため、
  // 先頭 [0, opFrames) にOPのSequenceを置くだけで本編と衝突しない
  const op = normalizeOpData(timeline.op);
  const opFrames = op ? Math.max(1, Math.round((op.duration_ms / 1000) * fps)) : 0;

  // フェーズU9: BGMトラック。start/endはタイムライン全体基準(OPがある場合もOP含む先頭=0起点)
  const bgmClips = normalizeBgmTrack(timeline.bgm);

  // フェーズV4: 画像挿入トラック。start/endはタイムライン全体基準。
  // レイヤー順は zIndex で 映像 < 画像 < テロップ < オーバーレイ を保証する
  // (映像+テロップは同じカットSequence内にあるためDOM順では間に挟めない)。
  const imageClips = normalizeImageTrack(timeline.images);

  // フェーズW2: シーン映像ギミック(pinch/zoom)。start/endはタイムライン全体基準。
  // 不正・省略時は空=効果なし(既存compositionは無変更で従来通り動く)
  const videoEffects = normalizeVideoEffects(timeline.video_effects);

  // フェーズW9: 映像フレーミング(変形・クロップ)。timeline.video_framing が存在し
  // identity でない場合のみ有効(nullなら従来のcover描画=完全後方互換)。
  // ソース寸法は meta.source_width/height(W8で追加。セグメントMP4も同寸法)。
  const framingRaw = timeline.video_framing != null ? normalizeVideoFraming(timeline.video_framing) : null;
  const videoFraming = framingRaw && !isIdentityFraming(framingRaw) ? framingRaw : null;
  const sourceWidth = Number((meta as Record<string, unknown> | undefined)?.source_width) || 0;
  const sourceHeight = Number((meta as Record<string, unknown> | undefined)?.source_height) || 0;
  const opFramingContext: OpVideoFramingContext | null = videoFraming
    ? { framing: videoFraming, sourceWidth, sourceHeight }
    : null;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {op && (
        <Sequence durationInFrames={opFrames} from={0}>
          <OpSequence
            op={op}
            sfxVolume={opSfxVolume(sfxVolume)}
            // フェーズW9: ハイライトクリップ映像にも本編と同じフレーミングを適用する
            videoFramingContext={opFramingContext}
            // フェーズV2: OP内テロップ(横スライド)は本編と同じ位置・サイズ・スタイル辞書で描く
            telopContext={{
              telopY,
              fontSize: telopFontSize,
              styles: timeline.telop_styles ?? {},
              defaultStyleName: timeline.default_telop_style ?? "default",
              maxCharsPerLine: timeline.telop_max_chars_per_line,
            }}
          />
        </Sequence>
      )}
      {renderCuts.map(({ cut, from: startFrame, durationInFrames: durationFrames }) => {
        const voiceCut = voiceCutMap.get(cut.cut_id);

        return (
          <Sequence
            key={cut.cut_id}
            from={startFrame}
            durationInFrames={durationFrames}
          >
            <AbsoluteFill>
              {/* 動画(フェーズW2: シーン映像ギミックのwrapper込み) */}
              <CutVideoWithEffects
                cut={cut}
                fps={fps}
                videoFit={timeline.video_fit}
                framing={framing}
                effects={videoEffects}
                videoFraming={videoFraming}
                sourceWidth={sourceWidth}
                sourceHeight={sourceHeight}
              />

              {/* テロップ。zIndexで挿入画像(IMAGE_LAYER_Z)より上に置く(V4) */}
              {voiceCut && voiceCut.telops.length > 0 && (
                <AbsoluteFill style={{ zIndex: TELOP_LAYER_Z }}>
                  <Telop
                    telops={voiceCut.telops}
                    positionRanges={voiceCut.telop_position_ranges}
                    words={voiceCut.voice.words}
                    cutStartFrame={startFrame}
                    fps={fps}
                    animationIn={animationIn}
                    animationOut={animationOut}
                    // フェーズW24 Phase A-2: cut単位のtelop_y(顔回避配置)をグローバル値より優先
                    telopY={effectiveCutTelopY(cut.telop_y, telopY)}
                    fontSize={telopFontSize}
                    styles={timeline.telop_styles ?? {}}
                    defaultStyleName={timeline.default_telop_style ?? "default"}
                    maxCharsPerLine={timeline.telop_max_chars_per_line}
                  />
                </AbsoluteFill>
              )}
            </AbsoluteFill>
          </Sequence>
        );
      })}

      {/* 画像挿入トラック(フェーズV4): カットの Sequence の外に置き、タイムライン基準msのまま
          カットを跨いで表示する。zIndexで映像の上・テロップの下に挟む。
          画像は render-cli がHTTP配信URLへ書き換える(BGMと同経路)。
          V6-5: 画像同士の前後関係は timeline.images の配列順(後ろの要素ほど手前)。
          desktopプレビュー(PreviewImageLayer)のDOM順と同じ重なりになる */}
      {imageClips.map((clip, index) => {
        const fromFrame = Math.round((clip.start_ms / 1000) * fps);
        const clipFrames = Math.max(1, Math.round(((clip.end_ms - clip.start_ms) / 1000) * fps));
        return (
          <Sequence
            durationInFrames={clipFrames}
            from={fromFrame}
            key={`image_${clip.id}`}
            style={{ zIndex: imageClipZIndex(index), pointerEvents: "none" }}
          >
            <Img src={resolveVideoSrc(clip.file)} style={imageOverlayStyle(clip)} />
          </Sequence>
        );
      })}

      {/* オーバーレイ(フェーズT1-3): カットの Sequence の外に置くことで、
          タイムライン基準msのままカットを跨いで連続表示できる。
          V4: zIndexで挿入画像・テロップより上のまま維持する */}
      <AbsoluteFill style={{ zIndex: OVERLAY_LAYER_Z }}>
        <Overlays overlays={timeline.overlays} styles={timeline.telop_styles} />
      </AbsoluteFill>

      {/* BGM(フェーズU9): クリップ区間をSequenceで配置し、volume関数でフェードイン/アウト。
          音源は render-cli がHTTP配信URLへ書き換える(segmentsと同経路)。複数クリップの重なりはミックスされる */}
      {bgmClips.map((clip) => {
        const fromFrame = Math.round((clip.start_ms / 1000) * fps);
        const clipFrames = Math.max(1, Math.round(((clip.end_ms - clip.start_ms) / 1000) * fps));
        return (
          <Sequence durationInFrames={clipFrames} from={fromFrame} key={`bgm_${clip.id}`}>
            <Audio
              src={resolveVideoSrc(clip.file)}
              volume={(frame) => bgmVolumeAtMs(clip, (frame / fps) * 1000)}
            />
          </Sequence>
        );
      })}

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

      {/* シーン映像ギミックSFX(フェーズW2): pinch開始でteenを小さく鳴らす(音量は固定0.3)。
          テロップSFXと同じくsfx_volume=0(全ミュート)なら鳴らさない */}
      {sfxVolume > 0 &&
        videoEffects
          .filter((effect) => effect.type === "pinch" && effect.sfx)
          .map((effect) => (
            <Sequence
              durationInFrames={Math.max(1, Math.ceil(fps * 2.0))}
              from={Math.round((effect.start_ms / 1000) * fps)}
              key={`ve_sfx_${effect.id}`}
            >
              <Audio
                src={staticFile(`sfx/${effect.sfx}.wav`)}
                volume={VIDEO_EFFECT_SFX_VOLUME}
              />
            </Sequence>
          ))}
    </AbsoluteFill>
  );
};
