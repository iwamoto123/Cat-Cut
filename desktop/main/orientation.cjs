"use strict";

/**
 * フェーズW8(素材選択時の縦横選択): 縦横判定・orientation解決の純ロジック。
 * main/index.cjs から使うほか、node --test(tests/orientationW8.test.ts)から直接importして
 * 検証できるよう副作用なしの関数だけを置く。
 * 判定規則は python/shared/ffmpeg_tools.get_video_metadata / step01_preprocess と同一:
 * - side_data_list の rotation が ±90/270 なら表示上の width/height を入れ替える
 * - 表示幅 > 表示高さ なら horizontal、それ以外(正方形含む)は vertical
 */

/** "horizontal" | "vertical" 以外は null に落とす。 */
function sanitizeOrientation(value) {
  return value === "horizontal" || value === "vertical" ? value : null;
}

/** 表示寸法(rotation適用後)から縦横を判定する(step01_preprocess と同じ規則)。 */
function orientationFromDisplaySize(displayWidth, displayHeight) {
  return Number(displayWidth) > Number(displayHeight) ? "horizontal" : "vertical";
}

/**
 * ffprobe(-print_format json -show_streams -show_format)の標準出力から
 * video:probe IPC の結果を組み立てる。videoストリームが無い・寸法不明・JSON不正は { ok: false }。
 */
function parseProbeOutput(stdoutText) {
  let data;
  try {
    data = JSON.parse(String(stdoutText || ""));
  } catch {
    return { ok: false };
  }
  const streams = Array.isArray(data?.streams) ? data.streams : [];
  const video = streams.find((stream) => stream && stream.codec_type === "video");
  if (!video) return { ok: false };

  let rotation = 0;
  const sideDataList = Array.isArray(video.side_data_list) ? video.side_data_list : [];
  for (const sideData of sideDataList) {
    if (sideData && sideData.rotation !== undefined) {
      rotation = Math.trunc(Number(sideData.rotation)) || 0;
      break;
    }
  }

  const rawWidth = Number(video.width) || 0;
  const rawHeight = Number(video.height) || 0;
  if (!rawWidth || !rawHeight) return { ok: false };

  const swapped = Math.abs(rotation) === 90 || Math.abs(rotation) === 270;
  const displayWidth = swapped ? rawHeight : rawWidth;
  const displayHeight = swapped ? rawWidth : rawHeight;
  const durationSeconds = Number(data?.format?.duration);
  const durationMs = Number.isFinite(durationSeconds) ? Math.round(durationSeconds * 1000) : 0;

  return {
    ok: true,
    displayWidth,
    displayHeight,
    rotation,
    durationMs,
    orientation: orientationFromDisplaySize(displayWidth, displayHeight),
  };
}

/**
 * runの実効orientationを解決する: orientation.json(ユーザー選択の正本)を最優先し、
 * 無い・不正なら preprocess.orientation、それも無ければ horizontal(従来の既定)。
 */
function resolveRunOrientationValue(orientationJson, preprocessOrientation) {
  const userOrientation = sanitizeOrientation(orientationJson ? orientationJson.orientation : null);
  if (userOrientation) return userOrientation;
  return sanitizeOrientation(preprocessOrientation) || "horizontal";
}

module.exports = {
  sanitizeOrientation,
  orientationFromDisplaySize,
  parseProbeOutput,
  resolveRunOrientationValue,
};
