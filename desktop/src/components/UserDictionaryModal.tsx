import { useCallback, useEffect, useState } from "react";

type DictionaryEntry = { from: string; to: string };

type Props = {
  open: boolean;
  onClose: () => void;
};

export function UserDictionaryModal({ open, onClose }: Props) {
  const [entries, setEntries] = useState<DictionaryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [deletingFrom, setDeletingFrom] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await window.catcut.getUserDictionary();
      setEntries(data.entries || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    void reload();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, reload]);

  async function handleDelete(from: string) {
    setDeletingFrom(from);
    try {
      const data = await window.catcut.deleteUserDictionaryEntry(from);
      setEntries(data.entries || []);
    } finally {
      setDeletingFrom(null);
    }
  }

  if (!open) return null;

  return (
    <div className="commandPaletteBackdrop" onClick={onClose} role="presentation">
      <div className="userDictionaryModal" onClick={(event) => event.stopPropagation()} role="dialog">
        <div className="userDictionaryModalTitle">登録済みユーザー辞書</div>
        <p className="userDictionaryModalHint">
          次回の解析(step02b)から自動修正されます。文脈で意味が変わる語は登録しないでください。
        </p>
        {loading ? (
          <p className="userDictionaryModalEmpty">読み込み中…</p>
        ) : entries.length === 0 ? (
          <p className="userDictionaryModalEmpty">登録済みの辞書はありません。</p>
        ) : (
          <ul className="userDictionaryList">
            {entries.map((entry) => (
              <li className="userDictionaryListItem" key={entry.from}>
                <span className="userDictionaryPair">
                  「{entry.from}」→「{entry.to}」
                </span>
                <button
                  disabled={deletingFrom === entry.from}
                  onClick={() => void handleDelete(entry.from)}
                  type="button"
                >
                  削除
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="telopReplaceModalActions">
          <button onClick={onClose} type="button">
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
