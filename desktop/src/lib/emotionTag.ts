/**
 * テロップ統合1画面化「テーマ×感情の自動スタイリング」(T-2) の感情タグ自動付与。
 * `2026-07-03_catcut-scene-row-ui-spec.md` の「T-2. 感情タグの自動付与」節に準拠する純関数群。
 */

export type EmotionTag = "normal" | "emphasis" | "question" | "surprise";

export const EMOTION_TAGS: EmotionTag[] = ["normal", "emphasis", "question", "surprise"];

export const EMOTION_LABELS: Record<EmotionTag, string> = {
  normal: "通常",
  emphasis: "強調",
  question: "疑問",
  surprise: "驚き",
};

/** バッジ表示用の簡易アイコン(絵文字)。モックアップ(v6)のバッジ意匠に合わせる。 */
export const EMOTION_ICONS: Record<EmotionTag, string> = {
  normal: "😐",
  emphasis: "😲",
  question: "❓",
  surprise: "😲",
};

const QUESTION_MARKERS = ["ですか", "ますか", "でしょうか", "だろうか", "かな", "？", "?"];
const SURPRISE_MARKERS = ["！", "!", "すごい", "まさか", "えっ", "びっくり", "驚き", "驚いた"];
const EMPHASIS_COMPARISON_WORDS = [
  "ぐっと",
  "一番",
  "実は",
  "なんと",
  "めちゃくちゃ",
  "かなり",
  "驚くほど",
  "圧倒的",
  "最も",
];
/** 数字・金額・割合等を含むかどうか(強調規則「数字・金額」)。 */
const EMPHASIS_NUMBER_RE = /[0-90-9]+(円|%|パーセント|割|倍|万|億|千|点|人|件|回|分|時間|日|年)/;
const HIRAGANA_RE = /[\u3040-\u309F]/;

function includesAny(text: string, markers: string[]): boolean {
  return markers.some((marker) => text.includes(marker));
}

function stripTrailingPunctuation(text: string): string {
  return text.replace(/[。、！？!?\s]+$/g, "");
}

/**
 * 強調規則「体言止め」: 完全な形態素解析はしない簡易判定として、末尾の1文字が
 * ひらがな(です/ます/だ/ない等の用言・助動詞語尾は必ずひらがなで終わる)でなければ
 * 体言止め(名詞止め)とみなす。ひらがなで終わる場合は用言・助詞の可能性が高いため
 * 体言止めとは判定しない(誤検知よりも見逃しを優先する安全側の判定)。
 */
function isTaigenDome(text: string): boolean {
  const trimmed = stripTrailingPunctuation(text);
  if (!trimmed) return false;
  const lastChar = trimmed[trimmed.length - 1];
  return !HIRAGANA_RE.test(lastChar);
}

/**
 * シーンのテロップ本文からルールベースで感情タグを判定する。
 * 優先順位(仕様書の記載順): 疑問 > 強調 > 驚き > 通常。
 * 疑問は明確な疑問形の語尾を持つため最優先。驚きは感嘆符・感嘆語を含むが、
 * 「実は」等の強調語と同時に出現した場合は仕様書の記載順に従い強調を優先する。
 */
export function detectEmotionTag(text: string): EmotionTag {
  const trimmed = (text || "").trim();
  if (!trimmed) return "normal";

  if (includesAny(trimmed, QUESTION_MARKERS)) return "question";
  if (includesAny(trimmed, EMPHASIS_COMPARISON_WORDS) || EMPHASIS_NUMBER_RE.test(trimmed) || isTaigenDome(trimmed)) {
    return "emphasis";
  }
  if (includesAny(trimmed, SURPRISE_MARKERS)) return "surprise";
  return "normal";
}
