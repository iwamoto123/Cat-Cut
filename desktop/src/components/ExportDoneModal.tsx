import { useState } from "react";
import { CheckCircle2, FolderOpen, Play, Share2 } from "lucide-react";

/**
 * フェーズW7: 書き出し完了ダイアログ。Finderでの表示は完了時に自動で行い、
 * ここでは「プロジェクトとして保存するか」を選ばせる。
 */
export type ExportDoneInfo = {
  runDir: string;
  finalVideo: string;
};

type Props = {
  info: ExportDoneInfo | null;
  busy: boolean;
  onSaveProject: () => void;
  onDeleteProject: () => void;
  onClose: () => void;
  onShareLearning: () => Promise<{
    path: string;
    stats: { runs: number; editEntries: number; correctionPairs: number };
    shared: boolean;
  }>;
};

export function ExportDoneModal({ info, busy, onSaveProject, onDeleteProject, onClose, onShareLearning }: Props) {
  const [sharing, setSharing] = useState(false);
  const [shareMessage, setShareMessage] = useState("");
  if (!info) return null;

  // 保存先が作業フォルダ内(既定のoutput/final.mp4)の場合、プロジェクト削除でMP4も消える
  const videoInsideRunDir = info.finalVideo.startsWith(`${info.runDir}/`);

  return (
    <div className="commandPaletteBackdrop" role="presentation">
      <div className="exportDoneModal" role="dialog">
        <div className="exportDoneHeader">
          <CheckCircle2 size={22} />
          <span>書き出しが完了しました</span>
        </div>
        <div className="exportDoneBody">
          <div className="exportDonePath" title={info.finalVideo}>
            {info.finalVideo}
          </div>
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
              disabled={sharing}
              onClick={async () => {
                setSharing(true);
                setShareMessage("");
                try {
                  const result = await onShareLearning();
                  setShareMessage(
                    result.shared
                      ? `Nextcloudの共有フォルダに保存しました（編集${result.stats.editEntries}件）。同期で自動的に届くため送付は不要です。`
                      : `JSONを作成しました（編集${result.stats.editEntries}件）。社員PCでは、このJSONだけを岩本さんへ送ってください。`,
                  );
                } catch {
                  setShareMessage("学習データの作成に失敗しました。");
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
          {shareMessage && <p className="exportDoneLearningMessage">{shareMessage}</p>}
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
