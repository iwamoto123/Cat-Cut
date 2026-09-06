// フェーズW1: 話者別テロップ色(UI側純関数)。
//
// python 側の正(shared/speakers.py / shared/telop_types.py)と同じ規則で
// 「話者カラーの発動判定」と「設定の正規化」を行う。プレビュー・スタイルバッジが
// 書き出し(step08 の effective_slot_style)と同じ色になるようにするための写像。
//
// 実行時(値)importのため、node --experimental-strip-types でテストを直接実行できるよう拡張子を明示する。
import { SEMANTIC_TYPES } from "./telopTypes.ts";

/** 話者カラーの発動に必要な最小発話シェア(python SPEAKER_SHARE_THRESHOLD と同期)。 */
export const SPEAKER_SHARE_THRESHOLD = 0.1;

/** speaker_colors 設定の完全形(main側 resolveSpeakerColorsConfig が返す形)。 */
export type SpeakerColorsConfig = {
  enabled: boolean;
  apply_types: string[];
  styles: Record<string, string>;
};

/** 既定値(templates/telop_type_mapping.yaml / python FALLBACK_SPEAKER_COLOR_STYLES と同期)。 */
export const DEFAULT_SPEAKER_COLORS: SpeakerColorsConfig = {
  enabled: true,
  apply_types: ["default", "reply"],
  styles: { speaker_1: "fact_cyan", speaker_2: "fact_green" },
};

/** IPC経由の生JSONを完全形へ正規化する(欠落・不正は既定で補完)。 */
export function sanitizeSpeakerColors(raw: unknown): SpeakerColorsConfig {
  const result: SpeakerColorsConfig = {
    enabled: DEFAULT_SPEAKER_COLORS.enabled,
    apply_types: [...DEFAULT_SPEAKER_COLORS.apply_types],
    styles: { ...DEFAULT_SPEAKER_COLORS.styles },
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return result;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.enabled === "boolean") result.enabled = obj.enabled;
  const applyTypes = Array.isArray(obj.apply_types) ? obj.apply_types : obj.applyTypes;
  if (Array.isArray(applyTypes)) {
    const valid = applyTypes
      .map(String)
      .filter((type) => (SEMANTIC_TYPES as readonly string[]).includes(type));
    if (valid.length) result.apply_types = valid;
  }
  if (obj.styles && typeof obj.styles === "object" && !Array.isArray(obj.styles)) {
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(obj.styles as Record<string, unknown>)) {
      const speaker = String(key || "").trim();
      if (speaker && typeof value === "string" && value.trim()) clean[speaker] = value.trim();
    }
    if (Object.keys(clean).length) result.styles = clean;
  }
  return result;
}

/** 発話シェア判定に必要な最小限のword形。 */
export type SpeakerWord = {
  startMs: number;
  endMs: number;
  speaker?: string;
};

/**
 * 発話シェアが threshold 以上の話者(発話時間の降順・同点は初出順)。
 * python shared/speakers.py の significant_speakers と同じ規則。
 * speaker 付き word が無い(旧run)場合は空配列。
 */
export function significantSpeakers(
  words: readonly SpeakerWord[],
  threshold: number = SPEAKER_SHARE_THRESHOLD,
): string[] {
  const durations = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  words.forEach((word, index) => {
    const speaker = word.speaker;
    if (!speaker) return;
    const duration = Math.max(0, (word.endMs || 0) - (word.startMs || 0));
    durations.set(speaker, (durations.get(speaker) || 0) + duration);
    if (!firstSeen.has(speaker)) firstSeen.set(speaker, index);
  });
  const total = [...durations.values()].reduce((sum, value) => sum + value, 0);
  if (total <= 0) return [];
  return [...durations.keys()]
    .sort((a, b) => durations.get(b)! - durations.get(a)! || firstSeen.get(a)! - firstSeen.get(b)!)
    .filter((speaker) => durations.get(speaker)! / total >= threshold);
}

/** 発動済みの話者カラー(effectiveDirectedStyleId へ渡す形)。null=発動しない。 */
export type ActiveSpeakerColors = {
  applyTypes: ReadonlySet<string>;
  styles: Readonly<Record<string, string>>;
};

/**
 * 話者カラーの発動判定。python step08 と同じ条件:
 * 設定が有効 かつ 発話シェア10%以上の話者が2人以上(1人喋りガード)。
 * 発動しない場合は null(=従来のスタイル解決のまま)。
 */
export function resolveActiveSpeakerColors(
  config: SpeakerColorsConfig | null | undefined,
  words: readonly SpeakerWord[],
): ActiveSpeakerColors | null {
  if (!config || !config.enabled) return null;
  if (!Object.keys(config.styles).length) return null;
  if (significantSpeakers(words).length < 2) return null;
  return { applyTypes: new Set(config.apply_types), styles: config.styles };
}
