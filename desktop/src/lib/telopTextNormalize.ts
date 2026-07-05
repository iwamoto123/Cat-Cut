/**
 * 改善10-B-3(UIテキストの正規化整合): Python telop_builder.py (改善9-A-3 / 改善14-C) と同じ
 * 句読点ルールをUI側の自動生成telopTextに適用する。
 * - 「。」は全除去
 * - 先頭の句読点(、。！？…ー単独)は禁止
 * - 連続読点「、、」→「、」、末尾読点除去
 * - 全角数字→半角数字
 *
 * ユーザーが手入力したテキップ編集には適用しない(初期化・wordsからの自動再生成のみ)。
 */

const PAGE_LEADING_FORBIDDEN = new Set(["、", "。", "！", "？", "!", "?", "…", "ー"]);

const FULLWIDTH_DIGIT_RE = /[０-９]/g;

/** 改善17-B: 行末の読点+フィラー断片 (長い順にマッチ) */
const TRAILING_FILLER_FRAGMENTS = ["まあ", "ま", "ね"] as const;
const TRAILING_COMMA_CHARS = ["、", "，"] as const;

/** 行末の「、ね」「、ま」「、まあ」等のフィラー断片を除去する。 */
export function stripTrailingFillerFragments(line: string): string {
  for (const fragment of TRAILING_FILLER_FRAGMENTS) {
    for (const comma of TRAILING_COMMA_CHARS) {
      const suffix = comma + fragment;
      if (line.endsWith(suffix)) {
        return line.slice(0, -suffix.length);
      }
    }
  }
  return line;
}

/** 全角数字を半角数字に変換する。 */
export function normalizeFullwidthDigits(text: string): string {
  return text.replace(FULLWIDTH_DIGIT_RE, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xfee0),
  );
}

/** 連続読点を1個にし、末尾の読点(、，)を除去する。 */
export function cleanTelopCommas(text: string): string {
  let result = text.replace(/、{2,}/g, "、").replace(/，{2,}/g, "，");
  result = result.replace(/[、，]+$/g, "");
  return result;
}

/** 表示用テキストから句点「。」を除去する。 */
export function removeTelopPeriods(text: string): string {
  return text.replace(/。/g, "").trim();
}

/** 先頭の禁止句読点を除去する(1文字ずつ)。 */
export function stripLeadingTelopPunctuation(text: string): string {
  let result = text;
  while (result.length > 0 && PAGE_LEADING_FORBIDDEN.has(result[0])) {
    result = result.slice(1).trimStart();
  }
  return result;
}

/** 決定的クリーニングを一括適用する。 */
export function applyDeterministicTextCleaning(text: string): string {
  return cleanTelopCommas(normalizeFullwidthDigits(text));
}

/** 行単位: 「？、」「！、」を正規化し、行末フィラー・読点(、，)を除去する。 */
export function cleanTelopLine(line: string): string {
  let result = line.replace(/([？！])[、，]+/g, "$1");
  result = stripTrailingFillerFragments(result);
  result = result.replace(/[、，]+$/g, "");
  return result;
}

/** 複数行テキストに行単位クリーニングを適用する。 */
export function applyTelopLineCleaning(text: string): string {
  if (!text.includes("\n")) {
    return cleanTelopLine(text);
  }
  return text.split("\n").map(cleanTelopLine).join("\n");
}

/** words連結やパイプライン未指定時のフォールバック向け正規化。 */
export function normalizeTelopDisplayText(text: string): string {
  return stripLeadingTelopPunctuation(
    applyTelopLineCleaning(applyDeterministicTextCleaning(removeTelopPeriods(text))),
  );
}
