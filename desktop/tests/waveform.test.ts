import test from "node:test";
import assert from "node:assert/strict";
import {
  binIndexToMs,
  computePeaksFromPcm16,
  interpolateWaveformHeights,
  msToBinIndex,
  scaleWaveformPeaksGlobal,
  scaleWaveformPeaksLocal,
  sliceWaveformPeaks,
  smoothWaveformHeights,
} from "../src/lib/waveform.ts";

test("computePeaksFromPcm16 は空配列で空を返す", () => {
  assert.deepEqual(computePeaksFromPcm16([], { sampleRate: 8000, binMs: 20 }), []);
});

test("computePeaksFromPcm16 は binMs ごとの最大振幅を0-1に正規化して返す", () => {
  // sampleRate=1000Hz, binMs=10ms -> 10サンプル/ビン
  const samples = [
    0, 0, 0, 0, 0, 16384, 0, 0, 0, 0, // ビン0: ピーク16384 -> 0.5
    -32768, 10, 20, 30, 40, 50, 60, 70, 80, 90, // ビン1: ピーク32768 -> 1.0
  ];
  const peaks = computePeaksFromPcm16(samples, { sampleRate: 1000, binMs: 10 });
  assert.equal(peaks.length, 2);
  assert.equal(peaks[0], 0.5);
  assert.equal(peaks[1], 1);
});

test("computePeaksFromPcm16 はサンプル数がビン境界と揃わなくても最後のビンを含める", () => {
  const samples = [0, 0, 0, 5000];
  const peaks = computePeaksFromPcm16(samples, { sampleRate: 1000, binMs: 10 });
  assert.equal(peaks.length, 1);
  assert.ok(peaks[0] > 0);
});

test("msToBinIndex / binIndexToMs は相互に変換できる", () => {
  assert.equal(msToBinIndex(105, 20), 5);
  assert.equal(msToBinIndex(119, 20), 5);
  assert.equal(binIndexToMs(5, 20), 100);
});

test("sliceWaveformPeaks は指定範囲[startMs,endMs)のピークを抽出する", () => {
  const peaks = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  // binMs=20 -> index2(=40ms)からindex6(=120ms)を含む範囲
  const sliced = sliceWaveformPeaks(peaks, 20, 40, 120);
  assert.deepEqual(sliced, [2, 3, 4, 5, 6]);
});

test("sliceWaveformPeaks は範囲外にはみ出さないようクランプする", () => {
  const peaks = [0, 1, 2, 3, 4];
  assert.deepEqual(sliceWaveformPeaks(peaks, 20, -100, 1000), [0, 1, 2, 3, 4]);
  assert.deepEqual(sliceWaveformPeaks(peaks, 20, 1000, 2000), []);
});

test("sliceWaveformPeaks は空配列やendMs<=startMsで空を返す", () => {
  assert.deepEqual(sliceWaveformPeaks([], 20, 0, 100), []);
  assert.deepEqual(sliceWaveformPeaks([1, 2, 3], 20, 100, 50), []);
});

// --- 改善2: 波形の縦スケール改善(シーン行ミニ波形のローカル正規化+非線形カーブ) ---

test("scaleWaveformPeaksLocal: 空配列は空を返す", () => {
  assert.deepEqual(scaleWaveformPeaksLocal([]), []);
});

test("scaleWaveformPeaksLocal: 完全無音(全て0)は0のまま", () => {
  assert.deepEqual(scaleWaveformPeaksLocal([0, 0, 0]), [0, 0, 0]);
});

test("scaleWaveformPeaksLocal: ローカル最大値を1.0に正規化する", () => {
  const scaled = scaleWaveformPeaksLocal([0.05, 0.1]);
  assert.equal(scaled[1], 1, "最大値は正規化後ちょうど1になる");
});

test("scaleWaveformPeaksLocal: 非線形カーブ(既定1.2乗)で音量差を強調する", () => {
  const scaled = scaleWaveformPeaksLocal([0.05, 0.1]);
  assert.ok(scaled[0] < 0.5, "指数が1を超えるため中間音量は線形値より低くなる");
  assert.ok(Math.abs(scaled[0] - Math.pow(0.5, 1.2)) < 1e-9);
});

