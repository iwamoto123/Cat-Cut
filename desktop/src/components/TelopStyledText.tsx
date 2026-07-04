import type { CSSProperties } from "react";
import { scaleTelopDropShadow, scaleTelopStrokeWidth, type TelopStyleDef } from "../lib/telopThemes";

type TelopStyledTextProps = {
  /** 表示行(1〜2行。改善8-B-4のフォントサイズクランプ/2行折り返しの結果をそのまま渡す)。 */
  lines: string[];
  style: TelopStyleDef;
  /** 実際に表示するフォントサイズ(px)。改善8-B-4のクランプ後の値。 */
  fontSizePx: number;
};

/**
 * 改善8-B-4(プレビューのテロップ描画をプリセット忠実に): Remotion側の実装
 * (`remotion/src/components/Telop.tsx`のTelopLayer)と可能な限り同じDOM構造・CSSプロパティを
 * 使って、プリセットの多重縁取り(外縁→内縁→塗り)とグラデ塗りを再現する。
 * プレビュー(Electronのレンダラー = Chromium)と実際の書き出し(Remotion = 同じくChromium系の
 * ヘッドレスブラウザでDOM/CSSを描画)は同じレンダリングエンジン系統のため、DOM構造を揃えることで
 * text-shadowによる近似より高い視覚的忠実度が得られる。
 *
 * 縁取り幅のスケーリング(改善9-B-2): 「表示フォントサイズ ÷ プリセット font_size」。
 * サムネイル(20px)等で style.font_size(72px)の縁取り(18px)が白塊にならないよう、
 * 比率で縮小する(例: 20/72 × 18 ≈ 5px)。
 */
export function TelopStyledText({ lines, style, fontSizePx }: TelopStyledTextProps) {
  const fontWeight = (style.font_weight ?? 900) as CSSProperties["fontWeight"];
  const letterSpacing = style.letter_spacing ?? "0.02em";
  const lineHeight = style.line_height ?? 1.4;
  const fontFamily =
    style.font_family ?? '"Zen Kaku Gothic Antique", "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Meiryo", sans-serif';

  const presetFontSize = style.font_size || fontSizePx || 1;
  const innerStrokeWidth = style.inner_stroke
    ? scaleTelopStrokeWidth(style.inner_stroke.width, fontSizePx, presetFontSize)
    : 0;
  const outerStrokeWidth = style.outer_stroke
    ? scaleTelopStrokeWidth(style.outer_stroke.width, fontSizePx, presetFontSize)
    : 0;
  const scaledDropShadow = scaleTelopDropShadow(style.drop_shadow, fontSizePx, presetFontSize);

  const textStyle: CSSProperties = {
    fontFamily,
    fontSize: `${fontSizePx}px`,
    fontWeight,
    letterSpacing,
    lineHeight,
    textAlign: "center",
    whiteSpace: "pre-wrap",
    wordBreak: "keep-all",
    margin: 0,
  };

  const fillStyle: CSSProperties =
    style.fill.type === "solid"
      ? { color: style.fill.color ?? "#FFFFFF", textDecoration: style.underline ? "underline" : undefined }
      : {
          color: "transparent",
          backgroundImage: `linear-gradient(${gradientCssAngle(style.fill.gradient_direction)}, ${style.fill.gradient_from ?? "#FFFFFF"}, ${style.fill.gradient_to ?? "#000000"})`,
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
        };

  const hasStroke = Boolean(style.outer_stroke || style.inner_stroke);

  return (
    <div
      className="telopStyledTextWrapper"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        filter: scaledDropShadow ?? undefined,
      }}
    >
      {lines.map((line, index) => (
        <div
          className="telopStyledTextLine"
          key={index}
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
              {line}
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
              {line}
            </div>
          )}
          <div style={{ ...textStyle, ...fillStyle, position: hasStroke ? "absolute" : "relative", inset: 0 }}>
            {line}
          </div>
        </div>
      ))}
    </div>
  );
}

function gradientCssAngle(direction: "vertical" | "horizontal" | "diagonal" | undefined): string {
  if (direction === "horizontal") return "90deg";
  if (direction === "diagonal") return "135deg";
  return "180deg";
}
