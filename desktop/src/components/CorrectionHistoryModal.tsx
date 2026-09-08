import { useEffect, useState } from "react";
import "./EditingLearning.css";

/**
 * W14-2: 学習済み修正(userData/correction_history.json)の一覧・個別削除モーダル。
 * 蓄積は自動・無操作のため、ここは「何を学習しているかの確認」と「誤learningの解除」だけを担う。
 * データは親(App)が保持し、削除も親のIPC呼び出しへ委譲する(UserDictionaryModalと同じ流儀の見た目)。
 */

type CorrectionPairView = { before: string; after: string; count: number };
type CatCutEditingLearningSummary = Awaited<ReturnType<typeof window.catcut.getEditingLearningSummary>>;
type CatCutEditingLearningKind = keyof CatCutEditingLearningSummary["counts"];

type Props = {
  open: boolean;
  pairs: CorrectionPairView[];
  editingSummary: CatCutEditingLearningSummary | null;
  onExcludeExample: (exampleId: string) => Promise<void>;
  onClose: () => void;
  onDelete: (pair: { before: string; after: string }) => Promise<void>;
  /** W15: 学習データ(全run edit_history + correction_history)の書き出し。shared=Nextcloud共有フォルダへ保存済み。 */
  onExport: () => Promise<{
    path: string;
    summaryPath?: string;
    stats: { runs: number; editEntries: number; correctionPairs: number; editingExamples?: number; confirmedProjects?: number };
    shared: boolean;
  }>;
};

const KIND_LABELS: Record<CatCutEditingLearningKind, string> = {
  proofreading: "文章校正", cut: "カット", scene_boundary: "シーン区切り", line_break: "改行",
};
type EditingExample = CatCutEditingLearningSummary["recentExamples"][number];

function formatTime(ms: number): string {
  const value = Math.max(0, Math.round(ms));
  return `${Math.floor(value / 60000)}:${String(Math.floor(value / 1000) % 60).padStart(2, "0")}.${String(value % 1000).padStart(3, "0")}`;
}

function exampleSummary(example: EditingExample): string {
  if (example.kind === "cut") {
    const duration = (version: EditingExample["before"]) => (version.keepSegments.reduce((sum, range) => sum + range.endMs - range.startMs, 0) / 1000).toFixed(3);
    return `保持する映像 ${duration(example.before)} 秒 → ${duration(example.after)} 秒`;
  }
  if (example.kind === "scene_boundary") return `${example.before.scenes.length} シーン → ${example.after.scenes.length} シーン`;
  const excerpt = (value: string) => value.replace(/\n/g, " ↵ ").slice(0, 56) || "（テロップなし）";
  return `${excerpt(example.before.text)} → ${excerpt(example.after.text)}`;
}

