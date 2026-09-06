/**
 * フェーズW6: シーン検品先頭のOP行リスト(旧OpSummaryCardの後継)。
 *
 * OP(冒頭ダイジェスト)の各クリップを、シーン行と同じ操作感の行として表示する:
 * - 波形ストリップの端をドラッグしてクリップ幅(尺)を変更できる(SceneRowの端トリムと同じ操作)
 * - 波形クリックでプレビューのOP該当位置へシーク(プレビュー連動)、再生バーも同期表示
 * - テロップ文言(フックワード/発話テロップ)をその場で編集できる
 * 編集はrun正本(op_config.json)へ保存し、映像への反映は従来どおり「適用」で行う。
 * 並び替え・追加・差し替え等の細かい操作は既存のOP編集モーダル(詳細編集)に任せる。
 */
import { useMemo, useRef, useState } from "react";
import { Play, SlidersHorizontal } from "lucide-react";
import type { Scene } from "../lib/scenes";
import type { EdgeTrimEdge } from "../lib/edgeTrim";
import type { OpPreviewData } from "../lib/previewPlaylist";
import {
  opClipDurationLabel,
  opClipPlayheadMs,
  opClipTimelineOffsets,
  opClipTrimBounds,
  opDurationLabel,
  sceneNumberForOpClip,
  trimOpClipEdge,
  type OpClip,
} from "../lib/opEditor";
import { usePlayheadTimelineMs } from "../lib/playheadStore";
import { SceneWaveformStrip } from "./SceneWaveformStrip";

type Props = {
  /** resolveOpPreviewData の結果(ヘッダのパターン・合計尺表示に使う)。 */
  op: OpPreviewData;
  /** 編集対象のクリップ(run正本 or AI選定の初期表示)。teaser以外は空配列。 */
  clips: OpClip[];
  /** clips=null(AI自動選定中)か。編集した瞬間に手動選定へ切り替わる。 */
  isAuto: boolean;
  scenes: Scene[];
  peaks: number[];
  globalPeakMax: number;
  binMs: number;
  /** 元動画の総尺(トリム範囲のフォールバック上限)。 */
  videoDurationMs: number;
  /** OP編集モーダル(並び替え・追加・パターン変更など)を開く。 */
  onOpenEditor: () => void;
  /** 波形クリック→プレビューのOP該当位置(タイムラインms)へシーク。 */
  onSeekTimeline: (timelineMs: number) => void;
  /** 行左端の再生ボタン→このクリップだけ再生(タイムラインmsの区間)。 */
  onPlayClip: (timelineStartMs: number, timelineEndMs: number) => void;
  /** W10-8d: 元シーン先頭へジャンプ(再生はしない。要確認パネルのジャンプと同挙動)。 */
  onJumpToSourceScene?: (clip: OpClip) => void;
  /** クリップの編集(トリム・文言)。commit=trueでrun正本(op_config.json)へ保存する。 */
  onClipsChange: (clips: OpClip[], options: { commit: boolean }) => void;
  /** W10-6: テキスト編集開始(textareaフォーカス)。再生中なら親側で一時停止する。 */
  onTextFocus?: () => void;
};

/** 波形ストリップ(SceneWaveformStrip)へ渡すためのOPクリップの疑似シーン。 */
function opStripScene(clip: OpClip, index: number): Scene {
  return {
    id: `op-clip-${index}`,
    sourceStartMs: clip.start_ms,
    sourceEndMs: clip.end_ms,
    words: [],
    telopText: "",
    telopEdited: false,
    cutMarks: [],
  };
}

const OP_PATTERN_LABELS: Record<string, string> = {
  highlight_teaser: "冒頭ダイジェスト",
  title_card: "タイトルカード",
  question_hook: "問いかけフック",
};

