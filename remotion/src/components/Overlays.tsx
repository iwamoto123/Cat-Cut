/**
 * オーバーレイトラック描画 (フェーズT1-3)
 *
 * テロップ(下部字幕)と独立した表示レイヤー timeline.overlays を描画する。
 * タイムライン基準ms(timeline.cuts と同じ軸)の Sequence として配置するため、
 * カットを跨いでも連続表示できる。overlays が無い/空なら何も描画しない。
 *
 * 5種の描画 (参考: templates/reference/telop_analysis_20260705/):
 *   chapter_title : 左上・黒文字+白太縁の章見出し・常時表示 (参考画像05)
 *   profile_card  : 下部左寄せの白角丸ボックス・氏名(大)+肩書き(小) (参考画像04)
 *   list_stack    : 中央の縦積み列挙。黒ベタ+黄文字の帯を1行ずつ積む (参考画像11)
 *   cta_banner    : 下部の黄ベタ帯+黒文字1〜2行 (参考画像12)
 *   caption       : 下部の白フチ黒字キャプション (B-roll用・T5で使用)
 *
 * フェーズU1-5(プレビュー忠実化): 見た目の数値・配色・フォントは lib/overlayStyles.ts に
 * 集約し、デスクトップのプレビュー(PreviewOverlays.tsx)と共有する(ファイル一致テストで同期)。
 * サイズは動画高さ1080px基準のデザイン値を height/1080 でスケールする。
 */
import React from "react";
import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";

import { normalizeOverlays, overlayLines, type OverlayItem } from "../lib/overlayItems";
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
import type { TelopStyle } from "./Telop";

// =============================================================================
// 共通部品
// =============================================================================

/** 縁取り付きテキスト(Telop.tsx と同じ多層 WebkitTextStroke 方式の簡易版)。 */
const StrokeText = ({ text, spec }: { text: string; spec: OverlayStrokeTextSpec }) => {
  const base = strokeTextBaseStyle(spec) as React.CSSProperties;
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

// =============================================================================
// type別の描画
// =============================================================================

const ChapterTitle = ({
  item,
  scale,
  styles,
}: {
  item: OverlayItem;
  scale: number;
  styles?: Record<string, TelopStyle>;
}) => {
  // フェーズU7: style はパターンID(box_accent等)。パターン外の値(旧preset参照)や欠落は
  // box_accent=現行デザインとして描き、preset参照の色上書きも従来通り効かせる
  const resolved = resolveOverlayTextStyle(item, styles, CHAPTER_TITLE_DEFAULTS);
  const spec = chapterTitleRenderSpec(resolveChapterTitlePattern(item.style), scale, resolved);
  const inner = (
    <>
      <StrokeText text={item.text ?? ""} spec={spec.text} />
      {spec.underline && <div style={spec.underline as React.CSSProperties} />}
    </>
  );
  return (
    <div style={spec.container as React.CSSProperties}>
      {spec.plate ? <div style={spec.plate as React.CSSProperties}>{inner}</div> : inner}
    </div>
  );
};

const ProfileCard = ({ item, scale }: { item: OverlayItem; scale: number }) => {
  const subtitleLines = (item.subtitle ?? "").split("\n").filter((line) => line.length > 0);
  return (
    <div style={profileCardBoxStyle(scale) as React.CSSProperties}>
      <div style={profileCardNameStyle(scale) as React.CSSProperties}>{item.text ?? ""}</div>
      {subtitleLines.map((line, idx) => (
        <div key={idx} style={profileCardSubtitleStyle(scale) as React.CSSProperties}>
          {line}
        </div>
      ))}
    </div>
  );
};

const ListStack = ({ item, scale }: { item: OverlayItem; scale: number }) => (
  <div style={listStackContainerStyle(scale) as React.CSSProperties}>
    {overlayLines(item).map((line, idx) => (
      <div key={idx} style={listStackLineStyle(scale) as React.CSSProperties}>
        {line}
      </div>
    ))}
  </div>
);

const CtaBanner = ({ item, scale }: { item: OverlayItem; scale: number }) => (
  <div style={ctaBannerBoxStyle(scale) as React.CSSProperties}>
    {overlayLines(item).map((line, idx) => (
      <div key={idx} style={ctaBannerLineStyle(scale) as React.CSSProperties}>
        {line}
      </div>
    ))}
  </div>
);

const Caption = ({
  item,
  scale,
  styles,
}: {
  item: OverlayItem;
  scale: number;
  styles?: Record<string, TelopStyle>;
}) => {
  const resolved = resolveOverlayTextStyle(item, styles, CAPTION_DEFAULTS);
  return (
    <div style={{ filter: CAPTION_FILTER }}>
      <StrokeText text={item.text ?? ""} spec={captionTextSpec(scale, resolved)} />
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
  styles?: Record<string, TelopStyle>;
}) => {
  switch (item.type) {
    case "chapter_title":
      return <ChapterTitle item={item} scale={scale} styles={styles} />;
    case "profile_card":
      return <ProfileCard item={item} scale={scale} />;
    case "list_stack":
      return <ListStack item={item} scale={scale} />;
    case "cta_banner":
      return <CtaBanner item={item} scale={scale} />;
    case "caption":
      return <Caption item={item} scale={scale} styles={styles} />;
  }
};

// =============================================================================
// コンポーネント
// =============================================================================

export const Overlays = ({
  overlays,
  styles,
}: {
  /** timeline.overlays (未検証JSON可。無ければ空扱い) */
  overlays: unknown;
  /** timeline.telop_styles (overlay の style 参照用) */
  styles?: Record<string, TelopStyle>;
}) => {
  const { fps, height } = useVideoConfig();
  const items = normalizeOverlays(overlays);
  if (items.length === 0) return null;

  const scale = height / 1080;

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {items.map((item) => {
        const from = Math.round((item.start_ms / 1000) * fps);
        const durationInFrames = Math.max(
          1,
          Math.round(((item.end_ms - item.start_ms) / 1000) * fps),
        );
        return (
          <Sequence key={item.id} from={from} durationInFrames={durationInFrames}>
            <div style={overlayPositionStyle(item.position, scale, item.type) as React.CSSProperties}>
              <OverlayContent item={item} scale={scale} styles={styles} />
            </div>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
