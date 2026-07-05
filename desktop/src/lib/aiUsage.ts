/** AI校正（パス1/パス2）のトークン使用量・概算コスト表示 */

export interface AiUsage {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number | null;
  provider: string;
  model: string;
}

const YEN_PER_USD = 150;

function formatTokenCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** パス1/パス2の使用量から表示用サマリ文字列を生成する。両方nullなら null。 */
export function formatAiUsageSummary(
  transcriptUsage: AiUsage | null | undefined,
  telopUsage: AiUsage | null | undefined,
): string | null {
  if (!transcriptUsage && !telopUsage) {
    return null;
  }

  const tokenParts: string[] = [];
  if (transcriptUsage) {
    tokenParts.push(
      `パス1 ${formatTokenCount(transcriptUsage.input_tokens)}→${formatTokenCount(transcriptUsage.output_tokens)}tok`,
    );
  }
  if (telopUsage) {
    tokenParts.push(
      `パス2 ${formatTokenCount(telopUsage.input_tokens)}→${formatTokenCount(telopUsage.output_tokens)}tok`,
    );
  }

  let summary = `AI校正コスト（目安）: ${tokenParts.join(" / ")}`;

  const cost1 = transcriptUsage?.estimated_cost_usd ?? null;
  const cost2 = telopUsage?.estimated_cost_usd ?? null;
  if (cost1 !== null || cost2 !== null) {
    const totalUsd = (cost1 ?? 0) + (cost2 ?? 0);
    const yen = Math.round(totalUsd * YEN_PER_USD);
    summary += ` ・ 合計 $${totalUsd.toFixed(2)}（約${formatTokenCount(yen)}円）`;
  }

  return summary;
}
