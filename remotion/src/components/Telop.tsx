/**
 * テロップコンポーネント (プリセット駆動・多層 stroke 方式)
 *
 * - 描画スタイルは props.styles (preset 辞書) と props.defaultStyleName で受け取る
 *   (将来 GUI から composition.json を編集して即反映できる構造)
 * - 各 TelopData は style?: string で preset 名を指定し、未指定なら default
 *   (style_override?: TelopStyle で個別オーバーライドも可能)
 *
 * SOT: composition.json
 *   timeline.telop_styles = { default: {...}, highlight: {...}, ... }
 *   timeline.default_telop_style = "default"
 *   voice_data.cuts[].telops[].style = preset 名 (省略時 default)
 *   voice_data.cuts[].telops[].style_override = TelopStyle 完全定義 (preset を上書き)
 */
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

import { DEFAULT_HIGHLIGHT_COLOR, splitHighlightRuns } from "../lib/telopHighlight";
import { clampTelopYPercent, computeTelopBlockLayout, TELOP_LINE_GAP_PX } from "../lib/telopLayout";
import {
  resolveTelopAnimation,
  type TelopAnimationIn,
  type TelopAnimationOut,
} from "../lib/telopAnimation";

// =============================================================================
// 型定義
// =============================================================================

interface VoiceWord {
  text: string;
  start: number;
  end: number;
}

interface TelopSegment {
  text: string;
  word_indices: number[];
}

export interface TelopStyle {
  font_family?: string;
  font_size?: number;
  font_weight?: number;
  letter_spacing?: string;
  line_height?: number;
  fill: {
    type: "solid" | "gradient";
    color?: string;
    gradient_from?: string;
    gradient_to?: string;
    gradient_direction?: "vertical" | "horizontal" | "diagonal";
  };
  inner_stroke?: { color: string; width: number } | null;
  outer_stroke?: { color: string; width: number } | null;
  drop_shadow?: string | null;
  /**
   * フェーズT2.5-2(縁取りデザイン刷新): ハードなオフセット影。縁レイヤーの下に
   * (x, y) pxずらした影レイヤーを描画する(CSS filterのdrop_shadowとは別物。
   * 「細い縁+オフセットシャドウ」の商用テロップ定番表現に使う)。
   * x/y はプリセット font_size 基準のpx値で、実フォントサイズに比例スケールされる。
   */
  shadow_offset?: { x: number; y: number; color: string } | null;
  y_position_offset?: number;
  /**
   * テーマ×感情の自動スタイリング(T-1/T-5)向けの最小拡張。
   * 疑問系スタイル等の下線表現。省略時は下線なし。
   */
  underline?: boolean;
  /**
   * テーマ×感情の自動スタイリング(T-1/T-5)向けの最小拡張。
   * 背景帯(色・角丸、行ごとにpadding付きで塗る)。null/省略時は背景帯なし。
   * borderRadiusは改善7-4(プリセットギャラリー「半透明角丸」背景)向けの追加拡張。
   *
   * フェーズT1-2(背景ボックス): padding_x / padding_y (px) を指定すると「行ごとの帯」ではなく
   * 文字ブロック全体の背後に1枚のベタ長方形を描画する(box_yellow / box_red / cta_yellow。
   * 参考画像06/12/13)。未指定なら従来の行ごと帯背景のまま(後方互換)。
   */
  background?: {
    color: string;
    borderRadius?: string;
    padding_x?: number;
    padding_y?: number;
    border_radius?: number;
  } | null;
  /**
   * フェーズT1-2(部分ハイライト A-emph): telops[].highlight_words に含まれる部分文字列の
   * 塗り色。省略時は DEFAULT_HIGHLIGHT_COLOR (#E7305B)。縁取り・サイズは変えない。
   */
  highlight_color?: string;
  /**
   * フェーズT3: プリセット単位の登場アニメーション
   * ("pop_big" | "slide_left" | "slide_up" | "zoom" | "stamp" | "fade" | "none")。
   * 省略時は timeline.animation_in(従来のグローバル設定)にフォールバック(後方互換)。
   */
  animation_in?: string | null;
  /** フェーズT3: プリセット単位の退場アニメーション("fade" | "pop_out" | "none")。 */
  animation_out?: string | null;
  /** フェーズT3: 登場アニメの長さ(フレーム数。省略時は既定12)。 */
  animation_duration_frames?: number;
  /** フェーズT3: 登場時効果音ID(assets/sfx/。null/省略で鳴らさない。再生はComposition側)。 */
  sfx?: string | null;
}

