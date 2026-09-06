import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SFX_VOLUME,
  SFX_IDS,
  SFX_MIN_INTERVAL_MS,
  computeSfxEvents,
  isRepeatedSfx,
  resolveTelopSfxId,
  sanitizeSfxVolume,
} from "../src/lib/telopSfx.ts";

/**
 * フェーズT3(テロップ効果音)の解決・最小間隔ガード・音量正規化のテスト。
 */

test("SFX_IDS: 同梱6種(assets/sfx/ と同期。フェーズW2でteen追加)", () => {
  assert.deepEqual([...SFX_IDS], ["don", "shakin", "pon", "jan", "hyu", "teen"]);
  assert.equal(SFX_MIN_INTERVAL_MS, 5000);
});

test("resolveTelopSfxId: telop明示 > プリセット既定 > なし の順で解決する", () => {
  // telopのID指定が最優先
  assert.equal(resolveTelopSfxId({ sfx: "jan" }, { sfx: "don" }), "jan");
  // telop未指定ならプリセット既定
  assert.equal(resolveTelopSfxId({}, { sfx: "don" }), "don");
  // どちらも無ければnull
  assert.equal(resolveTelopSfxId({}, {}), null);
  assert.equal(resolveTelopSfxId({}, undefined), null);
});

test('resolveTelopSfxId: null/false/"none"は明示OFF(プリセット既定より優先)', () => {
  assert.equal(resolveTelopSfxId({ sfx: null }, { sfx: "don" }), null);
  assert.equal(resolveTelopSfxId({ sfx: false }, { sfx: "don" }), null);
  assert.equal(resolveTelopSfxId({ sfx: "none" }, { sfx: "don" }), null);
  // プリセット側の"none"も鳴らさない
  assert.equal(resolveTelopSfxId({}, { sfx: "none" }), null);
});

test("sanitizeSfxVolume: 0〜1へクランプ・不正値は既定0.25", () => {
  assert.equal(sanitizeSfxVolume(0.5), 0.5);
  assert.equal(sanitizeSfxVolume(0), 0);
  assert.equal(sanitizeSfxVolume(2), 1);
  assert.equal(sanitizeSfxVolume(-1), 0);
  assert.equal(sanitizeSfxVolume(undefined), DEFAULT_SFX_VOLUME);
  assert.equal(sanitizeSfxVolume("abc"), DEFAULT_SFX_VOLUME);
});

/** computeSfxEvents 用の最小コンポジション素材を組み立てる。 */
function buildInput(telopsByCut: Array<Array<Record<string, unknown>>>, cutStartsMs: number[]) {
  return {
    cuts: telopsByCut.map((_telops, index) => ({
      cut_id: `cut_${String(index + 1).padStart(3, "0")}`,
      timeline: { start_ms: cutStartsMs[index] ?? 0 },
    })),
    voiceCuts: telopsByCut.map((telops, index) => ({
      id: `cut_${String(index + 1).padStart(3, "0")}`,
      voice: { words: [] },
      telops: telops as never,
    })),
    styles: {
      emotion_red: { sfx: "don" },
      fact_yellow: {},
    },
    fps: 30,
  };
}

test("computeSfxEvents: テロップ表示開始フレームにイベントを置く(タイムラインms基準)", () => {
  const input = buildInput(
    [[{ id: "p1", style: "emotion_red", start: 1.0, end: 3.0 }]],
    [2000],
  );
  const events = computeSfxEvents(input);
  assert.equal(events.length, 1);
  assert.equal(events[0].sfxId, "don");
  // (カット頭2000ms + 相対1000ms) / 1000 * 30fps = 90フレーム
  assert.equal(events[0].frame, 90);
  assert.equal(events[0].telopId, "p1");
});

test("computeSfxEvents: 最小間隔5秒未満のSEはスキップされる(決定的ガード)", () => {
  // W13-5の連続同一sfx抑止と観点を分けるため、sfxは交互にして間隔ガードだけを見る
  const input = buildInput(
    [[
      { id: "p1", style: "emotion_red", start: 0.0, end: 2.0 },
      { id: "p2", style: "fact_yellow", sfx: "shakin", start: 3.0, end: 5.0 },
      { id: "p3", style: "fact_yellow", sfx: "don", start: 6.0, end: 8.0 },
    ]],
    [0],
  );
  const events = computeSfxEvents(input);
  // p1(0秒)採用 → p2(3秒)は間隔3秒<5秒でスキップ → p3(6秒)は間隔6秒で採用
  // (p3はdonだが「直前のsfx付きスロット」p2はshakinなのでW13-5の抑止対象にならない)
  assert.deepEqual(events.map((event) => event.telopId), ["p1", "p3"]);
});

