import { memo, useMemo, useRef } from "react";
import { RotateCcw } from "lucide-react";
import { isSceneFullyDeleted, type Scene } from "../lib/scenes";
import type { SuspicionItem } from "../lib/suspicionQueue";
import type { EdgeTrimEdge } from "../lib/edgeTrim";
import type { EmotionTag } from "../lib/emotionTag";
import type { TelopThemeId } from "../lib/telopThemes";
import type { TelopTypeMapping } from "../lib/telopTypes";
import type { ActiveSpeakerColors } from "../lib/speakerColors";
import type { EdgeDragVisual } from "../lib/edgeDragVisual";
import { SceneRow } from "./SceneRow";
import type { VideoEffectOverride } from "../lib/videoEffectCatalog";

/**
 * 改善5-2(チップのドラッグ複数選択): どのシーンのどの範囲が選択されているか(App側で単一管理)。
 * W10-2: anchorはShift+クリック/Shift+矢印で範囲を伸縮するときの固定端(チップindex)。
 */
export type ChipSelectionState = { sceneId: string; start: number; end: number; anchor?: number };

/** W19-A3: 行へ配るコールバック一式(sceneId引数方式)。useStableRowHandlersで参照を安定化する。 */
type RowHandlers = {
  onSeek: (ms: number) => void;
  onHoverSeek: (ms: number) => void;
  onToggleChip: (sceneId: string, wordIds: string[]) => void;
  onTelopChange: (sceneId: string, text: string) => void;
  onEditingChange: (editing: boolean) => void;
  onTelopFocus: (sceneId: string, text: string) => void;
  onTelopBlur: (sceneId: string) => void;
  onSetEmotionTag: (sceneId: string, tag: EmotionTag) => void;
  onSetStyleOverride: (sceneId: string, styleId: string | null) => void;
  onApplyStyleToEmotionGroup: (sceneId: string, styleId: string) => void;
  onToggleSceneSelect?: (sceneId: string) => void;
  onSceneActivate?: (sceneId: string) => void;
  onCaretConfirm?: () => void;
  onCaretCommit?: (sceneId: string, groupIndex: number) => void;
  onChipCaretChange?: (sceneId: string, groupIndex: number | null) => void;
  onChipSelectionChange?: (sceneId: string, range: { start: number; end: number } | null) => void;
  onScissorsSplitChip?: (sceneId: string, groupIndex: number) => void;
  onScissorsCutMs?: (sceneId: string, ms: number) => void;
  onEdgeDragStart?: (sceneId: string, edge: EdgeTrimEdge) => void;
  onEdgeDragCancel?: () => void;
  onWaveformGestureStart?: () => void;
  onEdgeDragMove?: (sceneId: string, edge: EdgeTrimEdge, rawTargetMs: number, chipSnapToleranceMs: number) => void;
  onEdgeDragEnd?: (sceneId: string, edge: EdgeTrimEdge, rawTargetMs: number, chipSnapToleranceMs: number) => void;
  onRangeCut?: (sceneId: string, rawStartMs: number, rawEndMs: number, chipSnapToleranceMs: number) => void;
  onSetDirectedType?: (sceneId: string, typeId: string) => void;
  onSetDirectedStyle?: (sceneId: string, styleId: string | null) => void;
  onSetDirectedAnimation?: (sceneId: string, animationId: string | null) => void;
  onSetVideoEffectOverride?: (sceneId: string, override: VideoEffectOverride | null) => void;
  onSetHighlightWords?: (sceneId: string, words: string[]) => void;
  onMergeWithNext?: (sceneId: string) => void;
  onEditDesign?: (sceneId: string) => void;
  onOpenApiSettings?: () => void;
};

/**
 * W19-A3: 親(App)から毎レンダー新しい関数が渡されてもSceneRowItemのmemoが効くように、
 * 最新の実装をrefに保持した安定ラッパーへ変換する(呼び出しは常に最新実装へ届く)。
 * 省略可能なコールバックは「有無」がSceneRow側のUI表示(ボタンやメニュー項目の出し分け)に
 * 影響するため、undefinedはundefinedのまま透過し、有無が変わったときだけ作り直す。
 */
