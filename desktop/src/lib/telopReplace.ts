/**
 * シーン行UI(検品UI v2 改善5-7「一括置換ポップアップ」)を支える純関数。
 * `2026-07-03_catcut-scene-row-ui-spec.md` 改善5の7番目の項目に準拠する。
 *
 * テロップ枠(textarea)の編集確定時、編集前後のテキストから「単語Aを単語Bに置換した」という
 * 単一の連続編集を検出する。共通の先頭(prefix)・末尾(suffix)を取り除いた残りの差分区間を
 * 置換対象とみなす、シンプルな最長共通接頭辞/接尾辞ベースの差分判定。
 */

export type TelopWordReplacement = { from: string; to: string };

/** 「単語」とみなす差分の最大文字数。これを超える差分は文章の書き換えとみなしスキップする。 */
const MAX_REPLACEMENT_CHARS = 20;

/**
 * 編集前後のテキストから単語置換(A→B)を検出する。次のいずれかに該当する場合はnullを返す
 * (「複雑な編集はスキップ」の実装):
 * - 変更が無い
 * - 純粋な挿入/削除(置換ではない。fromまたはtoが空)
 * - 差分区間が長すぎる(MAX_REPLACEMENT_CHARSを超える。単語ではなく文章の書き換えとみなす)
 * - 差分区間に改行を含む(複数行にまたがる編集)
 *
 * 注意: 編集が2箇所以上に分散している場合でも、共通の先頭・末尾を取り除いた「間の区間全体」を
 * 1つの差分として扱う(例: "ABCDE"→"AXCYE" は from="BCD"/to="XCY" になる)。これは意図的な
 * 単純化であり、そのような複合編集は結果的に「複雑な編集」としてMAX_REPLACEMENT_CHARSや
 * 呼び出し側の「他シーンに出現するか」判定で実質的にフィルタされることを期待している。
 */
export function detectTelopWordReplacement(oldText: string, newText: string): TelopWordReplacement | null {
  if (oldText === newText) return null;
  const oldChars = [...oldText];
  const newChars = [...newText];

  const maxPrefix = Math.min(oldChars.length, newChars.length);
  let prefixLen = 0;
  while (prefixLen < maxPrefix && oldChars[prefixLen] === newChars[prefixLen]) prefixLen += 1;

  const maxSuffix = Math.min(oldChars.length - prefixLen, newChars.length - prefixLen);
  let suffixLen = 0;
  while (
    suffixLen < maxSuffix &&
    oldChars[oldChars.length - 1 - suffixLen] === newChars[newChars.length - 1 - suffixLen]
  ) {
    suffixLen += 1;
  }

  const from = oldChars.slice(prefixLen, oldChars.length - suffixLen).join("");
  const to = newChars.slice(prefixLen, newChars.length - suffixLen).join("");
  if (!from || !to) return null;
  if (from === to) return null;
  if (from.length > MAX_REPLACEMENT_CHARS || to.length > MAX_REPLACEMENT_CHARS) return null;
  if (from.includes("\n") || to.includes("\n")) return null;
  return { from, to };
}
