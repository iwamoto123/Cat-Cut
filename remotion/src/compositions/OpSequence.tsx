/**
 * フェーズU8: OP(オープニング)シーケンス。
 *
 * composition.json timeline.op(step08が--op-configから生成)を受け取り、
 * 本編カット群の前(タイムライン先頭)に3〜7秒のOPを描画する。
 * 設計指針(仕様書U8のネット調査): 長さ3〜7秒・文字は最小限(最大2行)・
 * 音と絵の同期(タイトルが出る瞬間にキメ音)・動きは2〜3種類に絞る。
 *
 * 3パターン:
 *   title_card      : ブランド色ベタ背景 → タイトルがstamp+キメ音でドン → キャッチfade → fadeで本編へ
 *   highlight_teaser: 本編の盛り上がりクリップを高速連続再生(音声そのまま) → 最後にタイトル被せ
 *   question_hook   : 暗背景+問いテキストfade → タイトル → 本編
 *
 * フェーズV2: highlight_teaser の各クリップ再生中に、該当スロットのテロップ文言を
 * 横スライド(slide_left)で表示する。描画は本編と同じ Telop コンポーネントを流用し、
 * telop_y・フォントサイズ・スタイル辞書も本編と共有する(OPと本編で見た目が揃う)。
 *
 * フェーズV5: highlight_teaser に装飾パターン4種(decoration)とテロップ登場アニメの
 * 選択(text_animation)を追加。装飾はSequence全体に被せるAbsoluteFillレイヤーで実装し、
 * タイミング計算は opTimeline.ts(desktopコピーと一致テスト)へ集約する。
 * title_card / question_hook はUIから撤去済みだが、既存runのcompositionを壊さないため
 * レンダラは残す(後方互換)。
 */
