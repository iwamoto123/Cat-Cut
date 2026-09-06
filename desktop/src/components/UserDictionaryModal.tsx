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
  // W16-2(手動追加フォーム): 誤→正の2入力。編集は「削除→追加」で足りるため専用UIは持たない。
  const [addFrom, setAddFrom] = useState("");
  const [addTo, setAddTo] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");

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

  /** W16-2: 手動追加。既存IPC saveUserDictionaryEntry をそのまま使う(同じfromは上書き)。 */
  async function handleAdd() {
    const from = addFrom.trim();
    const to = addTo.trim();
    if (!from || !to || from === to) {
      setAddError("誤・正の両方を入力してください(同じ文字列は登録できません)");
      return;
    }
    setAdding(true);
    setAddError("");
    try {
      const data = await window.catcut.saveUserDictionaryEntry({ from, to });
      setEntries(data.entries || []);
      setAddFrom("");
      setAddTo("");
    } catch {
      setAddError("辞書の保存に失敗しました");
    } finally {
      setAdding(false);
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
        {/* W16-2: 手動追加フォーム(誤→正)。IME変換中のEnterは確定キーなので送信しない */}
        <div className="userDictionaryAddRow">
          <input
            onChange={(event) => setAddFrom(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) void handleAdd();
            }}
            placeholder="誤(例: 埼京)"
            value={addFrom}
          />
          <span className="userDictionaryAddArrow">→</span>
          <input
            onChange={(event) => setAddTo(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) void handleAdd();
            }}
            placeholder="正(例: 最強)"
            value={addTo}
          />
          <button disabled={adding} onClick={() => void handleAdd()} type="button">
            {adding ? "追加中…" : "追加"}
          </button>
        </div>
        {addError && <p className="userDictionaryAddError">{addError}</p>}
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
