/**
 * Phase C (C-1/C-2): 波形ミニ表示のための純関数群。
 * - PCMサンプルからのピーク(ビン)計算
 * - ms <-> ビンindex変換
 * - カットカード表示用の範囲スライス
 *
 * main プロセス（main/index.cjs の computeWaveformPeaks）でも同一アルゴリズムを使用する。
 * main(CJS)とこのファイル(ESM/TS。Viteでレンダラー側にバンドルされ、テストは
 * `node --experimental-strip-types` で直接実行される)は実行時のモジュール形式が異なり
 * 直接 import/require で共有できないため、ロジックを複製している。
 * アルゴリズムを変更する場合は両方を同期すること。
 */

export type WaveformPeaksOptions = {
  /** PCMのサンプリングレート(Hz) */
  sampleRate: number;
  /** 1ビンあたりの時間幅(ms)。既定20ms */
  binMs: number;
};

/**
 * 16bit符号付きPCM(モノラル)のサンプル列から、binMsごとの最大振幅を
 * 0〜1に正規化(フルスケール=32768基準)したピーク配列を計算する。
 */
export function computePeaksFromPcm16(
  samples: Int16Array | ArrayLike<number>,
  options: WaveformPeaksOptions,
): number[] {
  const { sampleRate, binMs } = options;
  const totalSamples = samples.length;
  if (totalSamples === 0) return [];
  const samplesPerBin = Math.max(1, Math.round((sampleRate * binMs) / 1000));
  const binCount = Math.max(1, Math.ceil(totalSamples / samplesPerBin));
  const peaks = new Array<number>(binCount).fill(0);
  for (let bin = 0; bin < binCount; bin += 1) {
    const start = bin * samplesPerBin;
    const end = Math.min(totalSamples, start + samplesPerBin);
    let peak = 0;
    for (let i = start; i < end; i += 1) {
      const value = Math.abs(samples[i]);
      if (value > peak) peak = value;
    }
    peaks[bin] = peak;
  }
  return peaks.map((value) => Math.round((value / 32768) * 1000) / 1000);
}

export type WaveformCurveOptions = {
  /** 非線形カーブの指数。1超の値で小音量を抑え、音量差を強調する。既定1.2。 */
  curveExponent?: number;
  /** ノイズフロア比率(0〜1)。基準ピーク(ローカル最大 or フルスケール1.0)に対してこの比率以下は無音(0)扱い。既定0.06。 */
  noiseFloorRatio?: number;
};

const DEFAULT_CURVE_EXPONENT = 1.2;
const DEFAULT_NOISE_FLOOR_RATIO = 0.06;

/**
 * Math.max(...peaks) はビン数が多い(60分級長尺など)場合に引数展開でスタックサイズの上限に
 * 触れる可能性があるため、ループで安全に最大値を求める。呼び出し側(SceneWaveformStripなど)が
 * 録音全体のグローバルピークを都度再計算せずに済むよう、公開関数としても提供する
 * (App.tsx側でwaveform読み込み時に1回だけ計算してprops経由で配ることを想定)。
 */
export function computePeakMax(values: number[]): number {
  let max = 0;
  for (const value of values) {
    if (value > max) max = value;
  }
  return max;
}

export type LocalWaveformCurveOptions = WaveformCurveOptions & {
  /** 編集用は小声や息も低い波形で残す。表示だけの指定で、無音カットの判定は変更しない。 */
  preserveQuietPeaks?: boolean;
  /**
   * ノイズフロア判定の基準にする「録音全体のグローバルピーク」。省略時はこの関数に渡された
   * peaks自身の最大値で代替する(呼び出し側で全体ピークを渡せない場合のフォールバック)。
   * ローカル最大値だけをノイズフロアの基準にすると、録音全体で見れば無音同然の静かな区間でも
   * ストリップ内では相対的に「最大」になってしまい、ノイズが音声のように持ち上がって見えてしまう
   * ため、正規化(スケール)の基準と無音判定の基準を分離している。
   */
  globalMax?: number;
};

/**
 * シーン行ミニ波形向け(改善2「波形の縦スケール改善」節): 渡されたピーク配列(=表示範囲内に
 * スライス済みのもの)をローカル最大と録音全体ピークの35%の大きい方で正規化し、
 * 非線形カーブ(振幅^curveExponent、既定1.2)で音量差を強調する。
 * ノイズフロア(既定は録音全体のグローバルピークの6%)以下の値は0(無音)のまま区別する。
 */
export function scaleWaveformPeaksLocal(peaks: number[], options: LocalWaveformCurveOptions = {}): number[] {
  if (!peaks.length) return [];
  const curveExponent = options.curveExponent ?? DEFAULT_CURVE_EXPONENT;
  const noiseFloorRatio = options.noiseFloorRatio ?? DEFAULT_NOISE_FLOOR_RATIO;
  const localMax = computePeakMax(peaks);
  if (localMax <= 0) return peaks.map(() => 0);
  const noiseFloorReferenceMax = options.globalMax ?? localMax;
  const noiseFloor = noiseFloorReferenceMax * noiseFloorRatio;
  const normalizationMax = Math.max(localMax, noiseFloorReferenceMax * 0.35);
  return peaks.map((value) => {
    if (value <= noiseFloor && (!options.preserveQuietPeaks || value <= 0)) return 0;
    const normalized = Math.max(0, Math.min(1, value / normalizationMax));
    const height = Math.pow(normalized, curveExponent);
    // ノイズフロア以下は40px帯で最大約3px。小声を完全な無音と誤認させず、音量差も保つ。
    return value <= noiseFloor ? Math.min(0.075, height) : height;
  });
}

