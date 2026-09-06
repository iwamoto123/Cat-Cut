import test from "node:test";
import assert from "node:assert/strict";
import type { BgmClipData } from "../src/lib/bgmAudio.ts";
import {
  BGM_MIN_CLIP_MS,
  dragBgmVolume,
  moveBgmClip,
  nextBgmClipStartMs,
  removeBgmClip,
  replaceBgmClip,
  resizeBgmClip,
  setBgmFade,
  setBgmVolume,
} from "../src/lib/bgmClips.ts";

// フェーズU9(BGMトラック): クリップのドラッグ計算(移動・伸縮・フェード・音量)のテスト。

const CLIP: BgmClipData = {
  id: "bgm_1",
  file: "music.mp3",
  start_ms: 10000,
  end_ms: 40000,
  volume: 0.15,
  fade_in_ms: 1500,
  fade_out_ms: 1500,
};

const BOUNDS = { timelineDurationMs: 60000, audioDurationMs: 45000, snapMs: 150 };

// --- moveBgmClip(バー本体ドラッグ=移動) ---

test("moveBgmClip: 長さを保ったまま平行移動する", () => {
  const moved = moveBgmClip(CLIP, 5000, BOUNDS);
  assert.equal(moved.start_ms, 15000);
  assert.equal(moved.end_ms, 45000);
});

test("moveBgmClip: 左端0msを越えない", () => {
  const moved = moveBgmClip(CLIP, -99999, BOUNDS);
  assert.equal(moved.start_ms, 0);
  assert.equal(moved.end_ms, 30000);
});

test("moveBgmClip: 右端はタイムライン総尺を越えない", () => {
  const moved = moveBgmClip(CLIP, 99999, BOUNDS);
  assert.equal(moved.end_ms, 60000);
  assert.equal(moved.start_ms, 30000);
});

test("moveBgmClip: 0ms付近でスナップ", () => {
  const moved = moveBgmClip(CLIP, -9900, BOUNDS); // start=100 → snap 0
  assert.equal(moved.start_ms, 0);
});

test("moveBgmClip: 総尺端付近でスナップ", () => {
  const moved = moveBgmClip(CLIP, 19900, BOUNDS); // end=59900 → snap 60000
  assert.equal(moved.end_ms, 60000);
});

test("moveBgmClip: 総尺不明(0)でも左端クランプだけは効く", () => {
  const moved = moveBgmClip(CLIP, 999999, { timelineDurationMs: 0 });
  assert.equal(moved.start_ms, 1009999); // クランプなしで移動(右端制約なし)
  const movedLeft = moveBgmClip(CLIP, -999999, { timelineDurationMs: 0 });
  assert.equal(movedLeft.start_ms, 0);
});

// --- resizeBgmClip(左右端ドラッグ=伸縮) ---

test("resizeBgmClip: 開始端を右へ動かして短縮できる", () => {
  const resized = resizeBgmClip(CLIP, "start", 5000, BOUNDS);
  assert.equal(resized.start_ms, 15000);
  assert.equal(resized.end_ms, 40000);
});

test("resizeBgmClip: 最小尺を下回らない", () => {
  const resized = resizeBgmClip(CLIP, "start", 99999, BOUNDS);
  assert.equal(resized.end_ms - resized.start_ms, BGM_MIN_CLIP_MS);
  const resizedEnd = resizeBgmClip(CLIP, "end", -99999, BOUNDS);
  assert.equal(resizedEnd.end_ms - resizedEnd.start_ms, BGM_MIN_CLIP_MS);
});

test("resizeBgmClip: 音源長より長くはできない", () => {
  // audio 45000ms なので end は start+45000=55000 まで
  const resized = resizeBgmClip(CLIP, "end", 99999, BOUNDS);
  assert.equal(resized.end_ms, 55000);
  // 開始端も同様(end 40000固定で start >= 40000-45000 → 0だがaudio長が利く境界を確認)
  const shortAudio = resizeBgmClip(CLIP, "start", -99999, { ...BOUNDS, audioDurationMs: 32000 });
  assert.equal(shortAudio.start_ms, 8000); // 40000-32000
});

