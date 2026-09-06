import type { CSSProperties } from "react";
import type { OverlayItem } from "../lib/overlayItems";
import { overlayLines } from "../lib/overlayItems";
import { overlayTypeLabel } from "../lib/overlayLabels";
import {
  CAPTION_DEFAULTS,
  CAPTION_FILTER,
  captionTextSpec,
  CHAPTER_TITLE_DEFAULTS,
  chapterTitleRenderSpec,
  ctaBannerBoxStyle,
  ctaBannerLineStyle,
  listStackContainerStyle,
  listStackLineStyle,
  overlayPositionStyle,
  profileCardBoxStyle,
  profileCardNameStyle,
  profileCardSubtitleStyle,
  resolveChapterTitlePattern,
  resolveOverlayTextStyle,
  strokeTextBaseStyle,
  type OverlayStrokeTextSpec,
} from "../lib/overlayStyles";
import type { TelopStyleDef } from "../lib/telopThemes";

/**
 * フェーズU1-5: オーバーレイのDOM版プレビュー描画。
 * remotion/src/components/Overlays.tsx のRemotion API(Sequence/useVideoConfig)非依存な移植で、
 * 「今この瞬間に表示すべきitems」(タイムライン写像済み。lib/previewTimeline.ts)を受け取って
 * 絶対配置レイヤーに描くだけのpureコンポーネント。見た目の数値・配色・フォントは
 * lib/overlayStyles.ts(Remotion版と完全同一ファイル。一致テストで担保)を共有する。
 */

const StrokeText = ({ text, spec }: { text: string; spec: OverlayStrokeTextSpec }) => {
  const base = strokeTextBaseStyle(spec) as CSSProperties;
  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      {spec.strokeWidth > 0 && (
        <div
          style={{ ...base, color: "transparent", WebkitTextStroke: `${spec.strokeWidth}px ${spec.strokeColor}` }}
        >
          {text}
        </div>
      )}
      <div
        style={{ ...base, color: spec.fillColor, position: spec.strokeWidth > 0 ? "absolute" : "relative", inset: 0 }}
      >
        {text}
      </div>
    </div>
  );
};

const OverlayContent = ({
  item,
  scale,
  styles,
}: {
  item: OverlayItem;
  scale: number;
  styles?: Record<string, TelopStyleDef>;
}) => {
  switch (item.type) {
    case "chapter_title": {
      // フェーズU7: style はパターンID。Remotion(Overlays.tsx)と同じ描画計画をDOMへ写す
      const resolved = resolveOverlayTextStyle(item, styles, CHAPTER_TITLE_DEFAULTS);
      const spec = chapterTitleRenderSpec(resolveChapterTitlePattern(item.style), scale, resolved);
      const inner = (
        <>
          <StrokeText text={item.text ?? ""} spec={spec.text} />
          {spec.underline && <div style={spec.underline as CSSProperties} />}
        </>
      );
      return (
        <div style={spec.container as CSSProperties}>
          {spec.plate ? <div style={spec.plate as CSSProperties}>{inner}</div> : inner}
        </div>
      );
    }
    case "profile_card": {
      const subtitleLines = (item.subtitle ?? "").split("\n").filter((line) => line.length > 0);
      return (
        <div style={profileCardBoxStyle(scale) as CSSProperties}>
          <div style={profileCardNameStyle(scale) as CSSProperties}>{item.text ?? ""}</div>
          {subtitleLines.map((line, idx) => (
            <div key={idx} style={profileCardSubtitleStyle(scale) as CSSProperties}>
              {line}
            </div>
          ))}
        </div>
      );
    }
    case "list_stack":
      return (
        <div style={listStackContainerStyle(scale) as CSSProperties}>
          {overlayLines(item).map((line, idx) => (
            <div key={idx} style={listStackLineStyle(scale) as CSSProperties}>
              {line}
            </div>
          ))}
        </div>
      );
    case "cta_banner":
      return (
        <div style={ctaBannerBoxStyle(scale) as CSSProperties}>
          {overlayLines(item).map((line, idx) => (
            <div key={idx} style={ctaBannerLineStyle(scale) as CSSProperties}>
              {line}
            </div>
          ))}
        </div>
      );
    case "caption": {
      const resolved = resolveOverlayTextStyle(item, styles, CAPTION_DEFAULTS);
      return (
        <div style={{ filter: CAPTION_FILTER }}>
          <StrokeText text={item.text ?? ""} spec={captionTextSpec(scale, resolved)} />
        </div>
      );
    }
  }
};

type PreviewOverlaysProps = {
  /** 現在表示すべきオーバーレイ(activeOverlaysAtSourceMs の結果)。 */
  items: OverlayItem[];
  /** 表示高さ ÷ 1080(Remotion側と同じ1080p基準スケール)。 */
  scale: number;
  /** timeline.telop_styles(overlayのstyle参照用)。 */
  styles?: Record<string, TelopStyleDef>;
  /** U1-5: クリックで文言編集を開く(未指定ならクリック不可の純表示)。 */
  onItemClick?: (item: OverlayItem) => void;
};

export function PreviewOverlays({ items, scale, styles, onItemClick }: PreviewOverlaysProps) {
  if (!items.length || scale <= 0) return null;
  return (
    <>
      {items.map((item) => (
        <div
          key={item.id}
          style={{
            ...(overlayPositionStyle(item.position, scale, item.type) as CSSProperties),
            pointerEvents: onItemClick ? "auto" : "none",
            cursor: onItemClick ? "pointer" : undefined,
          }}
          onClick={
            onItemClick
              ? (event) => {
                  event.stopPropagation();
                  onItemClick(item);
                }
              : undefined
          }
          title={onItemClick ? `クリックで${overlayTypeLabel(item.type)}を編集` : undefined}
        >
          <OverlayContent item={item} scale={scale} styles={styles} />
        </div>
      ))}
    </>
  );
}
