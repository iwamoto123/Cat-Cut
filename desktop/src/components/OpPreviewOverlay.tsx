import { useMemo } from "react";
import type { OpPhasesMs, OpPreviewData } from "../lib/previewPlaylist";
import {
  OP_COLOR_WIPE_BAR_RATIO,
  OP_NEON_COLOR,
  opDecorationHasEndTitle,
  opHookFontPx,
  opHookLines,
  opHookSegments,
  type OpHookKeywordColor,
} from "../lib/opTimeline";

/**
 * フェーズV3(OPのプレビュー再生): OPの映像外要素(ベタ背景・タイトル・キャッチ・フラッシュ)の
 * DOM/CSS近似描画。Remotion(OpSequence.tsx)のspring/interpolateを厳密再現はせず、
 * U1のテロップアニメと同方針で「同じ種類の動き」をCSS keyframesで出す。
 * フェーズ境界(titleMs/catchMs/fadeOutMs)は previewPlaylist.opPhasesMsFor が
 * Remotionと同じフレーム計算から求めた値を使うため、出るタイミングは書き出しと一致する。
 */

// OpSequence.tsx と同じフォント・アクセント色(見た目を書き出しへ寄せる)
const OP_TITLE_FONT_FAMILY =
  '"GenEi Gothic N U-KL", "Dela Gothic One", "Zen Kaku Gothic Antique", "Hiragino Kaku Gothic ProN", sans-serif';
const OP_SUB_FONT_FAMILY =
  '"Zen Kaku Gothic Antique", "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Meiryo", sans-serif';
const OP_ACCENT_YELLOW = "#FFC400";

type Props = {
  op: OpPreviewData;
  /** OP先頭からの経過ms(タイムラインmsと同値。OPはタイムライン先頭[0, duration)のため)。 */
  opMs: number;
  phases: OpPhasesMs;
  /** 映像が実際に描画されている矩形(object-fit:contain計算済み)。 */
  box: { offsetX: number; offsetY: number; width: number; height: number };
  /**
   * highlight_teaser: クリップ切替の転換演出の発火キー(エントリ遷移で変わる)。
   * null=演出なし。keyの変化でCSSアニメを再発火する(装飾により白フラッシュ/ワイプ/パルス)。
   */
  flashKey: string | null;
  /** フェーズV5: 再生中クリップの0始まり番号(cinema_barsのクリップ番号表示に使う)。 */
  clipIndex?: number | null;
};

/** 終端の転換(黒フェード)の不透明度。OutroFade(interpolate)のms版。 */
function outroOpacity(opMs: number, fadeOutMs: number, durationMs: number): number {
  if (durationMs <= fadeOutMs) return 0;
  return Math.max(0, Math.min(1, (opMs - fadeOutMs) / (durationMs - fadeOutMs)));
}

// フェーズW: フックワードの色(OpSequence.tsx HOOK_KEYWORD_COLORS と同期)
const HOOK_KEYWORD_COLORS: Record<OpHookKeywordColor, { fill: string; outline: string }> = {
  yellow: { fill: "#FFE600", outline: "#000000" },
  red: { fill: "#FF1F0F", outline: "#FFFFFF" },
  white: { fill: "#FFFFFF", outline: "#000000" },
};

const HOOK_BASE_COLOR = { fill: "#FFFFFF", outline: "#000000" };

/** 極太縁取り(8方向text-shadow)。OpSequence.tsx hookOutlineShadow のCSS近似コピー。 */
function hookOutlineShadow(px: number, color: string): string {
  const offsets = [
    [px, 0], [-px, 0], [0, px], [0, -px],
    [px, px], [px, -px], [-px, px], [-px, -px],
  ];
  const outline = offsets.map(([x, y]) => `${x}px ${y}px 0 ${color}`).join(", ");
  return `${outline}, 0px ${px * 2.2}px ${px * 3}px rgba(0,0,0,0.55)`;
}

/**
 * フェーズW: display=hook クリップのフックワードCSS近似。
 * 2行=上下2段(上10%/下68%)・1行=中央やや上、各行stamp登場(2行目は0.3秒遅れ)は
 * opPreviewStamp のCSS keyframesを流用し、Remotion(HookWordLayer)と同じ配置にする。
 */
