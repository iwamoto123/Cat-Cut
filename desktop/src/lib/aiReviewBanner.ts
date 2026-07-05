/**
 * 改善14-A: AI校正失敗・部分失敗のバナー表示ロジック。
 * 改善21-B: 完全失敗時の詳細は要確認キューの先頭項目(buildAiFailureSuspicion)に移し、
 * バナーは見落とし防止のための簡潔な1行に短縮する。
 */

import { normalizeAiFailureErrorKind, type AiFailureErrorKind } from "./suspicionQueue.ts";

export type AiReviewBannerInput = {
  transcriptRefineFailed?: boolean;
  telopRefineFailed?: boolean;
  transcriptRefineFailureReason?: string;
  telopRefineFailureReason?: string;
  transcriptFailedChunks?: number;
  telopFailedChunks?: number;
  /** 改善21-B: ai_review.json / refine.json の error_kind(旧runでは undefined)。 */
  transcriptErrorKind?: string;
  telopErrorKind?: string;
};

export type AiReviewBanner = {
  severity: "error" | "warning";
  message: string;
};

const FAILURE_CAUSE_LABELS: Record<AiFailureErrorKind, string> = {
  billing: "残高不足",
  auth: "APIキー無効",
  rate_limit: "API制限中",
  overloaded: "API混雑中",
  timeout: "タイムアウト",
  other: "エラー",
};

export function buildAiReviewBanner(input: AiReviewBannerInput): AiReviewBanner | null {
  const transcriptFailed = Boolean(input.transcriptRefineFailed);
  const telopFailed = Boolean(input.telopRefineFailed);

  if (transcriptFailed || telopFailed) {
    const kind = normalizeAiFailureErrorKind(
      (transcriptFailed ? input.transcriptErrorKind : "") || input.telopErrorKind,
    );
    return {
      severity: "error",
      message: `⚠ AI校正未実行（${FAILURE_CAUSE_LABELS[kind]}）— このテキストは未校正です。詳細は要確認リスト参照`,
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
