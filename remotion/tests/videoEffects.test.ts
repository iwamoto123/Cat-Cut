import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DIM_OPACITY,
  DEFAULT_FACE_ZOOM_SCALE,
  DEFAULT_PINCH_BRIGHTNESS,
  DEFAULT_PINCH_SCALE,
  DEFAULT_SLOW_PUSH_SCALE,
  DEFAULT_ZOOM_FOCUS,
  DEFAULT_ZOOM_SCALE,
  DIM_EDGE_MS,
  FACE_ZOOM_FALLBACK_FOCUS,
  PINCH_EDGE_MS,
  VIDEO_EFFECT_SFX_VOLUME,
  ZOOM_EASE_MS,
  activeVideoEffectAt,
  normalizeVideoEffects,
  videoEffectStyle,
  type VideoEffect,
} from "../src/lib/videoEffects.ts";

/**
 * フェーズW2(シーン映像ギミック): timeline.video_effects の正規化と
 * videoEffectStyle の時刻別出力(プレビューと書き出しMP4が共有する計算)のテスト。
 */

test("normalizeVideoEffects: 省略・不正は空配列(後方互換)", () => {
  assert.deepEqual(normalizeVideoEffects(undefined), []);
  assert.deepEqual(normalizeVideoEffects(null), []);
  assert.deepEqual(normalizeVideoEffects("bad"), []);
  assert.deepEqual(normalizeVideoEffects({}), []);
  assert.deepEqual(normalizeVideoEffects([]), []);
});

test("normalizeVideoEffects: step08出力スキーマをそのまま受ける", () => {
  const effects = normalizeVideoEffects([
    {
      id: "ve_001",
      type: "pinch",
      start_ms: 10000,
      end_ms: 15000,
      slot_id: "s1",
      params: { scale: 0.9, brightness: 0.6 },
      sfx: "teen",
    },
    {
      id: "ve_002",
      type: "zoom",
      start_ms: 60000,
      end_ms: 65000,
      slot_id: "s2",
      params: { scale: 1.25, focus: { x: 0.5, y: 0.35 } },
    },
  ]);
  assert.equal(effects.length, 2);
  assert.equal(effects[0].type, "pinch");
  assert.equal(effects[0].params.scale, 0.9);
  assert.equal(effects[0].params.brightness, 0.6);
  assert.equal(effects[0].sfx, "teen");
  assert.equal(effects[1].type, "zoom");
  assert.deepEqual(effects[1].params.focus, { x: 0.5, y: 0.35 });
  assert.equal(effects[1].sfx, undefined);
});

test("normalizeVideoEffects: 不正エントリは捨て、範囲外パラメータは既定へ落とす", () => {
  const effects = normalizeVideoEffects([
    { type: "unknown", start_ms: 0, end_ms: 1000 },
    { type: "pinch", start_ms: 5000, end_ms: 5000 }, // 区間ゼロ
    { type: "pinch", start_ms: "x", end_ms: 1000 }, // 数値でない
    // pinchのscale>1やbrightness>1は既定値へ
    { type: "pinch", start_ms: 0, end_ms: 2000, params: { scale: 1.5, brightness: 2 } },
    // zoomのscale<1・focus範囲外はクランプ/既定へ
    { type: "zoom", start_ms: 10000, end_ms: 12000, params: { scale: 0.5, focus: { x: 2, y: -1 } } },
  ]);
  assert.equal(effects.length, 2);
  assert.equal(effects[0].params.scale, DEFAULT_PINCH_SCALE);
  assert.equal(effects[0].params.brightness, DEFAULT_PINCH_BRIGHTNESS);
  assert.equal(effects[1].params.scale, DEFAULT_ZOOM_SCALE);
  assert.deepEqual(effects[1].params.focus, { x: 1, y: 0 });
});

test("normalizeVideoEffects: start_ms昇順へ整列しIDを補完する", () => {
  const effects = normalizeVideoEffects([
    { type: "zoom", start_ms: 60000, end_ms: 65000 },
    { type: "pinch", start_ms: 10000, end_ms: 15000 },
  ]);
  assert.deepEqual(
    effects.map((effect) => [effect.type, effect.start_ms]),
    [
      ["pinch", 10000],
      ["zoom", 60000],
    ],
  );
  assert.ok(effects.every((effect) => effect.id.length > 0));
});

