import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Film,
  Image as ImageIcon,
  Maximize2,
  Music,
  Plus,
  Type,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { normalizeSceneSpeed, SCENE_SPEEDS, type Scene } from "../../lib/scenes";
import type { TimelineCutRange } from "../../lib/previewTimeline";
import { sourceMsToTimelineMs } from "../../lib/previewTimeline";
import { playheadStore, usePlayheadSourceMs, usePlayheadTimelineMs } from "../../lib/playheadStore";
import { telopStyleSwatchColors, type TelopStyleDef } from "../../lib/telopThemes";
import {
  clampZoomFactor,
  formatTimelineMs,
  maxZoomFactor,
  resolveTimelineTotalMs,
  sceneTimelineBlocks,
  seekSourceMsForTimelineMs,
  zoomedScrollLeft,
  zoomFactorForSliderRatio,
  zoomFactorToPxPerMs,
  zoomSliderRatio,
} from "../../lib/timelineLayout";
import { laneTrackHeightPx } from "../../lib/clipLanes";
import {
  classifyDropFileName,
  classifyDropMimeType,
  dropTimelineMs,
  type DropMediaKind,
} from "../../lib/timelineDrop";
import { nextBgmClipStartMs } from "../../lib/bgmClips";
import { effectiveTimelineOpInfo, type RunOpConfig } from "../../lib/opEditor";
import { TimelineRuler } from "./TimelineRuler";
import { TelopTrack } from "./TelopTrack";
import { ImageTrack, type ImagesState } from "./ImageTrack";
import { VideoTrack } from "./VideoTrack";
import { BgmTrackV2, type BgmState } from "./BgmTrackV2";

/** 各トラックの高さ(px)。左のラベル列と行の高さを揃えるためここで一元管理する。 */
const RULER_HEIGHT = 30;
const TELOP_LANE_HEIGHT = 52;
/** V6-5: 画像・BGMは1クリップ=1レーンの段積み。値は「1レーンあたり」の高さ。 */
const IMAGE_LANE_HEIGHT = 40;
const VIDEO_LANE_HEIGHT = 76;
const BGM_LANE_HEIGHT = 56;
const TRACK_LABEL_WIDTH = 96;

/** ⌘スクロール/ピンチ1単位あたりのズーム感度(deltaY→倍率の指数係数)。 */
const WHEEL_ZOOM_SENSITIVITY = 0.005;
/** 1回のwheelイベントで許容する倍率変化の上限(飛び防止。ピンチの高頻度イベントで積み上がる)。 */
const WHEEL_ZOOM_MAX_STEP = 1.25;
/** ズームボタン(±)1クリックあたりの倍率。 */
const BUTTON_ZOOM_STEP = 1.5;

/** deltaModeの差(行/ページ単位のデバイス)をpx相当へ正規化する。 */
function wheelDeltaYPx(event: WheelEvent): number {
  if (event.deltaMode === 1) return event.deltaY * 16; // 行単位
  if (event.deltaMode === 2) return event.deltaY * 400; // ページ単位
  return event.deltaY;
}

/** V6-4: D&D中のドロップ先表示(円形＋ / 非対応メッセージ)。 */
type DropIndicator = { kind: DropMediaKind | "unsupported"; timelineMs: number };

/**
 * 再生ヘッド位置(タイムラインms)の解決。フェーズV3: プレビューの仮想プレイリスト報告値
 * (timelineMs)を優先する(OP区間でも動く)。未報告は元動画msからの写像でフォールバックし、
 * カット区間外(シーク直後の無音部など)はnull=非表示。
 */
function resolvePlayheadTimelineMs(
  timelineMs: number | null,
  sourceMs: number,
  timelineCutRanges: TimelineCutRange[],
): number | null {
  return timelineMs !== null ? timelineMs : sourceMsToTimelineMs(timelineCutRanges, sourceMs);
}

