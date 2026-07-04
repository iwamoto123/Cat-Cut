import { useEffect, useMemo } from "react";
import type { TelopOccurrence } from "../lib/telopOccurrences";

/**
 * 改善10-B-1(一括変更ポップアップ): 改善5-7の一括置換を拡張。
 * 他シーンの出現箇所を文脈付きで一覧し、箇所ごとに適用可否を選べる。
 */

export type TelopReplaceCandidateView = {
  sceneId: string;
  from: string;
  to: string;
  occurrences: TelopOccurrence[];
};

type Props = {
  candidate: TelopReplaceCandidateView | null;
  selectedKeys: Set<string>;
  registerDictChecked: boolean;
  onToggleOccurrence: (key: string, checked: boolean) => void;
  onToggleRegisterDict: (checked: boolean) => void;
  onOpenDictionary: () => void;
  onConfirm: () => void;
  onCancel: () => void;
};

export function occurrenceKey(occurrence: TelopOccurrence): string {
  return `${occurrence.sceneId}:${occurrence.occurrenceIndex}`;
}

export function TelopReplaceModal({
  candidate,
  selectedKeys,
  registerDictChecked,
  onToggleOccurrence,
  onToggleRegisterDict,
  onOpenDictionary,
  onConfirm,
  onCancel,
}: Props) {
  useEffect(() => {
    if (!candidate) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [candidate, onCancel]);

  const selectedCount = useMemo(() => {
    if (!candidate) return 0;
    return candidate.occurrences.filter((item) => selectedKeys.has(occurrenceKey(item))).length;
  }, [candidate, selectedKeys]);

  if (!candidate) return null;

  return (
    <div className="commandPaletteBackdrop" onClick={onCancel} role="presentation">
      <div className="telopReplaceModal telopReplaceModalWide" onClick={(event) => event.stopPropagation()} role="dialog">
        <div className="telopReplaceModalTitle">
          「{candidate.from}」を「{candidate.to}」に置き換えますか?
        </div>
        <p className="telopReplaceModalSubtitle">他の出現箇所(全{candidate.occurrences.length}件)</p>
        <ul className="telopReplaceOccurrenceList">
          {candidate.occurrences.map((occurrence) => {
            const key = occurrenceKey(occurrence);
            return (
              <li className="telopReplaceOccurrenceItem" key={key}>
                <label className="telopReplaceOccurrenceLabel">
                  <input
                    checked={selectedKeys.has(key)}
                    onChange={(event) => onToggleOccurrence(key, event.target.checked)}
                    type="checkbox"
                  />
                  <span className="telopReplaceOccurrenceText">
                    <span className="telopReplaceOccurrenceScene">シーン{occurrence.sceneOrdinal}</span>
                    <span className="telopReplaceOccurrenceContext">
                      {occurrence.contextBefore}
                      <mark className="telopReplaceOccurrenceMatch">{occurrence.match}</mark>
                      {occurrence.contextAfter}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        <label className="telopReplaceModalOption">
          <input
            checked={registerDictChecked}
            onChange={(event) => onToggleRegisterDict(event.target.checked)}
            type="checkbox"
          />
          <span>ユーザー辞書に登録(次回の解析から自動修正)</span>
        </label>
        <p className="telopReplaceModalNote">
          文脈で意味が変わる語(例: もし/模試)は登録しないでください。
          <button className="telopReplaceDictionaryLink" onClick={onOpenDictionary} type="button">
            登録済みの辞書を見る
          </button>
        </p>
        <div className="telopReplaceModalActions">
          <button onClick={onCancel} type="button">
            キャンセル
          </button>
          <button className="primaryButton compactPrimary" onClick={onConfirm} type="button">
            選択した{selectedCount}件を置換
          </button>
        </div>
      </div>
    </div>
  );
}