const PINCH: VideoEffect = {
  id: "ve_001",
  type: "pinch",
  start_ms: 10000,
  end_ms: 15000,
  slot_id: "s1",
  params: { scale: 0.9, brightness: 0.6 },
  sfx: "teen",
};

const ZOOM: VideoEffect = {
  id: "ve_002",
  type: "zoom",
  start_ms: 60000,
  end_ms: 65000,
  slot_id: "s2",
  params: { scale: 1.25, focus: { x: 0.5, y: 0.35 } },
};

test("activeVideoEffectAt: 区間中のみ効果を返す(端点はstart含む・end含まない)", () => {
  const effects = [PINCH, ZOOM];
  assert.equal(activeVideoEffectAt(effects, 9999), null);
  assert.equal(activeVideoEffectAt(effects, 10000)?.id, "ve_001");
  assert.equal(activeVideoEffectAt(effects, 14999)?.id, "ve_001");
  assert.equal(activeVideoEffectAt(effects, 15000), null);
  assert.equal(activeVideoEffectAt(effects, 62000)?.id, "ve_002");
});

test("videoEffectStyle(pinch): 区間外はnull・出入り150ms ease・定常部はscale/brightness維持", () => {
  assert.equal(videoEffectStyle(PINCH, 9999), null);
  assert.equal(videoEffectStyle(PINCH, 15000), null);

  // 開始点: まだ変形なし(progress=0)
  const atStart = videoEffectStyle(PINCH, 10000);
  assert.ok(atStart);
  assert.equal(atStart.transform, "scale(1)");
  assert.equal(atStart.filter, "brightness(1)");

  // ease完了後(開始+150ms)〜終了-150msの定常部: 指定値そのまま
  const steady = videoEffectStyle(PINCH, 10000 + PINCH_EDGE_MS);
  assert.ok(steady);
  assert.equal(steady.transform, "scale(0.9)");
  assert.equal(steady.filter, "brightness(0.6)");
  assert.equal(steady.transformOrigin, "center center");
  const midway = videoEffectStyle(PINCH, 12500);
  assert.ok(midway);
  assert.equal(midway.transform, "scale(0.9)");

  // 出入りの途中は1.0と0.9の間(単調に変化する)
  const entering = videoEffectStyle(PINCH, 10075);
  assert.ok(entering);
  const enteringScale = Number(entering.transform.match(/scale\(([\d.]+)\)/)?.[1]);
  assert.ok(enteringScale < 1 && enteringScale > 0.9);

  // 終了直前も戻りかけ(端点150ms以内)
  const leaving = videoEffectStyle(PINCH, 14999);
  assert.ok(leaving);
  const leavingScale = Number(leaving.transform.match(/scale\(([\d.]+)\)/)?.[1]);
  assert.ok(leavingScale > 0.9);
});

test("videoEffectStyle(pinch): 300ms未満の短い区間でも出入りが潰れない(半分ずつease)", () => {
  const short: VideoEffect = { ...PINCH, start_ms: 0, end_ms: 200 };
  const mid = videoEffectStyle(short, 100);
  assert.ok(mid);
  assert.equal(mid.transform, "scale(0.9)");
  const start = videoEffectStyle(short, 0);
  assert.ok(start);
  assert.equal(start.transform, "scale(1)");
});

test("videoEffectStyle(zoom): focus原点で500ms ease-out→区間終端まで維持", () => {
  assert.equal(videoEffectStyle(ZOOM, 59999), null);
  assert.equal(videoEffectStyle(ZOOM, 65000), null);

  const atStart = videoEffectStyle(ZOOM, 60000);
  assert.ok(atStart);
  assert.equal(atStart.transform, "scale(1)");
  assert.equal(atStart.transformOrigin, "50% 35%");
  assert.equal(atStart.filter, undefined);

  // ease-out: 半分の時点で線形(0.5)より進んでいる
  const half = videoEffectStyle(ZOOM, 60000 + ZOOM_EASE_MS / 2);
  assert.ok(half);
  const halfScale = Number(half.transform.match(/scale\(([\d.]+)\)/)?.[1]);
  assert.ok(halfScale > 1 + (1.25 - 1) * 0.5);
  assert.ok(halfScale < 1.25);

  // 到達後は終端まで1.25を維持
  const reached = videoEffectStyle(ZOOM, 60000 + ZOOM_EASE_MS);
  assert.ok(reached);
  assert.equal(reached.transform, "scale(1.25)");
  const nearEnd = videoEffectStyle(ZOOM, 64999);
  assert.ok(nearEnd);
  assert.equal(nearEnd.transform, "scale(1.25)");
});