test("scaleWaveformPeaksLocal: globalMax省略時はローカル最大の2%未満を無音扱いにする(フォールバック)", () => {
  const scaled = scaleWaveformPeaksLocal([0.001, 1], { noiseFloorRatio: 0.02 });
  assert.equal(scaled[0], 0, "ローカル最大(1)の2%(0.02)未満の値は無音扱いになる");
  assert.equal(scaled[1], 1);
});

test("scaleWaveformPeaksLocal: 最大音量(1.0)は1のまま変化しない", () => {
  const scaled = scaleWaveformPeaksLocal([1, 1]);
  assert.deepEqual(scaled, [1, 1]);
});

test("scaleWaveformPeaksLocal: globalMaxを渡すと録音全体で見て無音同然の区間はローカル内でも0のままになる", () => {
  // このシーンの範囲内だけを見ると0.0012が「最大」だが、録音全体のグローバルピーク(1.0)から見れば
  // ノイズフロア以下の無音区間。globalMaxを渡さない場合は誤って持ち上がってしまう(下の対比参照)。
  const quietSlice = [0.001, 0.0012, 0.0009];
  const withoutGlobalMax = scaleWaveformPeaksLocal(quietSlice);
  assert.ok(withoutGlobalMax[1] > 0.9, "globalMaxを渡さない場合はローカル最大が持ち上がってしまう(フォールバック挙動)");

  const withGlobalMax = scaleWaveformPeaksLocal(quietSlice, { globalMax: 1 });
  assert.deepEqual(withGlobalMax, [0, 0, 0], "録音全体のグローバルピーク基準では無音区間のまま");
});

test("scaleWaveformPeaksLocal: 全体ピークより小さい区間はローカル最大でも低く描画される", () => {
  const scaled = scaleWaveformPeaksLocal([0.07, 0.1], { globalMax: 1 });
  assert.ok(scaled[1] < 0.3, "ローカル最大でも全体ピーク35%を分母にするため画面いっぱいまで伸びない");
  assert.ok(Math.abs(scaled[1] - Math.pow(0.1 / 0.35, 1.2)) < 1e-9);
});

test("編集波形: 小声を空白にせず低く残し、大声・完全無音と区別する", () => {
  const quiet = [0, 0.002, 0.015, 0.035, 0];
  assert.deepEqual(scaleWaveformPeaksLocal(quiet, { globalMax: 1 }), quiet.map(() => 0), "従来の表示では全て消える音量");
  const visible = scaleWaveformPeaksLocal(quiet, { globalMax: 1, preserveQuietPeaks: true });
  assert.equal(visible[0], 0);
  assert.equal(visible[4], 0);
  for (const height of visible.slice(1, 4)) assert.ok(height > 0 && height <= 0.075);
  assert.ok(visible[1] < visible[2] && visible[2] < visible[3], "小声内でも音量差を残す");
  const loud = scaleWaveformPeaksLocal([0.4, 1], { globalMax: 1, preserveQuietPeaks: true });
  assert.ok(loud[0] > visible[3]);
  assert.equal(loud[1], 1);
  assert.deepEqual(scaleWaveformPeaksLocal([0, 0], { globalMax: 1, preserveQuietPeaks: true }), [0, 0]);
});

test("scaleWaveformPeaksGlobal: 完全無音(全て0)は0のまま", () => {
  assert.deepEqual(scaleWaveformPeaksGlobal([0, 0]), [0, 0]);
});

test("scaleWaveformPeaksGlobal: 再正規化はせず非線形カーブだけを適用する", () => {
  const scaled = scaleWaveformPeaksGlobal([0.1, 0.5, 1]);
  assert.ok(Math.abs(scaled[0] - Math.pow(0.1, 1.2)) < 1e-9);
  assert.ok(Math.abs(scaled[1] - Math.pow(0.5, 1.2)) < 1e-9);
  assert.equal(scaled[2], 1);
});

