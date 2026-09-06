import {
  SEMANTIC_TYPES,
  SEMANTIC_TYPE_INFO,
  type SemanticType,
  type TelopTypeMapping,
  type TelopTypeMappingEntry,
} from "../lib/telopTypes";
import { ANIMATION_PICKER_OPTIONS, SFX_PICKER_OPTIONS } from "../lib/telopAnimations";
import { DIRECTED_STYLE_OPTIONS } from "../lib/directedTelop";
import { getPresetStyle } from "../lib/telopThemes";
import { TelopStyleSample } from "./TelopStyleSample";

/** 種類ごとのプレビュー例文(意味が伝わる短文)。 */
export const TYPE_SAMPLE_TEXT: Record<string, string> = {
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

type Props = {
  draft: TelopTypeMapping;
  onChange: (type: SemanticType, patch: Partial<TelopTypeMappingEntry>) => void;
  /** フェーズU6: 行の「編集」ボタンでスタイル詳細エディタを開く(未指定なら非表示)。 */
  onEditStyle?: (type: SemanticType, currentStyleId: string) => void;
};

/**
 * フェーズU2: シーン種類(10種)ごとのプリセット・アニメ・効果音の割り当てエディタ。
 * TelopTypeMappingModal(検品画面からの編集)と DesignThemePicker(新規テーマ作成フロー)で
 * 同じ調整UIを使うため、モーダルから行リスト部分を抽出した。
 */
export function TelopTypeMappingEditor({ draft, onChange, onEditStyle }: Props) {
  return (
    <div className="telopTypeMappingList">
      {SEMANTIC_TYPES.map((type) => {
        const entry = draft[type];
        const presetId = entry.style;
        const presetStyle = getPresetStyle(presetId);
        return (
          <div className="telopTypeMappingRow" key={type}>
            <div className="telopTypeMappingLabel">
              <div className="telopTypeMappingName">{SEMANTIC_TYPE_INFO[type].label}</div>
              <div className="telopTypeMappingDescription">{SEMANTIC_TYPE_INFO[type].description}</div>
            </div>
            <select
              className="telopTypeMappingSelect"
              onChange={(event) => onChange(type, { style: event.target.value })}
              title="テロップデザイン(プリセット)"
              value={presetId}
            >
              {DIRECTED_STYLE_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label} ({option.id})
                </option>
              ))}
            </select>
            <select
              className="telopTypeMappingSelect telopTypeMappingAnimationSelect"
              onChange={(event) => onChange(type, { animation_in: event.target.value })}
              title="登場アニメーション"
              value={entry.animation_in ?? ""}
            >
              {ANIMATION_PICKER_OPTIONS.map((option) => (
                <option key={option.id || "preset_default"} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              className="telopTypeMappingSelect telopTypeMappingSfxSelect"
              onChange={(event) => onChange(type, { sfx: event.target.value })}
              title="効果音"
              value={entry.sfx ?? ""}
            >
              {SFX_PICKER_OPTIONS.map((option) => (
                <option key={option.id || "preset_default"} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <div className="telopTypeMappingPreview">
              {presetStyle ? (
                <TelopStyleSample fontSizePx={16} style={presetStyle} text={TYPE_SAMPLE_TEXT[type]} />
              ) : (
                <span className="telopTypeMappingPreviewMissing">{presetId}</span>
              )}
            </div>
            {onEditStyle && (
              <button
                className="telopTypeMappingEditButton"
                onClick={() => onEditStyle(type, presetId)}
                title="このデザインを詳細エディタで編集する"
                type="button"
              >
                編集
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
