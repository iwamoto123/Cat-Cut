import { useEffect, useState } from "react";

/**
 * W14-2: 学習済み修正(userData/correction_history.json)の一覧・個別削除モーダル。
 * 蓄積は自動・無操作のため、ここは「何を学習しているかの確認」と「誤learningの解除」だけを担う。
 * データは親(App)が保持し、削除も親のIPC呼び出しへ委譲する(UserDictionaryModalと同じ流儀の見た目)。
 */

type CorrectionPairView = { before: string; after: string; count: number };

type Props = {
  open: boolean;
  pairs: CorrectionPairView[];
  onClose: () => void;
  onDelete: (pair: { before: string; after: string }) => Promise<void>;
  /** W15: 学習データ(全run edit_history + correction_history)の書き出し。shared=Nextcloud共有フォルダへ保存済み。 */
  onExport: () => Promise<{
    path: string;
    stats: { runs: number; editEntries: number; correctionPairs: number };
    shared: boolean;
  }>;
};

export function CorrectionHistoryModal({ open, pairs, onClose, onDelete, onExport }: Props) {
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState("");

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const sorted = [...pairs].sort((a, b) => b.count - a.count);

  async function handleDelete(pair: CorrectionPairView) {
    const key = `${pair.before}\u0000${pair.after}`;
    setDeletingKey(key);
    try {
      await onDelete({ before: pair.before, after: pair.after });
    } finally {
      setDeletingKey(null);
    }
  }

  async function handleExport() {
    setExporting(true);
    setExportMessage("");
    try {
      const result = await onExport();
      setExportMessage(
        result.shared
          ? `Nextcloudの共有フォルダに保存しました（${result.stats.runs}本の動画・編集${result.stats.editEntries}件・修正ペア${result.stats.correctionPairs}件）。同期で自動的に届くため送付は不要です。`
          : `書き出しました（${result.stats.runs}本の動画・編集${result.stats.editEntries}件・修正ペア${result.stats.correctionPairs}件）。このファイルを岩本へ送ってください。`,
      );
    } catch {
      setExportMessage("書き出しに失敗しました");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="commandPaletteBackdrop" onClick={onClose} role="presentation">
      <div className="userDictionaryModal" onClick={(event) => event.stopPropagation()} role="dialog">
        <div className="userDictionaryModalTitle">学習済み修正</div>
        <p className="userDictionaryModalHint">
          テロップ編集から自動で学習した「誤→正」の修正ペアです。次回以降のAI校正のヒントと
          要確認(「過去に修正した表記」)に使われます。適用はAIの文脈判断なので、確実に毎回
          置換したい語はユーザー辞書に登録してください。
        </p>
        {sorted.length === 0 ? (
          <p className="userDictionaryModalEmpty">学習済みの修正はありません。</p>
        ) : (
          <ul className="userDictionaryList">
            {sorted.map((pair) => {
              const key = `${pair.before}\u0000${pair.after}`;
              return (
                <li className="userDictionaryListItem" key={key}>
                  <span className="userDictionaryPair">
                    「{pair.before}」→「{pair.after}」
                    <span className="correctionHistoryCount">{pair.count}回</span>
                  </span>
                  <button
                    disabled={deletingKey === key}
                    onClick={() => void handleDelete(pair)}
                    type="button"
                  >
                    削除
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {exportMessage ? <p className="userDictionaryModalHint">{exportMessage}</p> : null}
        <div className="telopReplaceModalActions">
          <button disabled={exporting} onClick={() => void handleExport()} type="button">
            {exporting ? "書き出し中..." : "学習データを書き出す"}
          </button>
          <button onClick={onClose} type="button">
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