test("定数: teen SFXは音量0.3・focus既定は中央やや上", () => {
  assert.equal(VIDEO_EFFECT_SFX_VOLUME, 0.3);
  assert.deepEqual({ ...DEFAULT_ZOOM_FOCUS }, { x: 0.5, y: 0.35 });
});

// ---- フェーズW24 Phase C: dim / face_zoom / slow_push ----

test("normalizeVideoEffects(Phase C): 新3種のstep08出力スキーマを受け、範囲外は既定へ落とす", () => {
  const effects = normalizeVideoEffects([
    { id: "ve_001", type: "dim", start_ms: 0, end_ms: 3000, slot_id: "s1", params: { opacity: 0.5 } },
    {
      id: "ve_002",
      type: "face_zoom",
      start_ms: 10000,
      end_ms: 14000,
      slot_id: "s2",
      params: { scale: 1.15, focus: { x: 0.62, y: 0.28 } },
    },
    { id: "ve_003", type: "slow_push", start_ms: 20000, end_ms: 26000, slot_id: "c3", params: { scale: 1.06 } },
    // 範囲外パラメータは既定へ(dim opacity>0.7 / face_zoom scale>1.5 / slow_push scale>1.2)
    { type: "dim", start_ms: 30000, end_ms: 32000, params: { opacity: 0.9 } },
    { type: "face_zoom", start_ms: 40000, end_ms: 42000, params: { scale: 2.0 } },
    { type: "slow_push", start_ms: 50000, end_ms: 52000, params: { scale: 1.5 } },
  ]);
  assert.equal(effects.length, 6);
  assert.equal(effects[0].type, "dim");
  assert.equal(effects[0].params.opacity, 0.5);
  assert.equal(effects[1].type, "face_zoom");
  assert.equal(effects[1].params.scale, 1.15);
  assert.deepEqual(effects[1].params.focus, { x: 0.62, y: 0.28 });
  assert.equal(effects[2].type, "slow_push");
  assert.equal(effects[2].params.scale, 1.06);
  assert.equal(effects[3].params.opacity, DEFAULT_DIM_OPACITY);
  assert.equal(effects[4].params.scale, DEFAULT_FACE_ZOOM_SCALE);
  // face_zoomのfocus欠落は中央上寄りフォールバック
  assert.deepEqual(effects[4].params.focus, { ...FACE_ZOOM_FALLBACK_FOCUS });
  assert.equal(effects[5].params.scale, DEFAULT_SLOW_PUSH_SCALE);
  // 新3種はいずれもSFXなし
  assert.ok(effects.slice(0, 3).every((effect) => effect.sfx === undefined));
});

const DIM: VideoEffect = {
  id: "ve_010",
  type: "dim",
  start_ms: 10000,
  end_ms: 14000,
  slot_id: "s1",
  params: { scale: 1, opacity: 0.5 },
};