import React from "react";
import {
  AbsoluteFill,
  Audio,
  interpolate,
  OffthreadVideo,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

import { Telop, type TelopStyle } from "../components/Telop";
import {
  OP_COLOR_WIPE_BAR_RATIO,
  OP_NEON_COLOR,
  opClipSlowZoomScale,
  opClipTelopTiming,
  opClipTransitionFrames,
  opDecorationHasEndTitle,
  opHookFontPx,
  opHookLines,
  opHookLineStartFrame,
  opHookSegments,
  opQuestionHookPhases,
  opTeaserClipFrames,
  opTeaserTitleFrame,
  opTitleCardPhases,
  type OpData,
  type OpDecoration,
  type OpHookKeywordColor,
} from "../lib/opTimeline";
import { videoFramingLayout, type VideoFraming } from "../lib/videoFraming";
import { resolveVideoSrc } from "../lib/videoSrc";

/**
 * フェーズV2: OP内テロップの描画コンテキスト(本編テロップと共有する設定)。
 * CatCutComposition が timeline から解決した値をそのまま渡す。
 */
export type OpTelopContext = {
  telopY: number;
  fontSize: number;
  styles: Record<string, TelopStyle>;
  defaultStyleName: string;
  maxCharsPerLine?: number;
};

/**
 * フェーズW9: OPハイライトクリップ映像へ適用する映像フレーミング(本編と同一素材のため
 * 本編と同じ構図にする)。null=フレーミングなし(従来のcover描画)。
 */
export type OpVideoFramingContext = {
  framing: VideoFraming;
  sourceWidth: number;
  sourceHeight: number;
};

// タイトルは極太ゴシック(ローカル導入済みの源暎U)で「OPだとわかる」画作りにする
const OP_TITLE_FONT_FAMILY =
  '"GenEi Gothic N U-KL", "Dela Gothic One", "Zen Kaku Gothic Antique", "Hiragino Kaku Gothic ProN", sans-serif';
const OP_SUB_FONT_FAMILY =
  '"Zen Kaku Gothic Antique", "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Meiryo", sans-serif';
const OP_ACCENT_YELLOW = "#FFC400";

/** stamp(ドン)の登場変形。Telop.tsx の stamp と同じ味付け(2.5→1のバネ)。 */
const stampTransform = (frame: number, startFrame: number, fps: number) => {
  const localFrame = frame - startFrame;
  if (localFrame < 0) return { opacity: 0, transform: "scale(2.5)" };
  const progress = spring({ frame: localFrame, fps, config: { damping: 8, stiffness: 300 } });
  const scale = interpolate(progress, [0, 1], [2.5, 1]);
  return { opacity: Math.min(1, progress * 3), transform: `scale(${scale})` };
};

const fadeOpacity = (frame: number, startFrame: number, durationFrames: number) =>
  interpolate(frame, [startFrame, startFrame + durationFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

/** 終端の転換(黒フェード)。whooshと同期して本編へ渡す。 */
const OutroFade = ({ fromFrame, totalFrames }: { fromFrame: number; totalFrames: number }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [fromFrame, totalFrames - 1], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  if (opacity <= 0) return null;
  return <AbsoluteFill style={{ backgroundColor: "#000", opacity }} />;
};

const OpSfx = ({
  frame,
  sfxId,
  volume,
  fps,
}: {
  frame: number;
  sfxId: string | null;
  volume: number;
  fps: number;
}) => {
  if (!sfxId || volume <= 0) return null;
  return (
    <Sequence durationInFrames={Math.max(1, Math.ceil(fps * 1.2))} from={frame}>
      <Audio src={staticFile(`sfx/${sfxId}.wav`)} volume={volume} />
    </Sequence>
  );
};

// =============================================================================
// パターン別の描画
// =============================================================================

const TitleCardOp = ({ op, sfxVolume }: { op: OpData; sfxVolume: number }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const totalFrames = Math.max(1, Math.round((op.duration_ms / 1000) * fps));
  const phases = opTitleCardPhases(totalFrames, fps);

  const title = stampTransform(frame, phases.titleFrame, fps);
  const catchOpacity = fadeOpacity(frame, phases.catchFrame, Math.round(fps * 0.4));
  // アクセント下線はタイトル着地後に左から伸びる(動きは stamp / fade / 伸長の3種に絞る)
  const barProgress = spring({
    frame: Math.max(0, frame - phases.titleFrame - 3),
    fps,
    config: { damping: 200 },
    durationInFrames: Math.round(fps * 0.5),
  });

  return (
    <AbsoluteFill style={{ backgroundColor: op.accent_color }}>
      {/* 単色ベタだと平板なため、ごく薄いビネットで奥行きを足す(色は変えない) */}
      <AbsoluteFill
        style={{
          background: "radial-gradient(ellipse at center, rgba(255,255,255,0.07) 0%, rgba(0,0,0,0.28) 100%)",
        }}
      />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        {/* W11-5: タイトル空文字(未生成・「表示しない」)はタイトルブロックごと描画しない */}
        {op.title && (
        <div
          style={{
            opacity: title.opacity,
            transform: title.transform,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            maxWidth: width * 0.86,
          }}
        >
          <div
            style={{
              fontFamily: OP_TITLE_FONT_FAMILY,
              fontSize: Math.round(height * 0.105),
              fontWeight: 900,
              color: "#FFFFFF",
              letterSpacing: "0.04em",
              lineHeight: 1.25,
              textAlign: "center",
              textShadow: "0px 6px 18px rgba(0,0,0,0.45)",
            }}
          >
            {op.title}
          </div>
          <div
            style={{
              height: Math.max(3, Math.round(height * 0.008)),
              width: `${Math.round(barProgress * 100)}%`,
              marginTop: Math.round(height * 0.02),
              backgroundColor: OP_ACCENT_YELLOW,
            }}
          />
        </div>
        )}
        {op.catch_copy && (
          <div
            style={{
              opacity: catchOpacity,
              marginTop: Math.round(height * 0.05),
              fontFamily: OP_SUB_FONT_FAMILY,
              fontSize: Math.round(height * 0.042),
              fontWeight: 700,
              color: "rgba(255,255,255,0.92)",
              letterSpacing: "0.12em",
              textAlign: "center",
              maxWidth: width * 0.8,
            }}
          >
            {op.catch_copy}
          </div>
        )}
      </AbsoluteFill>
      <OutroFade fromFrame={phases.fadeOutFrame} totalFrames={totalFrames} />
      <OpSfx fps={fps} frame={phases.titleFrame} sfxId={op.sfx_hit} volume={sfxVolume} />
      <OpSfx fps={fps} frame={phases.fadeOutFrame} sfxId={op.sfx_transition} volume={sfxVolume} />
    </AbsoluteFill>
  );
};

// =============================================================================
// フェーズW(OP 0ベース再設計): フックワード表示
// 参考実例の分析(OP編集ガイド§3): 本編字幕の縮小版ではなく、発話を1〜2語に凝縮した
// 一言を画面の1/3を占める極太文字で出す。核心語だけ色分けし、2行は上下2段で対比を見せる。
// =============================================================================

/** 核心語の色(黄=結論・肯定 / 赤=ネガ・断定・警告 / 白=中立)と縁取り色。 */
const HOOK_KEYWORD_COLORS: Record<OpHookKeywordColor, { fill: string; outline: string }> = {
  yellow: { fill: "#FFE600", outline: "#000000" },
  red: { fill: "#FF1F0F", outline: "#FFFFFF" },
  white: { fill: "#FFFFFF", outline: "#000000" },
};

/** 通常(非核心語)文字の色。白+黒縁で実写背景でも読める。 */
const HOOK_BASE_COLOR = { fill: "#FFFFFF", outline: "#000000" };

/**
 * 極太縁取り(8方向text-shadow+ドロップシャドウ)。HTMLテキストの-webkit-text-strokeは
 * 塗りの内側に食い込むため、Telop.tsxと同じくshadow多重で「外側に太る」縁を作る。
 */
function hookOutlineShadow(px: number, color: string): string {
  const offsets = [
    [px, 0], [-px, 0], [0, px], [0, -px],
    [px, px], [px, -px], [-px, px], [-px, -px],
  ];
  const outline = offsets.map(([x, y]) => `${x}px ${y}px 0 ${color}`).join(", ");
  return `${outline}, 0px ${px * 2.2}px ${px * 3}px rgba(0,0,0,0.55)`;
}

/**
 * フックワードレイヤー。display=hook のクリップで、テロップ帯の代わりに
 * 凝縮ワードを大きく表示する。2行は上下2段(A01「定時8時/非人道的」型)、1行は中央。
 * 各行はstamp(ドン)で登場し、2行目は約0.3秒遅れて積み上がる。
 */
const HookWordLayer = ({
  hookText,
  keyword,
  keywordColor,
}: {
  hookText: string;
  keyword: string;
  keywordColor: OpHookKeywordColor;
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const lines = opHookLines(hookText);
  if (lines.length === 0) return null;
  const fontPx = opHookFontPx(lines, width, height);
  const outlinePx = Math.max(2, Math.round(fontPx * 0.06));
  const twoLines = lines.length === 2;

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {lines.map((line, lineIndex) => {
        const stamp = stampTransform(frame, opHookLineStartFrame(lineIndex, fps), fps);
        const segments = opHookSegments(line, keyword);
        // 2行=上下2段(上12%/下72%)で顔を隠さず対比を見せる。1行=中央やや下
        const top = twoLines ? (lineIndex === 0 ? height * 0.1 : height * 0.68) : height * 0.38;
        return (
          <div
            key={`hook_line_${lineIndex}`}
            style={{
              position: "absolute",
              top: Math.round(top),
              left: 0,
              right: 0,
              display: "flex",
              justifyContent: "center",
              opacity: stamp.opacity,
              transform: stamp.transform,
            }}
          >
            <div
              style={{
                fontFamily: OP_TITLE_FONT_FAMILY,
                fontWeight: 900,
                fontSize: fontPx,
                lineHeight: 1.2,
                letterSpacing: "0.03em",
                whiteSpace: "nowrap",
              }}
            >
              {segments.map((segment, segmentIndex) => {
                const palette = segment.keyword ? HOOK_KEYWORD_COLORS[keywordColor] : HOOK_BASE_COLOR;
                return (
                  <span
                    key={`hook_seg_${segmentIndex}`}
                    style={{
                      color: palette.fill,
                      textShadow: hookOutlineShadow(outlinePx, palette.outline),
                    }}
                  >
                    {segment.text}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

/** クリップ切替の勢いを出す白フラッシュ(Sequence内の先頭2フレームのみ)。 */
const ClipFlash = () => {
  const localFrame = useCurrentFrame();
  const opacity = interpolate(localFrame, [0, 2], [0.55, 0], { extrapolateRight: "clamp" });
  if (opacity <= 0) return null;
  return <AbsoluteFill style={{ backgroundColor: "#FFFFFF", opacity }} />;
};

/**
 * フェーズV5(color_wipe): アクセント色の斜め帯が左→右へ抜けてクリップを転換する。
 * Sequence先頭(localFrame=0)で帯が画面全体を覆いカット点を隠し、抜けきると新クリップが見える。
 */
const ClipColorWipe = ({ color, durationInFrames }: { color: string; durationInFrames: number }) => {
  const localFrame = useCurrentFrame();
  const progress = interpolate(localFrame, [0, durationInFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  if (progress >= 1) return null;
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          top: "-25%",
          bottom: "-25%",
          width: "170%",
          // 開始時(-35%)は画面全体を覆う位置。progress=1で右へ完全に抜ける
          left: `${-35 + progress * 150}%`,
          transform: "skewX(-18deg)",
          backgroundColor: color,
        }}
      />
    </AbsoluteFill>
  );
};

/**
 * フェーズV5(cinema_bars): 上下黒帯+左上OPENINGラベル+右下クリップ番号。
 * クリップ番号は再生中クリップに追従して 01/02/03… と切り替わる(映画予告の型)。
 */
const CinemaBarsLayer = ({ clipLabel }: { clipLabel: string }) => {
  const { height, width } = useVideoConfig();
  const barHeight = Math.round(height * 0.11);
  const labelStyle: React.CSSProperties = {
    position: "absolute",
    fontFamily: OP_SUB_FONT_FAMILY,
    fontWeight: 700,
    color: "rgba(255,255,255,0.85)",
    letterSpacing: "0.35em",
    fontSize: Math.round(height * 0.024),
  };
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: barHeight, backgroundColor: "#000" }} />
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: barHeight, backgroundColor: "#000" }} />
      {/* ラベルは黒帯の中に収め、映像を邪魔しない */}
      <div style={{ ...labelStyle, top: Math.round(barHeight * 0.34), left: Math.round(width * 0.03) }}>OPENING</div>
      <div
        style={{
          ...labelStyle,
          bottom: Math.round(barHeight * 0.3),
          right: Math.round(width * 0.03),
          letterSpacing: "0.2em",
          fontSize: Math.round(height * 0.028),
        }}
      >
        {clipLabel}
      </div>
    </AbsoluteFill>
  );
};

/**
 * フェーズV5(neon_frame): 画面縁のネオンフレーム。U6のtelopGlowと同じ
 * 「多層シャドウで芯のある光」の考え方をboxShadowで再現する(filterより軽い)。
 */
const NeonFrameLayer = () => {
  const { height, width } = useVideoConfig();
  const inset = Math.round(Math.min(width, height) * 0.03);
  const borderWidth = Math.max(3, Math.round(height * 0.005));
  const glow = Math.round(height * 0.018);
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          top: inset,
          left: inset,
          right: inset,
          bottom: inset,
          border: `${borderWidth}px solid ${OP_NEON_COLOR}`,
          borderRadius: Math.round(height * 0.01),
          boxShadow: `0 0 ${glow}px ${OP_NEON_COLOR}, 0 0 ${glow * 2}px ${OP_NEON_COLOR}, inset 0 0 ${glow}px ${OP_NEON_COLOR}`,
        }}
      />
    </AbsoluteFill>
  );
};

/**
 * フェーズV5(color_wipe): 画面下部のブランド色バー(タイトル常駐)。
 * タイトルを終端被せにしない代わりに、OP中ずっと番組名を見せ続ける型。
 */
const ColorWipeBarLayer = ({ accentColor, title }: { accentColor: string; title: string }) => {
  const { height } = useVideoConfig();
  const barHeight = Math.round(height * OP_COLOR_WIPE_BAR_RATIO);
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: barHeight,
          backgroundColor: accentColor,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0px -4px 14px rgba(0,0,0,0.35)",
        }}
      >
        {/* W11-5: タイトル空文字なら文字は描かない(ブランド色バー自体は装飾として残す) */}
        {title && (
          <div
            style={{
              fontFamily: OP_TITLE_FONT_FAMILY,
              fontWeight: 900,
              color: "#FFFFFF",
              fontSize: Math.round(barHeight * 0.42),
              letterSpacing: "0.06em",
              whiteSpace: "nowrap",
              textShadow: "0px 2px 8px rgba(0,0,0,0.35)",
            }}
          >
            {title}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

/** フェーズV5(neon_frame): クリップ映像の素早いズームイン(1.28→1.0)。転換の勢い付け。 */
const zoomInTransform = (localFrame: number, durationInFrames: number): string | undefined => {
  const progress = interpolate(localFrame, [0, durationInFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  if (progress >= 1) return undefined;
  return `scale(${1.28 - 0.28 * progress})`;
};

/** クリップSequence内の転換演出(装飾ごとに分岐)。2本目以降のクリップ先頭で使う。 */
const ClipTransition = ({ decoration, accentColor }: { decoration: OpDecoration; accentColor: string }) => {
  const { fps } = useVideoConfig();
  if (decoration === "color_wipe") {
    return <ClipColorWipe color={accentColor} durationInFrames={opClipTransitionFrames(decoration, fps)} />;
  }
  // neon_frame のズームインは映像自体に掛けるため、ここでは何も描かない
  if (decoration === "neon_frame") return null;
  return <ClipFlash />;
};

/** クリップ映像ラッパー。neon_frameの高速ズームイン転換+フェーズWの常時ゆっくりズーム。 */
const ZoomableClipVideo = ({
  clip,
  decoration,
  withZoom,
  durationInFrames,
  videoFramingContext,
}: {
  clip: OpData["highlight_cuts"][number];
  decoration: OpDecoration;
  withZoom: boolean;
  /** クリップSequenceの長さ(ゆっくりズームの進行計算に使う)。 */
  durationInFrames: number;
  /** フェーズW9: 映像フレーミング(null=従来のcover描画)。 */
  videoFramingContext: OpVideoFramingContext | null;
}) => {
  const localFrame = useCurrentFrame();
  const { fps, width: canvasWidth, height: canvasHeight } = useVideoConfig();
  // 転換中はneon_frameの高速ズームイン、それ以外は予告編らしい常時ゆっくりズーム(1.0→1.06)
  const transform =
    (decoration === "neon_frame" && withZoom
      ? zoomInTransform(localFrame, opClipTransitionFrames(decoration, fps))
      : undefined) ?? `scale(${opClipSlowZoomScale(localFrame, durationInFrames).toFixed(4)})`;
  if (videoFramingContext) {
    // フェーズW9: 本編と同じ「クロップラッパー > フル映像(videoRect絶対配置)」構造。
    // ズーム転換のtransformはラッパー(フレーミングの外側)に掛ける
    const layout = videoFramingLayout({
      canvasWidth,
      canvasHeight,
      sourceWidth: videoFramingContext.sourceWidth > 0 ? videoFramingContext.sourceWidth : canvasWidth,
      sourceHeight: videoFramingContext.sourceHeight > 0 ? videoFramingContext.sourceHeight : canvasHeight,
      framing: videoFramingContext.framing,
    });
    return (
      <AbsoluteFill style={{ transform, transformOrigin: "center center" }}>
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
            src={resolveVideoSrc(clip.file_path)}
            startFrom={Math.round((clip.start_ms / 1000) * fps)}
            style={{
              position: "absolute",
              left: layout.videoRect.left - layout.cropRect.left,
              top: layout.videoRect.top - layout.cropRect.top,
              width: layout.videoRect.width,
              height: layout.videoRect.height,
            }}
          />
        </div>
      </AbsoluteFill>
    );
  }
  return (
    <OffthreadVideo
      src={resolveVideoSrc(clip.file_path)}
      startFrom={Math.round((clip.start_ms / 1000) * fps)}
      style={{ width: "100%", height: "100%", objectFit: "cover", transform }}
    />
  );
};

const HighlightTeaserOp = ({
  op,
  sfxVolume,
  telopContext,
  videoFramingContext,
}: {
  op: OpData;
  sfxVolume: number;
  telopContext: OpTelopContext;
  videoFramingContext: OpVideoFramingContext | null;
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const totalFrames = Math.max(1, Math.round((op.duration_ms / 1000) * fps));
  const clips = opTeaserClipFrames(op.highlight_cuts, fps);
  const titleFrame = opTeaserTitleFrame(totalFrames, fps);
  const title = stampTransform(frame, titleFrame, fps);
  const decoration = op.decoration;
  // color_wipe はタイトルがバー常駐のため終端被せを描かない(二重表示を避ける)。
  // W11-5: タイトル空文字(未生成・「表示しない」)は終端被せ(暗幕+タイトル)自体を出さない
  const showEndTitle = Boolean(op.title) && opDecorationHasEndTitle(decoration) && frame >= titleFrame;
  // cinema_bars のクリップ番号: 再生中クリップに追従(見つからない=終端は最後の番号を維持)
  const activeClipIndex = (() => {
    for (let i = clips.length - 1; i >= 0; i -= 1) {
      if (frame >= clips[i].from) return i;
    }
    return 0;
  })();

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {clips.map(({ clip, from, durationInFrames }, index) => {
        const telopTiming = opClipTelopTiming(durationInFrames, fps);
        const showHook = clip.display === "hook" && opHookLines(clip.hook_text).length > 0;
        return (
          <Sequence durationInFrames={durationInFrames} from={from} key={`op_clip_${index}`}>
            <AbsoluteFill>
              <ZoomableClipVideo
                clip={clip}
                decoration={decoration}
                durationInFrames={durationInFrames}
                withZoom={index > 0}
                videoFramingContext={videoFramingContext}
              />
              {index > 0 && <ClipTransition accentColor={op.accent_color} decoration={decoration} />}
              {/* フェーズW: display=hook はフックワード(凝縮ワードの極太表示)を出す */}
              {showHook && (
                <HookWordLayer
                  hookText={clip.hook_text}
                  keyword={clip.keyword}
                  keywordColor={clip.keyword_color}
                />
              )}
              {/* フェーズV2: display=verbatim は従来どおり発話テロップを表示。描画・位置・
                  スタイル解決は本編と同じ Telop を流用する(明示start/end+animation_in個別
                  上書きで制御)。フェーズV5: 登場アニメは op.text_animation(全クリップ共通) */}
              {!showHook && clip.text && (
                <Telop
                  animationIn={op.text_animation}
                  animationOut="none"
                  cutStartFrame={from}
                  defaultStyleName={telopContext.defaultStyleName}
                  fontSize={telopContext.fontSize}
                  fps={fps}
                  maxCharsPerLine={telopContext.maxCharsPerLine}
                  styles={telopContext.styles}
                  telopY={telopContext.telopY}
                  telops={[
                    {
                      id: `op_clip_telop_${index}`,
                      text: clip.text,
                      word_indices: [],
                      segments: [{ text: clip.text, word_indices: [] }],
                      start: telopTiming.startFrame / fps,
                      end: telopTiming.endFrame / fps,
                      style: clip.style || undefined,
                      animation_in: op.text_animation,
                      animation_out: "none",
                      sfx: null,
                    },
                  ]}
                  words={[]}
                />
              )}
            </AbsoluteFill>
          </Sequence>
        );
      })}
      {/* フェーズV5: 装飾レイヤー(クリップの上・タイトルの下に常駐) */}
      {decoration === "cinema_bars" && (
        <CinemaBarsLayer clipLabel={String(activeClipIndex + 1).padStart(2, "0")} />
      )}
      {decoration === "color_wipe" && <ColorWipeBarLayer accentColor={op.accent_color} title={op.title} />}
      {decoration === "neon_frame" && <NeonFrameLayer />}
      {/* タイトル被せ: 暗幕+白極太(最後の約1.4秒。=キメ音)。color_wipe はバー常駐のため無し */}
      {showEndTitle && (
        <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
          <AbsoluteFill style={{ backgroundColor: "rgba(0,0,0,0.55)", opacity: title.opacity }} />
          <div
            style={{
              opacity: title.opacity,
              transform: title.transform,
              fontFamily: OP_TITLE_FONT_FAMILY,
              fontSize: Math.round(height * 0.095),
              fontWeight: 900,
              color: "#FFFFFF",
              letterSpacing: "0.04em",
              lineHeight: 1.25,
              textAlign: "center",
              maxWidth: width * 0.86,
              textShadow: "0px 6px 18px rgba(0,0,0,0.6)",
              borderBottom: `${Math.max(3, Math.round(height * 0.008))}px solid ${OP_ACCENT_YELLOW}`,
              paddingBottom: Math.round(height * 0.015),
            }}
          >
            {op.title}
          </div>
        </AbsoluteFill>
      )}
      <OpSfx fps={fps} frame={titleFrame} sfxId={op.sfx_hit} volume={sfxVolume} />
    </AbsoluteFill>
  );
};

const QuestionHookOp = ({ op, sfxVolume }: { op: OpData; sfxVolume: number }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const totalFrames = Math.max(1, Math.round((op.duration_ms / 1000) * fps));
  const phases = opQuestionHookPhases(totalFrames, fps);

  const questionOpacity = fadeOpacity(frame, phases.catchFrame, Math.round(fps * 0.5));
  const title = stampTransform(frame, phases.titleFrame, fps);

  return (
    <AbsoluteFill
      style={{
        // 「黒85%の暗背景」: 完全な黒より少し浮かせたダークグラデで問いに集中させる
        background: "radial-gradient(ellipse at center, #1B1E26 0%, #0A0B0E 100%)",
      }}
    >
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <div
          style={{
            opacity: questionOpacity,
            fontFamily: OP_SUB_FONT_FAMILY,
            fontSize: Math.round(height * 0.062),
            fontWeight: 700,
            color: "#FFFFFF",
            letterSpacing: "0.08em",
            lineHeight: 1.6,
            textAlign: "center",
            maxWidth: width * 0.82,
            whiteSpace: "pre-wrap",
          }}
        >
          {op.catch_copy}
        </div>
        {op.title && (
          <div
            style={{
              opacity: title.opacity,
              transform: title.transform,
              marginTop: Math.round(height * 0.06),
              fontFamily: OP_TITLE_FONT_FAMILY,
              fontSize: Math.round(height * 0.075),
              fontWeight: 900,
              color: OP_ACCENT_YELLOW,
              letterSpacing: "0.05em",
              lineHeight: 1.3,
              textAlign: "center",
              maxWidth: width * 0.86,
              textShadow: "0px 5px 16px rgba(0,0,0,0.6)",
            }}
          >
            {op.title}
          </div>
        )}
      </AbsoluteFill>
      <OutroFade fromFrame={phases.fadeOutFrame} totalFrames={totalFrames} />
      <OpSfx fps={fps} frame={phases.titleFrame} sfxId={op.sfx_hit} volume={sfxVolume} />
      <OpSfx fps={fps} frame={phases.fadeOutFrame} sfxId={op.sfx_transition} volume={sfxVolume} />
    </AbsoluteFill>
  );
};

// =============================================================================
// コンポーネント
// =============================================================================

export const OpSequence = ({
  op,
  sfxVolume,
  telopContext,
  videoFramingContext = null,
}: {
  op: OpData;
  sfxVolume: number;
  /** フェーズV2: highlight_teaser のクリップ内テロップ描画に使う(本編と共有)。 */
  telopContext: OpTelopContext;
  /** フェーズW9: ハイライトクリップ映像へ適用する映像フレーミング(null=従来のcover)。 */
  videoFramingContext?: OpVideoFramingContext | null;
}) => {
  switch (op.pattern) {
    case "title_card":
      return <TitleCardOp op={op} sfxVolume={sfxVolume} />;
    case "highlight_teaser":
      return (
        <HighlightTeaserOp
          op={op}
          sfxVolume={sfxVolume}
          telopContext={telopContext}
          videoFramingContext={videoFramingContext}
        />
      );
    case "question_hook":
      return <QuestionHookOp op={op} sfxVolume={sfxVolume} />;
  }
};
