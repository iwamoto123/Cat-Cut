import test from "node:test";
import assert from "node:assert/strict";
import { buildAiReviewBanner } from "../src/lib/aiReviewBanner.ts";

test("buildAiReviewBanner: キー未設定相当(reason=no AI provider key set)ではバナーなし", () => {
  assert.equal(
    buildAiReviewBanner({
      transcriptRefineFailed: false,
      telopRefineFailed: false,
    }),
    null,
  );
});

// 改善21-B: 完全失敗の詳細説明は要確認キュー先頭項目に移し、バナーは簡潔な1行に短縮。

test("buildAiReviewBanner: billing失敗は「残高不足」の簡潔な1行バナー", () => {
  const banner = buildAiReviewBanner({
    transcriptRefineFailed: true,
    transcriptErrorKind: "billing",
  });
  assert.ok(banner);
  assert.equal(banner?.severity, "error");
  assert.match(banner?.message || "", /AI校正未実行/);
  assert.match(banner?.message || "", /残高不足/);
  assert.match(banner?.message || "", /要確認リスト参照/);
  assert.ok((banner?.message || "").length < 80, "簡潔な1行に収まる");
});

test("buildAiReviewBanner: auth失敗は「APIキー無効」表示", () => {
  const banner = buildAiReviewBanner({
    telopRefineFailed: true,
    telopErrorKind: "auth",
  });
  assert.equal(banner?.severity, "error");
  assert.match(banner?.message || "", /APIキー無効/);
});

test("buildAiReviewBanner: error_kindが無い旧runは「エラー」(other)にフォールバック", () => {
  const banner = buildAiReviewBanner({
    transcriptRefineFailed: true,
    transcriptRefineFailureReason: "api_error: all 8 chunks failed",
  });
  assert.equal(banner?.severity, "error");
  assert.match(banner?.message || "", /AI校正未実行（エラー）/);
});

test("buildAiReviewBanner: 部分失敗は弱い警告", () => {
  const banner = buildAiReviewBanner({
    transcriptFailedChunks: 1,
    telopFailedChunks: 2,
  });
  assert.ok(banner);
  assert.equal(banner?.severity, "warning");
  assert.match(banner?.message || "", /一部が失敗しました/);
  assert.match(banner?.message || "", /3チャンク/);
});

test("buildAiReviewBanner: 完全失敗が部分失敗より優先", () => {
  const banner = buildAiReviewBanner({
    transcriptRefineFailed: true,
    transcriptErrorKind: "timeout",
    transcriptFailedChunks: 2,
  });
  assert.equal(banner?.severity, "error");
  assert.match(banner?.message || "", /タイムアウト/);
});
