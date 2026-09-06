import type { VideoEffectType } from "./videoEffects";

/** シーン単位の手動指定。null/undefined は自動選定へ戻す。 */
export type VideoEffectOverride = VideoEffectType | "none";

export type VideoEffectCatalogItem = {
  id: VideoEffectOverride | null;
  label: string;
  shortLabel: string;
  description: string;
};

/**
 * シーン検品の映像演出カタログ。
 * 新しい演出を追加するときは描画側の VideoEffectType とこの配列を拡張する。
 */
export const VIDEO_EFFECT_CATALOG: readonly VideoEffectCatalogItem[] = [
  {
    id: null,
    label: "自動",
    shortLabel: "自動",
    description: "シーンの種類から自動で選びます",
  },
  {
    id: "none",
    label: "なし",
    shortLabel: "なし",
    description: "このシーンには映像演出を付けません",
  },
  {
    id: "pinch",
    label: "引き締め",
    shortLabel: "引き締め",
    description: "映像を少し縮小して暗くします",
  },
  {
    id: "zoom",
    label: "ズーム",
    shortLabel: "ズーム",
    description: "映像をゆっくり拡大します",
  },
  {
    id: "dim",
    label: "暗転強調",
    shortLabel: "暗転強調",
    description: "映像を暗くしてテロップを際立たせます",
  },
  {
    id: "face_zoom",
    label: "顔ズーム",
    shortLabel: "顔ズーム",
    description: "顔を中心にゆっくり寄ります(顔が無い場合は中央上寄り)",
  },
  {
    id: "slow_push",
    label: "ゆっくり寄り",
    shortLabel: "ゆっくり寄り",
    description: "カット全体でごくゆっくり寄せ続けます",
  },
] as const;

export function videoEffectOverrideLabel(value: VideoEffectOverride | null | undefined): string {
  return VIDEO_EFFECT_CATALOG.find((item) => item.id === (value ?? null))?.shortLabel ?? "自動";
}
