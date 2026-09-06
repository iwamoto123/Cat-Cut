import { useEffect, useState } from "react";
import {
  DEFAULT_TYPE_MAPPING,
  sanitizeTypeMapping,
  type SemanticType,
  type TelopTypeMapping,
  type TelopTypeMappingEntry,
} from "../lib/telopTypes";
import { isValidThemeName } from "../lib/designThemes";
import {
  DEFAULT_OP_CONFIG,
  DEFAULT_OVERLAY_TITLE,
  DEFAULT_VIDEO_EFFECTS,
  type OpConfig,
  type OverlayTitleConfig,
  type VideoEffectsConfig,
} from "../lib/designExtras";
import { DEFAULT_SPEAKER_COLORS, type SpeakerColorsConfig } from "../lib/speakerColors";
import { TelopTypeMappingEditor } from "./TelopTypeMappingEditor";
import { OpSection, OverlayTitleSection, SpeakerColorsSection, VideoEffectsSection } from "./ThemeExtrasSections";

/** フェーズU7/U8: シーンタイトル・OP設定のペア(調整対象のテーマ or スタンダードの現在値)。 */
export type DesignExtras = {
  overlayTitle: OverlayTitleConfig;
  op: OpConfig;
  /** フェーズW1: 話者カラー設定(対談の話者ごとの色分け)。 */
  speakerColors: SpeakerColorsConfig;
  /** フェーズW2: シーン映像ギミック(pinch/zoom)のON/OFF設定。 */
  videoEffects: VideoEffectsConfig;
};

type Props = {
  open: boolean;
  /** 現在の解決済みマッピング(既定+アクティブテーマ or ユーザー設定)。 */
  mapping: TelopTypeMapping;
  /**
   * フェーズU2: 編集対象のデザインテーマ名(null=スタンダード)。
   * テーマ選択中は「上書き保存」がテーマ更新として動作する。
   */
  activeThemeName?: string | null;
  /** フェーズU7/U8: 編集対象のシーンタイトル・OP設定の現在値(未指定は既定=有効box_accent/OPなし)。 */
  extras?: DesignExtras;
  /** 上書き保存(テーマ更新 or スタンダードのユーザーマッピング保存)は親が行う。 */
  onSave: (mapping: TelopTypeMapping, extras: DesignExtras) => Promise<void> | void;
  /** フェーズU2: 現在の割り当てを新しいデザインテーマとして保存する(名前必須)。 */
  onSaveAsTheme?: (mapping: TelopTypeMapping, name: string, extras: DesignExtras) => Promise<void> | void;
  /** フェーズU6: 行の「編集」からスタイル詳細エディタを開く(このモーダルは閉じる)。 */
  onEditStyle?: (type: SemanticType, currentStyleId: string) => void;
  onClose: () => void;
};

/**
 * フェーズT2.5-4: 設定「テロップデザイン」ビュー。
 * シーンの種類(10種)ごとに適用するテロッププリセット・アニメ・効果音を選択する。
 * フェーズU2: 行エディタを TelopTypeMappingEditor へ共通化し、
 * 「選択中デザインテーマの上書き保存」「名前をつけて新規テーマ保存」に対応した。
 */
