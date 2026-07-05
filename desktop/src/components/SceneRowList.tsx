import type { Scene } from "../lib/scenes";
import type { SuspicionItem } from "../lib/suspicionQueue";
import type { EdgeTrimEdge } from "../lib/edgeTrim";
import type { EmotionTag } from "../lib/emotionTag";
import type { TelopThemeId } from "../lib/telopThemes";
import { SceneRow } from "./SceneRow";
import type { EdgeDragTooltip } from "./SceneWaveformStrip";

/** Phase 3: 行端の長押しスライドの見た目状態(行ごと)。App側でscenesHistory.scenesから導出する。 */
export type SceneEdgeVisual = {
  /** 次の行と時間的に連続している(境界を動かすと連動して伸縮する)か。 */
  linkedNext: boolean;
  /** この行が現在ドラッグ対象の場合のツールチップ表示内容。 */
  dragTooltip?: EdgeDragTooltip;
  /** 連動ロール中、この行が隣接行として受動的にハイライトすべき端。 */
  highlightEdge?: EdgeTrimEdge | null;
};

/** 改善5-2(チップのドラッグ複数選択): どのシーンのどの範囲が選択されているか(App側で単一管理)。 */
export type ChipSelectionState = { sceneId: string; start: number; end: number };

type Props = {
  scenes: Scene[];
  currentSceneId: string | null;
  playheadMs: number;
  /** 改善5-1(ホバー自動スクロールの抑制): <video>が実際に再生中か。 */
  isPlaybackActive: boolean;
  /** 改善5-6(ハサミモード): Bキーでトグル。 */
  scissorsMode: boolean;
  /** 改善5-2(チップのドラッグ複数選択): 現在の選択(1シーンのみ選択可能)。 */
  chipSelection: ChipSelectionState | null;
  suspicionsBySceneId: Map<string, SuspicionItem[]>;
  peaks: number[];
  /** 改善2(波形の縦スケール改善): 録音全体のグローバルピーク(App側で1回だけ計算した値)。 */
  globalPeakMax: number;
  binMs: number;
  onSeek: (ms: number) => void;
  onHoverSeek: (ms: number) => void;
  /** 改善1: 単語グループチップ単位の削除/復元(グループを構成する全文字wordIdを渡す)。 */
  onToggleChip: (sceneId: string, wordIds: string[]) => void;
  onTelopChange: (sceneId: string, text: string) => void;
  onEditingChange: (editing: boolean) => void;
  /** 改善1: テロップtextarea編集中はチップ列のホバースクラブを無効化するための参照。 */
  editingRef?: { current: boolean };
  onPlayScene: (scene: Scene) => void;
  /** 改善5-7(一括置換ポップアップ): テロップ編集フォーカス開始。 */
  onTelopFocus: (sceneId: string, text: string) => void;
  /** 改善5-7(一括置換ポップアップ): テロップ編集確定(blur)。 */
  onTelopBlur: (sceneId: string) => void;
  /** 改善5-8: チップ間クリック(キャレット確定)時に再生中なら一時停止する。 */
  onCaretConfirm?: () => void;
  /** 改善3(チップ間ホバーキャレット): 行のチップ列上でのキャレット状態変化を親へ伝える。 */
  onChipCaretChange?: (sceneId: string, groupIndex: number | null) => void;
  /** 改善5-2(チップのドラッグ複数選択): 選択範囲が変わった(またはnullになった)ことを親へ伝える。 */
  onChipSelectionChange?: (sceneId: string, range: { start: number; end: number } | null) => void;
  /** 改善5-6(ハサミモード): チップ列上のクリックでグループ境界にスナップして分割する。 */
  onScissorsSplitChip?: (sceneId: string, groupIndex: number) => void;
  /** 改善5-6(ハサミモード): 波形上のクリックで即座に分割する。 */
  onScissorsCutMs?: (sceneId: string, ms: number) => void;
  /** Phase 3: 行端の長押しスライド。省略時は端ハンドルのドラッグは無効。 */
  edgeVisualBySceneId?: Map<string, SceneEdgeVisual>;
  onEdgeDragStart?: (sceneId: string, edge: EdgeTrimEdge) => void;
  onEdgeDragMove?: (sceneId: string, edge: EdgeTrimEdge, rawTargetMs: number, chipSnapToleranceMs: number) => void;
  onEdgeDragEnd?: (sceneId: string, edge: EdgeTrimEdge, rawTargetMs: number, chipSnapToleranceMs: number) => void;
  /** T-1〜T-3(テーマ×感情の自動スタイリング): 現在アクティブなテーマ。 */
  themeId: TelopThemeId;
  /** T-2: 感情バッジクリックによるタグ変更。 */
  onSetEmotionTag: (sceneId: string, tag: EmotionTag) => void;
  /** T-3: スウォッチ→パレットからの個別スタイルオーバーライド設定/解除(null=解除)。 */
  onSetStyleOverride: (sceneId: string, styleId: string | null) => void;
  /** T-3: 「このスタイルを同じ感情の全シーンに適用」。 */
  onApplyStyleToEmotionGroup: (sceneId: string, styleId: string) => void;
  /** フェーズT2: directedモード(演出ディレクティブ駆動)ならスタイルバッジ=シーン種類/スタイルIDを正とする。 */
  directedMode?: boolean;
  /** フェーズT2.5-4: シーン種類→プリセットIDの解決済みマッピング(既定+ユーザー設定)。 */
  telopTypeMapping?: Record<string, string>;
  /** フェーズT2.5-4: typeバッジからのシーン種類変更。 */
  onSetDirectedType?: (sceneId: string, typeId: string) => void;
  /** フェーズT2: プリセットの個別上書き(null=解除)。 */
  onSetDirectedStyle?: (sceneId: string, styleId: string | null) => void;
  /** 改善21-B: ai_failure 疑義(AI校正未実行)の項目内から⚙API設定モーダルを開く。 */
  onOpenApiSettings?: () => void;
};

