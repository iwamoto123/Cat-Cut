import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Link2 } from "lucide-react";
import type { Scene } from "../lib/scenes";
import { highestSeveritySuspicion } from "../lib/scenes";
import {
  buildWordGroups,
  findActiveGroupId,
  msFromGroupBoundaryIndex,
  nearestGroupBoundaryIndex,
  normalizeChipDragRange,
  type WordGroup,
} from "../lib/wordGroups";
import type { SuspicionItem } from "../lib/suspicionQueue";
import type { EdgeTrimEdge } from "../lib/edgeTrim";
import { SceneWaveformStrip, type EdgeDragTooltip } from "./SceneWaveformStrip";
import { EMOTION_ICONS, EMOTION_LABELS, EMOTION_TAGS, type EmotionTag } from "../lib/emotionTag";
import {
  DIRECTED_STYLE_OPTIONS,
  directedStyleColor,
  directedStyleLabel,
  effectiveDirectedStyleId,
} from "../lib/directedTelop";
import {
  SEMANTIC_TYPES,
  SEMANTIC_TYPE_INFO,
  isSemanticType,
  semanticTypeLabel,
} from "../lib/telopTypes";
import { TelopStyleSample } from "./TelopStyleSample";
import {
  paletteOptionsForTheme,
  resolveEffectiveStyle,
  telopStyleSwatchColors,
  type TelopThemeId,
} from "../lib/telopThemes";

/** スウォッチの「あ」パレット・感情バッジメニューの基準フォントサイズ(px)。 */
const SWATCH_PREVIEW_FONT_PX = 22;

/** 改善3: チップ列上でホバー中のキャレット(境界カーソル)の描画位置と論理位置。 */
type ChipCaretState = {
  /** 0..groups.length。キーボード←→で移動する既存のGroupCursor.groupIndexと同じ意味。 */
  groupIndex: number;
  /** `.sceneChips`コンテナ基準の描画位置(px)。 */
  leftPx: number;
  topPx: number;
  heightPx: number;
};

/** 改善5-2(チップのドラッグ複数選択): ドラッグ中の一時状態(コミット前)。 */
type ChipDragState = {
  anchorIndex: number;
  active: boolean;
};