test("scaleWaveformPeaksGlobal: ノイズフロア(観測されたグローバルピークの6%)以下は0のまま無音として区別する", () => {
  const scaled = scaleWaveformPeaksGlobal([0.06, 1]);
  assert.equal(scaled[0], 0, "グローバルピーク(1)の6%(0.06)以下なので無音扱い");
  assert.equal(scaled[1], 1);
});

// --- 改善3(波形の描画改善): ビン単位のピークをcanvas実ピクセル幅へ補間・平滑化する ---

test("interpolateWaveformHeights: 空配列はwidthPx分の0配列を返す", () => {
  assert.deepEqual(interpolateWaveformHeights([], 5), [0, 0, 0, 0, 0]);
});

test("interpolateWaveformHeights: 要素数1のピークはwidthPx全体に同じ値を敷き詰める", () => {
  assert.deepEqual(interpolateWaveformHeights([0.7], 4), [0.7, 0.7, 0.7, 0.7]);
});

test("interpolateWaveformHeights: 1pxまで縮小してもNaNにならず区間のピークを残す", () => {
  for (const width of [0, 0.3, 1]) {
    assert.deepEqual(interpolateWaveformHeights([0, 0.8, 0.2], width), [0.8]);
  }
});

test("interpolateWaveformHeights: 両端はピーク配列の両端の値と一致する", () => {
  const result = interpolateWaveformHeights([0, 1], 5);
  assert.equal(result.length, 5);
  assert.equal(result[0], 0);
  assert.equal(result[result.length - 1], 1);
});

test("interpolateWaveformHeights: ビン間を線形補間する(中間値は単調に増加する)", () => {
  const result = interpolateWaveformHeights([0, 1], 5);
  for (let i = 1; i < result.length; i += 1) {
    assert.ok(result[i] >= result[i - 1], "0->1の単調増加区間で逆転しない");
  }
  assert.ok(Math.abs(result[2] - 0.5) < 1e-9, "ちょうど中間点は0.5に近い");
});

test("interpolateWaveformHeights: widthPxが元のビン数より少ない場合は各px内の最大値で縮小する", () => {
  const result = interpolateWaveformHeights([0, 0.2, 0.4, 0.6, 0.8, 1], 3);
  assert.deepEqual(result, [0.2, 0.6, 1]);
});

test("interpolateWaveformHeights: 長いシーンのどこに短い音があっても縮小で消えない", () => {
  for (let index = 0; index < 641; index++) {
    const peaks = new Array(641).fill(0);
    peaks[index] = 0.8;
    const result = interpolateWaveformHeights(peaks, 63);
    assert.equal(Math.max(...result), 0.8, `${index}番目の短い発話が残る`);
    assert.equal(result.filter((value) => value > 0).length, 1, "区間を広げず対応する1px内だけ残す");
  }
});

test("smoothWaveformHeights: radius=0は元の配列をそのまま返す(コピー)", () => {
  const heights = [0, 1, 0, 1, 0];
  const result = smoothWaveformHeights(heights, 0);
  assert.deepEqual(result, heights);
  assert.notEqual(result, heights, "元配列への参照ではなくコピーを返す");
});

test("smoothWaveformHeights: 移動平均で単発のスパイクをなめらかにする", () => {
  const heights = [0, 0, 1, 0, 0];
  const result = smoothWaveformHeights(heights, 1);
  assert.ok(result[2] < 1, "自分自身のピークも近傍の0で平均されて下がる");
  assert.ok(result[1] > 0, "隣接要素はスパイクの影響を受けて持ち上がる");
  assert.ok(result[0] === 0, "2つ離れた要素は半径1の平均に含まれないため影響を受けない");
});

test("smoothWaveformHeights: 配列端は範囲内の要素だけで平均する(端が不当に薄まらない)", () => {
  const heights = [1, 1, 1];
  const result = smoothWaveformHeights(heights, 1);
  assert.deepEqual(result, [1, 1, 1], "全要素同値なら平滑化しても値は変わらない");
});
