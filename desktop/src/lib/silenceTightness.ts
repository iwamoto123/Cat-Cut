export type SilenceTightness = "loose" | "normal" | "tight";

export type SilenceEditOverrides = {
  max_gap_ms: number;
  lead_padding_ms: number;
  tail_padding_ms: number;
  min_internal_silence_ms: number;
};

const SILENCE_EDIT_OVERRIDES: Record<Exclude<SilenceTightness, "normal">, SilenceEditOverrides> = {
  tight: {
    max_gap_ms: 180,
    lead_padding_ms: 70,
    tail_padding_ms: 50,
    min_internal_silence_ms: 280,
  },
  loose: {
    max_gap_ms: 1000,
    lead_padding_ms: 280,
    tail_padding_ms: 200,
    min_internal_silence_ms: 800,
  },
};

/** 標準は向き別YAMLの既定を保つため、上書きを返さない。 */
export function editOverridesForSilenceTightness(
  tightness: SilenceTightness | null | undefined,
): SilenceEditOverrides | null {
  if (tightness !== "tight" && tightness !== "loose") return null;
  return { ...SILENCE_EDIT_OVERRIDES[tightness] };
}