interface TelopData {
  id: string;
  text: string;
  word_indices: number[];
  segments: TelopSegment[];
  start?: number;
  end?: number;
  style?: string;
  style_override?: Partial<TelopStyle>;
  /**
   * フェーズT1-2(部分ハイライト A-emph): テロップ文言中の該当部分文字列だけ塗り色を
   * style.highlight_color に変える(複数語・複数出現対応)。省略時はハイライトなし。
   */
  highlight_words?: string[];
  /**
   * フェーズT3: テロップ個別の登場アニメーション上書き(UIピッカー or type→マッピング既定を
   * step08 が書き込む)。プリセット既定・timeline既定より優先される。
   */
  animation_in?: string | null;
  /** フェーズT3: テロップ個別の退場アニメーション上書き。 */
  animation_out?: string | null;
  /** フェーズT3: 効果音の個別指定(文字列=ID / null="鳴らさない"明示。再生はComposition側)。 */
  sfx?: string | null;
}

interface TelopProps {
  telops: TelopData[];
  words: VoiceWord[];
  cutStartFrame: number;
  fps: number;
  /** timeline.animation_in(従来のグローバル既定。旧名 popIn/fadeIn も受ける)。 */
  animationIn: string;
  /** timeline.animation_out(旧名 popOut/fadeOut も受ける)。 */
  animationOut: string;
  telopY?: number;
  fontSize?: number;
  styles: Record<string, TelopStyle>;
  defaultStyleName?: string;
  /**
   * 改善20-B: 1行の文字数バジェット(composition.json timeline.telop_max_chars_per_line)。
   * 手編集等でバジェットを超えた行はCSS任せにせず wrapTelopLine の語境界で折り返す
   * (プレビュー側 PreviewPlayer と同じロジック・同じ折返し位置)。未指定なら折返しなし。
   */
  maxCharsPerLine?: number;
}

// =============================================================================
// フォントとフォールバック
// =============================================================================

const DEFAULT_FONT_FAMILY =
  '"Zen Kaku Gothic Antique", "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Meiryo", sans-serif';

const FALLBACK_STYLE: TelopStyle = {
  font_family: DEFAULT_FONT_FAMILY,
  font_size: 52,
  font_weight: 900,
  letter_spacing: "0.02em",
  line_height: 1.4,
  fill: { type: "solid", color: "#FFFFFF" },
  inner_stroke: { color: "#000000", width: 8 },
  outer_stroke: null,
  drop_shadow: "drop-shadow(0px 4px 6px rgba(0,0,0,0.4))",
  y_position_offset: 0,
};

const resolveStyle = (
  telop: TelopData,
  styles: Record<string, TelopStyle>,
  defaultStyleName: string,
): TelopStyle => {
  const styleName = telop.style ?? defaultStyleName;
  const base = styles[styleName] ?? styles[defaultStyleName] ?? FALLBACK_STYLE;
  if (telop.style_override) {
    return { ...base, ...telop.style_override, fill: telop.style_override.fill ?? base.fill };
  }
  return base;
};

