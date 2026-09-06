import test from "node:test";
import assert from "node:assert/strict";
// main側の純ロジック(CJS)。ffprobe出力のパース・orientation解決はここが正本。
// @ts-expect-error CJSモジュール(型定義なし)をテストから直接読む
import orientation from "../main/orientation.cjs";
import { computeStageCanvasBox } from "../src/lib/telopPreviewSize.ts";

const { orientationFromDisplaySize, parseProbeOutput, resolveRunOrientationValue, sanitizeOrientation } =
  orientation;

/**
 * フェーズW8(素材選択時の縦横選択)のテスト。
 * - video:probe(ffprobe)出力のパース: rotation ±90/270 の表示寸法入替は
 *   python shared/ffmpeg_tools.get_video_metadata と同じ規則
 * - orientation.json(ユーザー選択) > preprocess(自動判定) > horizontal の優先順位
 * - プレビューのcontainedBoxのキャンバス基準計算(canvas未指定はvideo intrinsicへフォールバック)
 */

test("orientationFromDisplaySize: 幅>高さのみhorizontal(正方形はvertical=step01と同じ規則)", () => {
  assert.equal(orientationFromDisplaySize(1920, 1080), "horizontal");
  assert.equal(orientationFromDisplaySize(1080, 1920), "vertical");
  assert.equal(orientationFromDisplaySize(1080, 1080), "vertical");
});

test("sanitizeOrientation: horizontal/vertical以外はnull", () => {
  assert.equal(sanitizeOrientation("horizontal"), "horizontal");
  assert.equal(sanitizeOrientation("vertical"), "vertical");
  assert.equal(sanitizeOrientation("square"), null);
  assert.equal(sanitizeOrientation(undefined), null);
});

test("parseProbeOutput: rotationなしの横動画はそのままの寸法でhorizontal", () => {
  const stdout = JSON.stringify({
    streams: [{ codec_type: "video", width: 1920, height: 1080 }],
    format: { duration: "57.845" },
  });
  const result = parseProbeOutput(stdout);
  assert.deepEqual(result, {
    ok: true,
    displayWidth: 1920,
    displayHeight: 1080,
    rotation: 0,
    durationMs: 57845,
    orientation: "horizontal",
  });
});

test("parseProbeOutput: rotation=90は表示寸法を入替する(raw 1080x1920 → 表示1920x1080)", () => {
  const stdout = JSON.stringify({
    streams: [
      { codec_type: "audio" },
      {
        codec_type: "video",
        width: 1080,
        height: 1920,
        side_data_list: [{ side_data_type: "Display Matrix", rotation: 90 }],
      },
    ],
    format: { duration: "10.0" },
  });
  const result = parseProbeOutput(stdout);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.displayWidth, 1920);
    assert.equal(result.displayHeight, 1080);
    assert.equal(result.rotation, 90);
    assert.equal(result.orientation, "horizontal");
  }
});

test("parseProbeOutput: rotation=-90(iPhone縦撮り)は寸法入替でvertical判定になる", () => {
  const stdout = JSON.stringify({
    streams: [
      {
        codec_type: "video",
        width: 1920,
        height: 1080,
        side_data_list: [{ rotation: -90 }],
      },
    ],
    format: { duration: "5" },
  });
  const result = parseProbeOutput(stdout);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.displayWidth, 1080);
    assert.equal(result.displayHeight, 1920);
    assert.equal(result.orientation, "vertical");
  }
});

test("parseProbeOutput: rotation=180は寸法を入替しない", () => {
  const stdout = JSON.stringify({
    streams: [
      { codec_type: "video", width: 1920, height: 1080, side_data_list: [{ rotation: 180 }] },
    ],
  });
  const result = parseProbeOutput(stdout);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.displayWidth, 1920);
    assert.equal(result.displayHeight, 1080);
  }
});

test("parseProbeOutput: JSON不正・videoストリームなし・寸法0は ok:false", () => {
  assert.deepEqual(parseProbeOutput("not json"), { ok: false });
  assert.deepEqual(parseProbeOutput(JSON.stringify({ streams: [{ codec_type: "audio" }] })), { ok: false });
  assert.deepEqual(
    parseProbeOutput(JSON.stringify({ streams: [{ codec_type: "video", width: 0, height: 0 }] })),
    { ok: false },
  );
});

test("resolveRunOrientationValue: orientation.json(ユーザー選択)が最優先", () => {
  assert.equal(
    resolveRunOrientationValue({ version: 1, orientation: "vertical", source: "user" }, "horizontal"),
    "vertical",
  );
});

test("resolveRunOrientationValue: orientation.jsonなし・不正はpreprocessの自動判定へ", () => {
  assert.equal(resolveRunOrientationValue(null, "vertical"), "vertical");
  assert.equal(resolveRunOrientationValue({ orientation: "diagonal" }, "vertical"), "vertical");
});

test("resolveRunOrientationValue: どちらも無ければ従来既定のhorizontal", () => {
  assert.equal(resolveRunOrientationValue(null, undefined), "horizontal");
  assert.equal(resolveRunOrientationValue(null, "unknown"), "horizontal");
});

test("computeStageCanvasBox: キャンバス指定時はキャンバスのアスペクト基準でletterboxする", () => {
  // 横長ステージ(800x480)に縦キャンバス(1080x1920) → 高さいっぱい・左右に余白
  const box = computeStageCanvasBox(800, 480, 1080, 1920, 1920, 1080);
  assert.equal(box.height, 480);
  assert.equal(Math.round(box.width), 270);
  assert.equal(Math.round(box.offsetX), 265);
  assert.equal(box.offsetY, 0);
});

test("computeStageCanvasBox: キャンバス未指定(0/undefined)はvideo intrinsic基準へフォールバック", () => {
  const box = computeStageCanvasBox(800, 450, 0, 0, 1920, 1080);
  assert.equal(Math.round(box.width), 800);
  assert.equal(Math.round(box.height), 450);
  const boxUndefined = computeStageCanvasBox(800, 450, undefined, undefined, 1920, 1080);
  assert.deepEqual(boxUndefined, box);
});

test("computeStageCanvasBox: キャンバスとソースの向きが一致する場合は従来のcontain計算と同一", () => {
  // 16:9キャンバスを16:9より横長のステージへ → 高さ基準で左右レターボックス
  const box = computeStageCanvasBox(1000, 450, 1920, 1080, 1920, 1080);
  assert.equal(box.height, 450);
  assert.equal(box.width, 800);
  assert.equal(box.offsetX, 100);
});