test("computeSfxEvents: minIntervalMs指定でガード間隔を変えられる", () => {
  const input = {
    ...buildInput(
      [[
        { id: "p1", style: "emotion_red", start: 0.0, end: 2.0 },
        { id: "p2", style: "fact_yellow", sfx: "jan", start: 3.0, end: 5.0 },
      ]],
      [0],
    ),
    minIntervalMs: 2000,
  };
  assert.equal(computeSfxEvents(input).length, 2);
});

test("W13-5 computeSfxEvents: 直前スロットと同じsfxは間隔が空いても鳴らさない(アニメ側は影響なし)", () => {
  const input = buildInput(
    [[
      { id: "p1", style: "emotion_red", start: 0.0, end: 2.0 }, // don
      { id: "p2", style: "emotion_red", start: 6.0, end: 8.0 }, // don(間隔6秒>5秒でも同一sfxで抑止)
      { id: "p3", style: "fact_yellow", sfx: "shakin", start: 12.0, end: 14.0 }, // 別sfxは鳴る
      { id: "p4", style: "emotion_red", start: 18.0, end: 20.0 }, // 直前スロットはshakinなのでdonは鳴る
    ]],
    [0],
  );
  const events = computeSfxEvents(input);
  assert.deepEqual(
    events.map((event) => [event.telopId, event.sfxId]),
    [["p1", "don"], ["p3", "shakin"], ["p4", "don"]],
  );
});

test("W13-5 computeSfxEvents: sfxなしスロットを挟んでも「直前のsfx付きスロット」で判定する", () => {
  const input = buildInput(
    [[
      { id: "p1", style: "emotion_red", start: 0.0, end: 2.0 }, // don
      { id: "p2", style: "fact_yellow", start: 6.0, end: 8.0 }, // sfxなし(候補にならない)
      { id: "p3", style: "emotion_red", start: 12.0, end: 14.0 }, // don=直前sfx付きスロットp1と同一→抑止
    ]],
    [0],
  );
  const events = computeSfxEvents(input);
  assert.deepEqual(events.map((event) => event.telopId), ["p1"]);
});

test("W13-5 isRepeatedSfx: 共有判定関数(プレビューも同じ関数を使う)", () => {
  assert.equal(isRepeatedSfx(null, "don"), false);
  assert.equal(isRepeatedSfx(undefined, "don"), false);
  assert.equal(isRepeatedSfx("don", "don"), true);
  assert.equal(isRepeatedSfx("shakin", "don"), false);
});

test("computeSfxEvents: telop.sfx明示IDはプリセットより優先、null/none/プリセット無指定は鳴らない", () => {
  const input = buildInput(
    [[
      { id: "p1", style: "fact_yellow", sfx: "hyu", start: 0.0, end: 2.0 },
      { id: "p2", style: "emotion_red", sfx: null, start: 10.0, end: 12.0 },
      { id: "p3", style: "fact_yellow", start: 20.0, end: 22.0 },
    ]],
    [0],
  );
  const events = computeSfxEvents(input);
  assert.deepEqual(events.map((event) => [event.telopId, event.sfxId]), [["p1", "hyu"]]);
});

test("computeSfxEvents: 明示start/endが無いテロップはword_indicesの先頭語開始を使う", () => {
  const input = {
    cuts: [{ cut_id: "cut_001", timeline: { start_ms: 0 } }],
    voiceCuts: [{
      id: "cut_001",
      voice: { words: [{ start: 0.5, end: 1.0 }, { start: 1.2, end: 2.0 }] },
      telops: [{ id: "p1", style: "emotion_red", word_indices: [1] }],
    }],
    styles: { emotion_red: { sfx: "don" } },
    fps: 30,
  };
  const events = computeSfxEvents(input);
  assert.equal(events.length, 1);
  assert.equal(events[0].frame, Math.round(1.2 * 30));
});

test("computeSfxEvents: カット跨ぎでも時系列でガードが効く", () => {
  const input = buildInput(
    [
      [{ id: "p1", style: "emotion_red", start: 0.0, end: 2.0 }],
      [{ id: "p2", style: "emotion_red", start: 0.0, end: 2.0 }],
    ],
    [0, 3000], // cut_002はタイムライン3秒から
  );
  const events = computeSfxEvents(input);
  assert.deepEqual(events.map((event) => event.telopId), ["p1"], "3秒差は5秒ガードでスキップ");
});