/**
 * W19-A3: 全トラックを貫く再生ヘッド。playheadStoreをここで購読することで、再生中に
 * 毎フレーム再レンダリングされるのはこの小さなオーバーレイだけになる(TimelineView全体・
 * App全体は再レンダリングされない)。スクラブ操作(W11-3)のハンドラは親から受け取る。
 */
function TimelinePlayhead({
  timelineCutRanges,
  pxPerMs,
  scrubbing,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  timelineCutRanges: TimelineCutRange[];
  pxPerMs: number;
  scrubbing: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const sourceMs = usePlayheadSourceMs();
  const timelineMs = usePlayheadTimelineMs();
  const playheadTimelineMs = resolvePlayheadTimelineMs(timelineMs, sourceMs, timelineCutRanges);
  if (playheadTimelineMs === null) return null;
  return (
    <div className="timelinePlayhead" style={{ left: `${playheadTimelineMs * pxPerMs}px` }}>
      <div className="timelinePlayheadHandle" />
      {/* W11-3: プレイヘッドを掴むための透明なグラブ帯(線本体はpointer-events:noneのまま)。
          クリックはcanvasのクリックシークと二重にならないよう伝播を止める */}
      <div
        className={`timelinePlayheadGrab${scrubbing ? " scrubbing" : ""}`}
        onClick={(event) => event.stopPropagation()}
        onPointerCancel={onPointerUp}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
    </div>
  );
}

type Props = {
  runDir: string;
  scenes: Scene[];
  currentSceneId: string | null;
  timelineCutRanges: TimelineCutRange[];
  /** composition timeline.total_duration_ms(OP含む)。未生成は0。 */
  timelineDurationMs: number;
  /** composition timeline.op(未検証JSON)。 */
  timelineOp: unknown;
  /**
   * フェーズV2: run単位のOP設定(op_config.json)。明示クリップがあれば適用前でも
   * OPブロックの表示(クリップ数・尺)へ優先反映する。null/未指定はcomposition表示のまま。
   */
  runOpConfig?: RunOpConfig | null;
  /** ブロッククリックのシーク先(元動画ms)を親へ渡す(プレビューと双方向連動)。 */
  onSeekSource: (ms: number) => void;
  /**
   * フェーズV3: ルーラー/空白部/OPブロッククリックのシーク先(タイムラインms)。
   * OP区間へのシークができる(未指定は従来どおり最寄りカット端の元動画msへ丸める)。
   */
  onSeekTimeline?: (timelineMs: number) => void;
  /** シーン→テロップスタイル解決(App側の書き出しと同じ経路)。ブロックの色に使う。 */
  resolveSceneStyle: (scene: Scene) => TelopStyleDef | undefined;
  /** U6のテロップスタイル詳細エディタを開く(directedモードのみ)。 */
  onEditSceneStyle?: (sceneId: string) => void;
  /** テーマ調整モーダルのオープニングセクションへ誘導する(directedモードのみ)。 */
  onOpenOpSettings?: () => void;
  bgmState: BgmState | null;
  onBgmStateChange: (state: BgmState) => void;
  /** フェーズV4: 画像挿入トラックの状態(images.json由来。プレビュー反映のためAppが保持する)。 */
  imagesState: ImagesState | null;
  onImagesStateChange: (state: ImagesState) => void;
  /** W11-3: プレイヘッドのドラッグスクラブ開始時に呼ぶ(再生中なら親が一時停止する)。 */
  onScrubStart?: () => void;
  onSetSceneSpeed: (sceneId: string, speed: number) => void;
  onSetAllScenesSpeed: (speed: number) => void;
};

/**
 * フェーズV1: 統合タイムラインView(マルチトラック)。
 * 横軸=出力タイムライン(書き出し後)基準。トラックはレイヤー順に上から
 * テロップ / 画像 / 映像(シーン分割ブロック+OPグループ) / BGM。
 * - 上部に時間ルーラー+全トラックを貫く再生ヘッド(プレビューと双方向連動)
 * - V6-1: ズームは「フィット=1.0」基準の相対係数で保持(±ボタン・スライダ・ピンチ/⌘スクロール)。
 *   トラックパッドのピンチはctrl+wheelとして届くのでカーソル中心ズーム、2本指横スクロールは
 *   ネイティブの横スクロール(パン)に任せる
 * - V6-4: OSからのファイルD&Dで画像/BGMを追加(拡張子で自動振り分け)
 * - V6-5: 画像・BGMは1クリップ=1レーンの段積み表示(トラック高さはクリップ数に応じて伸びる)
 * - 座標計算は lib/timelineLayout.ts の純関数に集約
 */
export function TimelineView({
  runDir,
  scenes,
  currentSceneId,
  timelineCutRanges,
  timelineDurationMs,
  timelineOp,
  runOpConfig,
  onSeekSource,
  onSeekTimeline,
  resolveSceneStyle,
  onEditSceneStyle,
  onOpenOpSettings,
  bgmState,
  onBgmStateChange,
  imagesState,
  onImagesStateChange,
  onScrubStart,
  onSetSceneSpeed,
  onSetAllScenesSpeed,
}: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  // V6-1: ズーム状態は「フィット=1.0」基準の相対係数。px/msは毎レンダー fit×係数 で導出する
  // (絶対px/msで持つとフィット値の変動で下限が揺れ、ズームアウトでフィットへ戻れなくなる)。
  const [zoomFactor, setZoomFactor] = useState(1);
  const zoomFactorRef = useRef(1);
  const [frames, setFrames] = useState<Array<{ ms: number; url: string }>>([]);
  const [addingBgm, setAddingBgm] = useState(false);
  const [addingImage, setAddingImage] = useState(false);
  // ズーム後にscrollLeftを適用するための保留値(コンテンツ幅が更新された後に反映)
  const pendingScrollLeftRef = useRef<number | null>(null);
  // V6-4: D&D中のドロップ先インジケータ。ネストしたdragenter/leaveの誤消去を深さカウントで防ぐ
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
  const dragDepthRef = useRef(0);
  const unsupportedTimerRef = useRef<number | null>(null);

  // フェーズV2→V5: run正本(op_config)を表示の正とする。明示クリップは適用前でも反映し、
  // pattern=none はOPブロックを即時に消す(本編シフトはApp側のシフト済みrangesが担う)
  const opInfo = useMemo(
    () => effectiveTimelineOpInfo(runOpConfig ?? null, timelineOp),
    [runOpConfig, timelineOp],
  );
  const totalMs = useMemo(
    () =>
      resolveTimelineTotalMs(
        timelineDurationMs,
        timelineCutRanges,
        (bgmState?.clips ?? []).map((clip) => clip.end_ms),
      ),
    [timelineDurationMs, timelineCutRanges, bgmState],
  );
  const blocks = useMemo(() => sceneTimelineBlocks(scenes, timelineCutRanges), [scenes, timelineCutRanges]);
  const selectedScene = scenes.find((scene) => scene.id === currentSceneId) ?? null;
  const selectedSpeed = normalizeSceneSpeed(selectedScene?.speed);
  const colorBySceneId = useMemo(() => {
    const map = new Map<string, string>();
    for (const scene of scenes) {
      const style = resolveSceneStyle(scene);
      map.set(scene.id, style ? telopStyleSwatchColors(style).color : "#94a3b8");
    }
    return map;
  }, [scenes, resolveSceneStyle]);

  // ビューポート幅の追従(フィット倍率とズーム上限の計算に使う)。
  // スクロール実体はtimelineBodyなので、左ラベル列を除いたトラック表示幅を使う。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const updateWidth = (width: number) => setViewportWidth(Math.max(0, width - TRACK_LABEL_WIDTH));
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) updateWidth(entry.contentRect.width);
    });
    observer.observe(el);
    updateWidth(el.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  // U9のfilmstripキャッシュを流用(映像ブロックのサムネ)。失敗してもサムネ無しで表示は成立する
  useEffect(() => {
    let cancelled = false;
    setFrames([]);
    if (!runDir) return undefined;
    window.catcut
      .generateFilmstrip({ runDir })
      .then((result) => {
        if (!cancelled) setFrames(result.frames);
      })
      .catch(() => {
        if (!cancelled) setFrames([]);
      });
    return () => {
      cancelled = true;
    };
  }, [runDir]);

  // 高頻度のwheelイベントから最新値を読むためのrefミラー(state経由だと1レンダー前の値になる)
  const totalMsRef = useRef(totalMs);
  totalMsRef.current = totalMs;
  const viewportWidthRef = useRef(viewportWidth);
  viewportWidthRef.current = viewportWidth;

  const pxPerMs = zoomFactorToPxPerMs(zoomFactor, totalMs, viewportWidth);
  const contentPx = Math.max(viewportWidth, totalMs * pxPerMs);
  const maxFactor = maxZoomFactor(totalMs, viewportWidth);
  const zoomRatio = zoomSliderRatio(clampZoomFactor(zoomFactor, totalMs, viewportWidth), maxFactor);

  /**
   * V6-1: ズーム係数の適用(カーソル位置中心)。refベースで直前の係数から連続適用するため、
   * ピンチの高頻度イベントでも古いstateを読まずに正しく積み上がる。係数が変わらない
   * (下限/上限で頭打ち)場合はscrollLeft保留値も設定しない(後続レンダーでの飛びを防ぐ)。
   */
  const applyZoomFactor = useCallback((nextRaw: number, cursorXInViewport: number) => {
    const total = totalMsRef.current;
    const vw = viewportWidthRef.current;
    const current = clampZoomFactor(zoomFactorRef.current, total, vw);
    const next = clampZoomFactor(nextRaw, total, vw);
    zoomFactorRef.current = next;
    if (next === current) return;
    const scrollEl = scrollRef.current;
    if (scrollEl) {
      // 同一フレーム内に複数のピンチイベントが来た場合、scrollLeftはまだ前回の
      // 描画のままなので、直前イベントで計算した保留値を基準にする(px(current)と対になる値)。
      // これを混ぜると基準がズレて、ズームアウト時に視界が飛ぶ/戻らないように見える。
      const baseScrollLeft = pendingScrollLeftRef.current ?? scrollEl.scrollLeft;
      pendingScrollLeftRef.current = zoomedScrollLeft(
        cursorXInViewport,
        baseScrollLeft,
        zoomFactorToPxPerMs(current, total, vw),
        zoomFactorToPxPerMs(next, total, vw),
      );
    }
    setZoomFactor(next);
  }, []);

  // ズーム反映後(コンテンツ幅が変わった後)にscrollLeftを適用して「見ていた場所」を保つ
  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (scrollEl && pendingScrollLeftRef.current !== null) {
      scrollEl.scrollLeft = pendingScrollLeftRef.current;
      pendingScrollLeftRef.current = null;
    }
  }, [pxPerMs]);

  const cursorXForClientX = useCallback((clientX: number) => {
    const rect = scrollRef.current?.getBoundingClientRect() ?? rootRef.current?.getBoundingClientRect();
    if (!rect) return viewportWidthRef.current / 2;
    const trackVisibleWidth = Math.max(0, rect.width - TRACK_LABEL_WIDTH);
    return Math.max(0, Math.min(trackVisibleWidth, clientX - rect.left - TRACK_LABEL_WIDTH));
  }, []);

  // ピンチ(Chromiumではctrl+wheel)/⌘スクロール=カーソル中心ズーム。
  // Reactの合成イベントはpassiveでpreventDefaultできないためネイティブリスナーで登録する。
  // 修飾キーなしの2本指横スクロール(deltaX)はここで奪わず、ネイティブの横スクロール=パンに任せる。
  // リスナーはトラック領域(viewport)ではなくタイムライン全体(root)に付ける:
  // ルーラー・ラベル列・ツールバー上でのピンチも効かないと「ズームできない」体験になるため。
  // WebKit gesture* はElectron/Chrome環境でwheelと二重発火することがあり、拡大方向だけ
  // 累積して「勝手にピンチインし続ける」原因になるため扱わない。
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const handleWheel = (event: WheelEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      const deltaY = wheelDeltaYPx(event);
      // 1イベントの倍率変化をクランプ(deltaMode差や高精度デバイスでの飛び・片方向暴走を防ぐ)
      const step = Math.min(
        WHEEL_ZOOM_MAX_STEP,
        Math.max(1 / WHEEL_ZOOM_MAX_STEP, Math.exp(-deltaY * WHEEL_ZOOM_SENSITIVITY)),
      );
      // 基準点はトラック領域(viewport)内のカーソルX。領域外(ラベル列等)は端へクランプ
      const cursorX = cursorXForClientX(event.clientX);
      applyZoomFactor(zoomFactorRef.current * step, cursorX);
    };
    root.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      root.removeEventListener("wheel", handleWheel);
    };
  }, [applyZoomFactor, cursorXForClientX]);

  /** ±ボタン・スライダからのズームはビューポート中央を基準点にする。 */
  const zoomToFactor = useCallback(
    (factor: number) => applyZoomFactor(factor, viewportWidthRef.current / 2),
    [applyZoomFactor],
  );

  /**
   * ルーラー・トラック空白部のクリック=シーク。
   * フェーズV3: onSeekTimelineがあればタイムラインmsのまま渡す(OP区間へも入れる)。
   * なければ従来どおり元動画msへ写像(OP区間・末尾余白は最寄りカット端へ丸め)。
   */
  function handleCanvasClick(event: React.MouseEvent<HTMLDivElement>) {
    const canvas = canvasRef.current;
    if (!canvas || pxPerMs <= 0) return;
    const rect = canvas.getBoundingClientRect();
    const timelineMs = (event.clientX - rect.left) / pxPerMs;
    seekToTimelineMs(timelineMs);
  }

  // ---------------------------------------------------------------------------
  // W11-3: プレイヘッドのドラッグスクラブ。掴んで(pointerdown→setPointerCapture)
  // スライドすると pointermove ごとにシークして追従し、pointerup で確定する。
  // 再生中に掴んだ時点で親(onScrubStart)が一時停止する。
  // ---------------------------------------------------------------------------
  const [scrubbing, setScrubbing] = useState(false);

  /** クリックシークとスクラブで共通のシーク経路(タイムラインms→親へ)。 */
  function seekToTimelineMs(timelineMs: number) {
    const clamped = Math.max(0, Math.min(totalMs, timelineMs));
    if (onSeekTimeline) {
      onSeekTimeline(clamped);
      return;
    }
    const sourceMs = seekSourceMsForTimelineMs(timelineCutRanges, clamped);
    if (sourceMs !== null) onSeekSource(sourceMs);
  }

  function scrubTimelineMsForClientX(clientX: number): number | null {
    const canvas = canvasRef.current;
    if (!canvas || pxPerMs <= 0) return null;
    const rect = canvas.getBoundingClientRect();
    return (clientX - rect.left) / pxPerMs;
  }

  function handlePlayheadPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    // 掴んだ=スクラブ意図。再生中はプレイヘッドが逃げるためこの時点で一時停止する
    onScrubStart?.();
    event.currentTarget.setPointerCapture(event.pointerId);
    setScrubbing(true);
  }

  function handlePlayheadPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!scrubbing) return;
    const timelineMs = scrubTimelineMsForClientX(event.clientX);
    if (timelineMs !== null) seekToTimelineMs(timelineMs);
  }

  function handlePlayheadPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (!scrubbing) return;
    setScrubbing(false);
    const timelineMs = scrubTimelineMsForClientX(event.clientX);
    if (timelineMs !== null) seekToTimelineMs(timelineMs);
  }

  /** V6-5: 「+ BGM」の追加開始位置=既存クリップ最後尾の終端(1本目は0)。 */
  async function handleAddBgm() {
    if (addingBgm) return;
    setAddingBgm(true);
    try {
      const next = await window.catcut.addBgm({
        runDir,
        startMs: nextBgmClipStartMs(bgmState?.clips ?? []),
      });
      if (next) onBgmStateChange(next);
    } catch {
      // ダイアログ失敗・コピー失敗時は現状維持(致命的ではない)
    } finally {
      setAddingBgm(false);
    }
  }

  /** フェーズV4: 画像追加。既定の配置位置=現在の再生ヘッド位置から4秒間。 */
  async function handleAddImage() {
    if (addingImage) return;
    setAddingImage(true);
    try {
      // W19-A3: クリック時点の再生ヘッド位置はストアから直接読む(描画用の購読とは独立)。
      const playheadTimelineMs = resolvePlayheadTimelineMs(
        playheadStore.getTimelineMs(),
        playheadStore.getSourceMs(),
        timelineCutRanges,
      );
      const next = await window.catcut.addImage({
        runDir,
        startMs: Math.max(0, Math.round(playheadTimelineMs ?? 0)),
      });
      if (next) onImagesStateChange(next);
    } catch {
      // ダイアログ失敗・コピー失敗時は現状維持(致命的ではない)
    } finally {
      setAddingImage(false);
    }
  }

  // -------------------------------------------------------------------------
  // V6-4: OSからのファイルD&D(画像→画像トラック / 音声→BGMトラック)
  // -------------------------------------------------------------------------

  /** dragover時点ではファイル名が取れないため、MIMEタイプでインジケータの行き先を仮判定する。 */
  function dropIndicatorFromEvent(event: React.DragEvent): DropIndicator | null {
    const canvas = canvasRef.current;
    if (!canvas || pxPerMs <= 0) return null;
    const items = event.dataTransfer?.items;
    if (!items || items.length === 0) return null;
    const fileItem = Array.from(items).find((item) => item.kind === "file");
    if (!fileItem) return null;
    const rect = canvas.getBoundingClientRect();
    const timelineMs = dropTimelineMs(event.clientX - rect.left, pxPerMs);
    const kind = classifyDropMimeType(fileItem.type);
    return { kind: kind ?? "unsupported", timelineMs };
  }

  function clearUnsupportedTimer() {
    if (unsupportedTimerRef.current !== null) {
      window.clearTimeout(unsupportedTimerRef.current);
      unsupportedTimerRef.current = null;
    }
  }

  function handleDragEnter(event: React.DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer?.types.includes("Files")) return;
    dragDepthRef.current += 1;
  }

  function handleDragOver(event: React.DragEvent<HTMLDivElement>) {
    const info = dropIndicatorFromEvent(event);
    if (!info) return;
    // preventDefaultしないとdropイベント自体が発生しない
    event.preventDefault();
    event.dataTransfer.dropEffect = info.kind === "unsupported" ? "none" : "copy";
    clearUnsupportedTimer();
    setDropIndicator(info);
  }

  function handleDragLeave(_event: React.DragEvent<HTMLDivElement>) {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDropIndicator(null);
  }

  async function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepthRef.current = 0;
    clearUnsupportedTimer();
    const canvas = canvasRef.current;
    const file = event.dataTransfer?.files?.[0];
    if (!canvas || !file || pxPerMs <= 0) {
      setDropIndicator(null);
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const startMs = dropTimelineMs(event.clientX - rect.left, pxPerMs);
    // drop確定時は拡張子で最終判定する(MIMEはOS依存で欠けることがある)
    const kind = classifyDropFileName(file.name);
    if (!kind) {
      setDropIndicator({ kind: "unsupported", timelineMs: startMs });
      unsupportedTimerRef.current = window.setTimeout(() => setDropIndicator(null), 2000);
      return;
    }
    setDropIndicator(null);
    try {
      // Electron 32+はFile.pathが取れないため、preload経由のwebUtils.getPathForFileで解決する
      const filePath = window.catcut.getPathForFile(file);
      if (kind === "image") {
        const next = await window.catcut.addImageFile({ runDir, filePath, startMs });
        if (next) onImagesStateChange(next);
      } else {
        const next = await window.catcut.addBgmFile({ runDir, filePath, startMs });
        if (next) onBgmStateChange(next);
      }
    } catch {
      // main側の形式チェック落ち・コピー失敗時は現状維持(致命的ではない)
    }
  }

  useEffect(() => clearUnsupportedTimer, []);

  // V6-5: 画像・BGMは1クリップ=1レーン。トラック高さはクリップ数に応じて伸びる(0件は1レーン分)
  const imageTrackHeight = laneTrackHeightPx(imagesState?.clips.length ?? 0, IMAGE_LANE_HEIGHT);
  const bgmTrackHeight = laneTrackHeightPx(bgmState?.clips.length ?? 0, BGM_LANE_HEIGHT);

  /** V6-4: ドロップ先トラック上の円形「＋」インジケータ。 */
  function renderDropPlus(kind: DropMediaKind) {
    if (dropIndicator?.kind !== kind) return null;
    return (
      <div
        className="tlDropIndicator"
        style={{ left: `${dropIndicator.timelineMs * pxPerMs}px` }}
      >
        <Plus size={14} />
      </div>
    );
  }

  return (
    <div className="timelineView" ref={rootRef}>
      <div className="timelineToolbar">
        <span className="timelineToolbarTitle">タイムライン（書き出し後の時間軸）</span>
        <span className="timelineToolbarDuration">総尺 {formatTimelineMs(totalMs)}</span>
        {selectedScene && (
          <div className="timelineSpeedControl" aria-label="素材速度">
            <span>速度</span>
            {SCENE_SPEEDS.map((speed) => (
              <button
                className={selectedSpeed === speed ? "active" : ""}
                key={speed}
                onClick={() => onSetSceneSpeed(selectedScene.id, speed)}
                type="button"
              >
                {speed}x
              </button>
            ))}
            <button
              className="timelineSpeedApplyAll"
              onClick={() => onSetAllScenesSpeed(selectedSpeed)}
              type="button"
            >
              全体をこの速度に
            </button>
          </div>
        )}
        <div className="timelineZoomControl">
          <button
            className="timelineZoomButton"
            disabled={zoomRatio <= 0}
            onClick={() => zoomToFactor(zoomFactorRef.current / BUTTON_ZOOM_STEP)}
            title="ズームアウト（最小=全体表示）"
            type="button"
          >
            <ZoomOut size={13} />
          </button>
          <input
            max={100}
            min={0}
            onChange={(event) =>
              zoomToFactor(zoomFactorForSliderRatio(Number(event.target.value), maxFactor))
            }
            title="横ズーム（トラックパッドのピンチ / ⌘+スクロールでも操作できます）"
            type="range"
            value={Math.round(zoomRatio)}
          />
          <button
            className="timelineZoomButton"
            disabled={zoomRatio >= 100}
            onClick={() => zoomToFactor(zoomFactorRef.current * BUTTON_ZOOM_STEP)}
            title="ズームイン"
            type="button"
          >
            <ZoomIn size={13} />
          </button>
          <button
            className="timelineZoomButton"
            disabled={zoomRatio <= 0}
            onClick={() => applyZoomFactor(1, 0)}
            title="全体表示（フィット）に戻す"
            type="button"
          >
            <Maximize2 size={13} />
          </button>
        </div>
      </div>
      <div className="timelineBody" ref={scrollRef}>
        <div className="timelineLabels">
          <div className="timelineLabelCell" style={{ height: RULER_HEIGHT }} />
          <div className="timelineLabelCell" style={{ height: TELOP_LANE_HEIGHT }}>
            <Type size={14} />
            <span>テロップ</span>
          </div>
          <div className="timelineLabelCell" style={{ height: imageTrackHeight }}>
            <ImageIcon size={14} />
            <span>画像</span>
            <button
              className="timelineBgmAddButton"
              disabled={addingImage}
              onClick={() => void handleAddImage()}
              title="動画に重ねる画像を追加（png/jpg/webp/gif）。再生ヘッド位置から4秒間で配置します。ファイルを直接ドラッグ&ドロップでも追加できます"
              type="button"
            >
              <Plus size={11} />
              画像
            </button>
          </div>
          <div className="timelineLabelCell" style={{ height: VIDEO_LANE_HEIGHT }}>
            <Film size={14} />
            <span>映像</span>
          </div>
          <div className="timelineLabelCell" style={{ height: bgmTrackHeight }}>
            <Music size={14} />
            <span>BGM</span>
            <button
              className="timelineBgmAddButton"
              disabled={addingBgm}
              onClick={() => void handleAddBgm()}
              title="BGMファイルを追加（mp3/wav/m4a/aac）。既存BGMの後ろに続けて配置します。ファイルを直接ドラッグ&ドロップでも追加できます"
              type="button"
            >
              <Plus size={11} />
              BGM
            </button>
          </div>
        </div>
        <div
          className="timelineViewport"
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={(event) => void handleDrop(event)}
          ref={viewportRef}
        >
          <div
            className="timelineCanvas"
            onClick={handleCanvasClick}
            ref={canvasRef}
            style={{ width: `${contentPx}px` }}
          >
            <TimelineRuler pxPerMs={pxPerMs} totalMs={totalMs} />
            <div style={{ height: TELOP_LANE_HEIGHT, position: "relative" }}>
              <TelopTrack
                blocks={blocks}
                colorBySceneId={colorBySceneId}
                currentSceneId={currentSceneId}
                onEdit={onEditSceneStyle}
                onSelect={(block) => onSeekSource(block.sourceStartMs)}
                pxPerMs={pxPerMs}
              />
            </div>
            <div style={{ height: imageTrackHeight, position: "relative" }}>
              <ImageTrack
                laneHeightPx={IMAGE_LANE_HEIGHT}
                onStateChange={onImagesStateChange}
                pxPerMs={pxPerMs}
                runDir={runDir}
                state={imagesState}
              />
              {renderDropPlus("image")}
            </div>
            <div style={{ height: VIDEO_LANE_HEIGHT, position: "relative" }}>
              <VideoTrack
                blocks={blocks}
                currentSceneId={currentSceneId}
                frames={frames}
                onOpClick={onOpenOpSettings}
                onOpSeek={onSeekTimeline}
                onSelect={(block) => onSeekSource(block.sourceStartMs)}
                op={opInfo}
                pxPerMs={pxPerMs}
              />
            </div>
            <div style={{ height: bgmTrackHeight, position: "relative" }}>
              <BgmTrackV2
                laneHeightPx={BGM_LANE_HEIGHT}
                onStateChange={onBgmStateChange}
                pxPerMs={pxPerMs}
                runDir={runDir}
                state={bgmState}
              />
              {renderDropPlus("bgm")}
            </div>
            <TimelinePlayhead
              onPointerDown={handlePlayheadPointerDown}
              onPointerMove={handlePlayheadPointerMove}
              onPointerUp={handlePlayheadPointerUp}
              pxPerMs={pxPerMs}
              scrubbing={scrubbing}
              timelineCutRanges={timelineCutRanges}
            />
          </div>
        </div>
      </div>
      {dropIndicator?.kind === "unsupported" && (
        <div className="tlDropUnsupported">
          非対応の形式です（画像: png/jpg/jpeg/webp/gif ／ 音声: mp3/wav/m4a/aac）
        </div>
      )}
    </div>
  );
}
