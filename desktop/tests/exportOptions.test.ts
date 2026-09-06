import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPORT_HARDWARE_ENCODE_DEFAULT,
  buildExportOutputPath,
  concurrencyForRenderSpeed,
  crfForQuality,
  defaultExportFileName,
  ensureMp4FileName,
  formatProjectDuration,
  formatProjectTimestamp,
  initialExportFileName,
  targetShortSideForResolution,
  videoBitrateForQuality,
} from "../src/lib/exportOptions.ts";

test("targetShortSideForResolution: 元のサイズは0(=上限なし)", () => {
  assert.equal(targetShortSideForResolution("source"), 0);
  assert.equal(targetShortSideForResolution("1080"), 1080);
  assert.equal(targetShortSideForResolution("720"), 720);
});

test("crfForQuality: 標準は0(=Remotion既定)、高画質<軽量", () => {
  assert.equal(crfForQuality("standard"), 0);
  const high = crfForQuality("high");
  const light = crfForQuality("light");
  assert.ok(high >= 1 && high <= 51);
  assert.ok(light >= 1 && light <= 51);
  assert.ok(high < light, "CRFは小さいほど高画質");
});

test("concurrencyForRenderSpeed: 標準4・高速6・最高8", () => {
  assert.equal(concurrencyForRenderSpeed("standard"), 4);
  assert.equal(concurrencyForRenderSpeed("fast"), 6);
  assert.equal(concurrencyForRenderSpeed("max"), 8);
});

test("W11-1b videoBitrateForQuality: 1080p基準で高16M/標準10M/軽量6M", () => {
  assert.equal(videoBitrateForQuality("high", "1080"), "16000k");
  assert.equal(videoBitrateForQuality("standard", "1080"), "10000k");
  assert.equal(videoBitrateForQuality("light", "1080"), "6000k");
});

test("W11-1b videoBitrateForQuality: 720pは各60%、元のサイズは1080p扱い", () => {
  assert.equal(videoBitrateForQuality("high", "720"), "9600k");
  assert.equal(videoBitrateForQuality("standard", "720"), "6000k");
  assert.equal(videoBitrateForQuality("light", "720"), "3600k");
  assert.equal(videoBitrateForQuality("high", "source"), "16000k");
  assert.equal(videoBitrateForQuality("standard", "source"), "10000k");
});

test("W11-1b: ハードウェアエンコードの既定はON", () => {
  assert.equal(EXPORT_HARDWARE_ENCODE_DEFAULT, true);
});

test("ensureMp4FileName: 拡張子をmp4に正規化する", () => {
  assert.equal(ensureMp4FileName("video"), "video.mp4");
  assert.equal(ensureMp4FileName("video.mov"), "video.mp4");
  assert.equal(ensureMp4FileName("video.MP4"), "video.MP4");
  assert.equal(ensureMp4FileName("  "), "");
});

test("defaultExportFileName: 元動画名から生成する", () => {
  assert.equal(defaultExportFileName("/Users/a/Downloads/対談動画.m4v"), "対談動画_catcut.mp4");
  assert.equal(defaultExportFileName(""), "catcut-output_catcut.mp4");
});

test("W11-4a initialExportFileName: 元動画名から _catcut なしで毎回生成する", () => {
  assert.equal(initialExportFileName("/Users/a/Downloads/対談動画.mp4", ""), "対談動画.mp4");
  assert.equal(initialExportFileName("/Users/a/Downloads/対談動画.mov", "/Users/a/Desktop"), "対談動画.mp4");
  assert.equal(initialExportFileName("", ""), "catcut-output.mp4");
});

test("W11-4a initialExportFileName: 出力パスが元動画と一致する場合のみ _catcut を付ける", () => {
  // 保存場所=元動画のフォルダ かつ 元動画が.mp4 → そのままだと上書きになるため _catcut 付き
  assert.equal(initialExportFileName("/Users/a/Downloads/対談動画.mp4", "/Users/a/Downloads"), "対談動画_catcut.mp4");
  // 末尾スラッシュの揺れも同一視する
  assert.equal(initialExportFileName("/Users/a/Downloads/対談動画.mp4", "/Users/a/Downloads/"), "対談動画_catcut.mp4");
  // 元動画が.mov等なら出力の.mp4とはパスが一致しないので _catcut 不要
  assert.equal(initialExportFileName("/Users/a/Downloads/対談動画.mov", "/Users/a/Downloads"), "対談動画.mp4");
  // 別フォルダなら一致しない
  assert.equal(initialExportFileName("/Users/a/Downloads/対談動画.mp4", "/Users/a/Desktop"), "対談動画.mp4");
});

test("buildExportOutputPath: 保存場所未指定は空(=作業フォルダ内)、指定時は結合", () => {
  assert.equal(buildExportOutputPath("", "a.mp4", "/v/video.mp4"), "");
  assert.equal(buildExportOutputPath("/out/", "a.mov", "/v/video.mp4"), "/out/a.mp4");
  assert.equal(buildExportOutputPath("/out", "", "/v/video.mp4"), "/out/video_catcut.mp4");
});

test("formatProjectDuration: 分秒と時分秒", () => {
  assert.equal(formatProjectDuration(65_000), "1:05");
  assert.equal(formatProjectDuration(3_750_000), "1:02:30");
  assert.equal(formatProjectDuration(0), "0:00");
});

test("formatProjectTimestamp: YYYY-MM-DD HH:mm(0は空文字)", () => {
  assert.equal(formatProjectTimestamp(0), "");
  const formatted = formatProjectTimestamp(new Date(2026, 6, 8, 18, 35).getTime());
  assert.equal(formatted, "2026-07-08 18:35");
});
