// 改善20-B(行バジェット超過時の明示的な改行位置制御):
// desktop/src/lib/wrapTelopLine.ts の同一実装コピー(SOTはdesktop側)。
// プレビューとRemotionレンダリングで同じ位置で折り返すため、変更時は必ず両方を同期すること。

/**
 * `editor/python/shared/textwidth.py` の DEFAULT_WEIGHTS 移植
 * (全角1文字=1.0単位の相対文字幅)。
 */
const GLYPH_WEIGHTS = {
  ascii_alnum: 0.55,
  ascii_space: 0.3,
  ascii_punct: 0.5,
  cjk_punct: 0.5,
  small_kana: 0.85,
  long_dash: 0.9,
  default: 1.0,
} as const;

const SMALL_KANA = new Set(["ぁ", "ぃ", "ぅ", "ぇ", "ぉ", "ゃ", "ゅ", "ょ"]);
const ASCII_PUNCT = new Set(["!", "?", ",", ".", "-", "'", '"']);

/** 行頭に置けない文字(禁則)。この文字で始まる折返しは強く避ける。 */
const HEAD_FORBIDDEN = new Set([..."、。！？!?…‥・:;）)」』】〉》］"]);

function classifyGlyph(ch: string): keyof typeof GLYPH_WEIGHTS {
  if (ch === " ") return "ascii_space";
  if ((ch >= "0" && ch <= "9") || (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z")) return "ascii_alnum";
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 0x3000 && code <= 0x303f) return "cjk_punct";
  if (ch === "ー" || ch === "―") return "long_dash";
  if (SMALL_KANA.has(ch)) return "small_kana";
  if (ASCII_PUNCT.has(ch)) return "ascii_punct";
  return "default";
}

/** 重み付き文字数(全角=1.0、半角英数=0.55)。Python側のtextwidth基準と揃える。 */
export function weightedTelopLineLength(text: string): number {
  let total = 0;
  for (const ch of text) total += GLYPH_WEIGHTS[classifyGlyph(ch)];
  return total;
}

type SegmenterLike = { segment(text: string): Iterable<{ segment: string }> };

const wordSegmenter: SegmenterLike | null =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new (Intl as unknown as {
        Segmenter: new (locale: string, options: { granularity: string }) => SegmenterLike;
      }).Segmenter("ja", { granularity: "word" })
    : null;

function splitIntoWordUnits(text: string): string[] {
  if (!wordSegmenter) return [...text];
  return [...wordSegmenter.segment(text)].map((entry) => entry.segment);
}

/** 行数を増やすことへの固定ペナルティ(不要な細切れ防止)。 */
const LINE_COST = 0.5;
/** バジェット超過行(分割不能な長い語単体など)への超過ペナルティ係数。 */
const OVERFLOW_COST = 8;
/** 行頭禁則違反(折返し先頭が句読点等)へのペナルティ。 */
const KINSOKU_COST = 10;

/**
 * テロップ1行ぶんのテキストを行バジェット(重み付き文字数)以内に収まるよう、
 * Intl.Segmenter('ja', word)の語境界で折り返す。
 *
 * - バジェット以内ならそのまま1行で返す。
 * - 超過時は語境界のみで分割し、各行のバランス(バジェットに対する埋まり具合)が
 *   最も良い分割をDPで選ぶ。行頭が句読点になる分割は避ける。
 * - 単一の語がバジェットを超える場合(長い英単語等)は、その語を無理に文字分割せず
 *   超過1行として許容する。
 * - フェーズT2.5(はみ出し根絶): maxLines を指定すると、折返し結果がそれを超える場合に
 *   行バジェットを広げながら再折返しし、必ず maxLines 行以内で確定する
 *   (超過ぶんの幅は描画側の幅フィット縮小に任せる)。
 */
export function wrapTelopLine(text: string, budget: number, maxLines?: number): string[] {
  const lines = wrapTelopLineAtBudget(text, budget);
  if (!maxLines || maxLines < 1 || lines.length <= maxLines) return lines;
  const total = weightedTelopLineLength(text);
  // 最小でも「総幅÷行数」の幅は必要。そこから1ずつ広げ、収まる最小の広げ幅を採用する。
  let widened = Math.max(Math.floor(budget) + 1, Math.ceil(total / maxLines));
  for (; widened < total; widened += 1) {
    const attempt = wrapTelopLineAtBudget(text, widened);
    if (attempt.length <= maxLines) return attempt;
  }
  return [text];
}

function wrapTelopLineAtBudget(text: string, budget: number): string[] {
  if (!text) return [];
  if (!Number.isFinite(budget) || budget <= 0) return [text];
  if (weightedTelopLineLength(text) <= budget) return [text];

  const units = splitIntoWordUnits(text);
  const n = units.length;
  if (n <= 1) return [text];
  const widths = units.map(weightedTelopLineLength);

  // dp[i]: units[i..] を折り返す最小コスト
  const INF = Number.POSITIVE_INFINITY;
  const dp = new Array<number>(n + 1).fill(INF);
  const next = new Array<number>(n + 1).fill(-1);
  dp[n] = 0;

  for (let i = n - 1; i >= 0; i -= 1) {
    let width = 0;
    for (let j = i + 1; j <= n; j += 1) {
      width += widths[j - 1];
      const overflow = width > budget;
      if (overflow && j > i + 1) break;

      let cost = LINE_COST + (1 - width / budget) ** 2;
      if (overflow) cost += OVERFLOW_COST * ((width - budget) / budget) ** 2;
      if (j < n) {
        const nextHead = units[j][0];
        if (nextHead !== undefined && HEAD_FORBIDDEN.has(nextHead)) cost += KINSOKU_COST;
      }

      const total = cost + dp[j];
      if (total < dp[i]) {
        dp[i] = total;
        next[i] = j;
      }
      if (overflow) break;
    }
  }

  const lines: string[] = [];
  let index = 0;
  while (index < n) {
    let j = next[index];
    if (j <= index) j = n;
    lines.push(units.slice(index, j).join(""));
    index = j;
  }
  return lines;
}
