import { useState } from "react";
import { Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import {
  designSwatchEntries,
  isValidThemeName,
  STANDARD_DESIGN_THEME_ID,
  type DesignScene,
  type DesignTheme,
  type DesignThemeSaveInput,
} from "../lib/designThemes";
import { DEFAULT_TYPE_MAPPING, sanitizeTypeMapping, type TelopTypeMapping, type TelopTypeMappingEntry, type SemanticType } from "../lib/telopTypes";
import { type OpConfig, type OverlayTitleConfig } from "../lib/designExtras";
import { getPresetStyle } from "../lib/telopThemes";
import { TelopStyleSample } from "./TelopStyleSample";
import { TelopTypeMappingEditor } from "./TelopTypeMappingEditor";
import { OpSection, OverlayTitleSection } from "./ThemeExtrasSections";

type Props = {
  scenes: DesignScene[];
  themes: DesignTheme[];
  /** 選択中テーマID(空文字=スタンダード)。 */
  activeThemeId: string;
  /** 現在の解決済みマッピング(スタンダードカードのミニプレビューに使う)。 */
  currentMapping: TelopTypeMapping;
  disabled?: boolean;
  onSelect: (themeId: string) => Promise<void> | void;
  onCreate: (input: DesignThemeSaveInput) => Promise<void> | void;
  onDelete: (themeId: string) => Promise<void> | void;
  /** フェーズU6: 選択中カードの「調整」から種類ごとの割り当て+詳細エディタを開く。 */
  onAdjust?: () => void;
};

/** 代表3種(説明・強調・質問)のミニプレビュー。書き出しと同じ TelopStyledText 描画。 */
function DesignSwatches({ mapping }: { mapping: Partial<TelopTypeMapping> }) {
  return (
    <span className="designSwatchRow">
      {designSwatchEntries(mapping).map((entry) => {
        const style = getPresetStyle(entry.styleId);
        return style ? (
          <TelopStyleSample className="designSwatch" fontSizePx={12} key={entry.type} style={style} text={entry.text} />
        ) : (
          <span className="designSwatch designSwatchMissing" key={entry.type}>
            {entry.styleId}
          </span>
        );
      })}
    </span>
  );
}

type CreateState =
  | { phase: "scene" }
  | {
      phase: "adjust";
      scene: DesignScene;
      draft: TelopTypeMapping;
      name: string;
      /** フェーズU7: シーンタイトル設定(初期値はシーンのジャンル既定)。 */
      overlayTitle: OverlayTitleConfig;
      /** フェーズU8: OP設定(初期値はOPなし=後方互換)。 */
      op: OpConfig;
    };

/**
 * フェーズU2-3: 左ペイン(動画選択の直下)のテロップデザイン選択UI。
 * 上段=保存済みテーマのカード横並び(名前+ミニプレビュー、削除ボタン付き)、
 * 「新規作成」=使用シーン4択→種類ごとの割り当て調整→名前をつけて保存。
 */
export function DesignThemePicker({
  scenes,
  themes,
  activeThemeId,
  currentMapping,
  disabled,
  onSelect,
  onCreate,
  onDelete,
  onAdjust,
}: Props) {
  const [create, setCreate] = useState<CreateState | null>(null);
  const [busy, setBusy] = useState(false);

  function updateDraftEntry(type: SemanticType, patch: Partial<TelopTypeMappingEntry>) {
    setCreate((current) => {
      if (!current || current.phase !== "adjust") return current;
      const entry: TelopTypeMappingEntry = { ...current.draft[type], ...patch };
      if (!entry.animation_in) delete entry.animation_in;
      if (!entry.sfx) delete entry.sfx;
      return { ...current, draft: { ...current.draft, [type]: entry } };
    });
  }

  async function handleSelect(themeId: string) {
    if (disabled || busy || themeId === activeThemeId) return;
    setBusy(true);
    try {
      await onSelect(themeId);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(theme: DesignTheme) {
    if (disabled || busy) return;
    if (!window.confirm(`デザインテーマ「${theme.name}」を削除しますか?`)) return;
    setBusy(true);
    try {
      await onDelete(theme.id);
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateSave() {
    if (!create || create.phase !== "adjust" || !isValidThemeName(create.name)) return;
    setBusy(true);
    try {
      await onCreate({
        name: create.name.trim(),
        baseScene: create.scene.id,
        typeStyles: create.draft,
        overlayTitle: create.overlayTitle,
        op: create.op,
      });
      setCreate(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="designThemePicker">
      <div className="designThemeCards">
        {/* 未選択=スタンダード(既定マッピング)。既存runと同じ挙動になる既定カード。
            フェーズU6: 必ずどれか1枚が選択状態で見えるよう、スタンダードも他テーマと同じ
            カード構造(選択中は「調整」ボタン付き)で常設表示する。 */}
        <div className={`designThemeCard ${activeThemeId === STANDARD_DESIGN_THEME_ID ? "selected" : ""}`}>
          <button
            className="designThemeCardBody"
            disabled={disabled || busy}
            onClick={() => void handleSelect(STANDARD_DESIGN_THEME_ID)}
            title="既定のシーン種類ごとの割り当てを使います"
            type="button"
          >
            <span className="designThemeCardName">スタンダード</span>
            <DesignSwatches mapping={activeThemeId === STANDARD_DESIGN_THEME_ID ? currentMapping : DEFAULT_TYPE_MAPPING} />
          </button>
          {onAdjust && activeThemeId === STANDARD_DESIGN_THEME_ID && (
            <button
              className="designThemeAdjustButton"
              disabled={disabled || busy}
              onClick={onAdjust}
              title="シーンの種類ごとの割り当てとデザインの詳細を調整"
              type="button"
            >
              <SlidersHorizontal size={12} />
              調整
            </button>
          )}
        </div>
        {themes.map((theme) => (
          <div className={`designThemeCard ${theme.id === activeThemeId ? "selected" : ""}`} key={theme.id}>
            <button
              className="designThemeCardBody"
              disabled={disabled || busy}
              onClick={() => void handleSelect(theme.id)}
              title={theme.name}
              type="button"
            >
              <span className="designThemeCardName">{theme.name}</span>
              <DesignSwatches mapping={theme.typeStyles} />
            </button>
            {onAdjust && theme.id === activeThemeId && (
              <button
                className="designThemeAdjustButton"
                disabled={disabled || busy}
                onClick={onAdjust}
                title={`「${theme.name}」の割り当てとデザインの詳細を調整`}
                type="button"
              >
                <SlidersHorizontal size={12} />
                調整
              </button>
            )}
            <button
              className="designThemeDeleteButton"
              disabled={disabled || busy}
              onClick={() => void handleDelete(theme)}
              title={`「${theme.name}」を削除`}
              type="button"
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <button
          className="designThemeCard designThemeNewCard"
          disabled={disabled || busy}
          onClick={() => setCreate({ phase: "scene" })}
          title="使用シーンを選んで新しいデザインテーマを作ります"
          type="button"
        >
          <Plus size={14} />
          <span>新規作成</span>
        </button>
      </div>

      {create && (
        <div className="commandPaletteBackdrop" onClick={() => setCreate(null)} role="presentation">
          <div className="telopTypeMappingModal designThemeCreateModal" onClick={(event) => event.stopPropagation()} role="dialog">
            {create.phase === "scene" ? (
              <>
                <div className="userDictionaryModalTitle">
                  <span>使用シーンを選ぶ</span>
                  <span className="helpIcon" title="動画の使い方に合わせた既定のテロップ割り当てから始めます。選んだ後に種類ごとに調整できます。">
                    ?
                  </span>
                </div>
                <div className="designSceneGrid">
                  {scenes.map((scene) => (
                    <button
                      className="designSceneCard"
                      key={scene.id}
                      onClick={() =>
                        setCreate({
                          phase: "adjust",
                          scene,
                          draft: sanitizeTypeMapping(scene.typeStyles),
                          name: "",
                          overlayTitle: { ...scene.overlayTitle },
                          // フェーズV2: OP既定はジャンルの性格で選んだシーン既定(design_scenes.yaml)
                          op: { ...scene.op },
                        })
                      }
                      title={scene.description}
                      type="button"
                    >
                      <span className="designSceneCardLabel">{scene.label}</span>
                      <DesignSwatches mapping={scene.typeStyles} />
                    </button>
                  ))}
                </div>
                <div className="telopReplaceModalActions">
                  <button onClick={() => setCreate(null)} type="button">
                    キャンセル
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="userDictionaryModalTitle">
                  <span>{`新規テーマ(${create.scene.label}ベース)の調整`}</span>
                  <span className="helpIcon" title="シーンの種類ごとにプリセット・登場アニメーション・効果音を調整し、名前をつけて保存します。">
                    ?
                  </span>
                </div>
                <TelopTypeMappingEditor draft={create.draft} onChange={updateDraftEntry} />
                <OverlayTitleSection
                  onChange={(next) =>
                    setCreate((current) => (current && current.phase === "adjust" ? { ...current, overlayTitle: next } : current))
                  }
                  value={create.overlayTitle}
                />
                <OpSection
                  onChange={(next) =>
                    setCreate((current) => (current && current.phase === "adjust" ? { ...current, op: next } : current))
                  }
                  value={create.op}
                />
                <div className="themeNamingRow">
                  <input
                    onChange={(event) =>
                      setCreate((current) =>
                        current && current.phase === "adjust" ? { ...current, name: event.target.value } : current,
                      )
                    }
                    placeholder="テーマ名(例: 対談用ポップ)"
                    value={create.name}
                  />
                </div>
                <div className="telopReplaceModalActions">
                  <button onClick={() => setCreate({ phase: "scene" })} type="button">
                    シーン選択に戻る
                  </button>
                  <button disabled={busy || !isValidThemeName(create.name)} onClick={() => void handleCreateSave()} type="button">
                    {busy ? "保存中…" : "保存して選択"}
                  </button>
                  <button onClick={() => setCreate(null)} type="button">
                    キャンセル
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
