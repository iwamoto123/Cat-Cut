import { useEffect, useState } from "react";
import { CheckCircle2, FolderOpen, Play, Share2 } from "lucide-react";
import "./EditingLearning.css";

/**
 * フェーズW7: 書き出し完了ダイアログ。Finderでの表示は完了時に自動で行い、
 * ここでは「プロジェクトとして保存するか」を選ばせる。
 */
export type ExportDoneInfo = {
  runDir: string;
  finalVideo: string;
  learning?: { examples: number; changed: boolean; warning?: string };
};

type Props = {
  info: ExportDoneInfo | null;
  busy: boolean;
  onSaveProject: () => void;
  onDeleteProject: () => void;
  onClose: () => void;
  onShareLearning: () => Promise<{
    path: string;
    summaryPath?: string;
    stats: { runs: number; editEntries: number; correctionPairs: number; editingExamples?: number; confirmedProjects?: number };
    shared: boolean;
  }>;
};

export function ExportDoneModal({ info, busy, onSaveProject, onDeleteProject, onClose, onShareLearning }: Props) {
  const [sharing, setSharing] = useState(false);
  const [shareMessage, setShareMessage] = useState("");
  const [shareError, setShareError] = useState(false);
  const [shareFiles, setShareFiles] = useState<{ path: string; summaryPath?: string } | null>(null);
  useEffect(() => {
    setShareMessage("");
    setShareError(false);
    setShareFiles(null);
  }, [info]);
  if (!info) return null;

  // 保存先が作業フォルダ内(既定のoutput/final.mp4)の場合、プロジェクト削除でMP4も消える
  const videoInsideRunDir = info.finalVideo.startsWith(`${info.runDir}/`);

  return (
    <div className="commandPaletteBackdrop" role="presentation">
      <div className="exportDoneModal editingLearningExportDone" role="dialog" aria-modal="true" aria-labelledby="exportDoneTitle">
        <div className="exportDoneHeader" id="exportDoneTitle">
          <CheckCircle2 size={22} />
          <span>書き出しが完了しました</span>
        </div>
        <div className="exportDoneBody">
          <div className="exportDonePath" title={info.finalVideo}>
            {info.finalVideo}
          </div>
          {info.learning && (
            <div className={`exportDoneLearningStatus ${info.learning.warning ? "isWarning" : ""}`} role={info.learning.warning ? "alert" : "status"}>
              {info.learning.warning ? (
                <>
                  <strong>編集事例の保存を確認できませんでした</strong>
                  <p>{info.learning.warning}</p>
                  <p>動画は書き出し済みです。共有ファイルには、最後に保存できた確定事例を含めます。</p>
                </>
              ) : (
                <>
                  <strong>{info.learning.examples > 0 ? `確定した編集事例を${info.learning.changed ? "保存しました" : "保存済みです"} · ${info.learning.examples} 件` : "編集結果を記録しました · 学習対象になる変更はありません"}</strong>
                  <p>{info.learning.examples === 0 ? "変更前後の差分がある場合に、編集事例として蓄積します。" : info.learning.changed ? "カット・文章校正・シーン区切り・改行の変更を、次回のAI編集の参考に使います。" : "同じ編集結果の書き出しでは、事例の件数を増やしません。"}</p>
                </>
              )}
            </div>
          )}
          <div className="exportDoneQuickActions">
            <button onClick={() => window.catcut.openPath(info.finalVideo)} type="button">
              <Play size={14} />
              <span>MP4を再生</span>
            </button>
            <button onClick={() => window.catcut.revealPath(info.finalVideo)} type="button">
              <FolderOpen size={14} />
              <span>Finderで表示</span>
            </button>
            <button
              disabled={sharing || busy}
              onClick={async () => {
                setSharing(true);
                setShareMessage("");
                setShareError(false);
                setShareFiles(null);
                try {
                  const result = await onShareLearning();
                  const count = result.stats.editingExamples == null ? `従来の編集 ${result.stats.editEntries} 件` : `確定した編集事例 ${result.stats.editingExamples} 件`;
                  setShareMessage(
                    `${result.shared ? "Nextcloudの共有フォルダに保存しました。同期状況はNextcloudで確認できます。" : "共有用ファイルを保存しました。"}\n` +
                    `${count}。${result.summaryPath ? "学習用JSONと確認用TXTを作成しました。TXT単体は学習に取り込みません。" : "学習用JSONを作成しました。"}`,
                  );
                  setShareFiles({ path: result.path, summaryPath: result.summaryPath });
                } catch (error) {
                  setShareError(true);
                  setShareMessage(error instanceof Error ? error.message : "学習データの作成に失敗しました。");
                } finally {
                  setSharing(false);
                }
              }}
              type="button"
            >
              <Share2 size={14} />
              <span>{sharing ? "作成中..." : "編集学習データを共有"}</span>
            </button>
          </div>
          <p className="exportDoneLearningHint">共有ファイルは、変更前後の文章・カット区間・シーン区切り・改行を含みます。再編集中は、最後に書き出しが成功した確定結果を使います。</p>
          {shareMessage && <div className={`editingLearningFeedback ${shareError ? "editingLearningError" : ""}`} role={shareError ? "alert" : "status"}>
            {shareMessage}
            {shareFiles && <div className="editingLearningExportFiles">
              <button type="button" onClick={() => window.catcut.revealPath(shareFiles.path)}>学習用JSONを表示</button>
              {shareFiles.summaryPath && <button type="button" onClick={() => window.catcut.revealPath(shareFiles.summaryPath!)}>確認用TXTを表示</button>}
            </div>}
          </div>}
          <p className="exportDoneQuestion">
            このプロジェクトを保存しますか？保存するとプロジェクト一覧からいつでも検品画面を開いて再編集できます。
          </p>
          {videoInsideRunDir && (
            <p className="exportDoneWarn">
              書き出したMP4は作業フォルダ内にあるため、「削除する」を選ぶとMP4も一緒に削除されます。
            </p>
          )}
        </div>
        <div className="exportDoneFooter">
          <button className="exportDoneDeleteButton" disabled={busy} onClick={onDeleteProject} type="button">
            削除する
          </button>
          <div className="exportDoneFooterRight">
            <button className="secondaryButton" disabled={busy} onClick={onClose} type="button">
              あとで決める
            </button>
            <button className="primaryButton" disabled={busy} onClick={onSaveProject} type="button">
              保存する
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
