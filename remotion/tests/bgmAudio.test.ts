import test from "node:test";
import assert from "node:assert/strict";
import {
  BGM_DEFAULT_VOLUME,
  bgmVolumeAtMs,
  bgmVolumeAtTimelineMs,
  normalizeBgmTrack,
  type BgmClipData,
} from "../src/lib/bgmAudio.ts";

// フェーズU9(BGMトラック): timeline.bgm 正規化とフェード音量カーブのテスト。

const CLIP: BgmClipData = {
  id: "bgm_1",
  file: "/tmp/bgm.mp3",
  start_ms: 2000,
  end_ms: 12000,
  volume: 0.4,
  fade_in_ms: 1000,
  fade_out_ms: 2000,
};

test("normalizeBgmTrack: bgmキーなし・非配列・空配列は空(後方互換)", () => {
  assert.deepEqual(normalizeBgmTrack(undefined), []);
  assert.deepEqual(normalizeBgmTrack(null), []);
  assert.deepEqual(normalizeBgmTrack("garbage"), []);
  assert.deepEqual(normalizeBgmTrack([]), []);
});

test("normalizeBgmTrack: 不正エントリを除外し有効なものだけ残す", () => {
  const clips = normalizeBgmTrack([
    null,
    { file: "", start_ms: 0, end_ms: 5000 },
    { file: "/a.mp3", start_ms: 5000, end_ms: 5000 }, // 区間ゼロ
    { file: "/a.mp3", start_ms: "x", end_ms: 5000 }, // 数値でない
    { file: "/ok.mp3", start_ms: 0, end_ms: 5000, volume: 0.2, fade_in_ms: 100, fade_out_ms: 200 },
  ]);
  assert.equal(clips.length, 1);
  assert.equal(clips[0].file, "/ok.mp3");
  assert.equal(clips[0].volume, 0.2);
});

test("normalizeBgmTrack: 欠落フィールドは既定値で補完・start昇順に整列", () => {
  const clips = normalizeBgmTrack([
    { file: "/b.mp3", start_ms: 8000, end_ms: 9000 },
    { file: "/a.mp3", start_ms: 0, end_ms: 5000 },
  ]);
  assert.equal(clips.length, 2);
  assert.equal(clips[0].file, "/a.mp3");
  assert.equal(clips[1].file, "/b.mp3");
  assert.equal(clips[0].volume, BGM_DEFAULT_VOLUME);
  assert.equal(clips[0].fade_in_ms, 0);
  assert.equal(clips[0].fade_out_ms, 0);
  assert.ok(clips[0].id.length > 0);
});

test("normalizeBgmTrack: 音量0〜1クランプ・フェードはクリップ長へ丸め", () => {
  const clips = normalizeBgmTrack([
    { file: "/a.mp3", start_ms: 0, end_ms: 1000, volume: 5, fade_in_ms: 9999, fade_out_ms: -100 },
  ]);
  assert.equal(clips[0].volume, 1);
  assert.equal(clips[0].fade_in_ms, 1000);
  assert.equal(clips[0].fade_out_ms, 0);
});

test("bgmVolumeAtMs: フェードイン中は線形に立ち上がる", () => {
  assert.equal(bgmVolumeAtMs(CLIP, 0), 0);
  assert.ok(Math.abs(bgmVolumeAtMs(CLIP, 500) - 0.2) < 1e-9); // 半分=0.4*0.5
  assert.ok(Math.abs(bgmVolumeAtMs(CLIP, 1000) - 0.4) < 1e-9); // フェードイン完了
});

test("bgmVolumeAtMs: 中央はベース音量・フェードアウトは線形に減衰", () => {
  assert.ok(Math.abs(bgmVolumeAtMs(CLIP, 5000) - 0.4) < 1e-9);
  // クリップ長10000ms・fade_out 2000ms → 残り1000ms時点でゲイン0.5
  assert.ok(Math.abs(bgmVolumeAtMs(CLIP, 9000) - 0.2) < 1e-9);
});

test("bgmVolumeAtMs: 区間外は0", () => {
  assert.equal(bgmVolumeAtMs(CLIP, -1), 0);
  assert.equal(bgmVolumeAtMs(CLIP, 10000), 0); // end(半開区間)
  assert.equal(bgmVolumeAtMs(CLIP, 99999), 0);
});

test("bgmVolumeAtMs: フェードが重なる短クリップは両カーブのmin(音が跳ねない)", () => {
  const short: BgmClipData = { ...CLIP, start_ms: 0, end_ms: 1000, fade_in_ms: 1000, fade_out_ms: 1000 };
  // 中央(500ms)= min(0.5, 0.5) = 0.5ゲイン
  assert.ok(Math.abs(bgmVolumeAtMs(short, 500) - 0.4 * 0.5) < 1e-9);
  // 前半はフェードイン支配、後半はフェードアウト支配
  assert.ok(Math.abs(bgmVolumeAtMs(short, 250) - 0.4 * 0.25) < 1e-9);
  assert.ok(Math.abs(bgmVolumeAtMs(short, 750) - 0.4 * 0.25) < 1e-9);
});

test("bgmVolumeAtTimelineMs: タイムラインms基準で同じカーブになる", () => {
  assert.equal(bgmVolumeAtTimelineMs(CLIP, 2000), bgmVolumeAtMs(CLIP, 0));
  assert.equal(bgmVolumeAtTimelineMs(CLIP, 7000), bgmVolumeAtMs(CLIP, 5000));
  assert.equal(bgmVolumeAtTimelineMs(CLIP, 0), 0);
});

test("フェードなしクリップは全域ベース音量", () => {
  const flat: BgmClipData = { ...CLIP, fade_in_ms: 0, fade_out_ms: 0 };
  assert.equal(bgmVolumeAtMs(flat, 0), 0.4);
  assert.equal(bgmVolumeAtMs(flat, 9999), 0.4);
});