/**
 * シーン行の縦リスト。実際の仮想化(重い波形canvas描画の間引き)は各SceneRow内の
 * IntersectionObserverで行う(CutCardsPanelと同じ方針)。DOM自体はシンプルに保つ。
 */
export function SceneRowList({
  scenes,
  currentSceneId,
  playheadMs,
  isPlaybackActive,
  scissorsMode,
  chipSelection,
  suspicionsBySceneId,
  peaks,
  globalPeakMax,
  binMs,
  onSeek,
  onHoverSeek,
  onToggleChip,
  onTelopChange,
  onEditingChange,
  editingRef,
  onPlayScene,
  onTelopFocus,
  onTelopBlur,
  onCaretConfirm,
  onChipCaretChange,
  onChipSelectionChange,
  onScissorsSplitChip,
  onScissorsCutMs,
  edgeVisualBySceneId,
  onEdgeDragStart,
  onEdgeDragMove,
  onEdgeDragEnd,
  themeId,
  onSetEmotionTag,
  onSetStyleOverride,
  onApplyStyleToEmotionGroup,
  directedMode,
  telopTypeMapping,
  onSetDirectedType,
  onSetDirectedStyle,
  onOpenApiSettings,
}: Props) {
  if (!scenes.length) {
    return <div className="sceneRowListEmpty">表示できるシーンがありません。</div>;
  }
  return (
    <div className="sceneRowList">
      {scenes.map((scene, index) => {
        const edgeVisual = edgeVisualBySceneId?.get(scene.id);
        return (
          <SceneRow
            binMs={binMs}
            chipSelection={chipSelection && chipSelection.sceneId === scene.id ? chipSelection : null}
            dragTooltip={edgeVisual?.dragTooltip}
            editingRef={editingRef}
            highlightEdge={edgeVisual?.highlightEdge}
            isCurrent={scene.id === currentSceneId}
            isPlaybackActive={isPlaybackActive}
            key={scene.id}
            linkedNext={edgeVisual?.linkedNext}
            onCaretConfirm={onCaretConfirm}
            onChipCaretChange={onChipCaretChange}
            onChipSelectionChange={onChipSelectionChange ? (range) => onChipSelectionChange(scene.id, range) : undefined}
            onEditingChange={onEditingChange}
            onEdgeDragEnd={
              onEdgeDragEnd ? (edge, rawTargetMs, tolerance) => onEdgeDragEnd(scene.id, edge, rawTargetMs, tolerance) : undefined
            }
            onEdgeDragMove={
              onEdgeDragMove
                ? (edge, rawTargetMs, tolerance) => onEdgeDragMove(scene.id, edge, rawTargetMs, tolerance)
                : undefined
            }
            onEdgeDragStart={onEdgeDragStart ? (edge) => onEdgeDragStart(scene.id, edge) : undefined}
            onHoverSeek={onHoverSeek}
            onPlayScene={() => onPlayScene(scene)}
            onScissorsCutMs={onScissorsCutMs ? (ms) => onScissorsCutMs(scene.id, ms) : undefined}
            onScissorsSplitChip={onScissorsSplitChip ? (groupIndex) => onScissorsSplitChip(scene.id, groupIndex) : undefined}
            onSeek={onSeek}
            onTelopBlur={() => onTelopBlur(scene.id)}
            onTelopChange={(text) => onTelopChange(scene.id, text)}
            onTelopFocus={() => onTelopFocus(scene.id, scene.telopText)}
            onToggleChip={(wordIds) => onToggleChip(scene.id, wordIds)}
            globalPeakMax={globalPeakMax}
            ordinal={index + 1}
            peaks={peaks}
            playheadMs={playheadMs}
            scene={scene}
            scissorsMode={scissorsMode}
            suspicions={suspicionsBySceneId.get(scene.id) || []}
            themeId={themeId}
            onSetEmotionTag={(tag) => onSetEmotionTag(scene.id, tag)}
            onSetStyleOverride={(styleId) => onSetStyleOverride(scene.id, styleId)}
            onApplyStyleToEmotionGroup={(styleId) => onApplyStyleToEmotionGroup(scene.id, styleId)}
            directedMode={directedMode}
            telopTypeMapping={telopTypeMapping}
            onSetDirectedType={onSetDirectedType ? (typeId) => onSetDirectedType(scene.id, typeId) : undefined}
            onSetDirectedStyle={onSetDirectedStyle ? (styleId) => onSetDirectedStyle(scene.id, styleId) : undefined}
            onOpenApiSettings={onOpenApiSettings}
          />
        );
      })}
    </div>
  );
}
