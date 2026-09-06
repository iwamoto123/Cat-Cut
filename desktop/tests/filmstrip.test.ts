import test from "node:test";
import assert from "node:assert/strict";
import {
  filmstripFrameTimesMs,
  filmstripIndexForRatio,
  filmstripMsForRatio,
  filmstripPopupLeftPx,
  formatFilmstripTime,
} from "../src/lib/filmstrip.ts";

// フェーズU9(フィルムストリップ): サムネ枚数/位置計算のテスト。

test("filmstripFrameTimesMs: ビン中央の時刻を返す(main側の抽出規則と同一)", () => {
  const times = filmstripFrameTimesMs(4, 8000);
  assert.deepEqual(times, [1000, 3000, 5000, 7000]);
});

test("filmstripFrameTimesMs: 末尾は動画長-1msを越えない", () => {
  const times = filmstripFrameTimesMs(1, 1000);
  assert.deepEqual(times, [500]);
  const edge = filmstripFrameTimesMs(2, 1);
  assert.ok(edge.every((ms) => ms <= 0));
});

test("filmstripFrameTimesMs: 不正入力は空配列", () => {
  assert.deepEqual(filmstripFrameTimesMs(0, 8000), []);
  assert.deepEqual(filmstripFrameTimesMs(10, 0), []);
});

test("filmstripIndexForRatio: 横位置0〜1をフレーム番号へ量子化しクランプ", () => {
  assert.equal(filmstripIndexForRatio(0, 48), 0);
  assert.equal(filmstripIndexForRatio(0.5, 48), 24);
  assert.equal(filmstripIndexForRatio(0.999, 48), 47);
  assert.equal(filmstripIndexForRatio(1, 48), 47); // ちょうど1でも範囲内
  assert.equal(filmstripIndexForRatio(-0.5, 48), 0);
  assert.equal(filmstripIndexForRatio(2, 48), 47);
});

test("filmstripMsForRatio: クリックシークの時刻(0〜durationにクランプ)", () => {
  assert.equal(filmstripMsForRatio(0.25, 60000), 15000);
  assert.equal(filmstripMsForRatio(-1, 60000), 0);
  assert.equal(filmstripMsForRatio(2, 60000), 60000);
});

test("filmstripPopupLeftPx: カーソル追従・帯からはみ出さない", () => {
  // 中央追従
  assert.equal(filmstripPopupLeftPx(400, 160, 800), 320);
  // 左端クランプ
  assert.equal(filmstripPopupLeftPx(10, 160, 800), 0);
  // 右端クランプ
  assert.equal(filmstripPopupLeftPx(790, 160, 800), 640);
  // ポップアップが帯より広い場合も負にならない
  assert.equal(filmstripPopupLeftPx(50, 900, 800), 0);
});

test("formatFilmstripTime: mm:ss表記", () => {
  assert.equal(formatFilmstripTime(0), "00:00");
  assert.equal(formatFilmstripTime(65000), "01:05");
  assert.equal(formatFilmstripTime(-5), "00:00");
});