function useStableRowHandlers(handlers: RowHandlers): RowHandlers {
  const ref = useRef(handlers);
  ref.current = handlers;
  const presenceKey = [
    handlers.onToggleSceneSelect,
    handlers.onSceneActivate,
    handlers.onCaretConfirm,
    handlers.onCaretCommit,
    handlers.onChipCaretChange,
    handlers.onChipSelectionChange,
    handlers.onScissorsSplitChip,
    handlers.onScissorsCutMs,
    handlers.onEdgeDragStart,
    handlers.onEdgeDragCancel,
    handlers.onWaveformGestureStart,
    handlers.onEdgeDragMove,
    handlers.onEdgeDragEnd,
    handlers.onRangeCut,
    handlers.onSetDirectedType,
    handlers.onSetDirectedStyle,
    handlers.onSetDirectedAnimation,
    handlers.onSetVideoEffectOverride,
    handlers.onSetHighlightWords,
    handlers.onMergeWithNext,
    handlers.onEditDesign,
    handlers.onOpenApiSettings,
  ]
    .map((fn) => (fn ? "1" : "0"))
    .join("");
  return useMemo<RowHandlers>(
    () => ({
      onSeek: (ms) => ref.current.onSeek(ms),
      onHoverSeek: (ms) => ref.current.onHoverSeek(ms),
      onToggleChip: (sceneId, wordIds) => ref.current.onToggleChip(sceneId, wordIds),
      onTelopChange: (sceneId, text) => ref.current.onTelopChange(sceneId, text),
      onEditingChange: (editing) => ref.current.onEditingChange(editing),
      onTelopFocus: (sceneId, text) => ref.current.onTelopFocus(sceneId, text),
      onTelopBlur: (sceneId) => ref.current.onTelopBlur(sceneId),
      onSetEmotionTag: (sceneId, tag) => ref.current.onSetEmotionTag(sceneId, tag),
      onSetStyleOverride: (sceneId, styleId) => ref.current.onSetStyleOverride(sceneId, styleId),
      onApplyStyleToEmotionGroup: (sceneId, styleId) => ref.current.onApplyStyleToEmotionGroup(sceneId, styleId),
      onToggleSceneSelect: ref.current.onToggleSceneSelect
        ? (sceneId) => ref.current.onToggleSceneSelect?.(sceneId)
        : undefined,
      onSceneActivate: ref.current.onSceneActivate ? (sceneId) => ref.current.onSceneActivate?.(sceneId) : undefined,
      onCaretConfirm: ref.current.onCaretConfirm ? () => ref.current.onCaretConfirm?.() : undefined,
      onCaretCommit: ref.current.onCaretCommit
        ? (sceneId, groupIndex) => ref.current.onCaretCommit?.(sceneId, groupIndex)
        : undefined,
      onChipCaretChange: ref.current.onChipCaretChange
        ? (sceneId, groupIndex) => ref.current.onChipCaretChange?.(sceneId, groupIndex)
        : undefined,
      onChipSelectionChange: ref.current.onChipSelectionChange
        ? (sceneId, range) => ref.current.onChipSelectionChange?.(sceneId, range)
        : undefined,
      onScissorsSplitChip: ref.current.onScissorsSplitChip
        ? (sceneId, groupIndex) => ref.current.onScissorsSplitChip?.(sceneId, groupIndex)
        : undefined,
      onScissorsCutMs: ref.current.onScissorsCutMs
        ? (sceneId, ms) => ref.current.onScissorsCutMs?.(sceneId, ms)
        : undefined,
      onEdgeDragCancel: ref.current.onEdgeDragCancel ? () => ref.current.onEdgeDragCancel?.() : undefined,
      onWaveformGestureStart: ref.current.onWaveformGestureStart ? () => ref.current.onWaveformGestureStart?.() : undefined,
      onEdgeDragStart: ref.current.onEdgeDragStart
        ? (sceneId, edge) => ref.current.onEdgeDragStart?.(sceneId, edge)
        : undefined,
      onEdgeDragMove: ref.current.onEdgeDragMove
        ? (sceneId, edge, rawTargetMs, tolerance) => ref.current.onEdgeDragMove?.(sceneId, edge, rawTargetMs, tolerance)
        : undefined,
      onEdgeDragEnd: ref.current.onEdgeDragEnd
        ? (sceneId, edge, rawTargetMs, tolerance) => ref.current.onEdgeDragEnd?.(sceneId, edge, rawTargetMs, tolerance)
        : undefined,
      onRangeCut: ref.current.onRangeCut
        ? (sceneId, rawStartMs, rawEndMs, tolerance) => ref.current.onRangeCut?.(sceneId, rawStartMs, rawEndMs, tolerance)
        : undefined,
      onSetDirectedType: ref.current.onSetDirectedType
        ? (sceneId, typeId) => ref.current.onSetDirectedType?.(sceneId, typeId)
        : undefined,
      onSetDirectedStyle: ref.current.onSetDirectedStyle
        ? (sceneId, styleId) => ref.current.onSetDirectedStyle?.(sceneId, styleId)
        : undefined,
      onSetDirectedAnimation: ref.current.onSetDirectedAnimation
        ? (sceneId, animationId) => ref.current.onSetDirectedAnimation?.(sceneId, animationId)
        : undefined,
      onSetVideoEffectOverride: ref.current.onSetVideoEffectOverride
        ? (sceneId, override) => ref.current.onSetVideoEffectOverride?.(sceneId, override)
        : undefined,
      onSetHighlightWords: ref.current.onSetHighlightWords
        ? (sceneId, words) => ref.current.onSetHighlightWords?.(sceneId, words)
        : undefined,
      onMergeWithNext: ref.current.onMergeWithNext
        ? (sceneId) => ref.current.onMergeWithNext?.(sceneId)
        : undefined,
      onEditDesign: ref.current.onEditDesign ? (sceneId) => ref.current.onEditDesign?.(sceneId) : undefined,
      onOpenApiSettings: ref.current.onOpenApiSettings ? () => ref.current.onOpenApiSettings?.() : undefined,
    }),
    // presenceKey=省略可能コールバックの有無フィンガープリント(識別性はrefが担うため中身は見ない)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [presenceKey],
  );
}

