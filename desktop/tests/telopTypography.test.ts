import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitTypographyRuns } from "../src/lib/telopTypography.ts";

/**
 * タイポグラフィ(助詞縮小・和欧混植)のデスクトップ側コピーのテスト。
 * ロジック本体のテストは remotion/tests/telopTypography.test.ts にあり、
 * ここでは「プレビューと書き出しで同じ字組みになる」ことを保証する。
 */

test("telopTypography: Remotion側のコピーと完全一致している(プレビュー/書き出しの字組み同一保証)", () => {
  const desktopSource = readFileSync(
    join(import.meta.dirname, "../src/lib/telopTypography.ts"),
    "utf-8",
  );
  const remotionSource = readFileSync(
    join(import.meta.dirname, "../../remotion/src/lib/telopTypography.ts"),
    "utf-8",
  );
  assert.equal(
    desktopSource,
    remotionSource,
    "desktop/src/lib/telopTypography.ts と remotion/src/lib/telopTypography.ts の内容が食い違っている。片方を変更したらもう片方へコピーすること",
  );
});

test("splitTypographyRuns: 助詞縮小と和欧混植の基本動作", () => {
  assert.deepEqual(splitTypographyRuns("昨年の平均点が3.5点下落"), [
    { text: "昨年", kind: "normal" },
    { text: "の", kind: "particle" },
    { text: "平均点", kind: "normal" },
    { text: "が", kind: "particle" },
    { text: "3.5", kind: "latin" },
    { text: "点下落", kind: "normal" },
  ]);
});