export function OpClipRows({
  op,
  clips,
  isAuto,
  scenes,
  peaks,
  globalPeakMax,
  binMs,
  videoDurationMs,
  onOpenEditor,
  onSeekTimeline,
  onPlayClip,
  onJumpToSourceScene,
  onClipsChange,
  onTextFocus,
}: Props) {
  // W19-A3: OP再生中の再生バー同期はplayheadStoreを直接購読する(App経由のprop配布をやめる)。
  // OP行はクリップ数が少ないため、このコンポーネント単位の毎フレーム再レンダリングで足りる。
  const previewTimelineMs = usePlayheadTimelineMs();
  /** 端ドラッグ中の行(ツールチップ表示用)。実際の値更新は onClipsChange(live) で親へ流す。 */
  const [draggingEdge, setDraggingEdge] = useState<{ index: number; edge: EdgeTrimEdge } | null>(null);
  /** テキスト編集がコミット待ちか(blur時に無変更ならop_config.jsonへ書き込まない)。 */
  const textDirtyRef = useRef(false);
  /**
   * このドラッグで実際に値が変わったか。端を触っただけ(移動なし)の場合は保存しない
   * (AI自動選定が意図せず手動選定へ切り替わるのを防ぐ)。
   */
  const dragDirtyRef = useRef(false);

  const offsets = useMemo(() => opClipTimelineOffsets(clips), [clips]);
  const isTeaser = op.pattern === "highlight_teaser";

  function handleEdgeDragMove(index: number, edge: EdgeTrimEdge, rawTargetMs: number, commit: boolean) {
    const bounds = opClipTrimBounds(scenes, clips[index], videoDurationMs);
    const next = trimOpClipEdge(clips, index, edge, rawTargetMs, bounds);
    const changed = next !== clips;
    if (changed) dragDirtyRef.current = true;
    if (commit) {
      const shouldCommit = dragDirtyRef.current;
      dragDirtyRef.current = false;
      if (shouldCommit) onClipsChange(next, { commit: true });
      return;
    }
    if (changed) onClipsChange(next, { commit: false });
  }

  function handleTextChange(index: number, value: string) {
    textDirtyRef.current = true;
    const clip = clips[index];
    const patch = clip.display === "hook" ? { hook_text: value } : { text: value };
    onClipsChange(
      clips.map((item, i) => (i === index ? { ...item, ...patch } : item)),
      { commit: false },
    );
  }

  function handleTextBlur() {
    if (!textDirtyRef.current) return;
    textDirtyRef.current = false;
    onClipsChange(clips, { commit: true });
  }

  return (
    <div className="opClipRows">
      <div className="opClipRowsHeader">
        <span className="opClipRowsBadge">OP</span>
        <span className="opClipRowsTitle">{OP_PATTERN_LABELS[op.pattern] || "オープニング"}</span>
        <span className="opClipRowsMeta">
          {isTeaser ? `${clips.length}クリップ・` : ""}
          {opDurationLabel(op.durationMs)}
          {isTeaser && isAuto ? "・AI自動選定" : ""}
        </span>
        <button
          className="opClipRowsEditButton"
          onClick={onOpenEditor}
          title="並び替え・クリップの追加/差し替え・パターン変更などの詳細編集を開きます"
          type="button"
        >
          <SlidersHorizontal size={12} />
          詳細編集
        </button>
      </div>
      {isTeaser && clips.length > 0 && (
        <div className="opClipRowList">
          {clips.map((clip, index) => {
            const sceneNumber = sceneNumberForOpClip(scenes, clip);
            const stripScene = opStripScene(clip, index);
            const isDraggingRow = draggingEdge?.index === index;
            const timelineStart = offsets[index];
            const timelineEnd = timelineStart + (clip.end_ms - clip.start_ms);
            return (
              <div className="opClipRow" key={index}>
                <div className="opClipRowIndex">{index + 1}</div>
                <div className="opClipRowBody">
                  <div className="opClipRowTop">
                    <button
                      className="opClipRowPlayButton"
                      onClick={() => onPlayClip(timelineStart, timelineEnd)}
                      title="このクリップだけプレビュー再生します"
                      type="button"
                    >
                      <Play size={12} />
                    </button>
                    <span className="opClipRowMeta">
                      {sceneNumber !== null ? `シーン${sceneNumber}` : "シーン対応なし"}・
                      {opClipDurationLabel(clip)}
                    </span>
                    {sceneNumber !== null && onJumpToSourceScene && (
                      <button
                        className="opClipRowJumpButton"
                        onClick={() => onJumpToSourceScene(clip)}
                        title="元シーンの先頭へジャンプします（再生はしません）"
                        type="button"
                      >
                        シーン{sceneNumber}へ↓
                      </button>
                    )}
                    <textarea
                      className="opClipRowTextInput"
                      onBlur={handleTextBlur}
                      onChange={(event) => handleTextChange(index, event.target.value)}
                      onFocus={onTextFocus}
                      placeholder={
                        clip.display === "hook"
                          ? "フックワード（大きく表示。改行で上下2段）"
                          : "テロップ文言（空欄=テロップなし）"
                      }
                      rows={(clip.display === "hook" ? clip.hook_text : clip.text).includes("\n") ? 2 : 1}
                      title={
                        clip.display === "hook"
                          ? "フックワード(画面いっぱいに大きく表示)をその場で編集できます"
                          : "発話テロップ文言をその場で編集できます"
                      }
                      value={clip.display === "hook" ? clip.hook_text : clip.text}
                    />
                  </div>
                  <SceneWaveformStrip
                    binMs={binMs}
                    dragTooltip={
                      isDraggingRow && draggingEdge
                        ? { edge: draggingEdge.edge, label: opClipDurationLabel(clip) }
                        : null
                    }
                    globalPeakMax={globalPeakMax}
                    onEdgeDragEnd={(edge, rawTargetMs) => {
                      setDraggingEdge(null);
                      handleEdgeDragMove(index, edge, rawTargetMs, true);
                    }}
                    onEdgeDragMove={(edge, rawTargetMs) => handleEdgeDragMove(index, edge, rawTargetMs, false)}
                    onEdgeDragStart={(edge) => setDraggingEdge({ index, edge })}
                    onSeek={(ms) => onSeekTimeline(timelineStart + (ms - clip.start_ms))}
                    peaks={peaks}
                    playheadMs={opClipPlayheadMs(clips, index, previewTimelineMs)}
                    scene={stripScene}
                    visible
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
