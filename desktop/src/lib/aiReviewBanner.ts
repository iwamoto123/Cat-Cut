/**
 * 改善14-A: AI校正失敗・部分失敗のバナー表示ロジック。
 */

export type AiReviewBannerInput = {
  transcriptRefineFailed?: boolean;
  telopRefineFailed?: boolean;
  transcriptRefineFailureReason?: string;
  telopRefineFailureReason?: string;
  transcriptFailedChunks?: number;
  telopFailedChunks?: number;
};

export type AiReviewBanner = {
  severity: "error" | "warning";
  message: string;
};

function formatFailureReason(reason: string | undefined): string {
  const normalized = String(reason || "").trim();
  if (!normalized) return "不明なエラー";
  return normalized.replace(/^api_error:\s*/i, "");
}

export function buildAiReviewBanner(input: AiReviewBannerInput): AiReviewBanner | null {
  const transcriptFailed = Boolean(input.transcriptRefineFailed);
  const telopFailed = Boolean(input.telopRefineFailed);

  if (transcriptFailed || telopFailed) {
    const reasons: string[] = [];
    if (transcriptFailed) {
      reasons.push(`パス1: ${formatFailureReason(input.transcriptRefineFailureReason)}`);
    }
    if (telopFailed) {
      reasons.push(`パス2: ${formatFailureReason(input.telopRefineFailureReason)}`);
    }
    const reasonText = reasons.join(" / ");
    return {
      severity: "error",
      message: `⚠ AI校正が実行できませんでした（${reasonText}）。このテキストは未校正です。再解析で再試行できます`,
    };
  }

  const partialChunks =
    Number(input.transcriptFailedChunks || 0) + Number(input.telopFailedChunks || 0);
  if (partialChunks > 0) {
    return {
      severity: "warning",
      message: `AI校正の一部が失敗しました（${partialChunks}チャンク）。未処理部分は未校正のままです。再解析で再試行できます`,
    };
  }

  return null;
}
