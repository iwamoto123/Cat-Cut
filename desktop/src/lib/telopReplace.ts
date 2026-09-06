/**
 * シーン行UI(検品UI v2 改善5-7「一括置換ポップアップ」)を支える純関数。
 * `2026-07-03_catcut-scene-row-ui-spec.md` 改善5の7番目の項目に準拠する。
 *
 * テロップ枠(textarea)の編集確定時、編集前後のテキストから「単語Aを単語Bに置換した」という
 * 単一の連続編集を検出する。共通の先頭(prefix)・末尾(suffix)を取り除いた残りの差分区間を
 * 置換対象とみなす、シンプルな最長共通接頭辞/接尾辞ベースの差分判定。
 *
 * W10-5(抑制ルール): 差分が数字列・英字列・カタカナ列の途中に落ちた場合はその連続全体まで
 * from/toを拡張し(「17」→「27」を「1」→「2」にしない)、拡張後のfromが1文字なら候補にしない
 * (「で」「を」や漢字1字の修正でポップアップを出さない)。
 */

export type TelopWordReplacement = { from: string; to: string };

/** 「単語」とみなす差分の最大文字数。これを超える差分は文章の書き換えとみなしスキップする。 */
const MAX_REPLACEMENT_CHARS = 20;

/**
 * W10-5: 単語境界拡張・出現検索の境界チェックで使う文字種。数字・英字・カタカナの連続は
 * 「1つの単語」とみなし、その途中で差分・一致を切らない。それ以外(ひらがな・漢字・記号)はnull。
 */
export type TelopCharClass = "digit" | "latin" | "katakana" | null;

const DIGIT_RE = /[0-9０-９]/;
const LATIN_RE = /[A-Za-zＡ-Ｚａ-ｚ]/;
const KATAKANA_RE = /[ァ-ヶーｦ-ﾟ]/;

/** 1文字の文字種を返す(数字/英字/カタカナ以外はnull)。telopOccurrences.tsの境界チェックと共用。 */
export function telopCharClass(char: string | undefined): TelopCharClass {
  if (!char) return null;
  if (DIGIT_RE.test(char)) return "digit";
  if (LATIN_RE.test(char)) return "latin";
  if (KATAKANA_RE.test(char)) return "katakana";
  return null;
}

/**
 * 編集前後のテキストから単語置換(A→B)を検出する。次のいずれかに該当する場合はnullを返す
 * (「複雑な編集はスキップ」の実装):
 * - 変更が無い
 * - 純粋な挿入/削除(置換ではない。fromまたはtoが空)
 * - 拡張後のfromが1文字(W10-5: 助詞・漢字1字などの局所修正は一括置換の対象にしない)
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

  // 純粋な挿入/削除(fromまたはtoが空)は従来どおり対象外(境界拡張より先に判定する)。
  if (oldChars.length - suffixLen - prefixLen <= 0) return null;
  if (newChars.length - suffixLen - prefixLen <= 0) return null;

  // W10-5: 差分の単語境界拡張。旧テキスト側でfromの前後が同一文字種(数字/英字/カタカナ)の
  // 連続の途中なら、その連続全体までfrom/toを両側へ広げる(拡張分は共通prefix/suffixなので
  // from/toに同じ文字が付き、from≠toは保たれる)。
  while (prefixLen > 0) {
    const prefixEndClass = telopCharClass(oldChars[prefixLen - 1]);
    if (!prefixEndClass || prefixEndClass !== telopCharClass(oldChars[prefixLen])) break;
    prefixLen -= 1;
  }
  while (suffixLen > 0) {
    const suffixStartClass = telopCharClass(oldChars[oldChars.length - suffixLen]);
    if (!suffixStartClass || suffixStartClass !== telopCharClass(oldChars[oldChars.length - suffixLen - 1])) break;
    suffixLen -= 1;
  }

  const fromChars = oldChars.slice(prefixLen, oldChars.length - suffixLen);
  const toChars = newChars.slice(prefixLen, newChars.length - suffixLen);
  const from = fromChars.join("");
  const to = toChars.join("");
  if (from === to) return null;
  // W10-5: 拡張後のfromが1文字なら不発火(「で」「を」・漢字1字・数字1桁の修正)。
  if (fromChars.length <= 1) return null;
  if (fromChars.length > MAX_REPLACEMENT_CHARS || toChars.length > MAX_REPLACEMENT_CHARS) return null;
  if (from.includes("\n") || to.includes("\n")) return null;
  return { from, to };
}