type Props = {
  scene: Scene;
  ordinal: number;
  isCurrent: boolean;
  /** 再生バーの現在位置(ms)。波形ストリップ内の再生バー描画・再生中チップハイライトの算出に使う。 */
  playheadMs: number;
  /**
   * 改善5-1(ホバー自動スクロールの抑制): <video>が実際に再生中かどうか。自動追従スクロールは
   * これがtrueの場合のみ発火する(ホバースクラブ・キャレット・クリックシークでは発火させない)。
   */
  isPlaybackActive: boolean;
  /**
   * 改善5-6(ハサミモード): Bキーでトグルするハサミモード。ONの間はチップ列クリックが
   * 分割(グループ境界にスナップ)に切り替わり、波形上のクリックも即分割になる。
   */
  scissorsMode: boolean;
  /**
   * 改善5-2(チップのドラッグ複数選択): このシーンの選択範囲(親でsceneId一致時のみ渡される。
   * 一致しない/選択なしはnull)。
   */
  chipSelection: { start: number; end: number } | null;
  suspicions: SuspicionItem[];
  peaks: number[];
  /** 改善2(波形の縦スケール改善): 録音全体のグローバルピーク(App側で1回だけ計算した値)。 */
  globalPeakMax: number;
  binMs: number;
  onSeek: (ms: number) => void;
  onHoverSeek: (ms: number) => void;
  /** 改善1: 単語グループチップ単位の削除/復元(グループを構成する全文字wordIdを渡す)。 */
  onToggleChip: (wordIds: string[]) => void;
  onTelopChange: (text: string) => void;
  onEditingChange: (editing: boolean) => void;
  /** 改善1: テロップ編集中はチップ列のホバースクラブを無効化するための参照(誤動作防止)。 */
  editingRef?: { current: boolean };
  /** 改善5-4: テキスト枠クリックでこのシーンの先頭から再生する(旧「▶」ボタン/ダブルクリックを統合)。 */
  onPlayScene: () => void;
  /** 改善5-7(一括置換ポップアップ): テロップ編集フォーカス開始(編集前テキストのスナップショット取得用)。 */
  onTelopFocus?: () => void;
  /** 改善5-7(一括置換ポップアップ): テロップ編集確定(blur)。 */
  onTelopBlur?: () => void;
  /** 改善5-8: チップ間クリック(キャレット確定)時に再生中なら一時停止する。 */
  onCaretConfirm?: () => void;
  /**
   * 改善3(チップ間ホバーキャレット): この行のチップ列上でキャレットが立った/消えたことを
   * 親(App.tsx)へ伝える。キャレットが立っている間はEnter=分割/Delete=左隣削除が即発動する
   * (App.tsx側のキーボードeffectがrefで最新値を読む。previewCurrentMsRefと同じ方針)。
   */
  onChipCaretChange?: (sceneId: string, groupIndex: number | null) => void;
  /** 改善5-2(チップのドラッグ複数選択): 選択範囲が変わった(またはnullになった)ことを親へ伝える。 */
  onChipSelectionChange?: (range: { start: number; end: number } | null) => void;
  /** 改善5-6(ハサミモード): チップ列上のクリックでグループ境界にスナップして分割する。 */
  onScissorsSplitChip?: (groupIndex: number) => void;
  /** 改善5-6(ハサミモード): 波形上のクリックで即座に分割する(任意ms、チップ境界には限らない)。 */
  onScissorsCutMs?: (ms: number) => void;
  /** Phase 3: 行端の長押しスライド。次の行と時間的に連続している(連動対象)場合true。 */
  linkedNext?: boolean;
  onEdgeDragStart?: (edge: EdgeTrimEdge) => void;
  onEdgeDragMove?: (edge: EdgeTrimEdge, rawTargetMs: number, chipSnapToleranceMs: number) => void;
  onEdgeDragEnd?: (edge: EdgeTrimEdge, rawTargetMs: number, chipSnapToleranceMs: number) => void;
  /** この行が現在ドラッグ中の場合のツールチップ表示内容。 */
  dragTooltip?: EdgeDragTooltip;
  /** 連動ロール中、この行が隣接行として受動的にハイライトすべき端。 */
  highlightEdge?: EdgeTrimEdge | null;
  /** T-1〜T-3(テーマ×感情の自動スタイリング): 現在アクティブなテーマ。 */
  themeId: TelopThemeId;
  /** T-2: 感情バッジクリックによるタグ変更。 */
  onSetEmotionTag: (tag: EmotionTag) => void;
  /** T-3: スウォッチ→パレットからの個別スタイルオーバーライド設定/解除(null=解除)。 */
  onSetStyleOverride: (styleId: string | null) => void;
  /** T-3: 「このスタイルを同じ感情の全シーンに適用」。 */
  onApplyStyleToEmotionGroup: (styleId: string) => void;
  /** フェーズT2: directedモード(演出ディレクティブ駆動)ならスタイルバッジ=シーン種類/スタイルIDを正とする。 */
  directedMode?: boolean;
  /** フェーズT2.5-4: シーン種類(semantic type)→プリセットIDの解決済みマッピング(既定+ユーザー設定)。 */
  telopTypeMapping?: Record<string, string>;
  /** フェーズT2.5-4: typeバッジのドロップダウンからシーン種類を変更する(スタイルはマッピング解決へ戻る)。 */
  onSetDirectedType?: (typeId: string) => void;
  /** フェーズT2: プリセットの個別上書き(null=上書き解除してマッピング解決へ戻す)。 */
  onSetDirectedStyle?: (styleId: string | null) => void;
  /** 改善21-B: ai_failure 疑義(AI校正未実行)の項目内から⚙API設定モーダルを開く。 */
  onOpenApiSettings?: () => void;
};