const gradientCss = (style: TelopStyle): string => {
  const { fill } = style;
  if (fill.type === "solid") return "";
  const from = fill.gradient_from ?? "#FFFFFF";
  const to = fill.gradient_to ?? "#000000";
  const dir = fill.gradient_direction ?? "vertical";
  const angle = dir === "vertical" ? "180deg" : dir === "horizontal" ? "90deg" : "135deg";
  return `linear-gradient(${angle}, ${from} 0%, ${to} 100%)`;
};

// =============================================================================
// アニメーション (Remotion spring ベース。種類の解決は lib/telopAnimation.ts)
// =============================================================================

const OUT_DURATION = 6;

/** pop_big / slide 系の移動量計算に使う画面コンテキスト。 */
type AnimContext = {
  /** テロップ定位置から画面中央までの縦距離(px。pop_bigの出現位置)。 */
  centerOffsetYPx: number;
  /** slide_left の横移動距離(px)。 */
  slideDistancePx: number;
};

const getInAnim = (
  frame: number,
  startFrame: number,
  type: TelopAnimationIn,
  fps: number,
  durationFrames: number,
  ctx: AnimContext,
): { opacity: number; transform: string } => {
  const localFrame = frame - startFrame;
  if (type === "none" || localFrame < 0) return { opacity: 1, transform: "" };

  if (type === "pop_big") {
    // 画面中央に大きく(scale 1.8)バッと出て、定位置へ縮みながら移動する(強調・煽り系)
    const progress = spring({
      frame: localFrame,
      fps,
      config: { damping: 13, stiffness: 160 },
      durationInFrames: durationFrames,
    });
    const scale = interpolate(progress, [0, 1], [1.8, 1]);
    const translateY = ctx.centerOffsetYPx * (1 - progress);
    return {
      opacity: Math.min(1, localFrame / 2),
      transform: `translateY(${translateY}px) scale(${scale})`,
    };
  }

  if (type === "slide_left") {
    // 左からスライドイン+フェード(名言・辛辣系)
    const progress = spring({
      frame: localFrame,
      fps,
      config: { damping: 200 },
      durationInFrames: durationFrames,
    });
    const translateX = -ctx.slideDistancePx * (1 - progress);
    return { opacity: progress, transform: `translateX(${translateX}px)` };
  }

  if (type === "slide_up") {
    // 下から浮き上がる(質問系)
    const progress = spring({
      frame: localFrame,
      fps,
      config: { damping: 200 },
      durationInFrames: durationFrames,
    });
    const translateY = 56 * (1 - progress);
    return { opacity: progress, transform: `translateY(${translateY}px)` };
  }

  if (type === "zoom") {
    // その場でズームイン(要点・オチ・CTA)
    const progress = spring({
      frame: localFrame,
      fps,
      config: { damping: 11, stiffness: 190 },
      durationInFrames: durationFrames,
    });
    const scale = interpolate(progress, [0, 1], [0.55, 1]);
    return { opacity: Math.min(1, localFrame / 2), transform: `scale(${scale})` };
  }

  if (type === "stamp") {
    const progress = spring({ frame: localFrame, fps, config: { damping: 8, stiffness: 300 } });
    const scale = interpolate(progress, [0, 1], [2.5, 1]);
    return { opacity: Math.min(1, progress * 3), transform: `scale(${scale})` };
  }

  if (type === "fade") {
    const opacity = interpolate(localFrame, [0, durationFrames], [0, 1], { extrapolateRight: "clamp" });
    return { opacity, transform: "" };
  }

  return { opacity: 1, transform: "" };
};

