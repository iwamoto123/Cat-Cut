/**
 * フェーズV8-5: オーバーレイ文言の編集モーダル。
 *
 * 従来はプレビュー列の内部にインライン描画していたため、レイアウトによっては
 * シーン行のテキスト欄と重なって表示されていた。他のモーダル(コマンドパレット等)と
 * 同じ「背景dim+中央配置」の作法に統一し、App直下(ルート)から描画する。
 * 見出しには対象の種類名(ユーザー語彙)と表示時間帯を出す。
 */
import type { OverlayItem } from "../lib/overlayItems";
import { overlayTimeRangeLabel, overlayTypeLabel } from "../lib/overlayLabels";

export type OverlayEditDraft = { text: string; subtitle: string };

export type OverlayEditModalProps = {
  /** 編集対象(nullなら呼び出し側で非表示にする)。 */
  target: OverlayItem;
  draft: OverlayEditDraft;
  onDraftChange: (draft: OverlayEditDraft) => void;
  onCancel: () => void;
  onCommit: () => void;
};

export function OverlayEditModal({ target, draft, onDraftChange, onCancel, onCommit }: OverlayEditModalProps) {
  return (
    <div
      className="overlayEditModal"
      onClick={onCancel}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        }
      }}
      role="dialog"
    >
      <div className="overlayEditModalBody" onClick={(event) => event.stopPropagation()}>
        <p className="overlayEditModalTitle">{overlayTypeLabel(target.type)}を編集</p>
        <p className="overlayEditModalMeta">
          表示時間帯: {overlayTimeRangeLabel(target.start_ms, target.end_ms)}
        </p>
        <textarea
          autoFocus
          onChange={(event) => onDraftChange({ ...draft, text: event.target.value })}
          rows={Math.max(2, draft.text.split("\n").length)}
          value={draft.text}
        />
        {target.type === "profile_card" && (
          <textarea
            onChange={(event) => onDraftChange({ ...draft, subtitle: event.target.value })}
            placeholder="肩書き(サブタイトル)"
            rows={2}
            value={draft.subtitle}
          />
        )}
        <div className="overlayEditModalActions">
          <button onClick={onCancel} type="button">
            キャンセル
          </button>
          <button className="primary" onClick={onCommit} type="button">
            反映
          </button>
        </div>
      </div>
    </div>
  );
}
