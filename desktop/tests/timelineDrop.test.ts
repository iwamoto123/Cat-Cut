import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyDropFileName,
  classifyDropMimeType,
  dropTimelineMs,
} from "../src/lib/timelineDrop.ts";

// フェーズV6-4(画像・BGMのD&D): 拡張子/MIMEの振り分けとドロップ位置計算のテスト。

test("classifyDropFileName: 画像拡張子はimageへ振り分け(大文字・複合名も可)", () => {
  assert.equal(classifyDropFileName("shot.png"), "image");
  assert.equal(classifyDropFileName("Photo.JPG"), "image");
  assert.equal(classifyDropFileName("a.b.c.jpeg"), "image");
  assert.equal(classifyDropFileName("anim.webp"), "image");
  assert.equal(classifyDropFileName("loop.gif"), "image");
});

test("classifyDropFileName: 音声拡張子はbgmへ振り分け", () => {
  assert.equal(classifyDropFileName("music.mp3"), "bgm");
  assert.equal(classifyDropFileName("track.WAV"), "bgm");
  assert.equal(classifyDropFileName("voice.m4a"), "bgm");
  assert.equal(classifyDropFileName("sound.aac"), "bgm");
});

test("classifyDropFileName: 対象外拡張子・拡張子なしはnull(非対応の形式)", () => {
  assert.equal(classifyDropFileName("movie.mp4"), null);
  assert.equal(classifyDropFileName("doc.pdf"), null);
  assert.equal(classifyDropFileName("noext"), null);
  assert.equal(classifyDropFileName(""), null);
});

test("classifyDropMimeType: image/*→image、audio/*→bgm、それ以外はnull", () => {
  assert.equal(classifyDropMimeType("image/png"), "image");
  assert.equal(classifyDropMimeType("IMAGE/JPEG"), "image");
  assert.equal(classifyDropMimeType("audio/mpeg"), "bgm");
  assert.equal(classifyDropMimeType("video/mp4"), null);
  assert.equal(classifyDropMimeType(""), null);
});

test("dropTimelineMs: X座標→タイムラインms(負は0へ、整数へ丸め)", () => {
  assert.equal(dropTimelineMs(100, 0.01), 10000);
  assert.equal(dropTimelineMs(-5, 0.01), 0);
  assert.equal(dropTimelineMs(33, 0.01), 3300);
  assert.equal(dropTimelineMs(100, 0), 0); // 倍率ゼロ(未計測)は0固定
});