test("resizeBgmClip: 終了端はタイムライン総尺を越えない・端でスナップ", () => {
  const resized = resizeBgmClip(CLIP, "end", 30000, { ...BOUNDS, audioDurationMs: 0 });
  assert.equal(resized.end_ms, 60000); // 総尺クランプ
  const snapped = resizeBgmClip(CLIP, "end", 19900, { ...BOUNDS, audioDurationMs: 0 });
  assert.equal(snapped.end_ms, 60000); // 59900 → snap
});

test("resizeBgmClip: 開始端は0でスナップ", () => {
  const clip = { ...CLIP, start_ms: 100, end_ms: 30100 };
  const snapped = resizeBgmClip(clip, "start", -50, { ...BOUNDS, audioDurationMs: 45000 });
  assert.equal(snapped.start_ms, 0);
});

test("resizeBgmClip: 短縮でフェードがクリップ長へ丸められる", () => {
  const clip = { ...CLIP, fade_in_ms: 20000, fade_out_ms: 20000 };
  const resized = resizeBgmClip(clip, "end", -25000, BOUNDS); // 長さ5000へ
  assert.equal(resized.end_ms - resized.start_ms, 5000);
  assert.equal(resized.fade_in_ms, 5000);
  assert.equal(resized.fade_out_ms, 5000);
});

// --- フェード・音量・配列操作 ---

test("setBgmFade: フェード長は0〜クリップ長にクランプ", () => {
  assert.equal(setBgmFade(CLIP, "start", 5000).fade_in_ms, 5000);
  assert.equal(setBgmFade(CLIP, "start", -100).fade_in_ms, 0);
  assert.equal(setBgmFade(CLIP, "end", 99999).fade_out_ms, 30000);
});

test("setBgmVolume: 0〜1にクランプ・0.1%刻みへ丸め", () => {
  assert.equal(setBgmVolume(CLIP, 0.4564).volume, 0.456);
  assert.equal(setBgmVolume(CLIP, 0.0104).volume, 0.01);
  assert.equal(setBgmVolume(CLIP, 0.0106).volume, 0.011);
  assert.equal(setBgmVolume(CLIP, -1).volume, 0);
  assert.equal(setBgmVolume(CLIP, 2).volume, 1);
});

// --- フェーズV1(タイムラインView): 音量エンベロープの上下ドラッグ ---

test("dragBgmVolume: 上ドラッグ(負のdeltaY)で音量が上がる", () => {
  // 高さ40pxを100%として、-8px = +20%
  assert.equal(dragBgmVolume(CLIP, 0.15, -8, 40).volume, 0.35);
});

test("dragBgmVolume: 下ドラッグで音量が下がり0で止まる", () => {
  assert.equal(dragBgmVolume(CLIP, 0.15, 4, 40).volume, 0.05);
  assert.equal(dragBgmVolume(CLIP, 0.15, 999, 40).volume, 0);
});

test("dragBgmVolume: 100%を超えない・高さ0は変更なし", () => {
  assert.equal(dragBgmVolume(CLIP, 0.9, -999, 40).volume, 1);
  assert.equal(dragBgmVolume(CLIP, 0.15, -8, 0).volume, CLIP.volume);
});

test("replaceBgmClip / removeBgmClip", () => {
  const other: BgmClipData = { ...CLIP, id: "bgm_2", start_ms: 50000, end_ms: 55000 };
  const clips = [CLIP, other];
  const replaced = replaceBgmClip(clips, { ...CLIP, volume: 0.5 });
  assert.equal(replaced[0].volume, 0.5);
  assert.equal(replaced[1], other);
  const removed = removeBgmClip(clips, "bgm_1");
  assert.deepEqual(removed.map((clip) => clip.id), ["bgm_2"]);
});

// --- V6-5: 「+ BGM」の追加開始位置 ---

test("nextBgmClipStartMs: 既存クリップ最後尾の終端に続ける(1本目は0)", () => {
  assert.equal(nextBgmClipStartMs([]), 0);
  assert.equal(nextBgmClipStartMs([{ end_ms: 40000 }]), 40000);
  // 配列順(レーン順)に依らず、一番遅い終端を採用する
  assert.equal(nextBgmClipStartMs([{ end_ms: 55000 }, { end_ms: 40000 }]), 55000);
});
