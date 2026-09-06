// フェーズW23(改善1): 解析開始前のOP有無チェックボックスから run正本 op_config.json の
// 初期値を決める純ロジック(electron非依存。desktop/tests/opStart.test.ts でテストする)。
"use strict";

/**
 * 開始オプションの opEnabled とテーマのOP設定(resolveDesignExtras().op 相当)から、
 * run開始時に明示生成する op_config.json の内容を決める。
 *
 * @param {object|null|undefined} baseOp テーマ由来のOP設定(sanitize済みを想定)
 * @param {unknown} opEnabled UIチェックボックスの値
 * @returns {object|null}
 *   - opEnabled === false → pattern="none"(OPなし)。title等のテーマ設定は保持する
 *     (検品後に OpEditorModal でONへ戻したときテーマの装飾・文言が生きるように)
 *   - opEnabled === true → テーマ設定を維持。テーマが "none" の場合のみ
 *     "highlight_teaser" へ昇格する(それ以外のパターンはそのまま)
 *   - それ以外(undefined等。旧UI・後方互換) → null(呼び出し側は何も書かず
 *     従来どおり ensureRunOpConfig に任せる)
 *   返り値は書き込み時に sanitizeRunOpConfig で正規化される前提(clips: null=AI自動選定)。
 */
function resolveStartOpConfig(baseOp, opEnabled) {
  if (opEnabled !== true && opEnabled !== false) return null;
  const base = baseOp && typeof baseOp === "object" ? baseOp : {};
  if (opEnabled === false) {
    return { ...base, pattern: "none", clips: null };
  }
  const pattern =
    typeof base.pattern === "string" && base.pattern !== "none" ? base.pattern : "highlight_teaser";
  return { ...base, pattern, clips: null };
}

module.exports = { resolveStartOpConfig };
