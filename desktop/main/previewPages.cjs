"use strict";

const path = require("path");

/**
 * 旧テロップ検品画面用のページ情報を既存カットから組み立てる。
 * 現編集画面は元動画と仮想プレイリストで再生するため、ここで全編結合動画を生成しない。
 * カット動画が無ければ従来のfallbackと同様、そのページを省略する。
 */
function buildPreviewPagesFromComposition(composition, compositionPath, registerVideo) {
  const cuts = composition?.timeline?.cuts || [];
  const voiceCuts = new Map((composition?.voice_data?.cuts || []).map((cut) => [cut.id, cut]));
  const displayWidth = Number(composition?.meta?.display_width || 1280);
  const displayHeight = Number(composition?.meta?.display_height || 720);
  const result = [];

  for (const cut of cuts) {
    const pages = cut?.telop?.pages || [];
    if (!pages.length) continue;
    const rawVideoPath = cut?.video?.file_path;
    if (!rawVideoPath) continue;
    const videoPath = path.isAbsolute(rawVideoPath)
      ? rawVideoPath
      : path.resolve(path.dirname(compositionPath), rawVideoPath);
    const videoUrl = registerVideo(videoPath);
    if (!videoUrl) continue;

    const cutDurationMs =
      Number(cut?.video?.end_ms || 0) - Number(cut?.video?.start_ms || 0) ||
      Number(cut?.timeline?.end_ms || 0) - Number(cut?.timeline?.start_ms || 0);
    const sourceStartMs = Number(cut?.video?.start_ms || 0);
    const voiceCut = voiceCuts.get(cut.cut_id);
    const voiceWords = voiceCut?.voice?.words || [];
    const voiceTelops = voiceCut?.telops || [];

    const telopRange = (index) => {
      const telop = voiceTelops[index];
      if (typeof telop?.start === "number" && typeof telop?.end === "number" && telop.end > telop.start) {
        return {
          pageStartMs: Math.max(0, Math.floor(telop.start * 1000)),
          pageEndMs: Math.max(0, Math.floor(telop.end * 1000)),
        };
      }
      const indices = telop?.word_indices || [];
      if (!indices.length || !voiceWords.length) {
        return {
          pageStartMs: Math.max(0, Math.floor((cutDurationMs * index) / pages.length)),
          pageEndMs: Math.max(0, Math.floor((cutDurationMs * (index + 1)) / pages.length)),
        };
      }
      const firstWord = voiceWords[Math.min(...indices)];
      const lastWord = voiceWords[Math.max(...indices)];
      const nextIndices = voiceTelops[index + 1]?.word_indices || [];
      const nextWord = nextIndices.length ? voiceWords[Math.min(...nextIndices)] : null;
      const pageStartMs = Math.max(0, Math.floor(Number(firstWord?.start || 0) * 1000));
      const pageEndMs = Math.max(
        pageStartMs + 100,
        Math.floor(Number((nextWord || lastWord)?.[nextWord ? "start" : "end"] || 0) * 1000),
      );
      return { pageStartMs, pageEndMs };
    };

    pages.forEach((page, index) => {
      const { pageStartMs, pageEndMs } = telopRange(index);
      result.push({
        pageId: page.id,
        cutId: cut.cut_id,
        videoUrl,
        startMs: sourceStartMs + pageStartMs,
        endMs: sourceStartMs + pageEndMs,
        displayWidth,
        displayHeight,
      });
    });
  }
  return result;
}

module.exports = { buildPreviewPagesFromComposition };
