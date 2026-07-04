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

test("buildAiReviewBanner: パス1失敗で強い警告バナー", () => {
  const banner = buildAiReviewBanner({
    transcriptRefineFailed: true,
    transcriptRefineFailureReason: "api_error: The read operation timed out",
  });
  assert.ok(banner);
  assert.equal(banner?.severity, "error");
  assert.match(banner?.message || "", /AI校正が実行できませんでした/);
  assert.match(banner?.message || "", /未校正です/);
  assert.match(banner?.message || "", /timed out/);
});

test("buildAiReviewBanner: パス2失敗で強い警告バナー", () => {
  const banner = buildAiReviewBanner({
    telopRefineFailed: true,
    telopRefineFailureReason: "api_error: connection reset",
  });
  assert.ok(banner);
  assert.equal(banner?.severity, "error");
  assert.match(banner?.message || "", /パス2/);
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
    transcriptRefineFailureReason: "api_error: boom",
    transcriptFailedChunks: 2,
  });
  assert.equal(banner?.severity, "error");
});