const getOutAnim = (
  framesUntilEnd: number,
  type: TelopAnimationOut,
): { opacity: number; scale: number } => {
  if (type === "none") return { opacity: 1, scale: 1 };
  const progress = Math.min(1, framesUntilEnd / OUT_DURATION);

  if (type === "pop_out") {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    const eased = progress < 1 ? 1 + c3 * (progress - 1) ** 3 + c1 * (progress - 1) ** 2 : 1;
    return {
      opacity: interpolate(progress, [0, 0.3], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
      scale: eased,
    };
  }

  if (type === "fade") return { opacity: progress, scale: 1 };
  return { opacity: 1, scale: 1 };
};

// =============================================================================
// 単一テロップ描画 (style 反映)
// =============================================================================

/**
 * フェーズT1-2(背景ボックス): padding_x/padding_y 指定時は文字ブロック全体の背後に
 * 1枚のベタ長方形を描く。未指定の background は従来通り「行ごとの帯」(後方互換)。
 */
const resolveBlockBackground = (style: TelopStyle) =>
  style.background &&
  (style.background.padding_x !== undefined || style.background.padding_y !== undefined)
    ? style.background
    : null;

const TelopLayer = ({
  lineTexts,
  fontSize,
  style,
  opacity,
  transform,
  highlightWords,
}: {
  /**
   * フェーズT2.5-1(多層縁の行ズレ根絶): 折返しは親(computeTelopBlockLayout)で1回だけ
   * 計算済み。縁取り(outer/inner)・影・塗りの全レイヤーがこの同じ行配列を描画する。
   */
  lineTexts: string[];
  /** 幅フィット適用後のフォントサイズ(親で計算済み)。 */
  fontSize: number;
  style: TelopStyle;
  opacity: number;
  transform: string;
  highlightWords?: string[];
}) => {
  const fontWeight = (style.font_weight ?? 900) as React.CSSProperties["fontWeight"];
  const letterSpacing = style.letter_spacing ?? "0.02em";
  const lineHeight = style.line_height ?? 1.4;
  const fontFamily = style.font_family ?? DEFAULT_FONT_FAMILY;

  const blockBackground = resolveBlockBackground(style);
  const lineBandBackground = blockBackground ? null : style.background;

  // フェーズT1-2(部分ハイライト): 塗り潰しレイヤーの該当部分文字列だけ色を変える。
  // 縁取りレイヤーは従来通り行全文を描くため、縁取り・サイズは変わらない。
  const highlightColor = style.highlight_color ?? DEFAULT_HIGHLIGHT_COLOR;
  const renderFillLine = (lineText: string): React.ReactNode => {
    const runs = splitHighlightRuns(lineText, highlightWords);
    if (!runs.some((run) => run.highlight)) return lineText;
    return runs.map((run, runIdx) =>
      run.highlight ? (
        <span
          key={runIdx}
          style={{ color: highlightColor, WebkitTextFillColor: highlightColor }}
        >
          {run.text}
        </span>
      ) : (
        <span key={runIdx}>{run.text}</span>
      ),
    );
  };

  const innerStrokeWidth = style.inner_stroke
    ? Math.round(style.inner_stroke.width * (fontSize / 52))
    : 0;
  const outerStrokeWidth = style.outer_stroke
    ? Math.round(style.outer_stroke.width * (fontSize / 52))
    : 0;
  // フェーズT2.5-2(オフセット影): 影のずらし量はプリセット font_size 基準の値を
  // 実フォントサイズに比例スケールする(縁取り幅と同じ規則)。影の輪郭は最も外側の
  // 縁と同じシルエット(同じstroke幅)で描く。
  const shadowOffset = style.shadow_offset ?? null;
  const shadowScale = fontSize / (style.font_size ?? 52);
  const shadowStrokeWidth = Math.max(outerStrokeWidth, innerStrokeWidth);

  // フェーズT2.5-1(多層縁の行ズレ根絶): 折返しはlineTextsで確定済みのため、
  // CSSの再折返し(pre-wrap)を禁止する(WebkitTextStroke幅差による行数食い違いを構造的に排除)。
  const textStyle: React.CSSProperties = {
    fontFamily,
    fontSize,
    fontWeight,
    letterSpacing,
    lineHeight,
    textAlign: "center",
    whiteSpace: "nowrap",
  };

  // 下線(underline)は塗り潰しレイヤーにのみ適用する(縁取りレイヤーは文字色が透明なため、
  // 共通のtextStyleに混ぜると下線の色も透明になり二重線に見えてしまうのを避けるため)。
  const fillStyle: React.CSSProperties =
    style.fill.type === "solid"
      ? { color: style.fill.color ?? "#FFFFFF", textDecoration: style.underline ? "underline" : undefined }
      : {
          color: "transparent",
          backgroundImage: gradientCss(style),
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
        };

  return (
    <div
      style={{
        opacity,
        transform,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: blockBackground ? 0 : 8,
        filter: style.drop_shadow ?? undefined,
        // ブロック背景: 文字ブロック全体の背後に1枚のベタ長方形を描画する(参考画像06/12/13)
        backgroundColor: blockBackground?.color,
        padding: blockBackground
          ? `${blockBackground.padding_y ?? 0}px ${blockBackground.padding_x ?? 0}px`
          : undefined,
        borderRadius: blockBackground?.border_radius,
      }}
    >
      {lineTexts.map((lineText, lineIdx) => (
        <div
          key={lineIdx}
          style={{
            position: "relative",
            display: "inline-block",
            backgroundColor: lineBandBackground?.color,
            padding: lineBandBackground ? "0.15em 0.5em" : undefined,
            borderRadius: lineBandBackground?.borderRadius,
          }}
        >
          {shadowOffset && (
            <div
              style={{
                ...textStyle,
                color: shadowOffset.color,
                WebkitTextStroke: shadowStrokeWidth
                  ? `${shadowStrokeWidth}px ${shadowOffset.color}`
                  : undefined,
                position: "absolute",
                inset: 0,
                transform: `translate(${shadowOffset.x * shadowScale}px, ${shadowOffset.y * shadowScale}px)`,
              }}
            >
              {lineText}
            </div>
          )}
          {style.outer_stroke && (
            <div
              style={{
                ...textStyle,
                color: "transparent",
                WebkitTextStroke: `${outerStrokeWidth}px ${style.outer_stroke.color}`,
              }}
            >
              {lineText}
            </div>
          )}
          {style.inner_stroke && (
            <div
              style={{
                ...textStyle,
                color: "transparent",
                WebkitTextStroke: `${innerStrokeWidth}px ${style.inner_stroke.color}`,
                position: style.outer_stroke ? "absolute" : "relative",
                inset: 0,
              }}
            >
              {lineText}
            </div>
          )}
          <div
            style={{
              ...textStyle,
              ...fillStyle,
              position: style.outer_stroke || style.inner_stroke ? "absolute" : "relative",
              inset: 0,
            }}
          >
            {renderFillLine(lineText)}
          </div>
        </div>
      ))}
    </div>
  );
};

// =============================================================================
// コンポーネント
// =============================================================================

export const Telop = ({
  telops,
  words,
  fps,
  animationIn,
  animationOut,
  telopY = 0.5,
  fontSize,
  styles,
  defaultStyleName = "default",
  maxCharsPerLine,
}: TelopProps) => {
  const frame = useCurrentFrame();
  const { width: videoWidth, height: videoHeight } = useVideoConfig();
  const globalFontSize = fontSize ?? 52;

  const rawTimings = telops
    .map((telop) => {
      if (typeof telop.start === "number" && typeof telop.end === "number" && telop.end > telop.start) {
        return {
          telop,
          startFrame: Math.round(telop.start * fps),
          endFrame: Math.round(telop.end * fps),
          segments: telop.segments,
          style: resolveStyle(telop, styles, defaultStyleName),
        };
      }
      const indices = telop.word_indices;
      if (indices.length === 0) return null;
      const firstIdx = Math.min(...indices);
      const lastIdx = Math.max(...indices);
      const startWord = words[firstIdx];
      const endWord = words[lastIdx];
      if (!startWord || !endWord) return null;
      return {
        telop,
        startFrame: Math.round(startWord.start * fps),
        endFrame: Math.round(endWord.end * fps),
        segments: telop.segments,
        style: resolveStyle(telop, styles, defaultStyleName),
      };
    })
    .filter(Boolean) as Array<{
      telop: TelopData;
      startFrame: number;
      endFrame: number;
      segments: TelopSegment[];
      style: TelopStyle;
    }>;

  const telopTimings = rawTimings.map((t, i) => {
    const isLast = i === rawTimings.length - 1;
    const displayEnd = isLast ? t.endFrame : rawTimings[i + 1].startFrame;
    return { ...t, displayEnd };
  });

  return (
    <AbsoluteFill>
      {telopTimings.map((timing) => {
        const { telop, startFrame, displayEnd, segments, style } = timing;
        const isLast = timing === telopTimings[telopTimings.length - 1];

        const isVisible = isLast
          ? frame >= startFrame && frame <= displayEnd
          : frame >= startFrame && frame < displayEnd;
        if (!isVisible) return null;

        // フェーズT2.5-1(はみ出し根絶): 折返し(最大2行)と幅フィットをここで1回だけ確定し、
        // TelopLayerの全レイヤー(影・縁取り・塗り)は同じ行配列・同じフォントサイズを使う。
        const blockBackground = resolveBlockBackground(style);
        const baseFontSize = style.font_size ?? globalFontSize;
        const letterSpacingEm = Number.parseFloat(style.letter_spacing ?? "0.02em") || 0;
        const layout = computeTelopBlockLayout({
          segmentTexts: segments.map((segment) => segment.text),
          maxCharsPerLine,
          baseFontSize,
          letterSpacingEm,
          fitWidth:
            videoWidth * 0.92 - (blockBackground ? (blockBackground.padding_x ?? 0) * 2 : 0),
        });

        // 縦方向: y_position_offset 適用後もブロック全体が上下セーフエリア内に収まるようクランプする
        const yPercent = clampTelopYPercent({
          telopY,
          yOffset: style.y_position_offset ?? 0,
          lineCount: layout.lineTexts.length,
          lineHeight: style.line_height ?? 1.4,
          fontSize: layout.fontSize,
          videoHeight,
          lineGapPx: blockBackground ? 0 : TELOP_LINE_GAP_PX,
          blockPaddingY: blockBackground ? (blockBackground.padding_y ?? 0) : 0,
        });

        // フェーズT3: アニメの解決(telop個別 > プリセット既定 > timeline既定 > none)
        const anim = resolveTelopAnimation({
          telopAnimationIn: telop.animation_in,
          telopAnimationOut: telop.animation_out,
          styleAnimationIn: style.animation_in,
          styleAnimationOut: style.animation_out,
          styleDurationFrames: style.animation_duration_frames,
          timelineAnimationIn: animationIn,
          timelineAnimationOut: animationOut,
        });
        const inAnim = getInAnim(frame, startFrame, anim.animationIn, fps, anim.durationFrames, {
          // pop_big: 画面中央(50%)から定位置(yPercent)への縦移動距離
          centerOffsetYPx: ((50 - yPercent) / 100) * videoHeight,
          slideDistancePx: videoWidth * 0.18,
        });
        const outAnim = getOutAnim(displayEnd - frame, anim.animationOut);
        const opacity = inAnim.opacity * outAnim.opacity;
        const transform = `${inAnim.transform}${outAnim.scale !== 1 ? ` scale(${outAnim.scale})` : ""}`;

        return (
          <div
            key={telop.id}
            style={{
              position: "absolute",
              top: `${yPercent}%`,
              left: 0,
              right: 0,
              transform: "translateY(-50%)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
            }}
          >
            <TelopLayer
              lineTexts={layout.lineTexts}
              fontSize={layout.fontSize}
              style={style}
              opacity={opacity}
              transform={transform}
              highlightWords={telop.highlight_words}
            />
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
