import { useEffect, useState } from "react";
import {
  DEFAULT_TYPE_MAPPING,
  SEMANTIC_TYPES,
  SEMANTIC_TYPE_INFO,
  sanitizeTypeMapping,
  type TelopTypeMapping,
} from "../lib/telopTypes";
import { DIRECTED_STYLE_OPTIONS } from "../lib/directedTelop";
import { getPresetStyle } from "../lib/telopThemes";
import { TelopStyleSample } from "./TelopStyleSample";

type Props = {
  open: boolean;
  /** 現在の解決済みマッピング(既定+ユーザー設定)。 */
  mapping: TelopTypeMapping;
  /** 保存(main永続化+directedスロットへの即時再適用)は親が行う。 */
  onSave: (mapping: TelopTypeMapping) => Promise<void> | void;
  onClose: () => void;
};

/** 種類ごとのプレビュー例文(意味が伝わる短文)。 */
const SAMPLE_TEXT: Record<string, string> = {
  default: "毎月30万円の売上",
  surprise: "実は逆効果なんです",
  harsh: "正直それはダメです",
  quote: "努力は裏切らない",
  emphasis: "絶対にやめてください",
  question: "それって本当ですか?",
  reply: "なるほどですね",
  punchline: "結論はこれ一択",
  hype: "今だけの特別公開",
  cta: "概要欄のLINEへ",
};

/**
 * フェーズT2.5-4: 設定「テロップデザイン」ビュー。
 * シーンの種類(10種)ごとに適用するテロッププリセットをドロップダウンで選択する。
 * 保存すると userData に永続化され、directedモードのプロジェクトへ即時反映される
 * (ディレクティブのstyle再解決 + step08再実行は親のonSaveが行う)。
 */
export function TelopTypeMappingModal({ open, mapping, onSave, onClose }: Props) {
  const [draft, setDraft] = useState<TelopTypeMapping>(mapping);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setDraft(sanitizeTypeMapping(mapping));
  }, [open, mapping]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(draft);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="commandPaletteBackdrop" onClick={onClose} role="presentation">
      <div className="telopTypeMappingModal" onClick={(event) => event.stopPropagation()} role="dialog">
        <div className="userDictionaryModalTitle">テロップデザイン(シーンの種類ごとの割り当て)</div>
        <p className="userDictionaryModalHint">
          AIが判定したシーンの種類ごとに、適用するテロップデザインを選べます。
          保存すると現在のプロジェクトにも即時反映され、以後の動画にも自動適用されます。
        </p>
        <div className="telopTypeMappingList">
          {SEMANTIC_TYPES.map((type) => {
            const presetId = draft[type];
            const presetStyle = getPresetStyle(presetId);
            return (
              <div className="telopTypeMappingRow" key={type}>
                <div className="telopTypeMappingLabel">
                  <div className="telopTypeMappingName">{SEMANTIC_TYPE_INFO[type].label}</div>
                  <div className="telopTypeMappingDescription">{SEMANTIC_TYPE_INFO[type].description}</div>
                </div>
                <select
                  className="telopTypeMappingSelect"
                  onChange={(event) => setDraft((current) => ({ ...current, [type]: event.target.value }))}
                  value={presetId}
                >
                  {DIRECTED_STYLE_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label} ({option.id})
                    </option>
                  ))}
                </select>
                <div className="telopTypeMappingPreview">
                  {presetStyle ? (
                    <TelopStyleSample fontSizePx={16} style={presetStyle} text={SAMPLE_TEXT[type]} />
                  ) : (
                    <span className="telopTypeMappingPreviewMissing">{presetId}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="telopReplaceModalActions">
          <button onClick={() => setDraft({ ...DEFAULT_TYPE_MAPPING })} type="button">
            既定に戻す
          </button>
          <button disabled={saving} onClick={() => void handleSave()} type="button">
            {saving ? "適用中…" : "保存して適用"}
          </button>
          <button onClick={onClose} type="button">
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
