// テロップ改行位置の付属語ルール（行頭に助詞・助動詞を置かない）。
// `editor/python/shared/line_break_rules.py` の移植（判定結果が一致するよう規則を揃える）。
//
// 日本語テロップの改行は文節の切れ目（助詞・助動詞の直後）が自然で、
// 「名詞 + 助詞」「名詞 + して」の間で切ると読みづらくなる。
//   NG: 共通テスト模試 / を受けられると思う   OK: 共通テスト模試を / 受けられると思う
//   NG: 国語担当 / していまして               OK: 国語担当していまして

/** 行頭に置くと不自然な付属語（長いものから順に一致させる）。 */
const DEPENDENT_PREFIXES = [
  // 複合格助詞・連語
  "について",
  "によって",
  "における",
  "において",
  "に対して",
  "とともに",
  "として",
  "による",
  // 引用・体言化
  "っていう",
  "という",
  "といった",
  "といって",
  "とゆう",
  "って",
  // 接続助詞・理由
  "なんです",
  "なので",
  "なのか",
  "んです",
  "んじゃ",
  "ので",
  "のに",
  "んで",
  "んだ",
  "から",
  "けれど",
  "けど",
  "ながら",
  "つつ",
  // 助動詞・丁寧形
  "でした",
  "ました",
  "ましょう",
  "ません",
  "まして",
  "です",
  "ます",
  "だった",
  // 補助動詞（サ変・受身・使役・「〜ていう」「〜ている」）
  "している",
  "してる",
  "しない",
  "します",
  "して",
  "した",
  "される",
  "され",
  "させ",
  "せて",
  "いました",
  "います",
  "いない",
  "いう",
  "いる",
  "いて",
  "いた",
  "しまっ",
  "しまう",
  // W26: 「〜てきた」「〜てきて」等の補助動詞と依頼の「ください」
  // (「送り出して / きた塾の講師なら」「お申し込み / ください」の分断を防ぐ)
  "きました",
  "きます",
  "きた",
  "きて",
  "ください",
  // 形式名詞
  "ところ",
  "つもり",
  "こと",
  "もの",
  "とき",
  "わけ",
  "はず",
  "ため",
  "まま",
  "ほう",
  "ほど",
  // 副助詞・並立助詞
  "ばかり",
  "くらい",
  "ぐらい",
  "なんて",
  "とか",
  "など",
  "だけ",
  "しか",
  "まで",
  "より",
  "ずつ",
  // 助詞の連続
  "では",
  "には",
  "にも",
  "でも",
  "とは",
  "とも",
  "との",
] as const;

/** 単独で行頭に来ると不自然な1文字助詞。 */
const SINGLE_PARTICLES = new Set([..."はがをにでともへやのかねよばさぞ"]);

/** 直前がこれらで終わるなら文・節が閉じているため、行頭が付属語でも不自然にならない。 */
const CLOSING_CHARS = new Set([..."。、．，！？!?…‥」』）)】〉》"]);

/** 文節の末尾になり得る文字(助詞・連用の語尾)。ここで終わる行は自然。 */
const PHRASE_END_CHARS = new Set([..."はがをにでともへやのかねよばさぞてしくな"]);

function isHiragana(ch: string): boolean {
  return (ch >= "ぁ" && ch <= "ん") || ch === "ー";
}

/** text の先頭にある付属語の長さ（付属語で始まらないなら0）。 */
export function dependentHeadLength(text: string): number {
  if (!text) return 0;
  for (const prefix of DEPENDENT_PREFIXES) {
    if (text.startsWith(prefix)) return prefix.length;
  }
  const head = text[0];
  if (SINGLE_PARTICLES.has(head)) {
    // 「を」は語頭に立たないので常に助詞。他の1文字はひらがなが続く場合
    // 「がんばる」「はい」等の自立語の可能性があるため助詞と見なさない。
    if (head === "を" || text.length === 1 || !isHiragana(text[1])) return 1;
  }
  return 0;
}

/** text（改行直後のテキスト）が付属語で始まるか。 */
export function isDependentLineHead(text: string): boolean {
  return dependentHeadLength(text) > 0;
}

/** before / after の間で改行すると付属語が行頭に来るか。 */
export function isBadLineBreak(before: string, after: string): boolean {
  if (!before || !after) return false;
  if (CLOSING_CHARS.has(before[before.length - 1])) return false;
  return isDependentLineHead(after);
}

/**
 * before の末尾が文節の切れ目か(句読点・助詞・連用の語尾で終わるか)。
 * 複合名詞の途中(「共通テスト / 対策の」)より文節末(「共通テスト対策の / 動画を」)を
 * 優先させるために使う。
 */
export function isPhraseEndBreak(before: string): boolean {
  if (!before) return false;
  const last = before[before.length - 1];
  return CLOSING_CHARS.has(last) || PHRASE_END_CHARS.has(last);
}