/**
 * 全体ナビバー向け(改善2「波形の縦スケール改善」節): 入力ピークは既にグローバル正規化済み
 * (0〜1、フルスケール基準)であることを前提とし、値自体の再正規化はしない(=グローバル正規化を
 * 維持する)。ノイズフロアは録音全体(=渡されたpeaks全体)の観測最大値を基準に判定し、
 * それに満たない値と非線形カーブ(振幅^curveExponent)を適用する。
 */
export function scaleWaveformPeaksGlobal(peaks: number[], options: WaveformCurveOptions = {}): number[] {
  if (!peaks.length) return [];
  const curveExponent = options.curveExponent ?? DEFAULT_CURVE_EXPONENT;
  const noiseFloorRatio = options.noiseFloorRatio ?? DEFAULT_NOISE_FLOOR_RATIO;
  const globalMax = computePeakMax(peaks);
  if (globalMax <= 0) return peaks.map(() => 0);
  const noiseFloor = globalMax * noiseFloorRatio;
  return peaks.map((value) => {
    if (value <= noiseFloor) return 0;
    const normalized = Math.max(0, Math.min(1, value));
    return Math.pow(normalized, curveExponent);
  });
}

/**
 * 改善3(波形の描画改善): scaleWaveformPeaksLocal/Global後のピーク配列(ビン単位、間隔は
 * binMs=20msなど粗い)を、canvasの実ピクセル幅ぶんの配列へ線形補間する。
 * ビンをそのまま棒として描画すると(シーンが短い/canvas幅が広い場合)棒同士の間隔が粗くなるため、
 * 1px刻みでサンプルし直すことで「棒の幅を細く高密度に」を満たしつつ、面グラフとして
 * なめらかに繋げて描画できるようにする。縮小時は各px内の最大値を残し、短い発話を
 * 点サンプリングの隙間へ落とさない。
 */
export function interpolateWaveformHeights(peaks: number[], widthPx: number): number[] {
  const targetLength = Math.max(1, Math.round(widthPx));
  if (!peaks.length) return new Array(targetLength).fill(0);
  if (targetLength === 1) return [computePeakMax(peaks)];
  if (peaks.length === 1) return new Array(targetLength).fill(peaks[0]);
  const result = new Array<number>(targetLength);
  if (peaks.length > targetLength) {
    for (let x = 0; x < targetLength; x += 1) {
      const start = Math.floor(x * peaks.length / targetLength);
      const end = Math.floor((x + 1) * peaks.length / targetLength);
      let peak = 0;
      for (let index = start; index < end; index += 1) peak = Math.max(peak, peaks[index]);
      result[x] = peak;
    }
    return result;
  }
  const lastIndex = peaks.length - 1;
  for (let x = 0; x < targetLength; x += 1) {
    // targetLengthが1のケースは上のガードで弾いているためtargetLength-1>=1が保証される。
    const position = (x / (targetLength - 1)) * lastIndex;
    const lowerIndex = Math.floor(position);
    const upperIndex = Math.min(lastIndex, lowerIndex + 1);
    const ratio = position - lowerIndex;
    result[x] = peaks[lowerIndex] + (peaks[upperIndex] - peaks[lowerIndex]) * ratio;
  }
  return result;
}

/**
 * 改善3(波形の描画改善): interpolateWaveformHeightsで得た1px刻みの高さ配列に、
 * 軽い移動平均(既定半径2px)をかけて輪郭をなめらかにする(角の丸い面グラフ的な見た目にする)。
 * ノイズフロアで既に0になっている完全無音区間は、平滑化で周囲の音量が漏れ出して
 * 持ち上がってしまわないよう、0はそのまま0として扱う(0近傍への平均は許容する)。
 */
export function smoothWaveformHeights(heights: number[], radius = 2): number[] {
  if (!heights.length || radius <= 0) return heights.slice();
  const result = new Array<number>(heights.length);
  for (let i = 0; i < heights.length; i += 1) {
    let sum = 0;
    let count = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      const index = i + offset;
      if (index < 0 || index >= heights.length) continue;
      sum += heights[index];
      count += 1;
    }
    result[i] = count > 0 ? sum / count : heights[i];
  }
  return result;
}

export function msToBinIndex(ms: number, binMs: number): number {
  return Math.floor(ms / binMs);
}

export function binIndexToMs(index: number, binMs: number): number {
  return index * binMs;
}

/**
 * 全体ピーク配列から [startMs, endMs) に対応する範囲だけを抽出する。
 * カットカードごとに必要な範囲だけを描画するために使う(C-2の仮想化と対になる最適化)。
 */
export function sliceWaveformPeaks(
  peaks: number[],
  binMs: number,
  startMs: number,
  endMs: number,
): number[] {
  if (!peaks.length || endMs <= startMs) return [];
  const startIndex = Math.max(0, msToBinIndex(startMs, binMs));
  const endIndex = Math.min(peaks.length, Math.max(startIndex + 1, msToBinIndex(endMs, binMs) + 1));
  return peaks.slice(startIndex, endIndex);
}
