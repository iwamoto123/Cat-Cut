import type { TelopStyleDef } from "../lib/telopThemes";
import { TelopStyledText } from "./TelopStyledText";

type TelopStyleSampleProps = {
  style: TelopStyleDef;
  /** サムネイル・スウォッチ等の表示フォントサイズ(px)。 */
  fontSizePx: number;
  text?: string;
  className?: string;
};

/** ギャラリー・スウォッチ等の小サイズ向け TelopStyledText ラッパー（改善9-B-2）。 */
export function TelopStyleSample({
  style,
  fontSizePx,
  text = "あいうアイウ",
  className,
}: TelopStyleSampleProps) {
  return (
    <span className={className}>
      <TelopStyledText fontSizePx={fontSizePx} lines={[text]} style={style} />
    </span>
  );
}
