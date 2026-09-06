import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Check, Focus, Link2, Moon } from "lucide-react";
import { TelopHighlightInput } from "./TelopHighlightInput";
import type { Scene } from "../lib/scenes";
import { highestSeveritySuspicion } from "../lib/scenes";
import {
  anchorChipIndexFromBoundary,
  buildWordGroups,
  findActiveGroupId,
  findBoundaryGroupIndex,
  msFromGroupBoundaryIndex,
  nearestGroupBoundaryIndex,
  normalizeChipDragRange,
  type WordGroup,
} from "../lib/wordGroups";
import type { SuspicionItem } from "../lib/suspicionQueue";
import { chipCaretPositionChanged, type ChipCaretPosition } from "../lib/chipCaret";
import { playheadStore } from "../lib/playheadStore";
import type { EdgeTrimEdge } from "../lib/edgeTrim";
import type { ActiveSpeakerColors } from "../lib/speakerColors";
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
  resolveStyleForType,
  semanticTypeLabel,
  type TelopTypeMapping,
} from "../lib/telopTypes";
import { ANIMATION_PICKER_OPTIONS, animationInLabel } from "../lib/telopAnimations";
import { TelopStyleSample } from "./TelopStyleSample";
import {
  paletteOptionsForTheme,
  resolveEffectiveStyle,
  telopStyleSwatchColors,
  type TelopThemeId,
} from "../lib/telopThemes";
import {
  VIDEO_EFFECT_CATALOG,
  videoEffectOverrideLabel,
  type VideoEffectOverride,
} from "../lib/videoEffectCatalog";

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
  /**
   * W10-1(シーン単位の選択): このシーンが選択中か。選択中は行にアクセントリング+
   * 行番号チップが塗りチェックになり、Delete/Backspaceでシーン丸ごと削除の対象になる。
   */
  selected?: boolean;
  /** W17: 元テキスト/表示テキストを現在操作している行。丸ごと削除選択とは別。 */
  active?: boolean;
  /** W10-1: 行番号チップのクリックで選択をトグルする。 */
  onToggleSelect?: () => void;
  /**
   * 改善5-1(ホバー自動スクロールの抑制): <video>が実際に再生中かどうか。自動追従スクロールは
   * これがtrueの場合のみ発火する(ホバースクラブ・キャレット・クリックシークでは発火させない)。
   */
  isPlaybackActive: boolean;
  /** フェーズW5-7: 要確認パネル発の再生中は自動追従スクロールを止める(パネルを見たまま聴ける)。 */
  playbackScrollSuppressed?: boolean;
  /**
   * フェーズW5-8: 要確認パネル内に埋め込まれたSceneRowでは、自動追従スクロール・
   * ジャンプフラッシュのscrollIntoViewを一切発火させない(発火するとペインが
   * パネル位置まで勝手に戻ってしまうため)。編集操作(チップ・textarea等)は通常と同一。
   */
  autoScrollDisabled?: boolean;
  /**
   * 改善5-6(ハサミモード): Bキーでトグルするハサミモード。ONの間はチップ列クリックが
   * 分割(グループ境界にスナップ)に切り替わり、波形上のクリックも即分割になる。
   */
  scissorsMode: boolean;
  /**
   * 改善5-2(チップのドラッグ複数選択): このシーンの選択範囲(親でsceneId一致時のみ渡される。
   * 一致しない/選択なしはnull)。W10-2: anchorはShift+クリック/Shift+矢印の起点チップ。
   */
  chipSelection: { start: number; end: number; anchor?: number } | null;
  /**
   * フェーズW5-5(要確認パネル): ジャンプ先シーンのid。自分と一致したらscrollIntoView+
   * 2秒フェードのハイライトクラス(.jumpFlash)を付ける(親側が2秒後にnullへ戻す)。
   */
  flashSceneId?: string | null;
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
  /** 改善5-7(一括置換ポップアップ): テロップ編集フォーカス開始(編集前テキストのスナップショット取得用)。 */
  onTelopFocus?: () => void;
  /** 改善5-7(一括置換ポップアップ): テロップ編集確定(blur)。 */
  onTelopBlur?: () => void;
  /** W17(操作中シーン): 元テキスト(チップ列)にホバー/クリックした行を「いま編集しているシーン」として親へ伝える。 */
  onSceneActivate?: () => void;
  /** 改善5-8: チップ間クリック(キャレット確定)時に再生中なら一時停止する。 */
  onCaretConfirm?: () => void;
  /**
   * W16-4(確定キャレット): チップ境界クリックで確定したキャレット位置を親へ伝える。
   * 以後のDelete/Backspace/Enterはこの位置を明示的アンカーとして使う(ホバーでは動かない)。
   */
  onCaretCommit?: (groupIndex: number) => void;
  /**
   * W16-4: この行に確定キャレットが立っている場合のグループ境界インデックス(0..groups.length)。
   * Backspaceで消える左隣チップへ削除候補の下線を表示する。
   */
  confirmedCaretIndex?: number | null;
  /**
   * 改善3(チップ間ホバーキャレット): この行のチップ列上でキャレットが立った/消えたことを
   * 親(App.tsx)へ伝える。キャレットが立っている間はEnter=分割/Delete=左隣削除が即発動する
   * (App.tsx側のキーボードeffectがrefで最新値を読む。previewCurrentMsRefと同じ方針)。
   */
  onChipCaretChange?: (sceneId: string, groupIndex: number | null) => void;
  /** 改善5-2(チップのドラッグ複数選択): 選択範囲が変わった(またはnullになった)ことを親へ伝える。 */
  onChipSelectionChange?: (range: { start: number; end: number; anchor?: number } | null) => void;
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
  /** W20-1(範囲選択カット): 波形本体の横ドラッグで選択した範囲をカットする(生ms+チップスナップ許容ms)。 */
  onRangeCutMs?: (rawStartMs: number, rawEndMs: number, chipSnapToleranceMs: number) => void;
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
  /** フェーズT2.5-4: シーン種類(semantic type)→マッピングエントリの解決済みマッピング(既定+ユーザー設定)。 */
  telopTypeMapping?: TelopTypeMapping;
  /** フェーズW1: 話者カラー(発動時のみ非null)。スタイルバッジの色見本を書き出しと一致させる。 */
  speakerColors?: ActiveSpeakerColors | null;
  /** フェーズT2.5-4: typeバッジのドロップダウンからシーン種類を変更する(スタイルはマッピング解決へ戻る)。 */
  onSetDirectedType?: (typeId: string) => void;
  /** フェーズT2: プリセットの個別上書き(null=上書き解除してマッピング解決へ戻す)。 */
  onSetDirectedStyle?: (styleId: string | null) => void;
  /** フェーズT3: アニメーションピッカーからの登場アニメ個別上書き(null=解除してマッピング/プリセット既定へ)。 */
  onSetDirectedAnimation?: (animationId: string | null) => void;
  /** シーン映像演出の手動指定(null=自動)。 */
  onSetVideoEffectOverride?: (override: VideoEffectOverride | null) => void;
  /** テロップの黄色部分(選択範囲から指定)。 */
  onSetHighlightWords?: (words: string[]) => void;
  /** この行を下の生きている行と結合する。 */
  onMergeWithNext?: () => void;
  /** フェーズU6: スタイルバッジメニューの「デザインを編集…」でスタイル詳細エディタを開く。 */
  onEditDesign?: () => void;
  /** 改善21-B: ai_failure 疑義(AI校正未実行)の項目内から⚙API設定モーダルを開く。 */
  onOpenApiSettings?: () => void;
};

