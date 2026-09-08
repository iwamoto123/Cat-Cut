import type { CSSProperties } from "react";
import { scaleTelopDropShadow, scaleTelopStrokeWidth, type TelopStyleDef } from "../lib/telopThemes";
import { buildGlowFilter, combineTelopFilters } from "../lib/telopGlow";
import { resolveBlockBackground } from "../lib/previewTelop";
import { DEFAULT_HIGHLIGHT_COLOR } from "../lib/telopHighlight";
import {
  buildHighlightMasksForLines,
  DEFAULT_LATIN_FONT_FAMILY,
  DEFAULT_PARTICLE_SCALE,
  splitStyledRuns,
  splitTypographyRuns,
  type TypographyRunKind,
} from "../lib/telopTypography";
import {
  splitGraphemes,
  typewriterCharDelayMs,
  typewriterLineOffsets,
} from "../lib/telopTypewriter";

type TelopStyledTextProps = {
  /** 表示行(1〜2行。折返し確定済みの行配列をそのまま渡す)。 */
  lines: string[];
  style: TelopStyleDef;
  /** 実際に表示するフォントサイズ(px)。 */
  fontSizePx: number;
  /**
   * U1-2(highlight_words 部分ハイライト): 文言中の該当部分文字列だけ塗り色を
   * style.highlight_color に変える(Remotion Telop.tsx の renderFillLine と同じ関数を使う)。
   */
  highlightWords?: string[];
  /**
   * U1-3(Remotionと同一の縁取りスケール): Remotion側は「幅フィット後のコンポジション基準
   * フォントサイズ ÷ 52」で縁取り幅を決める(Telop.tsx)。プレビューで同じ見た目にするため、
   * コンポジション基準のフォントサイズ(幅フィット後)を渡すとRemotionと同じ規則で縁取り・影を
   * スケールする。未指定時は従来規則(fontSizePx ÷ style.font_size)で近似する(サムネイル等)。
   */
  compositionFontSizePx?: number;
  /**
   * U1-2(ブロック背景): コンポジション基準px(background.padding_x等)を表示pxへ変換する係数
   * (動画の実表示幅 ÷ コンポジション幅)。未指定時は fontSizePx ÷ style.font_size で近似する。
   */
  layoutScale?: number;
  /**
   * W24 Phase B-1(typewriter): 登場アニメの全長(ms)。指定するとgrapheme単位のspanに
   * animation-delay(共有ロジック telopTypewriter.typewriterCharDelayMs)を振って
   * 1文字ずつ表示する(親のkey差し替えで再発火。Remotionのフレーム計算と同じ出現規則)。
   * null/未指定でtypewriter無効=従来描画。
   */
  typewriterDurationMs?: number | null;
};

/**
 * 改善8-B-4(プレビューのテロップ描画をプリセット忠実に): Remotion側の実装
 * (`remotion/src/components/Telop.tsx`のTelopLayer)と可能な限り同じDOM構造・CSSプロパティを
 * 使って、プリセットの多重縁取り(外縁→内縁→塗り)とグラデ塗りを再現する。
 * プレビュー(Electronのレンダラー = Chromium)と実際の書き出し(Remotion = 同じくChromium系の
 * ヘッドレスブラウザでDOM/CSSを描画)は同じレンダリングエンジン系統のため、DOM構造を揃えることで
 * text-shadowによる近似より高い視覚的忠実度が得られる。
 *
 * フェーズU1-2で TelopLayer と1:1になるよう完全化した:
 * - ブロック背景(background.padding_x/padding_y/border_radius = box系座布団)
 * - highlight_words 部分ハイライト(buildHighlightMask/splitStyledRuns。Remotionと同一関数)
 * - 縁取り幅のRemotion同一規則スケール(compositionFontSizePx指定時)
 */
