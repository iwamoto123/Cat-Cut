/**
 * フェーズW10-7(相槌・極短シーンのテロップ空欄化): 「相槌・フィラーだけの発話」判定の共有関数。
 * 元は reviewHotspots.ts のtinyシーン判定(要確認パネル専用)だったものを切り出し、
 * scenes.ts のシーン初期化(初期telopTextの空欄化)からも使えるようにした。
 */

/** 判定用: 空白・改行・句読点を除いた文字数を数えるための除去パターン。 */
const TRIVIAL_STRIP_RE = /[\s、。！？!?・…]/gu;

/** 3文字以上でも相槌とみなすフィラーパターン(「あのー」「えっと」等。正規化後の全文一致)。 */
const FILLER_ONLY_RE = /^(あの+ー*|えっと+|えー+|うー*ん|はい|うん+|まあ+|なんか)$/;

/**
 * 相槌・極短の発話テキストかどうか(正規化後 maxChars 文字以下、またはフィラーのみ)。
 * 空文字・句読点だけのテキストも true になる。
 */
export function isTrivialUtteranceText(text: string, maxChars = 2): boolean {
  const normalized = text.replace(TRIVIAL_STRIP_RE, "");
  if ([...normalized].length <= maxChars) return true;
  return FILLER_ONLY_RE.test(normalized);
}