/** 非current行のスナップショット(常にnull=ストア更新で再レンダリングされない)。 */
const nullPlayheadSnapshot = () => null;

/**
 * W19-A3: React.memo化。再生中の毎フレーム値(playheadMs)はpropで受け取らず、
 * current行だけがplayheadStoreを購読する(他の行はストア通知で再レンダリングされない)。
 */
export const SceneRow = memo(function SceneRow({
  scene,
  ordinal,
  isCurrent,
  selected,
  active,
  onToggleSelect,
  isPlaybackActive,
  playbackScrollSuppressed,
  autoScrollDisabled,
  scissorsMode,
  chipSelection,
  flashSceneId,
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
  onTelopFocus,
  onTelopBlur,
  onSceneActivate,
  onCaretConfirm,
  onCaretCommit,
  confirmedCaretIndex,
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
  onRangeCutMs,
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
  // W19-A3: 再生ヘッド位置はcurrent行のときだけ購読する。非current行はスナップショットが
  // 常にnullなのでストア更新(毎フレーム)では再レンダリングされない。
  const playheadMs = useSyncExternalStore(
    playheadStore.subscribe,
    isCurrent ? playheadStore.getSourceMs : nullPlayheadSnapshot,
  );
  const rowRef = useRef<HTMLDivElement | null>(null);
  const chipsRef = useRef<HTMLDivElement | null>(null);
  const emotionMenuRef = useRef<HTMLDivElement | null>(null);
  const stylePaletteRef = useRef<HTMLDivElement | null>(null);
  const directedMenuRef = useRef<HTMLDivElement | null>(null);
  const animationMenuRef = useRef<HTMLDivElement | null>(null);
  const videoEffectMenuRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [chipCaret, setChipCaret] = useState<ChipCaretState | null>(null);
  const [emotionMenuOpen, setEmotionMenuOpen] = useState(false);
  const [stylePaletteOpen, setStylePaletteOpen] = useState(false);
  // フェーズT2(directedモード): スタイルバッジのドロップダウン開閉。
  const [directedMenuOpen, setDirectedMenuOpen] = useState(false);
  // フェーズT3(directedモード): アニメーションピッカーのドロップダウン開閉。
  const [animationMenuOpen, setAnimationMenuOpen] = useState(false);
  const [videoEffectMenuOpen, setVideoEffectMenuOpen] = useState(false);
  /** 改善5-2(チップのドラッグ複数選択): ドラッグ中(コミット前)の一時状態。再描画不要なのでref。 */
  const chipDragRef = useRef<ChipDragState | null>(null);
  /** ドラッグ確定直後、mouseupの直後に発火するclickイベントを1回だけ無視するためのフラグ。 */
  const justDraggedRef = useRef(false);
  /** W19-A4: 前回setChipCaretした位置。同位置へのmousemove連発でsetStateしないためのref。 */
  const lastChipCaretRef = useRef<ChipCaretPosition | null>(null);

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
  // フェーズW5-7: 要確認パネル発の再生(playbackScrollSuppressed)では追従させない
  // (パネルにマウスを乗せたままSpaceで該当部分だけ聴くユースケース)。
  useEffect(() => {
    if (autoScrollDisabled) return;
    if (isCurrent && isPlaybackActive && !playbackScrollSuppressed) {
      rowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [autoScrollDisabled, isCurrent, isPlaybackActive, playbackScrollSuppressed]);

  // フェーズW5-5(要確認パネル): ジャンプ指定されたら行を中央へスクロールしてフラッシュ表示する。
  // 既存の「isCurrent && isPlaybackActive でscrollIntoView」との競合はflash優先で問題ない
  // (ジャンプは再生ヘッド移動のみで再生は始まらないため)。
  // W14-1: OP行操作中(playbackScrollSuppressed)はjumpFlashのscrollIntoViewも発火させない
  // (明示的なジャンプは親側で抑制を解除してから flashSceneId を立てるため従来どおり動く)。
  const isJumpFlashing = !autoScrollDisabled && !playbackScrollSuppressed && flashSceneId === scene.id;
  useEffect(() => {
    if (isJumpFlashing) rowRef.current?.scrollIntoView({ block: "center" });
  }, [isJumpFlashing]);

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

  // T-2/T-3/T2/T3: 感情バッジメニュー・スタイルパレット・directedスタイルメニュー・
  // アニメーションピッカーは外側クリックで閉じる。
  useEffect(() => {
    if (!emotionMenuOpen && !stylePaletteOpen && !directedMenuOpen && !animationMenuOpen && !videoEffectMenuOpen) {
      return undefined;
    }
    function handleOutsideClick(event: MouseEvent) {
      const target = event.target as Node;
      if (emotionMenuOpen && !emotionMenuRef.current?.contains(target)) setEmotionMenuOpen(false);
      if (stylePaletteOpen && !stylePaletteRef.current?.contains(target)) setStylePaletteOpen(false);
      if (directedMenuOpen && !directedMenuRef.current?.contains(target)) setDirectedMenuOpen(false);
      if (animationMenuOpen && !animationMenuRef.current?.contains(target)) setAnimationMenuOpen(false);
      if (videoEffectMenuOpen && !videoEffectMenuRef.current?.contains(target)) setVideoEffectMenuOpen(false);
    }
    window.addEventListener("mousedown", handleOutsideClick);
    return () => window.removeEventListener("mousedown", handleOutsideClick);
  }, [animationMenuOpen, directedMenuOpen, emotionMenuOpen, stylePaletteOpen, videoEffectMenuOpen]);

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
  const activeGroupId = isCurrent && playheadMs != null ? findActiveGroupId(groups, playheadMs) : null;

  /**
   * 改善3(チップ間ホバーキャレット): チップ列上のホバーで、最寄りのグループ境界に
   * テキストキャレット風の縦線を表示する。改善5-2: ドラッグ選択中(mouseボタン押下中)は
   * キャレット表示を止め、代わりに選択範囲を更新する。
   */
  function handleChipHover(event: React.MouseEvent<HTMLButtonElement>, groupIndex: number) {
    event.stopPropagation();
    // W19-A4: 行のアクティブ化(onSceneActivate)はmousemoveではなくチップ列のmouseenterで行う
    // (行をまたいだ瞬間だけ発火。mousemoveごとの親コールバック呼び出しをやめる)。
    const drag = chipDragRef.current;
    if (drag && event.buttons === 1) {
      if (groupIndex !== drag.anchorIndex || drag.active) {
        drag.active = true;
        onChipSelectionChange?.({
          ...normalizeChipDragRange(drag.anchorIndex, groupIndex),
          anchor: drag.anchorIndex,
        });
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
    // W19-A4: 境界インデックス・描画x位置が前回と同じならsetStateしない(チップ内の微小な
    // mousemove連発での再レンダー・親通知を抑制する)。
    if (!chipCaretPositionChanged(lastChipCaretRef.current, { groupIndex: boundaryIndex, leftPx })) {
      return;
    }
    lastChipCaretRef.current = { groupIndex: boundaryIndex, leftPx };
    setChipCaret({
      groupIndex: boundaryIndex,
      leftPx,
      topPx: buttonRect.top - containerRect.top,
      heightPx: buttonRect.height,
    });
    onChipCaretChange?.(scene.id, boundaryIndex);
  }

  /** W19-A4: チップ列に入った瞬間だけ、この行を操作中シーンとして親へ通知する。 */
  function handleChipsMouseEnter() {
    onSceneActivate?.();
  }

  /** チップ列(コンテナ)からマウスが離れたらキャレットを消す。 */
  function handleChipsMouseLeave() {
    lastChipCaretRef.current = null;
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
   * W10-2(Shift+クリック): アンカー(既存選択のアンカー → 再生ヘッド位置のキャレット(groupCursor) →
   * クリックチップ自身、の優先順)からクリックしたチップまでの範囲をchipSelectionに設定する。
   * 既存のドラッグ選択と同じ選択状態を作るだけなので、後続のDelete(選択削除)/Enter(選択分割)は
   * 追加配線なしで機能する。
   */
  function handleChipShiftClick(groupIndex: number) {
    let anchor: number;
    if (chipSelection) {
      anchor = chipSelection.anchor ?? chipSelection.start;
    } else if (isCurrent) {
      // W19-A3: イベント時点の再生ヘッド位置はストアから直接読む(購読値と同一)。
      anchor = anchorChipIndexFromBoundary(
        findBoundaryGroupIndex(groups, playheadStore.getSourceMs()),
        groupIndex,
        groups.length,
      );
    } else {
      anchor = groupIndex;
    }
    onChipSelectionChange?.({ ...normalizeChipDragRange(anchor, groupIndex), anchor });
  }

  /**
   * 改善3: チップ列クリック。削除済みグループはクリックで復活(メンバー全員)、そうでなければ
   * ホバーキャレットと同じ規則で最寄りのグループ境界を求め、そこへ再生バーを確定移動する
   * (キャレット表示中の一時状態を「クリックで確定」させる)。
   * 改善5-2: ドラッグ選択の直後のクリックは無視する(選択操作と競合させないため)。
   * 改善5-6: ハサミモード中はクリックで境界にスナップして分割する。
   * 改善5-8: 通常クリック(境界確定)時、再生中なら一時停止する。
   * W10-2: Shift+クリックは範囲選択(ハサミモード以外)。
   */
  function handleChipClick(event: React.MouseEvent<HTMLButtonElement>, group: WordGroup, groupIndex: number) {
    if (justDraggedRef.current) {
      justDraggedRef.current = false;
      return;
    }
    // W17: 元テキストをクリックした行を操作中シーンにする(別行の行番号選択が残っていても
    // Delete/Backspaceはこの行のキャレットを優先する)。
    onSceneActivate?.();
    if (event.shiftKey && !scissorsMode) {
      event.preventDefault();
      handleChipShiftClick(groupIndex);
      return;
    }
    // W16-1(無音チップ): 未削除の無音チップはクリックで選択する(ハサミモードでも分割しない)。
    // 直後のDelete/右クリックでその無音区間をカットできる(削除済みは通常どおりクリックで復活)。
    if (group.silence && !group.deleted) {
      onChipSelectionChange?.({ start: groupIndex, end: groupIndex, anchor: groupIndex });
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
    // W16-4: クリックした境界を確定キャレットとして親に記録する(Delete/Enterの明示的アンカー)。
    onCaretCommit?.(boundaryIndex);
  }

  /** V8-1: Enter/Shift+Enterはどちらも改行挿入(textareaの既定動作に任せる)。
   *  編集の確定はblur(欄外クリック)とEsc。IME変換中のEnter/Escは何もしない
   *  (変換確定・キャンセルのキーであり、改行やblurにしてはいけない)。 */
  function handleTelopKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "m") {
      event.preventDefault();
      event.stopPropagation();
      onMergeWithNext?.();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.currentTarget.blur();
    }
  }

  return (
    <div
      className={[
        "sceneRow",
        severityClass ? `severity-${severityClass}` : "",
        isCurrent ? "current" : "",
        selected ? "selectedScene" : "",
        active ? "activeScene" : "",
        isJumpFlashing ? "jumpFlash" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-scene-id={scene.id}
      ref={rowRef}
    >
      {/* W10-1: 行番号チップ=シーン選択トグル。ホバーでチェック枠、選択中は塗りチェックになる。 */}
      <button
        className={`sceneRowIndex sceneRowIndexButton ${selected ? "selected" : ""}`}
        onClick={onToggleSelect}
        title={
          selected
            ? "クリックで選択解除。Delete/Backspaceでこのシーンを丸ごと削除できます"
            : "クリックでシーンを選択(Delete/Backspaceで丸ごと削除)"
        }
        type="button"
      >
        <span className="sceneRowIndexNumber">{ordinal}</span>
        <Check className="sceneRowIndexCheck" size={13} strokeWidth={3} />
      </button>
      <div className={`sceneRowBody ${scissorsMode ? "scissorsMode" : ""}`}>
        <div className="sceneRowTop">
          <div
            className="sceneChips"
            onMouseEnter={handleChipsMouseEnter}
            onMouseLeave={handleChipsMouseLeave}
            ref={chipsRef}
          >
            {groups.map((group, index) => (
              <span className="sceneChipWithCaret" key={group.id}>
                {confirmedCaretIndex === index && !chipSelection && (
                  <span aria-hidden="true" className="chipConfirmedCaretLine" />
                )}
                <button
                className={[
                  "sceneChip",
                  group.deleted ? "deleted" : "",
                  group.silence ? "silence" : "",
                  flaggedGroupIds.has(group.id) ? "flagged" : "",
                  activeGroupId === group.id ? "playing" : "",
                  chipSelection && index >= chipSelection.start && index <= chipSelection.end ? "selected" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={(event) => handleChipClick(event, group, index)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onToggleChip(group.wordIds);
                }}
                onMouseDown={() => handleChipMouseDown(index)}
                onMouseMove={(event) => handleChipHover(event, index)}
                title={
                  group.silence
                    ? group.deleted
                      ? "カット済みの無音区間。クリックで復活"
                      : "無音区間。クリックで選択し、Deleteでカットできます(右クリックでも削除)"
                    : scissorsMode
                      ? "クリックでここを分割"
                      : group.deleted
                        ? "クリックで復活"
                        : "クリックでここに再生バー確定/右クリックで削除/ドラッグで範囲選択"
                }
                type="button"
              >
                {group.text}
              </button>
              </span>
            ))}
            {confirmedCaretIndex === groups.length && !chipSelection && (
              <span aria-hidden="true" className="chipConfirmedCaretLine" />
            )}
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
            <>
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
                    backgroundColor: directedStyleColor(
                      effectiveDirectedStyleId(scene, telopTypeMapping, speakerColors),
                    ),
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
                  {/* フェーズU6: 詳細エディタへの入口(プリセット選択では足りない細かい調整用) */}
                  {onEditDesign && (
                    <button
                      className="sceneEmotionMenuItem sceneDirectedEditDesign"
                      onClick={() => {
                        onEditDesign();
                        setDirectedMenuOpen(false);
                      }}
                      type="button"
                    >
                      <span>デザインを編集…</span>
                    </button>
                  )}
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
                              backgroundColor: directedStyleColor(resolveStyleForType(type, telopTypeMapping)),
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
                        option.id === effectiveDirectedStyleId(scene, telopTypeMapping, speakerColors) &&
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
            {/* フェーズT3(Canva式ワンクリック): スタイルバッジ隣のアニメーションピッカー。
                選択=登場アニメの個別上書き(「プリセット既定」=上書き解除)。適用時に
                directives の slots[].animation_in へ書き戻され、再レンダリングで反映される。 */}
            <div className="sceneEmotionBadgeWrap" ref={animationMenuRef}>
              <button
                className="sceneEmotionBadge sceneDirectedAnimationBadge"
                onClick={() => setAnimationMenuOpen((current) => !current)}
                title="クリックでテロップの登場アニメーションを変更"
                type="button"
              >
                <span aria-hidden="true">✦</span>
                <span>{animationInLabel(scene.directedAnimationIn)}</span>
              </button>
              {animationMenuOpen && (
                <div className="sceneEmotionMenu sceneDirectedAnimationMenu">
                  <div className="sceneDirectedMenuCaption">登場アニメーション</div>
                  {ANIMATION_PICKER_OPTIONS.map((option) => (
                    <button
                      className={`sceneEmotionMenuItem ${
                        (scene.directedAnimationIn ?? "") === option.id ? "active" : ""
                      }`}
                      key={option.id || "preset_default"}
                      onClick={() => {
                        onSetDirectedAnimation?.(option.id || null);
                        setAnimationMenuOpen(false);
                      }}
                      type="button"
                    >
                      <span>{option.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="sceneEmotionBadgeWrap" ref={videoEffectMenuRef}>
              <button
                className="sceneEmotionBadge sceneVideoEffectBadge"
                onClick={() => setVideoEffectMenuOpen((current) => !current)}
                title="クリックでこのシーンの映像演出を変更"
                type="button"
              >
                <Focus size={13} />
                <span>{videoEffectOverrideLabel(scene.videoEffectOverride)}</span>
              </button>
              {videoEffectMenuOpen && (
                <div className="sceneEmotionMenu sceneVideoEffectMenu">
                  <div className="sceneDirectedMenuCaption">映像演出</div>
                  {VIDEO_EFFECT_CATALOG.map((option) => (
                    <button
                      className={`sceneEmotionMenuItem ${
                        (scene.videoEffectOverride ?? null) === option.id ? "active" : ""
                      }`}
                      key={option.id ?? "auto"}
                      onClick={() => {
                        onSetVideoEffectOverride?.(option.id);
                        setVideoEffectMenuOpen(false);
                      }}
                      title={option.description}
                      type="button"
                    >
                      <span>{option.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            </>
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
        {/* 旧・改善5-4の「クリックで再生」はW20で撤去(W10-6のfocus=一時停止と衝突し、
            編集のためのクリックで毎回再生が始まっていた)。再生はホバー+Space/▶ボタンで行う。 */}
        <div className="sceneTelopEditorCol">
        <TelopHighlightInput
          edited={scene.telopEdited}
          highlightWords={scene.directedHighlightWords}
          onBlur={() => {
            onEditingChange(false);
            onTelopBlur?.();
          }}
          onChange={onTelopChange}
          onFocus={() => {
            onEditingChange(true);
            onTelopFocus?.();
          }}
          onHighlightWordsChange={onSetHighlightWords}
          onKeyDown={handleTelopKeyDown}
          rows={Math.min(3, scene.telopText.split("\n").length)}
          title="クリックで編集(再生中なら一時停止します)。文字を選んで黄色/白を切り替えられます。Enterで改行。確定は欄外クリックまたはEsc"
          value={scene.telopText}
        />
        <div className="sceneTelopToolbar">
          <label className="sceneTelopEffectLabel">
            映像演出
            <select
              className="sceneTelopEffectSelect"
              onChange={(event) => {
                const value = event.target.value;
                onSetVideoEffectOverride?.(value === "auto" ? null : (value as VideoEffectOverride));
              }}
              title="このシーンの映像演出(暗転・ズームなど)"
              value={scene.videoEffectOverride ?? "auto"}
            >
              {VIDEO_EFFECT_CATALOG.map((option) => (
                <option key={option.id ?? "auto"} value={option.id ?? "auto"}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className={`sceneTelopToolButton ${scene.videoEffectOverride === "dim" ? "isOn" : ""}`}
            onClick={() => onSetVideoEffectOverride?.(scene.videoEffectOverride === "dim" ? "none" : "dim")}
            title={
              scene.videoEffectOverride === "dim"
                ? "暗転をオフにします"
                : "このシーンの映像を暗くしてテロップを際立たせます"
            }
            type="button"
          >
            <Moon size={12} />
            暗転
          </button>
          <button
            className="sceneTelopToolButton"
            onClick={() => onMergeWithNext?.()}
            title="下の行と結合します(⌘M)。間の削除済み行はまたぎます"
            type="button"
          >
            下と結合
          </button>
        </div>
        </div>
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
            onRangeCut={onRangeCutMs}
            onScissorsCut={onScissorsCutMs}
            onSeek={onSeek}
            peaks={peaks}
            playheadMs={playheadMs}
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
                API設定を開く
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
});
