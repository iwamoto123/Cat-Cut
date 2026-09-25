import { useEffect, useRef } from "react";

/** 検品中も表示し、失敗理由を画面外の非表示ペインへ置かない。 */
export function EditorErrorNotice({ message, runDir, onDismiss }: {
  message: string; runDir: string; onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollIntoView({ block: "nearest" }); }, [message]);
  return <div className="editorErrorNotice" role="alert" ref={ref}>
    <strong>処理を完了できませんでした</strong>
    <p>{message.split("\n")[0]}</p>
    <details><summary>エラーの詳細を表示</summary><pre>{message}</pre></details>
    <div className="editorErrorActions">
      {runDir && <button type="button" onClick={() => window.catcut.openPath(runDir)}>ログのフォルダを開く</button>}
      <button type="button" onClick={onDismiss}>閉じる</button>
    </div>
    {runDir && <small>問い合わせ時は、このフォルダの pipeline.log と、あれば export-diagnostic.json をファイルのまま送ってください。</small>}
  </div>;
}