/** 疑義なしの行に配る空配列(毎レンダー`|| []`で新規配列を作るとmemoが崩れるため共有する)。 */
const EMPTY_SUSPICIONS: SuspicionItem[] = [];

type SceneRowItemProps = {
  scene: Scene;
  ordinal: number;
  isCurrent: boolean;
  selected: boolean;
  active: boolean;
  chipSelection: ChipSelectionState | null;
  confirmedCaretIndex: number | null;
  flashSceneId?: string | null;
  linkedNext: boolean;
  canMergeWithNext: boolean;
  dragTooltip?: { edge: EdgeTrimEdge; label: string };
  highlightEdge?: EdgeTrimEdge | null;
  isPlaybackActive: boolean;
  playbackScrollSuppressed?: boolean;
  scissorsMode: boolean;
  suspicions: SuspicionItem[];
  peaks: number[];
  globalPeakMax: number;
  binMs: number;
  editingRef?: { current: boolean };
  themeId: TelopThemeId;
  directedMode?: boolean;
  telopTypeMapping?: TelopTypeMapping;
  speakerColors?: ActiveSpeakerColors | null;
  handlers: RowHandlers;
};

/**
 * W19-A3: 1行分のmemo境界。handlersが安定参照なので、シーン境界を跨いだ再レンダリング時も
 * データprops(scene/isCurrent等)が変わらない行はここでスキップされる。
 */
