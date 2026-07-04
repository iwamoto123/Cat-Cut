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

// =============================================================================
// 型定義
// =============================================================================

type TelopAnimationIn = "stamp" | "popIn" | "fadeIn" | "none";
type TelopAnimationOut = "popOut" | "fadeOut" | "none";

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
   */
  background?: { color: string; borderRadius?: string } | null;
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
}

interface TelopProps {
  telops: TelopData[];
  words: VoiceWord[];
  cutStartFrame: number;
  fps: number;
  animationIn: TelopAnimationIn;
  animationOut: TelopAnimationOut;
  telopY?: number;
  fontSize?: number;
  styles: Record<string, TelopStyle>;
  defaultStyleName?: string;
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
// アニメーション (Remotion spring ベース)
// =============================================================================

const OUT_DURATION = 6;

const getInAnim = (
  frame: number,
  startFrame: number,
  type: TelopAnimationIn,
  fps: number,
): { opacity: number; transform: string } => {
  const localFrame = frame - startFrame;
  if (type === "none" || localFrame < 0) return { opacity: 1, transform: "" };

  if (type === "stamp") {
    const progress = spring({ frame: localFrame, fps, config: { damping: 8, stiffness: 300 } });
    const scale = interpolate(progress, [0, 1], [2.5, 1]);
    return { opacity: Math.min(1, progress * 3), transform: `scale(${scale})` };
  }

  if (type === "popIn") {
    const progress = spring({ frame: localFrame, fps, config: { damping: 10, stiffness: 200 } });
    return { opacity: progress, transform: `scale(${interpolate(progress, [0, 1], [0, 1])})` };
  }

  if (type === "fadeIn") {
    const opacity = interpolate(localFrame, [0, 10], [0, 1], { extrapolateRight: "clamp" });
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

  if (type === "popOut") {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    const eased = progress < 1 ? 1 + c3 * (progress - 1) ** 3 + c1 * (progress - 1) ** 2 : 1;
    return {
      opacity: interpolate(progress, [0, 0.3], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
      scale: eased,
    };
  }

  if (type === "fadeOut") return { opacity: progress, scale: 1 };
  return { opacity: 1, scale: 1 };
};

// =============================================================================
// 単一テロップ描画 (style 反映)
// =============================================================================

const TelopLayer = ({
  segments,
  style,
  globalFontSize,
  opacity,
  transform,
  videoWidth,
}: {
  segments: TelopSegment[];
  style: TelopStyle;
  globalFontSize: number;
  opacity: number;
  transform: string;
  videoWidth: number;
}) => {
  const baseFontSize = style.font_size ?? globalFontSize;
  const fontWeight = (style.font_weight ?? 900) as React.CSSProperties["fontWeight"];
  const letterSpacing = style.letter_spacing ?? "0.02em";
  const lineHeight = style.line_height ?? 1.4;
  const fontFamily = style.font_family ?? DEFAULT_FONT_FAMILY;

  // 幅フィット: 最長行が動画幅の92%(縁取り・背景padding込み)に収まるよう縮小する。
  // 全角=1em・半角=0.55em の概算幅。プリセットのpx指定は「十分な幅がある時の上限」として扱う。
  const maxLineEm = Math.max(
    1,
    ...segments.map((segment) =>
      [...segment.text].reduce((acc, ch) => acc + (ch.charCodeAt(0) <= 0xff ? 0.55 : 1), 0),
    ),
  );
  const spacingEm = Number.parseFloat(letterSpacing) || 0;
  const fitFontSize = (videoWidth * 0.92) / (maxLineEm * (1 + spacingEm) + 0.6);
  const fontSize = Math.min(baseFontSize, fitFontSize);

  const innerStrokeWidth = style.inner_stroke
    ? Math.round(style.inner_stroke.width * (fontSize / 52))
    : 0;
  const outerStrokeWidth = style.outer_stroke
    ? Math.round(style.outer_stroke.width * (fontSize / 52))
    : 0;

  const textStyle: React.CSSProperties = {
    fontFamily,
    fontSize,
    fontWeight,
    letterSpacing,
    lineHeight,
    textAlign: "center",
    whiteSpace: "pre-wrap",
    wordBreak: "keep-all",
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
        gap: 8,
        filter: style.drop_shadow ?? undefined,
      }}
    >
      {segments.map((segment, segIdx) => (
        <div
          key={segIdx}
          style={{
            position: "relative",
            display: "inline-block",
            backgroundColor: style.background?.color,
            padding: style.background ? "0.15em 0.5em" : undefined,
            borderRadius: style.background?.borderRadius,
          }}
        >
          {style.outer_stroke && (
            <div
              style={{
                ...textStyle,
                color: "transparent",
                WebkitTextStroke: `${outerStrokeWidth}px ${style.outer_stroke.color}`,
              }}
            >
              {segment.text}
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
              {segment.text}
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
            {segment.text}
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
}: TelopProps) => {
  const frame = useCurrentFrame();
  const { width: videoWidth } = useVideoConfig();
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

        const inAnim = getInAnim(frame, startFrame, animationIn, fps);
        const outAnim = getOutAnim(displayEnd - frame, animationOut);
        const opacity = inAnim.opacity * outAnim.opacity;
        const transform = `${inAnim.transform}${outAnim.scale !== 1 ? ` scale(${outAnim.scale})` : ""}`;

        const yOffset = style.y_position_offset ?? 0;
        const yPercent = (telopY + yOffset) * 100;

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
              segments={segments}
              style={style}
              globalFontSize={globalFontSize}
              opacity={opacity}
              transform={transform}
              videoWidth={videoWidth}
            />
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
