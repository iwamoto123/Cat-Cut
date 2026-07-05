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
 * サイズは動画高さ1080px基準のデザイン値を height/1080 でスケールする。
 */
import React from "react";
import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";

import {
  normalizeOverlays,
  overlayLines,
  type OverlayItem,
  type OverlayPosition,
} from "../lib/overlayItems";
import type { TelopStyle } from "./Telop";

// =============================================================================
// 共通部品
// =============================================================================

const GOTHIC_FONT_FAMILY =
  '"Zen Kaku Gothic Antique", "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Meiryo", sans-serif';
// 章見出しは参考動画に合わせてセリフ系太字(op_brushと同じ暫定代替)
const MINCHO_FONT_FAMILY = '"Hiragino Mincho ProN", "Hiragino Mincho Pro", "Yu Mincho", serif';

/** 縁取り付きテキスト(Telop.tsx と同じ多層 WebkitTextStroke 方式の簡易版)。 */
const StrokeText = ({
  text,
  fontSize,
  fontFamily,
  fontWeight,
  fillColor,
  strokeColor,
  strokeWidth,
}: {
  text: string;
  fontSize: number;
  fontFamily: string;
  fontWeight: number;
  fillColor: string;
  strokeColor: string;
  strokeWidth: number;
}) => {
  const base: React.CSSProperties = {
    fontFamily,
    fontSize,
    fontWeight: fontWeight as React.CSSProperties["fontWeight"],
    letterSpacing: "0.02em",
    lineHeight: 1.3,
    whiteSpace: "pre-wrap",
    wordBreak: "keep-all",
  };
  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      {strokeWidth > 0 && (
        <div style={{ ...base, color: "transparent", WebkitTextStroke: `${strokeWidth}px ${strokeColor}` }}>
          {text}
        </div>
      )}
      <div style={{ ...base, color: fillColor, position: strokeWidth > 0 ? "absolute" : "relative", inset: 0 }}>
        {text}
      </div>
    </div>
  );
};

/** position ごとの配置ラッパースタイル(Sequence の AbsoluteFill 内に絶対配置する)。 */
const positionStyle = (position: OverlayPosition, scale: number): React.CSSProperties => {
  const base: React.CSSProperties = { position: "absolute", display: "flex" };
  switch (position) {
    case "top_left":
      return { ...base, top: 28 * scale, left: 36 * scale };
    case "bottom_left":
      return { ...base, bottom: 44 * scale, left: 44 * scale };
    case "center":
      return { ...base, inset: 0, justifyContent: "center", alignItems: "center" };
    case "bottom":
      return { ...base, bottom: 52 * scale, left: 0, right: 0, justifyContent: "center" };
  }
};

// =============================================================================
// type別の描画
// =============================================================================

/** style指定(overlay用preset参照)からテキスト系オーバーレイの色・フォントを上書きする。 */
const resolveOverlayTextStyle = (
  item: OverlayItem,
  styles: Record<string, TelopStyle> | undefined,
  defaults: { fontFamily: string; fillColor: string; strokeColor: string },
): { fontFamily: string; fillColor: string; strokeColor: string } => {
  const preset = item.style ? styles?.[item.style] : undefined;
  if (!preset) return defaults;
  return {
    fontFamily: preset.font_family ?? defaults.fontFamily,
    fillColor: preset.fill.type === "solid" ? (preset.fill.color ?? defaults.fillColor) : defaults.fillColor,
    strokeColor: preset.outer_stroke?.color ?? preset.inner_stroke?.color ?? defaults.strokeColor,
  };
};

const ChapterTitle = ({
  item,
  scale,
  styles,
}: {
  item: OverlayItem;
  scale: number;
  styles?: Record<string, TelopStyle>;
}) => {
  const { fontFamily, fillColor, strokeColor } = resolveOverlayTextStyle(item, styles, {
    fontFamily: MINCHO_FONT_FAMILY,
    fillColor: "#111111",
    strokeColor: "#FFFFFF",
  });
  return (
    <div style={{ filter: "drop-shadow(0px 3px 5px rgba(0,0,0,0.5))" }}>
      <StrokeText
        text={item.text ?? ""}
        fontSize={46 * scale}
        fontFamily={fontFamily}
        fontWeight={800}
        fillColor={fillColor}
        strokeColor={strokeColor}
        strokeWidth={9 * scale}
      />
    </div>
  );
};