function HookWordPreview({
  clipKey,
  hookText,
  keyword,
  keywordColor,
  boxWidth,
  boxHeight,
}: {
  clipKey: string;
  hookText: string;
  keyword: string;
  keywordColor: OpHookKeywordColor;
  boxWidth: number;
  boxHeight: number;
}) {
  const lines = opHookLines(hookText);
  if (lines.length === 0) return null;
  const fontPx = opHookFontPx(lines, boxWidth, boxHeight);
  const outlinePx = Math.max(1, Math.round(fontPx * 0.06));
  const twoLines = lines.length === 2;
  return (
    <div key={clipKey} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {lines.map((line, lineIndex) => {
        const top = twoLines ? (lineIndex === 0 ? boxHeight * 0.1 : boxHeight * 0.68) : boxHeight * 0.38;
        return (
          <div
            className="opPreviewStamp"
            key={`hook_line_${lineIndex}`}
            style={{
              position: "absolute",
              top: Math.round(top),
              left: 0,
              right: 0,
              display: "flex",
              justifyContent: "center",
              animationDelay: lineIndex > 0 ? `${lineIndex * 0.3}s` : undefined,
              animationFillMode: "both",
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
              {opHookSegments(line, keyword).map((segment, segmentIndex) => {
                const palette = segment.keyword ? HOOK_KEYWORD_COLORS[keywordColor] : HOOK_BASE_COLOR;
                return (
                  <span
                    key={`hook_seg_${segmentIndex}`}
                    style={{ color: palette.fill, textShadow: hookOutlineShadow(outlinePx, palette.outline) }}
                  >
                    {segment.text}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function OpPreviewOverlay({ op, opMs, phases, box, flashKey, clipIndex }: Props) {
  const h = box.height;
  const containerStyle = useMemo(
    () =>
      ({
        position: "absolute" as const,
        left: `${box.offsetX}px`,
        top: `${box.offsetY}px`,
        width: `${box.width}px`,
        height: `${box.height}px`,
        overflow: "hidden",
      }) as const,
    [box.offsetX, box.offsetY, box.width, box.height],
  );
  if (h <= 0 || box.width <= 0) return null;

  const titleVisible = opMs >= phases.titleMs;
  const fadeOpacity = outroOpacity(opMs, phases.fadeOutMs, op.durationMs);

  if (op.pattern === "highlight_teaser") {
    // 映像(元動画シーク)は下の<video>が担当。ここでは装飾レイヤー・転換演出・タイトル被せのみ。
    // フェーズV5: 装飾4種をCSSで近似する(完全一致は不要、パターンの区別がつくレベル)。
    const decoration = op.decoration;
    const barHeight = Math.round(h * 0.11);
    const neonInset = Math.round(Math.min(box.width, h) * 0.03);
    // W11-5: タイトル空文字(未生成・「表示しない」)は終端被せを出さない(Remotionと同じガード)
    const showEndTitle = Boolean(op.title) && opDecorationHasEndTitle(decoration) && titleVisible;
    // フェーズW: 再生中クリップが display=hook ならフックワードを重ねる
    const activeClip = clipIndex !== null && clipIndex !== undefined ? (op.clips[clipIndex] ?? null) : null;
    const hookClip = activeClip && activeClip.display === "hook" && activeClip.hookText ? activeClip : null;
    return (
      <div className="opPreviewLayer" style={containerStyle}>
        {/* 転換演出: flash_pop / cinema_bars=白フラッシュ、color_wipe=斜めワイプ、
            neon_frame=ズームインの代わりのシアンパルス(映像自体の変形はCSS近似では行わない) */}
        {flashKey !== null && decoration !== "color_wipe" && decoration !== "neon_frame" && (
          <div className="opPreviewFlash" key={flashKey} />
        )}
        {flashKey !== null && decoration === "color_wipe" && (
          <div className="opPreviewWipe" key={flashKey} style={{ backgroundColor: op.accentColor }} />
        )}
        {flashKey !== null && decoration === "neon_frame" && (
          <div className="opPreviewNeonPulse" key={flashKey} />
        )}
        {decoration === "cinema_bars" && (
          <>
            <div className="opPreviewCinemaBar" style={{ top: 0, height: barHeight }} />
            <div className="opPreviewCinemaBar" style={{ bottom: 0, height: barHeight }} />
            <div
              className="opPreviewCinemaLabel"
              style={{ top: Math.round(barHeight * 0.3), left: Math.round(box.width * 0.03), fontSize: Math.round(h * 0.024) }}
            >
              OPENING
            </div>
            <div
              className="opPreviewCinemaLabel"
              style={{
                bottom: Math.round(barHeight * 0.28),
                right: Math.round(box.width * 0.03),
                fontSize: Math.round(h * 0.028),
                letterSpacing: "0.2em",
              }}
            >
              {String((clipIndex ?? 0) + 1).padStart(2, "0")}
            </div>
          </>
        )}
        {decoration === "color_wipe" && (
          <div
            className="opPreviewBrandBar"
            style={{ height: Math.round(h * OP_COLOR_WIPE_BAR_RATIO), backgroundColor: op.accentColor }}
          >
            {/* W11-5: タイトル空文字なら文字は描かない(バー自体は装飾として残す) */}
            {op.title && (
              <span
                style={{
                  fontFamily: OP_TITLE_FONT_FAMILY,
                  fontWeight: 900,
                  color: "#FFFFFF",
                  fontSize: Math.round(h * OP_COLOR_WIPE_BAR_RATIO * 0.42),
                  letterSpacing: "0.06em",
                  whiteSpace: "nowrap",
                  textShadow: "0px 2px 8px rgba(0,0,0,0.35)",
                }}
              >
                {op.title}
              </span>
            )}
          </div>
        )}
        {decoration === "neon_frame" && (
          <div
            className="opPreviewNeonFrame"
            style={{
              inset: neonInset,
              borderWidth: Math.max(2, Math.round(h * 0.005)),
              borderColor: OP_NEON_COLOR,
              borderRadius: Math.round(h * 0.01),
              boxShadow: `0 0 ${Math.round(h * 0.018)}px ${OP_NEON_COLOR}, 0 0 ${Math.round(h * 0.036)}px ${OP_NEON_COLOR}, inset 0 0 ${Math.round(h * 0.018)}px ${OP_NEON_COLOR}`,
            }}
          />
        )}
        {hookClip && (
          <HookWordPreview
            boxHeight={h}
            boxWidth={box.width}
            clipKey={`hook_${clipIndex}`}
            hookText={hookClip.hookText}
            keyword={hookClip.keyword}
            keywordColor={hookClip.keywordColor}
          />
        )}
        {showEndTitle && (
          <div className="opPreviewTitleCover">
            <div className="opPreviewVeil" />
            <div
              className="opPreviewStamp"
              style={{
                fontFamily: OP_TITLE_FONT_FAMILY,
                fontSize: Math.round(h * 0.095),
                fontWeight: 900,
                color: "#FFFFFF",
                letterSpacing: "0.04em",
                lineHeight: 1.25,
                textAlign: "center",
                maxWidth: box.width * 0.86,
                textShadow: "0px 6px 18px rgba(0,0,0,0.6)",
                borderBottom: `${Math.max(2, Math.round(h * 0.008))}px solid ${OP_ACCENT_YELLOW}`,
                paddingBottom: Math.round(h * 0.015),
              }}
            >
              {op.title}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (op.pattern === "title_card") {
    return (
      <div className="opPreviewLayer opPreviewStatic" style={{ ...containerStyle, backgroundColor: op.accentColor }}>
        {/* 単色ベタだと平板なため、Remotionと同じごく薄いビネットで奥行きを足す */}
        <div className="opPreviewVignette" />
        <div className="opPreviewCenter">
          {/* W11-5: タイトル空文字はタイトルブロックごと描画しない */}
          {op.title && titleVisible && (
            <div className="opPreviewStamp" style={{ maxWidth: box.width * 0.86 }}>
              <div
                style={{
                  fontFamily: OP_TITLE_FONT_FAMILY,
                  fontSize: Math.round(h * 0.105),
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
                className="opPreviewBar"
                style={{
                  height: Math.max(2, Math.round(h * 0.008)),
                  marginTop: Math.round(h * 0.02),
                  backgroundColor: OP_ACCENT_YELLOW,
                }}
              />
            </div>
          )}
          {op.catchCopy && opMs >= phases.catchMs && (
            <div
              className="opPreviewFadeIn"
              style={{
                marginTop: Math.round(h * 0.05),
                fontFamily: OP_SUB_FONT_FAMILY,
                fontSize: Math.round(h * 0.042),
                fontWeight: 700,
                color: "rgba(255,255,255,0.92)",
                letterSpacing: "0.12em",
                textAlign: "center",
                maxWidth: box.width * 0.8,
              }}
            >
              {op.catchCopy}
            </div>
          )}
        </div>
        {fadeOpacity > 0 && <div className="opPreviewOutro" style={{ opacity: fadeOpacity }} />}
      </div>
    );
  }

  // question_hook: 暗背景+問いテキストfade → タイトル(黄)被せ
  return (
    <div
      className="opPreviewLayer opPreviewStatic"
      style={{
        ...containerStyle,
        background: "radial-gradient(ellipse at center, #1B1E26 0%, #0A0B0E 100%)",
      }}
    >
      <div className="opPreviewCenter">
        {opMs >= phases.catchMs && (
          <div
            className="opPreviewFadeIn"
            style={{
              fontFamily: OP_SUB_FONT_FAMILY,
              fontSize: Math.round(h * 0.062),
              fontWeight: 700,
              color: "#FFFFFF",
              letterSpacing: "0.08em",
              lineHeight: 1.6,
              textAlign: "center",
              maxWidth: box.width * 0.82,
              whiteSpace: "pre-wrap",
            }}
          >
            {op.catchCopy}
          </div>
        )}
        {op.title && titleVisible && (
          <div
            className="opPreviewStamp"
            style={{
              marginTop: Math.round(h * 0.06),
              fontFamily: OP_TITLE_FONT_FAMILY,
              fontSize: Math.round(h * 0.075),
              fontWeight: 900,
              color: OP_ACCENT_YELLOW,
              letterSpacing: "0.05em",
              lineHeight: 1.3,
              textAlign: "center",
              maxWidth: box.width * 0.86,
              textShadow: "0px 5px 16px rgba(0,0,0,0.6)",
            }}
          >
            {op.title}
          </div>
        )}
      </div>
      {fadeOpacity > 0 && <div className="opPreviewOutro" style={{ opacity: fadeOpacity }} />}
    </div>
  );
}