const SceneRowItem = memo(function SceneRowItem({
  scene,
  ordinal,
  isCurrent,
  selected,
  active,
  chipSelection,
  confirmedCaretIndex,
  flashSceneId,
  linkedNext,
  canMergeWithNext,
  dragTooltip,
  highlightEdge,
  isPlaybackActive,
  playbackScrollSuppressed,
  scissorsMode,
  suspicions,
  peaks,
  globalPeakMax,
  binMs,
  editingRef,
  themeId,
  directedMode,
  telopTypeMapping,
  speakerColors,
  handlers,
}: SceneRowItemProps) {
  const sceneId = scene.id;
  return (
    <SceneRow
      binMs={binMs}
      chipSelection={chipSelection}
      dragTooltip={dragTooltip}
      editingRef={editingRef}
      flashSceneId={flashSceneId}
      highlightEdge={highlightEdge}
      isCurrent={isCurrent}
      selected={selected}
      active={active}
      onToggleSelect={handlers.onToggleSceneSelect ? () => handlers.onToggleSceneSelect?.(sceneId) : undefined}
      isPlaybackActive={isPlaybackActive}
      playbackScrollSuppressed={playbackScrollSuppressed}
      linkedNext={linkedNext}
      onCaretConfirm={handlers.onCaretConfirm}
      onSceneActivate={handlers.onSceneActivate ? () => handlers.onSceneActivate?.(sceneId) : undefined}
      onCaretCommit={handlers.onCaretCommit ? (groupIndex) => handlers.onCaretCommit?.(sceneId, groupIndex) : undefined}
      confirmedCaretIndex={confirmedCaretIndex}
      onChipCaretChange={handlers.onChipCaretChange}
      onChipSelectionChange={
        handlers.onChipSelectionChange ? (range) => handlers.onChipSelectionChange?.(sceneId, range) : undefined
      }
      onEditingChange={handlers.onEditingChange}
      onEdgeDragEnd={
        handlers.onEdgeDragEnd
          ? (edge, rawTargetMs, tolerance) => handlers.onEdgeDragEnd?.(sceneId, edge, rawTargetMs, tolerance)
          : undefined
      }
      onEdgeDragMove={
        handlers.onEdgeDragMove
          ? (edge, rawTargetMs, tolerance) => handlers.onEdgeDragMove?.(sceneId, edge, rawTargetMs, tolerance)
          : undefined
      }
      onEdgeDragCancel={handlers.onEdgeDragCancel}
      onWaveformGestureStart={handlers.onWaveformGestureStart}
      onEdgeDragStart={handlers.onEdgeDragStart ? (edge) => handlers.onEdgeDragStart?.(sceneId, edge) : undefined}
      onRangeCutMs={
        handlers.onRangeCut
          ? (rawStartMs, rawEndMs, tolerance) => handlers.onRangeCut?.(sceneId, rawStartMs, rawEndMs, tolerance)
          : undefined
      }
      onHoverSeek={handlers.onHoverSeek}
      onScissorsCutMs={handlers.onScissorsCutMs ? (ms) => handlers.onScissorsCutMs?.(sceneId, ms) : undefined}
      onScissorsSplitChip={
        handlers.onScissorsSplitChip ? (groupIndex) => handlers.onScissorsSplitChip?.(sceneId, groupIndex) : undefined
      }
      onSeek={handlers.onSeek}
      onTelopBlur={() => handlers.onTelopBlur(sceneId)}
      onTelopChange={(text) => handlers.onTelopChange(sceneId, text)}
      onTelopFocus={() => handlers.onTelopFocus(sceneId, scene.telopText)}
      onToggleChip={(wordIds) => handlers.onToggleChip(sceneId, wordIds)}
      globalPeakMax={globalPeakMax}
      ordinal={ordinal}
      peaks={peaks}
      scene={scene}
      scissorsMode={scissorsMode}
      suspicions={suspicions}
      themeId={themeId}
      onSetEmotionTag={(tag) => handlers.onSetEmotionTag(sceneId, tag)}
      onSetStyleOverride={(styleId) => handlers.onSetStyleOverride(sceneId, styleId)}
      onApplyStyleToEmotionGroup={(styleId) => handlers.onApplyStyleToEmotionGroup(sceneId, styleId)}
      directedMode={directedMode}
      telopTypeMapping={telopTypeMapping}
      speakerColors={speakerColors}
      onSetDirectedType={handlers.onSetDirectedType ? (typeId) => handlers.onSetDirectedType?.(sceneId, typeId) : undefined}
      onSetDirectedStyle={
        handlers.onSetDirectedStyle ? (styleId) => handlers.onSetDirectedStyle?.(sceneId, styleId) : undefined
      }
      onSetDirectedAnimation={
        handlers.onSetDirectedAnimation
          ? (animationId) => handlers.onSetDirectedAnimation?.(sceneId, animationId)
          : undefined
      }
      onSetVideoEffectOverride={
        handlers.onSetVideoEffectOverride
          ? (override) => handlers.onSetVideoEffectOverride?.(sceneId, override)
          : undefined
      }
      onSetHighlightWords={
        handlers.onSetHighlightWords ? (words) => handlers.onSetHighlightWords?.(sceneId, words) : undefined
      }
      onMergeWithNext={canMergeWithNext && handlers.onMergeWithNext ? () => handlers.onMergeWithNext?.(sceneId) : undefined}
      onEditDesign={handlers.onEditDesign ? () => handlers.onEditDesign?.(sceneId) : undefined}
      onOpenApiSettings={handlers.onOpenApiSettings}
    />
  );
});