function ExampleVersion({ version, kind, after, originalAi }: { version: EditingExample["before"]; kind: CatCutEditingLearningKind; after?: boolean; originalAi: boolean }) {
  return (
    <div className={`editingLearningVersion ${after ? "editingLearningAfter" : ""}`}>
      <strong className="editingLearningVersionTitle">{after ? "書き出しで確定した編集結果" : originalAi ? "AIの初回提案" : "記録開始時の状態"}</strong>
      <pre className="editingLearningText">{version.text || "（テロップなし）"}</pre>
      {kind === "cut" && (
        <>
          <p className="editingLearningRangeTitle">保持する素材区間</p>
          <ul className="editingLearningRanges">
            {version.keepSegments.length ? version.keepSegments.map((range, index) => (
              <li key={index}><time>{formatTime(range.startMs)} → {formatTime(range.endMs)}</time></li>
            )) : <li>保持区間なし</li>}
          </ul>
        </>
      )}
      {kind === "scene_boundary" && (
        <>
          <p className="editingLearningRangeTitle">シーンごとの素材時刻・テロップ</p>
          <ol className="editingLearningRanges">
            {version.scenes.map((scene, index) => (
              <li key={index}>
                <time>{index + 1}. {formatTime(scene.startMs)} → {formatTime(scene.endMs)}</time>
                <span className="editingLearningSceneText">{scene.text || "（テロップなし）"}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function EditingExampleItem({ example, excludingId, onExclude }: { example: EditingExample; excludingId: string | null; onExclude: (exampleId: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const originalAi = example.context?.baselineProvenance === "ai_original";
  return (
    <details className="editingLearningExample" data-kind={example.kind} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>
        <span className="editingLearningKind">{KIND_LABELS[example.kind]}</span>
        <span className="editingLearningExampleSummary">{exampleSummary(example)}</span>
      </summary>
      {expanded && (
        <>
          <div className="editingLearningCompare">
            <ExampleVersion version={example.before} kind={example.kind} originalAi={originalAi} />
            <ExampleVersion version={example.after} kind={example.kind} originalAi={originalAi} after />
          </div>
          <div className="editingLearningExampleFooter">
            <span>{originalAi ? "初回のAI提案との比較です。" : "旧プロジェクトなどのため、記録開始時の状態と比較しています。"}<br />除外しても動画・編集内容は変わりません。</span>
            <button className="editingLearningExclude" disabled={excludingId !== null} onClick={() => onExclude(example.exampleId)} type="button">
              {excludingId === example.exampleId ? "除外中…" : "この事例を除外"}
            </button>
          </div>
        </>
      )}
    </details>
  );
}

export function CorrectionHistoryModal({ open, pairs, editingSummary, onExcludeExample, onClose, onDelete, onExport }: Props) {
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [excludingId, setExcludingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState("");
  const [exportFiles, setExportFiles] = useState<{ path: string; summaryPath?: string } | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    setActionError("");
    setExportMessage("");
    setExportFiles(null);
  }, [open]);

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
    setActionError("");
    try {
      await onDelete({ before: pair.before, after: pair.after });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "修正ペアの削除に失敗しました。");
    } finally {
      setDeletingKey(null);
    }
  }

  async function handleExclude(exampleId: string) {
    setExcludingId(exampleId);
    setActionError("");
    try {
      await onExcludeExample(exampleId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "事例の除外に失敗しました。もう一度お試しください。");
    } finally {
      setExcludingId(null);
    }
  }

  async function handleExport() {
    setExporting(true);
    setExportMessage("");
    setActionError("");
    setExportFiles(null);
    try {
      const result = await onExport();
      const examples = result.stats.editingExamples;
      const confirmed = result.stats.confirmedProjects;
      const counts = examples == null ? `修正ペア ${result.stats.correctionPairs} 件` : `${confirmed == null ? "" : `確定済み ${confirmed} プロジェクト・`}編集事例 ${examples} 件`;
      setExportMessage(
        `${result.shared ? "Nextcloudの共有フォルダに保存しました。同期状況はNextcloudで確認できます。" : "共有用ファイルを保存しました。"}\n` +
        `${counts}。${result.summaryPath ? "学習用JSONと確認用TXTを作成しました。TXT単体は学習に取り込みません。" : "学習用JSONを作成しました。"}`,
      );
      setExportFiles({ path: result.path, summaryPath: result.summaryPath });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "学習データの書き出しに失敗しました。");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="commandPaletteBackdrop" onClick={onClose} role="presentation">
      <div className="userDictionaryModal editingLearningModal" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="editingLearningTitle">
        <div className="editingLearningHeader">
          <div className="userDictionaryModalTitle" id="editingLearningTitle">編集からの学習</div>
          {editingSummary && <span>{editingSummary.projects} プロジェクト・{editingSummary.examples} 事例</span>}
        </div>
        <div className="editingLearningScroll">
        <p className="userDictionaryModalHint">
          書き出しが成功した編集結果を、次回のAIカット・校正・シーン区切りの参考に使います。
          編集途中や書き出す前に⌘Zで戻した変更は確定事例に入りません。再編集後は、次の書き出し成功時に更新します。
        </p>
        {editingSummary ? (
          <>
            <dl className="editingLearningStats">
              {(Object.keys(KIND_LABELS) as CatCutEditingLearningKind[]).map((kind) => (
                <div key={kind}><dt>{KIND_LABELS[kind]}</dt><dd>{editingSummary.counts[kind]}<small>件</small></dd></div>
              ))}
            </dl>
            {editingSummary.recentExamples.length ? (
              <section>
                <h3 className="editingLearningSectionTitle">最近の確定事例 · 開くと変更前後を確認できます</h3>
                <div className="editingLearningExamples">
                  {editingSummary.recentExamples.map((example) => <EditingExampleItem example={example} excludingId={excludingId} onExclude={(id) => void handleExclude(id)} key={example.exampleId} />)}
                </div>
              </section>
            ) : <p className="userDictionaryModalHint editingLearningEmpty">確定済みの編集事例はまだありません。動画の書き出しが成功すると、学習対象になる変更をここに記録します。</p>}
          </>
        ) : <p className="userDictionaryModalHint editingLearningEmpty">確定済みの編集事例を読み込み中です。</p>}
        <section className="editingLearningLegacy">
          <h3 className="editingLearningSectionTitle">従来の修正ペア · {sorted.length} 件</h3>
          <p className="userDictionaryModalHint">過去に蓄積した「誤→正」の表記です。AIの文脈判断に使います。毎回置換したい語はユーザー辞書へ登録してください。</p>
        {sorted.length === 0 ? (
          <p className="userDictionaryModalEmpty">修正ペアはありません。</p>
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
                    disabled={deletingKey !== null}
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
        </section>
        </div>
        {actionError && <p className="editingLearningFeedback editingLearningError" role="alert">{actionError}</p>}
        {exportMessage && <div className="editingLearningFeedback" role="status">{exportMessage}
          {exportFiles && <div className="editingLearningExportFiles">
            <button type="button" onClick={() => window.catcut.revealPath(exportFiles.path)}>学習用JSONを表示</button>
            {exportFiles.summaryPath && <button type="button" onClick={() => window.catcut.revealPath(exportFiles.summaryPath!)}>確認用TXTを表示</button>}
          </div>}
        </div>}
        <div className="telopReplaceModalActions">
          <button disabled={exporting} onClick={() => void handleExport()} type="button">
            {exporting ? "書き出し中..." : "学習データを書き出す"}
          </button>
          <button autoFocus onClick={onClose} type="button">
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