test("videoEffectStyle(dim): 出入り300ms easeでbrightnessだけ下げる(transformは変えない)", () => {
  assert.equal(videoEffectStyle(DIM, 9999), null);
  assert.equal(videoEffectStyle(DIM, 14000), null);

  const atStart = videoEffectStyle(DIM, 10000);
  assert.ok(atStart);
  assert.equal(atStart.transform, "none");
  assert.equal(atStart.filter, "brightness(1)");

  // ease完了後の定常部: 黒50%オーバーレイ相当 = brightness(0.5)
  const steady = videoEffectStyle(DIM, 10000 + DIM_EDGE_MS);
  assert.ok(steady);
  assert.equal(steady.transform, "none");
  assert.equal(steady.filter, "brightness(0.5)");
  const mid = videoEffectStyle(DIM, 12000);
  assert.ok(mid);
  assert.equal(mid.filter, "brightness(0.5)");

  // 出入りの途中は 0.5〜1.0 の間で単調に変化する
  const entering = videoEffectStyle(DIM, 10150);
  assert.ok(entering);
  const enteringBrightness = Number(entering.filter?.match(/brightness\(([\d.]+)\)/)?.[1]);
  assert.ok(enteringBrightness > 0.5 && enteringBrightness < 1);
  const leaving = videoEffectStyle(DIM, 13999);
  assert.ok(leaving);
  const leavingBrightness = Number(leaving.filter?.match(/brightness\(([\d.]+)\)/)?.[1]);
  assert.ok(leavingBrightness > 0.5);
});

const FACE_ZOOM: VideoEffect = {
  id: "ve_011",
  type: "face_zoom",
  start_ms: 20000,
  end_ms: 24000,
  slot_id: "s2",
  params: { scale: 1.15, focus: { x: 0.62, y: 0.28 } },
};

test("videoEffectStyle(face_zoom): 顔focus原点で区間全長かけて1.0→1.15へease-in-out", () => {
  assert.equal(videoEffectStyle(FACE_ZOOM, 19999), null);
  assert.equal(videoEffectStyle(FACE_ZOOM, 24000), null);

  const atStart = videoEffectStyle(FACE_ZOOM, 20000);
  assert.ok(atStart);
  assert.equal(atStart.transform, "scale(1)");
  assert.equal(atStart.transformOrigin, "62% 28.000000000000004%");
  assert.equal(atStart.filter, undefined);

  // 中点でちょうど半分(smoothstep(0.5)=0.5)
  const mid = videoEffectStyle(FACE_ZOOM, 22000);
  assert.ok(mid);
  const midScale = Number(mid.transform.match(/scale\(([\d.]+)\)/)?.[1]);
  assert.ok(Math.abs(midScale - 1.075) < 1e-9);

  // ease-in: 序盤は線形より遅い / 終端付近でほぼ1.15へ到達
  const early = videoEffectStyle(FACE_ZOOM, 21000);
  assert.ok(early);
  const earlyScale = Number(early.transform.match(/scale\(([\d.]+)\)/)?.[1]);
  assert.ok(earlyScale > 1 && earlyScale < 1 + (1.15 - 1) * 0.25);
  const nearEnd = videoEffectStyle(FACE_ZOOM, 23999);
  assert.ok(nearEnd);
  const nearEndScale = Number(nearEnd.transform.match(/scale\(([\d.]+)\)/)?.[1]);
  assert.ok(nearEndScale > 1.149 && nearEndScale <= 1.15);
});

const SLOW_PUSH: VideoEffect = {
  id: "ve_012",
  type: "slow_push",
  start_ms: 30000,
  end_ms: 40000,
  slot_id: "c3",
  params: { scale: 1.06 },
};

test("videoEffectStyle(slow_push): 中央原点で区間全長かけて1.0→1.06へ線形に寄せ続ける", () => {
  assert.equal(videoEffectStyle(SLOW_PUSH, 29999), null);
  assert.equal(videoEffectStyle(SLOW_PUSH, 40000), null);

  const atStart = videoEffectStyle(SLOW_PUSH, 30000);
  assert.ok(atStart);
  assert.equal(atStart.transform, "scale(1)");
  assert.equal(atStart.transformOrigin, "center center");
  assert.equal(atStart.filter, undefined);

  // 線形: 中点でちょうど半分
  const mid = videoEffectStyle(SLOW_PUSH, 35000);
  assert.ok(mid);
  assert.equal(mid.transform, "scale(1.03)");

  const nearEnd = videoEffectStyle(SLOW_PUSH, 39999);
  assert.ok(nearEnd);
  const nearEndScale = Number(nearEnd.transform.match(/scale\(([\d.]+)\)/)?.[1]);
  assert.ok(nearEndScale > 1.0599 && nearEndScale <= 1.06);
});