export function SceneRow({
  scene,
  ordinal,
  isCurrent,
  playheadMs,
  isPlaybackActive,
  scissorsMode,
  chipSelection,
  suspicions,
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
  linkedNext,
  onEdgeDragStart,
  onEdgeDragMove,
  onEdgeDragEnd,
  dragTooltip,
  highlightEdge,
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
  const rowRef = useRef<HTMLDivElement | null>(null);
  const chipsRef = useRef<HTMLDivElement | null>(null);
  const emotionMenuRef = useRef<HTMLDivElement | null>(null);
  const stylePaletteRef = useRef<HTMLDivElement | null>(null);
  const directedMenuRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [chipCaret, setChipCaret] = useState<ChipCaretState | null>(null);
  const [emotionMenuOpen, setEmotionMenuOpen] = useState(false);
  const [stylePaletteOpen, setStylePaletteOpen] = useState(false);
  // フェーズT2(directedモード): スタイルバッジのドロップダウン開閉。
  const [directedMenuOpen, setDirectedMenuOpen] = useState(false);
  /** 改善5-2(チップのドラッグ複数選択): ドラッグ中(コミット前)の一時状態。再描画不要なのでref。 */
  const chipDragRef = useRef<ChipDragState | null>(null);
  /** ドラッグ確定直後、mouseupの直後に発火するclickイベントを1回だけ無視するためのフラグ。 */
  const justDraggedRef = useRef(false);

  useEffect(() => {
    const el = rowRef.current;
    if (!el) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) setVisible(entry.isIntersecting);
      },
      { root: el.closest(".sceneRowList"), rootMargin: "300px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 改善5-1(ホバー自動スクロールの抑制): 自動追従スクロールは実際の再生中のみ発火する。
  // previewCurrentMsはホバースクラブ・キャレット確定クリック・キーボードシーク等でも更新されるため、
  // isPlaybackActive(<video>のplay/pauseイベント由来)を条件に加えることで、ホバー由来の
  // 「マウスを合わせたボックスがズレるほどスクロールされる」問題を解消する。
  useEffect(() => {
    if (isCurrent && isPlaybackActive) rowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [isCurrent, isPlaybackActive]);

  // アンマウント時(行の削除・結合等)に、自分が立てたキャレット/選択が親側に残ったままにならないようにする。
  useEffect(() => {
    return () => {
      onChipCaretChange?.(scene.id, null);
      onChipSelectionChange?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene.id]);

  // 改善5-2(チップのドラッグ複数選択): mousedownしたボタン以外の場所でmouseupされても
  // ドラッグを終了できるよう、window全体でmouseupを監視する。
  useEffect(() => {
    function handleWindowMouseUp() {
      if (chipDragRef.current?.active) justDraggedRef.current = true;
      chipDragRef.current = null;
    }
    window.addEventListener("mouseup", handleWindowMouseUp);
    return () => window.removeEventListener("mouseup", handleWindowMouseUp);
  }, []);

  // T-2/T-3/T2: 感情バッジメニュー・スタイルパレット・directedスタイルメニューは外側クリックで閉じる。
  useEffect(() => {
    if (!emotionMenuOpen && !stylePaletteOpen && !directedMenuOpen) return undefined;
    function handleOutsideClick(event: MouseEvent) {
      const target = event.target as Node;
      if (emotionMenuOpen && !emotionMenuRef.current?.contains(target)) setEmotionMenuOpen(false);
      if (stylePaletteOpen && !stylePaletteRef.current?.contains(target)) setStylePaletteOpen(false);
      if (directedMenuOpen && !directedMenuRef.current?.contains(target)) setDirectedMenuOpen(false);
    }
    window.addEventListener("mousedown", handleOutsideClick);
    return () => window.removeEventListener("mousedown", handleOutsideClick);
  }, [directedMenuOpen, emotionMenuOpen, stylePaletteOpen]);

  const emotionTag: EmotionTag = scene.emotionTag ?? "normal";
  const resolvedStyle = useMemo(
    () => resolveEffectiveStyle(themeId, scene.emotionTag, scene.styleOverrideId),
    [themeId, scene.emotionTag, scene.styleOverrideId],
  );
  const paletteOptions = useMemo(() => paletteOptionsForTheme(themeId), [themeId]);
  const activeStyleId = scene.styleOverrideId ?? `${themeId}_${emotionTag}`;
  const swatchColors = useMemo(() => telopStyleSwatchColors(resolvedStyle), [resolvedStyle]);

  const flaggedWordIds = useMemo(() => new Set(suspicions.flatMap((item) => item.wordIds)), [suspicions]);
  const topSuspicion = highestSeveritySuspicion(suspicions);
  const severityClass = topSuspicion ? topSuspicion.severity : "";

  // 改善1: 一文字チップの代わりに形態素的な単語グループチップを表示する。
  // buildWordGroups自体がシーン参照をキーにメモ化しているため、ここでのuseMemoは
  // 依存配列([scene])に対する呼び出し回数の削減(同一レンダー内での再呼び出し防止)が目的。
  const groups = useMemo(() => buildWordGroups(scene), [scene]);
  const flaggedGroupIds = useMemo(() => {
    const ids = new Set<string>();
    for (const group of groups) {
      if (group.wordIds.some((wordId) => flaggedWordIds.has(wordId))) ids.add(group.id);
    }
    return ids;
  }, [groups, flaggedWordIds]);

  // 改善3(再生中のチップハイライト): 再生バーが現在シーン内にある間、該当グループチップを
  // 濃い色+わずかな拡大で示す(貫通再生バーの代替となる「テキスト側の現在位置表現」)。
  const activeGroupId = isCurrent ? findActiveGroupId(groups, playheadMs) : null;

  /**
   * 改善3(チップ間ホバーキャレット): チップ列上のホバーで、最寄りのグループ境界に
   * テキストキャレット風の縦線を表示する。改善5-2: ドラッグ選択中(mouseボタン押下中)は
   * キャレット表示を止め、代わりに選択範囲を更新する。
   */
  function handleChipHover(event: React.MouseEvent<HTMLButtonElement>, groupIndex: number) {
    event.stopPropagation();
    const drag = chipDragRef.current;
    if (drag && event.buttons === 1) {
      if (groupIndex !== drag.anchorIndex || drag.active) {
        drag.active = true;
        onChipSelectionChange?.(normalizeChipDragRange(drag.anchorIndex, groupIndex));
      }
      return;
    }
    if (editingRef?.current) return;
    const containerRect = chipsRef.current?.getBoundingClientRect();
    if (!containerRect) return;
    const buttonRect = event.currentTarget.getBoundingClientRect();
    const offsetX = event.clientX - buttonRect.left;
    const boundaryIndex = nearestGroupBoundaryIndex(groupIndex, offsetX, buttonRect.width);
    const onLeftSide = offsetX < buttonRect.width / 2;
    const leftPx = (onLeftSide ? buttonRect.left : buttonRect.right) - containerRect.left;
    setChipCaret({
      groupIndex: boundaryIndex,
      leftPx,
      topPx: buttonRect.top - containerRect.top,
      heightPx: buttonRect.height,
    });
    onChipCaretChange?.(scene.id, boundaryIndex);
  }

  /** チップ列(コンテナ)からマウスが離れたらキャレットを消す。 */
  function handleChipsMouseLeave() {
    setChipCaret(null);
    onChipCaretChange?.(scene.id, null);
  }

  /**
   * 改善5-2(チップのドラッグ複数選択): チップのmousedownでドラッグ選択の起点を記録する。
   * テロップ編集中(textareaフォーカス中)は発動しない(仕様書「テキスト編集中は発動しない」)。
   */
  function handleChipMouseDown(groupIndex: number) {
    if (editingRef?.current) return;
    chipDragRef.current = { anchorIndex: groupIndex, active: false };
  }

  /**
   * 改善3: チップ列クリック。削除済みグループはクリックで復活(メンバー全員)、そうでなければ
   * ホバーキャレットと同じ規則で最寄りのグループ境界を求め、そこへ再生バーを確定移動する
   * (キャレット表示中の一時状態を「クリックで確定」させる)。
   * 改善5-2: ドラッグ選択の直後のクリックは無視する(選択操作と競合させないため)。
   * 改善5-6: ハサミモード中はクリックで境界にスナップして分割する。
   * 改善5-8: 通常クリック(境界確定)時、再生中なら一時停止する。
   */
  function handleChipClick(event: React.MouseEvent<HTMLButtonElement>, group: WordGroup, groupIndex: number) {
    if (justDraggedRef.current) {
      justDraggedRef.current = false;
      return;
    }
    const buttonRect = event.currentTarget.getBoundingClientRect();
    const offsetX = event.clientX - buttonRect.left;
    const boundaryIndex = nearestGroupBoundaryIndex(groupIndex, offsetX, buttonRect.width);
    if (scissorsMode) {
      if (group.deleted) return;
      onScissorsSplitChip?.(boundaryIndex);
      return;
    }
    if (group.deleted) {
      onToggleChip(group.wordIds);
      return;
    }
    onSeek(msFromGroupBoundaryIndex(groups, boundaryIndex));
    onCaretConfirm?.();
  }

  /** 改善5-7(一括置換ポップアップ): Enter確定(改行させず、blurで編集を確定させる)。 */
  function handleTelopKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.blur();
    }
  }

  return (
    <div
      className={["sceneRow", severityClass ? `severity-${severityClass}` : "", isCurrent ? "current" : ""]
        .filter(Boolean)
        .join(" ")}
      data-scene-id={scene.id}
      ref={rowRef}
    >
      <div className="sceneRowIndex">{ordinal}</div>
      <div className={`sceneRowBody ${scissorsMode ? "scissorsMode" : ""}`}>
        <div className="sceneRowTop">
          <div className="sceneChips" onMouseLeave={handleChipsMouseLeave} ref={chipsRef}>
            {groups.map((group, index) => (
              <button
                className={[
                  "sceneChip",
                  group.deleted ? "deleted" : "",
                  flaggedGroupIds.has(group.id) ? "flagged" : "",
                  activeGroupId === group.id ? "playing" : "",
                  chipSelection && index >= chipSelection.start && index <= chipSelection.end ? "selected" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                key={group.id}
                onClick={(event) => handleChipClick(event, group, index)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onToggleChip(group.wordIds);
                }}
                onMouseDown={() => handleChipMouseDown(index)}
                onMouseMove={(event) => handleChipHover(event, index)}
                title={
                  scissorsMode
                    ? "クリックでここを分割"
                    : group.deleted
                      ? "クリックで復活"
                      : "クリックでここに再生バー確定/右クリックで削除/ドラッグで範囲選択"
                }
                type="button"
              >
                {group.text}
              </button>
            ))}
            {chipCaret && !chipSelection && (
              <span
                className={`chipCaretLine ${scissorsMode ? "scissors" : ""}`}
                style={{ left: chipCaret.leftPx, top: chipCaret.topPx, height: chipCaret.heightPx }}
              />
            )}
          </div>
          {topSuspicion && (
            <span className={`sceneSuspicionBadge ${topSuspicion.severity}`}>{topSuspicion.label}</span>
          )}
          {directedMode ? (
            // フェーズT2.5-4(directedモード): シーン種類(semantic type)を主表示にするtypeバッジ。
            // クリックでドロップダウンを開き、種類の変更(=マッピング解決)と
            // プリセットの個別上書き(マッピングより優先)ができる。
            // 旧run(type無し)のシーンはT2までと同じくプリセット名を表示する。
            <div className="sceneEmotionBadgeWrap" ref={directedMenuRef}>
              <button
                className="sceneEmotionBadge sceneDirectedStyleBadge"
                onClick={() => setDirectedMenuOpen((current) => !current)}
                title={
                  isSemanticType(scene.directedType)
                    ? "クリックでシーンの種類・テロップデザインを変更"
                    : "クリックでテロップスタイルを変更"
                }
                type="button"
              >
                <span
                  className="sceneDirectedStyleDot"
                  style={{
                    display: "inline-block",
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    backgroundColor: directedStyleColor(effectiveDirectedStyleId(scene, telopTypeMapping)),
                    border: "1px solid rgba(0,0,0,0.25)",
                  }}
                />
                <span>
                  {isSemanticType(scene.directedType)
                    ? `${semanticTypeLabel(scene.directedType)}${scene.directedStyleId ? "*" : ""}`
                    : directedStyleLabel(scene.directedStyleId)}
                </span>
              </button>
              {directedMenuOpen && (
                <div className="sceneEmotionMenu sceneDirectedTypeMenu">
                  {isSemanticType(scene.directedType) && (
                    <>
                      <div className="sceneDirectedMenuCaption">シーンの種類</div>
                      {SEMANTIC_TYPES.map((type) => (
                        <button
                          className={`sceneEmotionMenuItem ${
                            type === scene.directedType && !scene.directedStyleId ? "active" : ""
                          }`}
                          key={type}
                          onClick={() => {
                            onSetDirectedType?.(type);
                            setDirectedMenuOpen(false);
                          }}
                          title={SEMANTIC_TYPE_INFO[type].description}
                          type="button"
                        >
                          <span
                            style={{
                              display: "inline-block",
                              width: 10,
                              height: 10,
                              borderRadius: "50%",
                              backgroundColor: directedStyleColor(telopTypeMapping?.[type]),
                              border: "1px solid rgba(0,0,0,0.25)",
                            }}
                          />
                          <span>{SEMANTIC_TYPE_INFO[type].label}</span>
                        </button>
                      ))}
                      <div className="sceneDirectedMenuCaption">プリセットで個別指定</div>
                      {scene.directedStyleId && (
                        <button
                          className="sceneEmotionMenuItem"
                          onClick={() => {
                            onSetDirectedStyle?.(null);
                            setDirectedMenuOpen(false);
                          }}
                          type="button"
                        >
                          <span>個別指定を解除(種類の設定に従う)</span>
                        </button>
                      )}
                    </>
                  )}
                  {DIRECTED_STYLE_OPTIONS.map((option) => (
                    <button
                      className={`sceneEmotionMenuItem ${
                        option.id === effectiveDirectedStyleId(scene, telopTypeMapping) &&
                        (scene.directedStyleId || !isSemanticType(scene.directedType))
                          ? "active"
                          : ""
                      }`}
                      key={option.id}
                      onClick={() => {
                        onSetDirectedStyle?.(option.id);
                        setDirectedMenuOpen(false);
                      }}
                      type="button"
                    >
                      <span
                        style={{
                          display: "inline-block",
                          width: 10,
                          height: 10,
                          borderRadius: "50%",
                          backgroundColor: option.color,
                          border: "1px solid rgba(0,0,0,0.25)",
                        }}
                      />
                      <span>{option.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="sceneEmotionBadgeWrap" ref={emotionMenuRef}>
              <button
                className="sceneEmotionBadge"
                onClick={() => setEmotionMenuOpen((current) => !current)}
                title="クリックで感情タグを変更(スタイルも追従します)"
                type="button"
              >
                <span>{EMOTION_ICONS[emotionTag]}</span>
                <span>{EMOTION_LABELS[emotionTag]}</span>
              </button>
              {emotionMenuOpen && (
                <div className="sceneEmotionMenu">
                  {EMOTION_TAGS.map((tag) => (
                    <button
                      className={`sceneEmotionMenuItem ${tag === emotionTag ? "active" : ""}`}
                      key={tag}
                      onClick={() => {
                        onSetEmotionTag(tag);
                        setEmotionMenuOpen(false);
                      }}
                      type="button"
                    >
                      <span>{EMOTION_ICONS[tag]}</span>
                      <span>{EMOTION_LABELS[tag]}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="sceneTelopInputRow">
        <textarea
          className={`sceneTelopInput ${scene.telopEdited ? "edited" : ""}`}
          onBlur={() => {
            onEditingChange(false);
            onTelopBlur?.();
          }}
          onChange={(event) => onTelopChange(event.target.value)}
          onClick={onPlayScene}
          onFocus={() => {
            onEditingChange(true);
            onTelopFocus?.();
          }}
          onKeyDown={handleTelopKeyDown}
          rows={1}
          title="クリックでこのシーンの先頭から再生します"
          value={scene.telopText}
        />
          {/* T-3のテーマ×感情スウォッチはfullモード専用(directedではスタイルバッジが正)。 */}
          {!directedMode && (
          <div className="sceneStyleSwatchWrap" ref={stylePaletteRef}>
            <button
              className="sceneStyleSwatch"
              onClick={() => setStylePaletteOpen((current) => !current)}
              style={{ backgroundColor: swatchColors.color, borderColor: swatchColors.borderColor }}
              title="クリックでテロップスタイルを変更"
              type="button"
            />
            {stylePaletteOpen && (
              <div className="sceneStylePalette">
                <div className="sceneStylePaletteGrid">
                  {paletteOptions.map((option) => (
                    <button
                      className="sceneStylePaletteItem"
                      key={option.id}
                      onClick={() => {
                        onSetStyleOverride(option.id);
                        setStylePaletteOpen(false);
                      }}
                      title={option.label}
                      type="button"
                    >
                      <TelopStyleSample fontSizePx={SWATCH_PREVIEW_FONT_PX} style={option.style} text="あ" />
                      {activeStyleId === option.id && <Check className="sceneStylePaletteCheck" size={12} />}
                    </button>
                  ))}
                </div>
                <button
                  className="sceneStylePaletteApplyAll"
                  onClick={() => {
                    onApplyStyleToEmotionGroup(activeStyleId);
                    setStylePaletteOpen(false);
                  }}
                  type="button"
                >
                  このスタイルを同じ感情の全シーンに適用
                </button>
              </div>
            )}
          </div>
          )}
        </div>
        <div className="sceneRowBottom">
          <SceneWaveformStrip
            binMs={binMs}
            dragTooltip={dragTooltip}
            globalPeakMax={globalPeakMax}
            highlightEdge={highlightEdge}
            onEdgeDragEnd={onEdgeDragEnd}
            onEdgeDragMove={onEdgeDragMove}
            onEdgeDragStart={onEdgeDragStart}
            onHoverSeek={onHoverSeek}
            onScissorsCut={onScissorsCutMs}
            onSeek={onSeek}
            peaks={peaks}
            playheadMs={isCurrent ? playheadMs : null}
            scene={scene}
            scissorsMode={scissorsMode}
            visible={visible}
          />
        </div>
        {suspicions.length > 0 && (
          <div className="sceneSuspicionFooter">
            <span className="sceneSuspicionDetail">
              {topSuspicion?.type === "ai_failure" ? `${topSuspicion.label}: ` : ""}
              {topSuspicion?.detail}
            </span>
            {topSuspicion?.type === "ai_failure" && onOpenApiSettings && (
              <button
                className="sceneSuspicionActionButton"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenApiSettings();
                }}
                type="button"
              >
                ⚙ API設定を開く
              </button>
            )}
          </div>
        )}
        {linkedNext && (
          <div className="sceneLinkedIndicator" title="次の行と連動しています(境界を動かすと両方が伸縮します)">
            <Link2 size={11} />
          </div>
        )}
      </div>
    </div>
  );
}