type Props = {
  scenes: Scene[];
  currentSceneId: string | null;
  /** W10-1(シーン単位の選択): 選択中シーンのid(単一)。行番号チップのクリックでトグルする。 */
  selectedSceneId?: string | null;
  /** W17: 元テキスト/表示テキスト操作中の行(行番号選択とは別)。 */
  activeSceneId?: string | null;
  /** W10-1: 行番号チップのクリックによる選択トグル。 */
  onToggleSceneSelect?: (sceneId: string) => void;
  /** W10-1: 削除済みシーンのスタブ行の復元ボタン(全単語のdeletedを解除する)。 */
  onRestoreScene?: (sceneId: string) => void;
  /** 改善5-1(ホバー自動スクロールの抑制): <video>が実際に再生中か。 */
  isPlaybackActive: boolean;
  /** フェーズW5-7: 要確認パネル発の再生中は自動追従スクロールを止める。 */
  playbackScrollSuppressed?: boolean;
  /** 改善5-6(ハサミモード): Bキーでトグル。 */
  scissorsMode: boolean;
  /** 改善5-2(チップのドラッグ複数選択): 現在の選択(1シーンのみ選択可能)。 */
  chipSelection: ChipSelectionState | null;
  /** フェーズW5-5(要確認パネル): ジャンプ先シーンの2秒フラッシュ表示(scrollIntoView+.jumpFlash)。 */
  flashSceneId?: string | null;
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
  /** 改善5-7(一括置換ポップアップ): テロップ編集フォーカス開始。 */
  onTelopFocus: (sceneId: string, text: string) => void;
  /** 改善5-7(一括置換ポップアップ): テロップ編集確定(blur)。 */
  onTelopBlur: (sceneId: string) => void;
  /** W17(操作中シーン): 元テキストのホバー/クリックでこの行をアクティブにする。 */
  onSceneActivate?: (sceneId: string) => void;
  /** 改善5-8: チップ間クリック(キャレット確定)時に再生中なら一時停止する。 */
  onCaretConfirm?: () => void;
  /** W16-4(確定キャレット): チップ境界クリックで確定したキャレット位置を親へ伝える。 */
  onCaretCommit?: (sceneId: string, groupIndex: number) => void;
  /** W16-4: 確定キャレット(該当シーンの行にだけ渡して削除候補の下線を表示する)。 */
  confirmedCaret?: { sceneId: string; groupIndex: number } | null;
  /** 改善3(チップ間ホバーキャレット): 行のチップ列上でのキャレット状態変化を親へ伝える。 */
  onChipCaretChange?: (sceneId: string, groupIndex: number | null) => void;
  /** 改善5-2(チップのドラッグ複数選択): 選択範囲が変わった(またはnullになった)ことを親へ伝える。 */
  onChipSelectionChange?: (sceneId: string, range: { start: number; end: number } | null) => void;
  /** 改善5-6(ハサミモード): チップ列上のクリックでグループ境界にスナップして分割する。 */
  onScissorsSplitChip?: (sceneId: string, groupIndex: number) => void;
  /** 改善5-6(ハサミモード): 波形上のクリックで即座に分割する。 */
  onScissorsCutMs?: (sceneId: string, ms: number) => void;
  /** W19-A5: 次の行と連動する(🔗アイコンを出す)シーンidの集合。scenesのみから導出される。 */
  linkedNextSceneIds?: Set<string>;
  /** W19-A5: ドラッグ中の対象行ツールチップ+隣接行ハイライト(対象2行分のみ。非ドラッグ中はnull)。 */
  edgeDragVisual?: EdgeDragVisual | null;
  /** W19-A5: ドラッグ中に内容がライブ追従する行だけのプレビュー版Scene差し替え(最大2件)。 */
  sceneOverrideById?: Map<string, Scene> | null;
  onEdgeDragStart?: (sceneId: string, edge: EdgeTrimEdge) => void;
  onEdgeDragCancel?: () => void;
  onWaveformGestureStart?: () => void;
  onEdgeDragMove?: (sceneId: string, edge: EdgeTrimEdge, rawTargetMs: number, chipSnapToleranceMs: number) => void;
  onEdgeDragEnd?: (sceneId: string, edge: EdgeTrimEdge, rawTargetMs: number, chipSnapToleranceMs: number) => void;
  /** W20-1(範囲選択カット): 波形本体の横ドラッグで選択した範囲をカットする。 */
  onRangeCut?: (sceneId: string, rawStartMs: number, rawEndMs: number, chipSnapToleranceMs: number) => void;
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
  /** フェーズT2.5-4: シーン種類→マッピングエントリ({style, animation_in?, sfx?})の解決済みマッピング。 */
  telopTypeMapping?: TelopTypeMapping;
  /** フェーズW1: 話者カラー(発動時のみ非null)。スタイルバッジの色解決に使う。 */
  speakerColors?: ActiveSpeakerColors | null;
  /** フェーズT2.5-4: typeバッジからのシーン種類変更。 */
  onSetDirectedType?: (sceneId: string, typeId: string) => void;
  /** フェーズT2: プリセットの個別上書き(null=解除)。 */
  onSetDirectedStyle?: (sceneId: string, styleId: string | null) => void;
  /** フェーズT3: アニメーションピッカーからの登場アニメ個別上書き(null=解除)。 */
  onSetDirectedAnimation?: (sceneId: string, animationId: string | null) => void;
  /** シーン映像演出の手動指定(null=自動)。 */
  onSetVideoEffectOverride?: (sceneId: string, override: VideoEffectOverride | null) => void;
  /** テロップの黄色部分。 */
  onSetHighlightWords?: (sceneId: string, words: string[]) => void;
  /** 指定行を下の生きている行と結合する。 */
  onMergeWithNext?: (sceneId: string) => void;
  /** フェーズU6: スタイルバッジメニューの「デザインを編集…」。 */
  onEditDesign?: (sceneId: string) => void;
  /** 改善21-B: ai_failure 疑義(AI校正未実行)の項目内から⚙API設定モーダルを開く。 */
  onOpenApiSettings?: () => void;
};