const ProfileCard = ({ item, scale }: { item: OverlayItem; scale: number }) => {
  const subtitleLines = (item.subtitle ?? "").split("\n").filter((line) => line.length > 0);
  return (
    <div
      style={{
        backgroundColor: "#FFFFFF",
        border: `${Math.max(1, 2 * scale)}px solid #3A3A3A`,
        borderRadius: 18 * scale,
        padding: `${20 * scale}px ${44 * scale}px`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8 * scale,
        boxShadow: `0px ${5 * scale}px ${14 * scale}px rgba(0,0,0,0.35)`,
        // 幅は内容に合わせる(親が絶対配置のため%指定は幅崩壊する。nowrapで一行維持)
        width: "max-content",
      }}
    >
      <div
        style={{
          fontFamily: GOTHIC_FONT_FAMILY,
          fontSize: 44 * scale,
          fontWeight: 800,
          color: "#111111",
          letterSpacing: "0.06em",
          lineHeight: 1.2,
          textAlign: "center",
          whiteSpace: "nowrap",
        }}
      >
        {item.text ?? ""}
      </div>
      {subtitleLines.map((line, idx) => (
        <div
          key={idx}
          style={{
            fontFamily: GOTHIC_FONT_FAMILY,
            fontSize: 21 * scale,
            fontWeight: 700,
            color: "#222222",
            lineHeight: 1.25,
            textAlign: "center",
            whiteSpace: "nowrap",
          }}
        >
          {line}
        </div>
      ))}
    </div>
  );
};

const ListStack = ({ item, scale }: { item: OverlayItem; scale: number }) => (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 52 * scale,
      filter: "drop-shadow(0px 4px 8px rgba(0,0,0,0.4))",
    }}
  >
    {overlayLines(item).map((line, idx) => (
      <div
        key={idx}
        style={{
          backgroundColor: "#000000",
          color: "#FFE600",
          fontFamily: GOTHIC_FONT_FAMILY,
          fontSize: 56 * scale,
          fontWeight: 900,
          letterSpacing: "0.04em",
          lineHeight: 1.2,
          padding: `${8 * scale}px ${34 * scale}px`,
          whiteSpace: "pre-wrap",
        }}
      >
        {line}
      </div>
    ))}
  </div>
);

const CtaBanner = ({ item, scale }: { item: OverlayItem; scale: number }) => (
  <div
    style={{
      backgroundColor: "#FFE600",
      padding: `${16 * scale}px ${52 * scale}px`,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      filter: "drop-shadow(0px 4px 10px rgba(0,0,0,0.4))",
    }}
  >
    {overlayLines(item).map((line, idx) => (
      <div
        key={idx}
        style={{
          color: "#000000",
          fontFamily: GOTHIC_FONT_FAMILY,
          fontSize: 58 * scale,
          fontWeight: 900,
          letterSpacing: "0.02em",
          lineHeight: 1.25,
          textAlign: "center",
          whiteSpace: "pre-wrap",
        }}
      >
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
  const { fontFamily, fillColor, strokeColor } = resolveOverlayTextStyle(item, styles, {
    fontFamily: GOTHIC_FONT_FAMILY,
    fillColor: "#111111",
    strokeColor: "#FFFFFF",
  });
  return (
    <div style={{ filter: "drop-shadow(0px 3px 6px rgba(0,0,0,0.45))" }}>
      <StrokeText
        text={item.text ?? ""}
        fontSize={58 * scale}
        fontFamily={fontFamily}
        fontWeight={900}
        fillColor={fillColor}
        strokeColor={strokeColor}
        strokeWidth={10 * scale}
      />
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
            <div style={positionStyle(item.position, scale)}>
              <OverlayContent item={item} scale={scale} styles={styles} />
            </div>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
