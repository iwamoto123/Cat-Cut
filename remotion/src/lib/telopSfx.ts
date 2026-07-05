/**
 * フェーズT3: テロップ効果音(SFX)の解決と過剰防止ガード(純関数)。
 *
 * SFX IDの解決優先順位(上が強い):
 * 1. telops[].sfx が文字列 → その効果音ID(type→マッピング既定を step08 が書き込んだもの)
 * 2. telops[].sfx が null/false/"none" → 明示的に鳴らさない
 * 3. プリセット既定(telop_presets.yaml の sfx)
 * 4. なし
 *
 * 過剰防止ガード: SE付きテロップの最小間隔(既定5秒)。タイムライン全体を
 * 時系列に走査し、前のSE再生から間隔未満のSEはスキップする(決定的)。
 * 実再生(<Audio>)は CatCutComposition が computeSfxEvents の結果に対して行う。
 */

/** assets/sfx/ に同梱している効果音ID(python/tools/generate_sfx.py と同期)。 */
export const SFX_IDS = ["don", "shakin", "pon", "jan", "hyu"] as const;

/** SE付きテロップの最小間隔(ms)。 */
export const SFX_MIN_INTERVAL_MS = 5000;

/** 効果音の既定音量(timeline.sfx_volume 未指定時。0.25 ≒ -12dB)。 */
export const DEFAULT_SFX_VOLUME = 0.25;

type SfxTelop = {
  sfx?: unknown;
  style?: string;
  start?: number;
  end?: number;
  word_indices?: number[];
};

type SfxVoiceWord = { start: number; end: number };

/**
 * 1テロップ分のSFX IDを解決する(ガード適用前)。
 * telop.sfx: 文字列=そのID / null・false・"none"=明示OFF / 未指定=プリセット既定。
 */
export function resolveTelopSfxId(
  telop: Pick<SfxTelop, "sfx">,
  style: { sfx?: unknown } | undefined,
): string | null {
  if (telop.sfx !== undefined) {
    if (typeof telop.sfx === "string" && telop.sfx && telop.sfx !== "none") return telop.sfx;
    return null;
  }
  const presetSfx = style?.sfx;
  if (typeof presetSfx === "string" && presetSfx && presetSfx !== "none") return presetSfx;
  return null;
}

/** timeline.sfx_volume を 0〜1 に正規化する(未指定・不正は既定0.25)。 */
export function sanitizeSfxVolume(value: unknown): number {
  const volume = Number(value);
  if (!Number.isFinite(volume)) return DEFAULT_SFX_VOLUME;
  return Math.max(0, Math.min(1, volume));
}

export type SfxEvent = {
  /** タイムライン絶対フレーム(SE再生開始 = テロップ表示開始)。 */
  frame: number;
  sfxId: string;
  telopId: string;
};

type ComputeSfxEventsInput = {
  /** timeline.cuts(timeline.start_ms を使う)。 */
  cuts: Array<{ cut_id: string; timeline: { start_ms: number } }>;
  /** voice_data.cuts(telops と word timing)。 */
  voiceCuts: Array<{
    id: string;
    voice?: { words?: SfxVoiceWord[] };
    telops?: Array<SfxTelop & { id?: string }>;
  }>;
  styles: Record<string, { sfx?: unknown } | undefined>;
  defaultStyleName?: string;
  fps: number;
  minIntervalMs?: number;
};

/** テロップ表示開始のカット内相対秒(Telop.tsx の rawTimings と同じ規則)。 */
function telopStartSeconds(telop: SfxTelop, words: SfxVoiceWord[]): number | null {
  if (typeof telop.start === "number" && typeof telop.end === "number" && telop.end > telop.start) {
    return telop.start;
  }
  const indices = Array.isArray(telop.word_indices) ? telop.word_indices : [];
  if (!indices.length) return null;
  const firstWord = words[Math.min(...indices)];
  if (!firstWord) return null;
  return firstWord.start;
}

/**
 * タイムライン全体のSFX再生イベントを決定する(決定的・ガード適用済み)。
 */
export function computeSfxEvents(input: ComputeSfxEventsInput): SfxEvent[] {
  const minIntervalMs = input.minIntervalMs ?? SFX_MIN_INTERVAL_MS;
  const defaultStyleName = input.defaultStyleName ?? "default";
  const voiceCutMap = new Map(input.voiceCuts.map((cut) => [cut.id, cut]));

  const candidates: SfxEvent[] = [];
  for (const cut of input.cuts) {
    const voiceCut = voiceCutMap.get(cut.cut_id);
    if (!voiceCut?.telops?.length) continue;
    const words = voiceCut.voice?.words ?? [];
    const cutStartMs = Number(cut.timeline?.start_ms ?? 0);
    for (const telop of voiceCut.telops) {
      const style = input.styles[telop.style ?? defaultStyleName];
      const sfxId = resolveTelopSfxId(telop, style);
      if (!sfxId) continue;
      const startSec = telopStartSeconds(telop, words);
      if (startSec === null) continue;
      candidates.push({
        frame: Math.round(((cutStartMs + startSec * 1000) / 1000) * input.fps),
        sfxId,
        telopId: String(telop.id ?? ""),
      });
    }
  }

  candidates.sort((a, b) => a.frame - b.frame);

  // 過剰防止ガード: 前のSE再生から minIntervalMs 未満のSEはスキップする
  const minIntervalFrames = (minIntervalMs / 1000) * input.fps;
  const events: SfxEvent[] = [];
  let lastFrame = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate.frame - lastFrame < minIntervalFrames) continue;
    events.push(candidate);
    lastFrame = candidate.frame;
  }
  return events;
}
