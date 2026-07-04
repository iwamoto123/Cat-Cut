import { type MouseEvent, useState } from "react";
import { Check, Trash2, X } from "lucide-react";
import {
  describeThemeCard,
  SAVED_THEME_ID,
  THEME_IDS,
  THEME_LABELS,
  variantOptionsForFamily,
  type TelopThemeId,
} from "../lib/telopThemes";
import { TelopStyleSample } from "./TelopStyleSample";

const GALLERY_SAMPLE_FONT_PX = 22;

type TelopThemeGalleryModalProps = {
  /** 現在選択中のテーマID(プリセットファミリーID、または"saved")。 */
  currentThemeId: TelopThemeId;
  /** 保存済みフォントプロファイルが読み込まれ、"saved"テーマとして選択可能かどうか。 */
  savedThemeAvailable: boolean;
  /** 「保存済み: <プロファイル名>」の表示ラベル(savedThemeAvailable=falseなら未使用)。 */
  savedThemeLabel: string;
  /** 保存済みプロファイル名(削除確認ダイアログ用)。 */
  savedProfileName?: string;
  onSelect: (themeId: TelopThemeId) => void;
  onClose: () => void;
  /** 改善9-B-3: 保存済みテーマ(フォントプロファイル)を削除する。 */
  onDeleteSavedTheme?: () => void;
};

const SAVED_TAB_ID = "__saved__";

/**
 * 改善8-B-1/8-B-2(プリセット駆動テーマ・カラーウェイ×用途で整理): タブ=カラーウェイ
 * (プリセットファミリー)、カード=そのファミリー内の用途バリエーション(標準/強調大/控えめ小/
 * 帯背景)。改善7-4の「ジャンル→複数テーマ」の2階層は、テーマ=ファミリーへの一本化(改善8-B-1)
 * により「ファミリー→用途バリエーション」の2階層に置き換わった。カードをクリックすると
 * 用途に関わらずそのファミリー全体(タブのテーマID)を選択する(テーマ=ファミリー単位の原則)。
 * 改善7-3の「保存済み」テーマも専用タブとして先頭に表示する。
 */
export function TelopThemeGalleryModal({
  currentThemeId,
  savedThemeAvailable,
  savedThemeLabel,
  savedProfileName,
  onSelect,
  onClose,
  onDeleteSavedTheme,
}: TelopThemeGalleryModalProps) {
  const initialTab: TelopThemeId | typeof SAVED_TAB_ID =
    savedThemeAvailable && currentThemeId === SAVED_THEME_ID ? SAVED_TAB_ID : currentThemeId;
  const [activeTab, setActiveTab] = useState<TelopThemeId | typeof SAVED_TAB_ID>(initialTab);

  const isSavedTab = activeTab === SAVED_TAB_ID;
  const variantOptions = isSavedTab ? [] : variantOptionsForFamily(activeTab);
  const savedCard = isSavedTab ? describeThemeCard(SAVED_THEME_ID) : null;

  function handleDeleteSaved(event: MouseEvent) {
    event.stopPropagation();
    const profileLabel = savedProfileName || savedThemeLabel.replace(/^保存済み:\s*/, "") || "字幕フォント設定";
    if (!window.confirm(`保存済みテーマ『${profileLabel}』を削除しますか？`)) return;
    onDeleteSavedTheme?.();
  }

  return (
    <div className="themeGalleryBackdrop" onClick={onClose}>
      <div className="themeGalleryDialog" onClick={(event) => event.stopPropagation()}>
        <div className="themeGalleryHeader">
          <span className="themeGalleryTitle">テロップテーマを選択</span>
          <button className="themeGalleryCloseButton" onClick={onClose} type="button">
            <X size={16} />
          </button>
        </div>
        <div className="themeGalleryTabs">
          {savedThemeAvailable && (
            <button
              className={`themeGalleryTab ${activeTab === SAVED_TAB_ID ? "active" : ""}`}
              onClick={() => setActiveTab(SAVED_TAB_ID)}
              type="button"
            >
              保存済み
            </button>
          )}
          {THEME_IDS.map((themeId) => (
            <button
              className={`themeGalleryTab ${activeTab === themeId ? "active" : ""}`}
              key={themeId}
              onClick={() => setActiveTab(themeId)}
              type="button"
            >
              {THEME_LABELS[themeId] ?? themeId}
            </button>
          ))}
        </div>
        <div className="themeGalleryGrid">
          {isSavedTab && savedCard && (
            <div
              className={`themeGalleryCard themeGalleryCardWithActions ${currentThemeId === SAVED_THEME_ID ? "active" : ""}`}
            >
              <button className="themeGalleryCardSelect" onClick={() => onSelect(SAVED_THEME_ID)} type="button">
                <TelopStyleSample
                  className="themeGalleryCardSample"
                  fontSizePx={GALLERY_SAMPLE_FONT_PX}
                  style={savedCard.sampleStyle}
                />
                <span className="themeGalleryCardLabel">
                  {currentThemeId === SAVED_THEME_ID && <Check size={12} />}
                  {savedThemeLabel}
                </span>
              </button>
              {onDeleteSavedTheme && (
                <button
                  aria-label="保存済みテーマを削除"
                  className="themeGalleryCardDelete"
                  onClick={handleDeleteSaved}
                  title="削除"
                  type="button"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          )}
          {!isSavedTab &&
            variantOptions.map((variant) => {
              const isActive = activeTab === currentThemeId;
              return (
                <button
                  className={`themeGalleryCard ${isActive ? "active" : ""}`}
                  key={variant.presetName}
                  onClick={() => onSelect(activeTab)}
                  type="button"
                >
                  <TelopStyleSample
                    className="themeGalleryCardSample"
                    fontSizePx={GALLERY_SAMPLE_FONT_PX}
                    style={variant.style}
                  />
                  <span className="themeGalleryCardLabel">
                    {isActive && <Check size={12} />}
                    {variant.label}
                  </span>
                </button>
              );
            })}
        </div>
      </div>
    </div>
  );
}