/**
 * シーン行の縦リスト。実際の仮想化(重い波形canvas描画の間引き)は各SceneRow内の
 * IntersectionObserverで行う(CutCardsPanelと同じ方針)。DOM自体はシンプルに保つ。
 * W19-A3: 行はmemo化したSceneRowItemで描画し、コールバックはuseStableRowHandlersで
 * 参照を安定化する。これによりcurrentSceneId変化(シーン境界跨ぎ)等の親再レンダリングでは
 * 変化した行だけが再レンダリングされる。
 */
export function SceneRowList({
  scenes,
  currentSceneId,
  selectedSceneId,
  activeSceneId,
  onToggleSceneSelect,
  onRestoreScene,
  isPlaybackActive,
  playbackScrollSuppressed,
  scissorsMode,
  chipSelection,
  flashSceneId,
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
  onTelopFocus,
  onTelopBlur,
  onSceneActivate,
  onCaretConfirm,
  onCaretCommit,
  confirmedCaret,
  onChipCaretChange,
  onChipSelectionChange,
  onScissorsSplitChip,
  onScissorsCutMs,
  linkedNextSceneIds,
  edgeDragVisual,
  sceneOverrideById,
  onEdgeDragStart,
  onEdgeDragCancel,
  onWaveformGestureStart,
  onEdgeDragMove,
  onEdgeDragEnd,
  onRangeCut,
  themeId,
  onSetEmotionTag,
  onSetStyleOverride,
  onApplyStyleToEmotionGroup,
  directedMode,
  telopTypeMapping,
  speakerColors,
  onSetDirectedType,
  onSetDirectedStyle,
  onSetDirectedAnimation,
  onSetVideoEffectOverride,
  onSetHighlightWords,
  onMergeWithNext,
  onEditDesign,
  onOpenApiSettings,
}: Props) {
  const handlers = useStableRowHandlers({
    onSeek,
    onHoverSeek,
    onToggleChip,
    onTelopChange,
    onEditingChange,
    onTelopFocus,
    onTelopBlur,
    onSetEmotionTag,
    onSetStyleOverride,
    onApplyStyleToEmotionGroup,
    onToggleSceneSelect,
    onSceneActivate,
    onCaretConfirm,
    onCaretCommit,
    onChipCaretChange,
    onChipSelectionChange,
    onScissorsSplitChip,
    onScissorsCutMs,
    onEdgeDragStart,
    onEdgeDragCancel,
    onWaveformGestureStart,
    onEdgeDragMove,
    onEdgeDragEnd,
    onRangeCut,
    onSetDirectedType,
    onSetDirectedStyle,
    onSetDirectedAnimation,
    onSetVideoEffectOverride,
    onSetHighlightWords,
    onMergeWithNext,
    onEditDesign,
    onOpenApiSettings,
  });
  const lastLiveSceneId = useMemo(() => {
    for (let index = scenes.length - 1; index >= 0; index -= 1) {
      if (!isSceneFullyDeleted(scenes[index])) return scenes[index].id;
    }
    return null;
  }, [scenes]);
  if (!scenes.length) {
    return <div className="sceneRowListEmpty">表示できるシーンがありません。</div>;
  }
  return (
    <div className="sceneRowList">
      {scenes.map((scene, index) => {
        // W10-1: 丸ごと削除済み(全単語deleted)のシーンは通常行を描画せず、高さの低い
        // スタブ行に畳む。復元ボタンで全単語のdeletedを解除する(Undo可能)。
        if (isSceneFullyDeleted(scene)) {
          return (
            <div className="sceneRowDeletedStub" data-scene-id={scene.id} key={scene.id}>
              <div className="sceneRowIndex">{index + 1}</div>
              <span className="sceneRowDeletedStubLabel">シーン{index + 1} を削除しました</span>
              {Array.isArray(scene.sourceKeepRanges) ? (
                <span className="sceneRowDeletedStubLabel">⌘Zで取り消し</span>
              ) : <button
                className="sceneRowDeletedStubRestore"
                onClick={() => onRestoreScene?.(scene.id)}
                title="このシーンを復元します(⌘Zでも戻せます)"
                type="button"
              >
                <RotateCcw size={12} />
                復元
              </button>}
            </div>
          );
        }
        // W19-A5: 端ドラッグ中の対象行だけプレビュー版シーンに差し替える(他行は同一参照を保つ)。
        const liveScene = sceneOverrideById?.get(scene.id) ?? scene;
        return (
          <SceneRowItem
            active={scene.id === activeSceneId}
            binMs={binMs}
            canMergeWithNext={scene.id !== lastLiveSceneId}
            chipSelection={chipSelection && chipSelection.sceneId === scene.id ? chipSelection : null}
            confirmedCaretIndex={
              confirmedCaret && confirmedCaret.sceneId === scene.id ? confirmedCaret.groupIndex : null
            }
            directedMode={directedMode}
            dragTooltip={edgeDragVisual?.sceneId === scene.id ? edgeDragVisual.tooltip : undefined}
            editingRef={editingRef}
            flashSceneId={flashSceneId}
            globalPeakMax={globalPeakMax}
            handlers={handlers}
            highlightEdge={
              edgeDragVisual?.neighborSceneId === scene.id ? edgeDragVisual.neighborHighlightEdge : undefined
            }
            isCurrent={scene.id === currentSceneId}
            isPlaybackActive={isPlaybackActive}
            key={scene.id}
            linkedNext={linkedNextSceneIds?.has(scene.id) ?? false}
            ordinal={index + 1}
            peaks={peaks}
            playbackScrollSuppressed={playbackScrollSuppressed}
            scene={liveScene}
            scissorsMode={scissorsMode}
            selected={scene.id === selectedSceneId}
            speakerColors={speakerColors}
            suspicions={suspicionsBySceneId.get(scene.id) || EMPTY_SUSPICIONS}
            telopTypeMapping={telopTypeMapping}
            themeId={themeId}
          />
        );
      })}
    </div>
  );
}