export function TelopStyledText({
  lines,
  style,
  fontSizePx,
  highlightWords,
  compositionFontSizePx,
  layoutScale,
  typewriterDurationMs,
}: TelopStyledTextProps) {
  const fontWeight = (style.font_weight ?? 900) as CSSProperties["fontWeight"];
  const letterSpacing = style.letter_spacing ?? "0.02em";
  const lineHeight = style.line_height ?? 1.4;
  const fontFamily =
    style.font_family ?? '"Zen Kaku Gothic Antique", "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Meiryo", sans-serif';

  const presetFontSize = style.font_size || fontSizePx || 1;
  // コンポジション基準px → 表示px の係数(ブロック背景・行間ギャップ用)。
  const displayScale = layoutScale ?? fontSizePx / presetFontSize;
  // 縁取り幅: Remotion(Telop.tsx)は round(width × コンポジション基準フォント ÷ 52) を使う。
  // compositionFontSizePx があればそれを表示pxへ換算して同じシルエットにする。
  const strokeWidthPx = (width: number): number => {
    if (compositionFontSizePx && compositionFontSizePx > 0) {
      const compositionPx = Math.round(width * (compositionFontSizePx / 52));
      return compositionPx * (fontSizePx / compositionFontSizePx);
    }
    return scaleTelopStrokeWidth(width, fontSizePx, presetFontSize);
  };
  const innerStrokeWidth = style.inner_stroke ? strokeWidthPx(style.inner_stroke.width) : 0;
  const outerStrokeWidth = style.outer_stroke ? strokeWidthPx(style.outer_stroke.width) : 0;
  // フェーズU6: 第3縁(最背面)。スケール規則は他の縁と同一。
  const outerStroke2Width = style.outer_stroke2 ? strokeWidthPx(style.outer_stroke2.width) : 0;
  const scaledDropShadow = scaleTelopDropShadow(style.drop_shadow, fontSizePx, presetFontSize);
  // フェーズT2.5-2(オフセット影): Remotion側(Telop.tsx TelopLayer)と同じく、縁レイヤーの
  // 下に(x,y)pxずらした影レイヤーを描画する。ずらし量はプリセットfont_size基準の値を
  // 表示フォントサイズに比例スケールする(Remotionの shadowScale = fontSize/(font_size??52) と同値)。
  const shadowOffset = style.shadow_offset ?? null;
  const shadowScale = fontSizePx / presetFontSize;
  const shadowStrokeWidth = Math.max(outerStroke2Width, outerStrokeWidth, innerStrokeWidth);
  // フェーズU6: 光彩(グロウ)。Remotion側と同じくdrop_shadowとfilterで結合する。
  const blockFilter = combineTelopFilters(
    buildGlowFilter(style.glow, shadowScale),
    scaledDropShadow,
  );

  // U1-2(ブロック背景): box系はブロック全体の背後に1枚のベタ長方形、それ以外は従来の行ごと帯。
  const blockBackground = resolveBlockBackground(style);
  const lineBandBackground = blockBackground ? null : style.background;

  // フェーズT2.5-1(多層縁の行ズレ根絶): 折返しはlines(呼び出し側)で確定済み。
  // CSSの再折返しを禁止し、全レイヤーの行数を構造的に一致させる(Remotion側と同じ)。
  // フェーズW27(表現拡張): 縦書きと回転(Remotion Telop.tsx TelopLayerと同一規則)
  const isVerticalWriting = style.writing_mode === "vertical";
  const rotateDeg = Number(style.rotate ?? 0) || 0;

  const textStyle: CSSProperties = {
    fontFamily,
    fontSize: `${fontSizePx}px`,
    fontWeight,
    letterSpacing,
    lineHeight,
    textAlign: "center",
    whiteSpace: "nowrap",
    wordBreak: "keep-all",
    margin: 0,
    ...(isVerticalWriting
      ? { writingMode: "vertical-rl" as const, textOrientation: "upright" as const }
      : {}),
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

  const hasStroke = Boolean(style.outer_stroke2 || style.outer_stroke || style.inner_stroke);

  // タイポグラフィ(助詞縮小・和欧混植): Remotion側(Telop.tsx)と同じ規則を全レイヤーに
  // 適用する(片方だけに適用するとレイヤー間で字幅がズレて多層縁が崩れる)。
  const particleScale = style.particle_scale ?? DEFAULT_PARTICLE_SCALE;
  const latinFontFamily =
    style.latin_font_family === null ? null : (style.latin_font_family ?? DEFAULT_LATIN_FONT_FAMILY);
  const runSpanStyle = (kind: TypographyRunKind): CSSProperties | undefined => {
    if (kind === "particle" && particleScale !== 1) {
      return { fontSize: `${Math.round(fontSizePx * particleScale)}px` };
    }
    if (kind === "latin" && latinFontFamily) {
      return { fontFamily: latinFontFamily };
    }
    return undefined;
  };
  // W24 Phase B-1(typewriter): grapheme単位のspanにanimation-delayを振って1文字ずつ表示する
  // (出現規則はRemotionのフレーム計算と同じ共有ロジック)。未表示文字は opacity:0 で
  // 字幅を保つ(中央寄せの位置ズレ防止)。run(タイポグラフィ・ハイライト)spanの内側に
  // 入れ子にするので、助詞縮小・和欧混植・highlight_words と共存する。
  const typewriterActive = typewriterDurationMs !== null && typewriterDurationMs !== undefined;
  const typewriterLayout = typewriterActive ? typewriterLineOffsets(lines) : null;
  const renderTypewriterText = (text: string, startIndex: number) =>
    splitGraphemes(text).map((grapheme, graphemeIdx) => (
      <span
        key={graphemeIdx}
        style={{
          opacity: 0,
          animationName: "telopTypewriterCharIn",
          animationDuration: "1ms",
          animationTimingFunction: "steps(1, end)",
          animationFillMode: "forwards",
          animationDelay: `${typewriterCharDelayMs(
            startIndex + graphemeIdx,
            typewriterLayout?.total ?? 0,
            typewriterDurationMs ?? 0,
          )}ms`,
        }}
      >
        {grapheme}
      </span>
    ));

  const renderLayerLine = (line: string, lineStart = 0) => {
    const runs = splitTypographyRuns(line);
    if (!typewriterActive && runs.every((run) => run.kind === "normal")) return line;
    let cursor = lineStart;
    return runs.map((run, runIdx) => {
      const runStart = cursor;
      if (typewriterActive) cursor += splitGraphemes(run.text).length;
      return (
        <span key={runIdx} style={runSpanStyle(run.kind)}>
          {typewriterActive ? renderTypewriterText(run.text, runStart) : run.text}
        </span>
      );
    });
  };

  // U1-2(部分ハイライト): 塗り潰しレイヤーはタイポグラフィ+ハイライト色を合成する
  // (Remotion Telop.tsx の renderFillLine と同一関数・同一規則)。
  const highlightColor = style.highlight_color ?? DEFAULT_HIGHLIGHT_COLOR;
  const lineHighlightMasks = buildHighlightMasksForLines(lines, highlightWords);
  const renderFillLine = (line: string, lineStart = 0, lineIndex = 0) => {
    const runs = splitStyledRuns(line, lineHighlightMasks[lineIndex]);
    if (!typewriterActive && runs.every((run) => run.kind === "normal" && !run.highlight)) {
      return line;
    }
    let cursor = lineStart;
    return runs.map((run, runIdx) => {
      const runStart = cursor;
      if (typewriterActive) cursor += splitGraphemes(run.text).length;
      return (
        <span
          key={runIdx}
          style={{
            ...runSpanStyle(run.kind),
            ...(run.highlight ? { color: highlightColor, WebkitTextFillColor: highlightColor } : {}),
          }}
        >
          {typewriterActive ? renderTypewriterText(run.text, runStart) : run.text}
        </span>
      );
    });
  };

  return (
    <div
      className="telopStyledTextWrapper"
      style={{
        display: "flex",
        // W27(縦書き): 複数行は右→左の列並び(和文縦書きの読み順。Remotionと同一)
        flexDirection: isVerticalWriting ? "row-reverse" : "column",
        alignItems: "center",
        gap: blockBackground ? 0 : 8 * displayScale,
        // W27(斜め文字): プリセットのrotateをブロック全体へ適用(Remotionと同一)
        transform: rotateDeg ? `rotate(${rotateDeg}deg)` : undefined,
        filter: blockFilter,
        // U1-2(ブロック背景): 文字ブロック全体の背後に1枚のベタ長方形を描画する(参考画像06/12/13)
        backgroundColor: blockBackground?.color,
        padding: blockBackground
          ? `${(blockBackground.padding_y ?? 0) * displayScale}px ${(blockBackground.padding_x ?? 0) * displayScale}px`
          : undefined,
        borderRadius:
          blockBackground?.border_radius !== undefined
            ? blockBackground.border_radius * displayScale
            : undefined,
      }}
    >
      {lines.map((line, index) => (
        <div
          className="telopStyledTextLine"
          key={index}
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
              {renderLayerLine(line, typewriterLayout?.offsets[index] ?? 0)}
            </div>
          )}
          {style.outer_stroke2 && (
            // フェーズU6: 第3縁は最背面(DOM上で最初の通常フローレイヤー)に描画する(Remotionと同一構造)
            <div
              style={{
                ...textStyle,
                color: "transparent",
                WebkitTextStroke: `${outerStroke2Width}px ${style.outer_stroke2.color}`,
              }}
            >
              {renderLayerLine(line, typewriterLayout?.offsets[index] ?? 0)}
            </div>
          )}
          {style.outer_stroke && (
            <div
              style={{
                ...textStyle,
                color: "transparent",
                WebkitTextStroke: `${outerStrokeWidth}px ${style.outer_stroke.color}`,
                position: style.outer_stroke2 ? "absolute" : "relative",
                inset: 0,
              }}
            >
              {renderLayerLine(line, typewriterLayout?.offsets[index] ?? 0)}
            </div>
          )}
          {style.inner_stroke && (
            <div
              style={{
                ...textStyle,
                color: "transparent",
                WebkitTextStroke: `${innerStrokeWidth}px ${style.inner_stroke.color}`,
                position: style.outer_stroke2 || style.outer_stroke ? "absolute" : "relative",
                inset: 0,
              }}
            >
              {renderLayerLine(line, typewriterLayout?.offsets[index] ?? 0)}
            </div>
          )}
          <div style={{ ...textStyle, ...fillStyle, position: hasStroke ? "absolute" : "relative", inset: 0 }}>
            {renderFillLine(line, typewriterLayout?.offsets[index] ?? 0, index)}
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
