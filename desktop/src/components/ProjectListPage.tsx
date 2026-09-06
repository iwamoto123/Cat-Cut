import { Clapperboard, FolderOpen, Trash2 } from "lucide-react";
import { formatProjectDuration, formatProjectTimestamp } from "../lib/exportOptions";

/**
 * フェーズW7: プロジェクト一覧。検品段階に到達した runs/<run>/ をカードで並べ、
 * クリックで検品画面(シーン検品)を直接開き直せる。
 */
type Props = {
  projects: CatCutProjectSummary[];
  openingRunDir: string | null;
  disabled: boolean;
  onOpen: (project: CatCutProjectSummary) => void;
  onDelete: (project: CatCutProjectSummary) => void;
  onReveal: (runDir: string) => void;
};

export function ProjectListPage({ projects, openingRunDir, disabled, onOpen, onDelete, onReveal }: Props) {
  return (
    <section className="projectListPage">
      <div className="projectListHeader">
        <div className="projectListTitle">
          <Clapperboard size={18} />
          <span>プロジェクト</span>
          <span className="projectListCount">{projects.length}件</span>
        </div>
        <p className="projectListHint">クリックすると検品画面から再編集できます</p>
      </div>
      {projects.length === 0 ? (
        <p className="projectListEmpty">
          プロジェクトはまだありません。左のパネルで動画を選んで「開始」すると、解析結果がプロジェクトとしてここに並びます。
        </p>
      ) : (
        <div className="projectListGrid">
          {projects.map((project) => {
            const opening = openingRunDir === project.runDir;
            return (
              <article
                className={`projectCard ${opening ? "projectCardOpening" : ""}`}
                key={project.runDir}
                onClick={() => {
                  if (!disabled && !opening) onOpen(project);
                }}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if ((event.key === "Enter" || event.key === " ") && !disabled && !opening) {
                    event.preventDefault();
                    onOpen(project);
                  }
                }}
              >
                <div className="projectCardThumb">
                  {project.thumbnailDataUrl ? (
                    <img alt="" src={project.thumbnailDataUrl} />
                  ) : (
                    <Clapperboard size={28} />
                  )}
                  {project.durationMs > 0 && (
                    <span className="projectCardDuration">{formatProjectDuration(project.durationMs)}</span>
                  )}
                </div>
                <div className="projectCardBody">
                  <div className="projectCardName" title={project.title}>
                    {project.title}
                  </div>
                  <div className="projectCardMeta">
                    <span>{formatProjectTimestamp(project.updatedAtMs || project.createdAtMs)}</span>
                    {project.exportedVideoPath && <span className="projectCardBadge projectCardBadgeDone">書き出し済み</span>}
                    {project.saved && <span className="projectCardBadge projectCardBadgeSaved">保存済み</span>}
                    {!project.sourceVideoExists && (
                      <span className="projectCardBadge projectCardBadgeWarn" title={`元動画が見つかりません: ${project.sourceVideoPath}`}>
                        元動画なし
                      </span>
                    )}
                  </div>
                </div>
                <div className="projectCardActions" onClick={(event) => event.stopPropagation()}>
                  <button
                    className="projectCardIconButton"
                    onClick={() => onReveal(project.runDir)}
                    title="作業フォルダをFinderで表示"
                    type="button"
                  >
                    <FolderOpen size={15} />
                  </button>
                  <button
                    className="projectCardIconButton projectCardDeleteButton"
                    disabled={disabled}
                    onClick={() => onDelete(project)}
                    title="プロジェクトを削除"
                    type="button"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                {opening && <div className="projectCardOpeningLabel">読み込み中…</div>}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
