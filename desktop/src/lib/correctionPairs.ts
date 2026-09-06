/**
 * フェーズW14-2: 編集前→編集後テキストの「語レベル差分ペア」抽出と、
 * 修正履歴(userData/correction_history.json)に基づく既知の「誤」表記の検出。
 *
 * - extractCorrectionPairs: テロップ編集確定(blur)時に、編集前後のテキストを
 *   Intl.Segmenter(単語粒度)でトークン化してLCS差分を取り、変更された語の対だけを返す。
 *   文全体ではなく「誤→正」の語ペアとして蓄積するための抽出器。
 * - findKnownWrongNotations: 全run横断の修正履歴に頻出する「誤」表記がテキスト中に
 *   残っている場合に決定的に検出する(AI不要。「過去に修正した表記」バッジの根拠)。
 */

export type CorrectionPair = { before: string; after: string };

/** userData/correction_history.json の1ペア(頻度カウント付き)。 */
export type CorrectionHistoryPair = {
  before: string;
  after: string;
  count: number;
  updatedAt?: string;
};

export type CorrectionHistory = { pairs: CorrectionHistoryPair[] };

/** 片側フラグメントの最大文字数。これを超える差分は文の書き換えとみなし語ペアにしない。 */
const MAX_PAIR_CHARS = 20;

/**
 * 編集前後で共通に残る文字の最低割合。これを下回る編集は「語の修正」ではなく
 * 「文全体の書き換え」とみなし、ペアを一切抽出しない(書き換えのLCS残骸を学習しないため)。
 */
const MIN_COMMON_RATIO = 0.4;

/** 「過去に修正した表記」として決定的に要確認へ昇格させる最小出現回数(頻出の閾値)。 */
export const KNOWN_WRONG_MIN_COUNT = 2;

const segmenter = new Intl.Segmenter("ja", { granularity: "word" });

const HIRAGANA_ONLY_RE = /^[\u3041-\u3096ー]+$/u;

/** テキストを単語粒度トークンへ分割する(空白・記号セグメントも保持する)。 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const segment of segmenter.segment(text)) tokens.push(segment.segment);
  return tokens;
}

type DiffRegion = { removed: string[]; added: string[] };

/**
 * トークン列のLCS差分から「削除トークン群/追加トークン群」の変更領域を列挙する。
 * テロップは短文(数十トークン)なので単純なO(n*m) DPで十分。
 */
function diffRegions(beforeTokens: string[], afterTokens: string[]): DiffRegion[] {
  const n = beforeTokens.length;
  const m = afterTokens.length;
  // lcs[i][j] = beforeTokens[i:] と afterTokens[j:] のLCS長
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] =
        beforeTokens[i] === afterTokens[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const regions: DiffRegion[] = [];
  let current: DiffRegion | null = null;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && beforeTokens[i] === afterTokens[j]) {
      current = null;
      i += 1;
      j += 1;
      continue;
    }
    if (!current) {
      current = { removed: [], added: [] };
      regions.push(current);
    }
    // LCSが伸びる側を優先して片側ずつ消費する(標準的なdiff復元)
    if (j >= m || (i < n && lcs[i + 1][j] >= lcs[i][j + 1])) {
      current.removed.push(beforeTokens[i]);
      i += 1;
    } else {
      current.added.push(afterTokens[j]);
      j += 1;
    }
  }
  return regions;
}

/** 改行を含む空白を1スペースへ正規化して前後を落とす(語ペアの表記キーとして扱うため)。 */
function normalizeFragment(tokens: string[]): string {
  return tokens.join("").replace(/\s+/gu, " ").trim();
}

/** 空白を無視した比較用文字列。 */
function stripWhitespace(text: string): string {
  return text.replace(/\s+/gu, "");
}

/**
 * 編集前→編集後の変更から「誤→正」の語レベルペアを抽出する。
 * ノイズ抑制のため以下は記録しない:
 * - 片側が空(純粋な挿入・削除。修正ペアにならない)
 * - 空白・改行のみの変更(改行位置調整はページレイアウトの編集であって誤字修正ではない)
 * - 両側とも1〜2文字のひらがなのみの変更(「が→を」等の助詞の入れ替え)
 * - 片側が MAX_PAIR_CHARS(20文字)を超える変更(語ではなく文の書き換え)
 */
export function extractCorrectionPairs(beforeText: string, afterText: string): CorrectionPair[] {
  if (beforeText === afterText) return [];
  const beforeTokens = tokenize(beforeText);
  const afterTokens = tokenize(afterText);
  const regions = diffRegions(beforeTokens, afterTokens);

  // 文全体の書き換え判定: 共通に残った文字が少なすぎる編集からはペアを抽出しない。
  const removedChars = regions.reduce(
    (sum, region) => sum + stripWhitespace(region.removed.join("")).length,
    0,
  );
  const commonChars = stripWhitespace(beforeText).length - removedChars;
  const longerLength = Math.max(stripWhitespace(beforeText).length, stripWhitespace(afterText).length);
  if (longerLength > 0 && commonChars / longerLength < MIN_COMMON_RATIO) return [];
  const pairs: CorrectionPair[] = [];
  const seen = new Set<string>();
  for (const region of regions) {
    const before = normalizeFragment(region.removed);
    const after = normalizeFragment(region.added);
    if (!before || !after || before === after) continue;
    if (stripWhitespace(before) === stripWhitespace(after)) continue;
    if (before.length > MAX_PAIR_CHARS || after.length > MAX_PAIR_CHARS) continue;
    if (
      before.length <= 2 &&
      after.length <= 2 &&
      HIRAGANA_ONLY_RE.test(before) &&
      HIRAGANA_ONLY_RE.test(after)
    ) {
      continue;
    }
    const key = `${before}\u0000${after}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ before, after });
  }
  return pairs;
}

export type KnownWrongNotation = { before: string; after: string; count: number };

/**
 * 修正履歴に頻出(count >= minCount)する「誤」表記がテキスト中に残っている場合に検出する。
 * 「正」表記の一部としてだけ出現するケース(例: 誤「白谷」/正「白谷塾」でテキストに
 * 「白谷塾」しか無い)は誤検出になるため、正表記の出現を潰してから部分一致を調べる。
 */
export function findKnownWrongNotations(
  telopText: string,
  history: CorrectionHistoryPair[] | undefined,
  options: { minCount?: number } = {},
): KnownWrongNotation[] {
  if (!telopText || !history?.length) return [];
  const minCount = options.minCount ?? KNOWN_WRONG_MIN_COUNT;
  const results: KnownWrongNotation[] = [];
  const seenBefore = new Set<string>();
  const sorted = [...history].sort((a, b) => b.count - a.count);
  for (const pair of sorted) {
    const before = String(pair.before || "");
    const after = String(pair.after || "");
    if (!before || !after || before === after) continue;
    if (pair.count < minCount) continue;
    // 1文字の「誤」は偶然の一致が多すぎるため決定的昇格の対象にしない
    if (before.length < 2) continue;
    if (seenBefore.has(before)) continue;
    // 正表記の出現箇所をセンチネルで潰し、連結部での偽マッチも防ぐ
    const masked = after.includes(before) ? telopText.split(after).join("\u0000") : telopText;
    if (!masked.includes(before)) continue;
    seenBefore.add(before);
    results.push({ before, after, count: pair.count });
  }
  return results;
}