export function TelopTypeMappingModal({ open, mapping, activeThemeName, extras, onSave, onSaveAsTheme, onEditStyle, onClose }: Props) {
  const [draft, setDraft] = useState<TelopTypeMapping>(mapping);
  const [saving, setSaving] = useState(false);
  const [namingOpen, setNamingOpen] = useState(false);
  const [newThemeName, setNewThemeName] = useState("");
  // フェーズU7/U8: シーンタイトル・OP設定もマッピングと同じ「下書き→保存」の流れで扱う
  const [extrasDraft, setExtrasDraft] = useState<DesignExtras>({
    overlayTitle: { ...DEFAULT_OVERLAY_TITLE },
    op: { ...DEFAULT_OP_CONFIG },
    speakerColors: { ...DEFAULT_SPEAKER_COLORS },
    videoEffects: { ...DEFAULT_VIDEO_EFFECTS },
  });

  /** 1エントリの部分更新(animation_in/sfx は空文字=「プリセット既定」でキーごと削除する)。 */
  function updateEntry(type: SemanticType, patch: Partial<TelopTypeMappingEntry>) {
    setDraft((current) => {
      const entry: TelopTypeMappingEntry = { ...current[type], ...patch };
      if (!entry.animation_in) delete entry.animation_in;
      if (!entry.sfx) delete entry.sfx;
      return { ...current, [type]: entry };
    });
  }

  useEffect(() => {
    if (open) {
      setDraft(sanitizeTypeMapping(mapping));
      setExtrasDraft({
        overlayTitle: { ...(extras?.overlayTitle ?? DEFAULT_OVERLAY_TITLE) },
        op: { ...(extras?.op ?? DEFAULT_OP_CONFIG) },
        speakerColors: { ...(extras?.speakerColors ?? DEFAULT_SPEAKER_COLORS) },
        videoEffects: { ...(extras?.videoEffects ?? DEFAULT_VIDEO_EFFECTS) },
      });
      setNamingOpen(false);
      setNewThemeName("");
    }
  }, [open, mapping, extras]);

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
      await onSave(draft, extrasDraft);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveAsTheme() {
    if (!onSaveAsTheme || !isValidThemeName(newThemeName)) return;
    setSaving(true);
    try {
      await onSaveAsTheme(draft, newThemeName.trim(), extrasDraft);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="commandPaletteBackdrop" onClick={onClose} role="presentation">
      <div className="telopTypeMappingModal" onClick={(event) => event.stopPropagation()} role="dialog">
        <div className="userDictionaryModalTitle">
          <span>
            テロップデザイン(シーンの種類ごとの割り当て)
            {activeThemeName ? ` — テーマ「${activeThemeName}」` : " — スタンダード"}
          </span>
          {/* U4: 常時表示だった説明文はホバー開示へ(アクションに集中できるUI) */}
          <span
            className="helpIcon"
            title={
              "AIが判定したシーンの種類ごとに、適用するテロップデザイン・登場アニメーション・効果音を選べます。\n" +
              "アニメーション・効果音の「プリセット既定」はデザイン(プリセット)側の既定値をそのまま使います。\n" +
              "保存すると現在のプロジェクトにも即時反映され、以後の動画にも自動適用されます。"
            }
          >
            ?
          </span>
        </div>
        <TelopTypeMappingEditor
          draft={draft}
          onChange={updateEntry}
          onEditStyle={
            onEditStyle
              ? (type, currentStyleId) => {
                  // 詳細エディタとこのモーダルの二重表示を避けるため閉じてから開く
                  onClose();
                  onEditStyle(type, currentStyleId);
                }
              : undefined
          }
        />
        <SpeakerColorsSection
          onChange={(next) => setExtrasDraft((current) => ({ ...current, speakerColors: next }))}
          value={extrasDraft.speakerColors}
        />
        <VideoEffectsSection
          onChange={(next) => setExtrasDraft((current) => ({ ...current, videoEffects: next }))}
          value={extrasDraft.videoEffects}
        />
        <OverlayTitleSection
          onChange={(next) => setExtrasDraft((current) => ({ ...current, overlayTitle: next }))}
          value={extrasDraft.overlayTitle}
        />
        <OpSection onChange={(next) => setExtrasDraft((current) => ({ ...current, op: next }))} value={extrasDraft.op} />
        {namingOpen && onSaveAsTheme && (
          <div className="themeNamingRow">
            <input
              autoFocus
              onChange={(event) => setNewThemeName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleSaveAsTheme();
              }}
              placeholder="新しいテーマ名(例: 対談用ポップ)"
              value={newThemeName}
            />
            <button disabled={saving || !isValidThemeName(newThemeName)} onClick={() => void handleSaveAsTheme()} type="button">
              {saving ? "保存中…" : "この名前で保存"}
            </button>
            <button onClick={() => setNamingOpen(false)} type="button">
              やめる
            </button>
          </div>
        )}
        <div className="telopReplaceModalActions">
          <button onClick={() => setDraft({ ...DEFAULT_TYPE_MAPPING })} type="button">
            既定に戻す
          </button>
          {onSaveAsTheme && !namingOpen && (
            <button onClick={() => setNamingOpen(true)} type="button">
              名前をつけて保存
            </button>
          )}
          <button disabled={saving} onClick={() => void handleSave()} type="button">
            {saving ? "適用中…" : activeThemeName ? `「${activeThemeName}」に上書き保存` : "保存して適用"}
          </button>
          <button onClick={onClose} type="button">
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
