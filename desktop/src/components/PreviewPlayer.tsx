import { PLAYBACK_RATES } from "../lib/followAlong";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties } from "react";
import { Check, Crop, Move, Pause, Play, RotateCcw, Volume2, VolumeX } from "lucide-react";
import type { KeepSegment, TranscriptWord } from "../lib/keepSegments";
import { findActiveWordIndex } from "../lib/keepSegments";
import type { TelopStyleDef } from "../lib/telopThemes";
import { computeStageCanvasBox } from "../lib/telopPreviewSize";
import {
  clampTelopYPercent,
  computeTelopBlockLayout,
  telopFitWidth,
  TELOP_LINE_GAP_PX,
  VERTICAL_TELOP_MIN_FONT_PX,
  VERTICAL_TELOP_MIN_FONT_SCALE,
} from "../lib/telopLayout";
import { effectiveCutTelopY } from "../lib/adSafeZone";
import { normalizePunchIn, punchInStyle } from "../lib/punchIn";
import { parseLetterSpacingEm, resolveBlockBackground } from "../lib/previewTelop";
import type { OverlayItem } from "../lib/overlayItems";
import { sourceMsToTimelineEditMs, sourceMsToTimelineMs, type TimelineCutRange } from "../lib/previewTimeline";
import { resolveKeepPlaybackAction } from "../lib/previewPlayback";
import {
  buildPreviewPlaylist,
  clampTimelineMsToPlaylist,
  opClipTelopDelayMs,
  opPhasesMsFor,
  playlistTotalDurationMs,
  type OpPreviewData,
  type PlaylistEntry,
} from "../lib/previewPlaylist";
import { opSfxVolume } from "../lib/opTimeline";
import { isRepeatedSfx } from "../lib/telopSfx";
import {
  activeVideoEffectAt,
  VIDEO_EFFECT_SFX_VOLUME,
  videoEffectStyle,
  type VideoEffect,
} from "../lib/videoEffects";
import { DEFAULT_ANIMATION_DURATION_FRAMES } from "../lib/telopAnimation";
import { videoFramingLayout, IDENTITY_VIDEO_FRAMING, type VideoFraming } from "../lib/videoFraming";
import {
  dragFramingCrop,
  dragFramingMove,
  dragFramingScale,
  framingEditView,
  type CropHandle,
  type TransformCorner,
} from "../lib/videoFramingDrag";
import { formatTimelineMs } from "../lib/timelineLayout";
import { useBgmPreviewAudio, type BgmPreviewClip } from "../hooks/useBgmPreviewAudio";
import { createPreviewAudioGroup } from "../lib/previewAudio";
import { TelopStyledText } from "./TelopStyledText";
import { PreviewOverlays } from "./PreviewOverlays";
import { OpPreviewOverlay } from "./OpPreviewOverlay";
import { PreviewImageLayer, type PreviewImageClip } from "./PreviewImageLayer";
import { TelopPositionControls } from "./TelopPositionControls";
import { clampTelopPosition, moveTelopPosition, normalizeTelopPosition, type TelopPosition, type TelopPositionGeometry } from "../lib/telopPosition";

/**
 * 改善7-2(プレビューテロップの適正サイズ): telopFontSize/telopBaseWidthが未指定の場合の
 * フォールバック値(Remotion側の一般的な既定値に合わせる)。
 */
const FALLBACK_TELOP_FONT_SIZE = 52;
const FALLBACK_TELOP_BASE_WIDTH = 1920;
/** ResizeObserver未計測時(初回マウント直後)の最低フォントサイズ(px)。0px表示のちらつき防止用。 */
const MIN_TELOP_FONT_PX = 14;
/** U1-6(効果音): SE付きテロップの最小間隔(ms)。remotion/lib/telopSfx.ts の SFX_MIN_INTERVAL_MS と同値。 */
const PREVIEW_SFX_MIN_INTERVAL_MS = 5000;
/**
 * フェーズV3: OPクリップ再生中にエンジン外(ネイティブ再生バー等)のシークと判定する許容ズレ(ms)。
 * エンジンのエントリ遷移シークはクリップ端付近に着地するため、これを超えたら
 * 「ユーザーが本編へ飛んだ」とみなしてOPモードを抜ける。
 */
const OP_CLIP_SEEK_TOLERANCE_MS = 400;

/** telopStyle未指定時(旧UI互換)のプレースホルダースタイル(白文字のみ)。 */
const FALLBACK_TELOP_STYLE: TelopStyleDef = {
  font_family: '"Zen Kaku Gothic Antique", "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Meiryo", sans-serif',
  font_size: FALLBACK_TELOP_FONT_SIZE,
  font_weight: 900,
  fill: { type: "solid", color: "#FFFFFF" },
};

export type PreviewPlayerHandle = {
  play: () => void;
  pause: () => void;
  isPaused: () => boolean;
  getCurrentTimeMs: () => number;
  seekTo: (ms: number) => void;
  /**
   * W19-A2(ホバースクラブ): 元動画ms直接シークのimperative API。seekMs prop(state経由)と
   * 同じ挙動(OPモード解除+currentTime設定)だが、Appの再レンダリングを一切発生させない。
   * ホバー由来の高頻度シーク専用。クリック確定は従来どおりseekMs(state)経由を使う。
   */
  seekToSourceMs: (ms: number) => void;
};

/** フェーズV3: 仮想プレイリストの現在再生位置(refで保持。mode=opのときのみentryIndex有効)。 */
type VirtualPlaybackState = {
  mode: "main" | "op";
  entryIndex: number;
  /** op_static エントリ内の経過ms(実時間タイマー駆動)。 */
  staticOffsetMs: number;
  /** op_static の仮想再生中フラグ(videoはpaused のまま進行する)。 */
  staticPlaying: boolean;
};

type Props = {
  videoUrl: string;
  keepSegments: KeepSegment[];
  /** 初期化済みの空配列は全カット。本編を再生しない。 */
  keepSegmentsReady?: boolean;
  words: TranscriptWord[];
  seekMs: number | null;
  onSeekConsumed: () => void;
  onActiveWordChange: (wordId: string | null) => void;
  /** 再生速度（既定1.0）。追い読みモードでは1.5等に切り替える（B-3）。 */
  playbackRate?: number;
  onPlaybackRateChange?: (rate: number) => void;
  /** 現在の再生位置(ms)。ハイライト更新と同じフレーム精度で追い読み進捗計算に使う（B-3）。 */
  onTimeUpdate?: (currentMs: number) => void;
  /**
   * シーン行UI(Phase 1)向け: 動画下部に焼き込み表示するテロップ本文。
   * 未指定またはundefinedならオーバーレイを描画しない(旧UIは影響を受けない)。
   */
  telopText?: string;
  /**
   * T-4(プレビュー反映): 現在シーンのテロップスタイル(色・縁取り・相対サイズ・背景帯)。
   * 未指定なら焼き込みテロップは既定スタイル(白文字)のまま描画する(旧UIは影響を受けない)。
   */
  telopStyle?: TelopStyleDef;
  /**
   * 改善7-2(プレビューテロップの適正サイズ): Remotion書き出し時のtelop_font_size(px、
   * 基準解像度=telopBaseWidth時の値)。未指定時はFALLBACK_TELOP_FONT_SIZEを使う。
   */
  telopFontSize?: number;
  /** 改善7-2: telopFontSizeの基準解像度幅(px)。未指定時はFALLBACK_TELOP_BASE_WIDTHを使う。 */
  telopBaseWidth?: number;
  /** U1-3: コンポジションの高さ(px)。縦位置クランプ(clampTelopYPercent)に使う。 */
  telopBaseHeight?: number;
  /**
   * 改善20-B: 1行の文字数バジェット(composition.jsonのtelop_max_chars_per_line)。
   * 折返し・幅フィットはRemotionと同一の computeTelopBlockLayout で確定する。
   */
  telopMaxCharsPerLine?: number;
  /**
   * U1-3: composition timeline.telop_y(0〜1の中心基準)。プリセットの y_position_offset と
   * 上下セーフエリアクランプを合わせてRemotionと同じ縦位置に描画する。未指定時は従来の下部固定。
   */
  telopY?: number;
  telopPosition?: TelopPosition;
  /** A completed drag/number edit calls once; null restores automatic placement. */
  onTelopPositionChange?: (position: TelopPosition | null) => void;
  onAllTelopPositionsChange?: (position: TelopPosition | null) => void;
  /** U1-2: highlight_words 部分ハイライト(現在シーンのスロット由来)。 */
  telopHighlightWords?: string[];
  /**
   * U1-6: 登場アニメーションID(pop_big/slide_left/slide_up/zoom/stamp/fade/none)。
   * telopSlotKey が変わる(=テロップ表示開始)たびにCSS近似アニメを発火する。
   */
  telopAnimationIn?: string;
  /** U1-6: 登場アニメの長さ(ms。Remotionの animation_duration_frames ÷ fps)。 */
  telopAnimationDurationMs?: number;
  /**
   * U1-4/U1-6: テロップスロットの同一性キー(シーンID)。変わった瞬間がテロップ表示開始
   * (アニメ再発火・効果音再生のトリガー)。
   */
  telopSlotKey?: string | null;
  /** U1-6: 現在スロットの効果音URL(main側プレビューサーバー配信)。null/未指定で鳴らさない。 */
  sfxUrl?: string | null;
  /** W13-5: 現在スロットの効果音ID(連続同一sfx抑止の判定に使う。sfxUrlと同時に指定)。 */
  sfxId?: string | null;
  /** U1-6: 効果音音量(composition timeline.sfx_volume。0〜1)。 */
  sfxVolume?: number;
  /** U1-6: 効果音ミュートトグル。 */
  sfxMuted?: boolean;
  /** U1-5: 現在表示すべきオーバーレイ(App側でタイムライン写像・表示判定済み)。 */
  overlayItems?: OverlayItem[];
  /** U1-5: overlayのstyle参照用スタイル辞書(composition timeline.telop_styles)。 */
  overlayStyles?: Record<string, TelopStyleDef>;
  /** U1-5: オーバーレイクリックで文言編集を開く。 */
  onOverlayClick?: (item: OverlayItem) => void;
  /**
   * フェーズU6: プレビュー上のテロップ文字クリックでスタイル詳細エディタを開く。
   * オーバーレイのクリック編集(onOverlayClick)とはレイヤーが別なので干渉しない。
   */
  onTelopClick?: () => void;
  /**
   * 改善5-1(ホバー自動スクロールの抑制): <video>要素が実際に再生中/停止中かを親へ通知する。
   * previewCurrentMsはホバースクラブ等でも(再生していなくても)更新されるため、
   * 「実際の再生中のみ自動追従スクロールする」判定にはこのコールバックを使う。
   * フェーズV3: OPの静止エントリ(タイマー駆動)の仮想再生もtrueとして通知する。
   */
  onPlayingChange?: (isPlaying: boolean) => void;
  /** U9(BGMトラック): プレビュー再生に並走させるBGMクリップ(配信URLつき)。 */
  bgmClips?: BgmPreviewClip[];
  /** U9: BGMミュートトグル(プレビューのみ。書き出しには影響しない)。 */
  bgmMuted?: boolean;
  /** U9: 元動画ms→タイムラインmsの写像(BGM区間判定・再生位置算出用)。 */
  timelineCutRanges?: TimelineCutRange[];
  /**
   * フェーズV3(OPのプレビュー再生): プレビュー用OPデータ(previewPlaylist.resolveOpPreviewData)。
   * null/未指定=OPなし=従来と完全同一の再生挙動。
   */
  opPreview?: OpPreviewData | null;
  /** V3: OPのフェーズ計算(Remotionと同一のフレーム計算)に使うfps。既定30。 */
  timelineFps?: number;
  /** V3: OPクリップテロップの style="" 時に使う既定スタイルID(composition default_telop_style)。 */
  opDefaultTelopStyleId?: string;
  /** V3: OPのキメ音・転換音のID→配信URL辞書(transcript:load の sfxUrls)。 */
  sfxUrls?: Record<string, string>;
  /**
   * V3: タイムラインms基準のシーク(タイムラインViewのクリック)。OP区間へのシークができる。
   * 隙間・末尾余白は最寄りのプレイリストエントリ端へ丸める。
   */
  seekTimelineMs?: number | null;
  onSeekTimelineConsumed?: () => void;
  /**
   * V3: 現在のタイムラインms(OP込み)の通知。OP静止エントリ再生中も更新される
   * (onTimeUpdateは元動画ms基準のため、タイムラインViewの再生ヘッドはこちらを使う)。
   * 写像不能(カット区間外)はnull。
   */
  onTimelineTimeUpdate?: (timelineMs: number | null) => void;
  /**
   * フェーズV4(画像挿入トラック): プレビューに重ねる画像クリップ(配信URLつき)。
   * 現在のタイムラインmsで表示判定し、映像の上・テロップの下にDOM描画する。
   */
  imageClips?: PreviewImageClip[];
  /**
   * V4: プレビュー上の画像ドラッグ(位置)・四隅ハンドル(大きさ)の編集通知。
   * commit=true が操作確定(親がimages.jsonへ保存する)。未指定なら表示のみ。
   */
  onImageClipsChange?: (clips: PreviewImageClip[], commit: boolean) => void;
  selectedImageClipId?: string | null;
  onImageSelect?: (id: string | null) => void;
  /**
   * フェーズW2(シーン映像ギミック): composition timeline.video_effects の正規化済み配列
   * (タイムラインms基準)。Remotionと同じ純関数(videoEffectStyle)でvideo要素へ
   * CSS transform/filterを適用する。未指定・空なら従来と完全同一の描画。
   */
  videoEffects?: VideoEffect[];
  /**
   * フェーズW8(キャンバス基準ステージ): コンポジションのキャンバス寸法(composition
   * meta.display_*)。指定時はプレビューステージ・containedBox・オーバーレイスケールを
   * キャンバス基準にし、映像は書き出しと同じ object-fit: cover でキャンバスを埋める。
   * 未指定(旧run・composition未生成)は従来どおり動画intrinsic基準。
   */
  canvasWidth?: number;
  canvasHeight?: number;
  /**
   * フェーズW9(映像フレーミング): ソース動画の表示解像度(composition meta.source_*)。
   * 未指定・0は動画intrinsic寸法へフォールバックする。
   */
  sourceWidth?: number;
  sourceHeight?: number;
  /**
   * フェーズW9: 映像フレーミング(run正本 video_framing.json 由来の正規化済み値)。
   * 未指定・identity なら W8 と同一の cover 描画(完全後方互換)。
   */
  videoFraming?: VideoFraming;
  /**
   * フェーズW9: プレビュー上のフレーミング編集(変形・クロップ)の通知。
   * commit=false はドラッグ中のライブ更新、commit=true が操作確定
   * (親が video-framing:save で保存する)。未指定なら編集UI(モードボタン)を出さない。
   */
  onVideoFramingChange?: (framing: VideoFraming, commit: boolean) => void;
};

/** フェーズW9: フレーミング編集モード(null=通常表示)。 */
type FramingEditMode = "transform" | "crop" | null;

/** フェーズW9: フレーミングドラッグ状態(pointerdown時のスナップショット基準で換算する)。 */
type FramingDragState = {
  kind: "move" | "scale" | "crop";
  corner?: TransformCorner;
  handle?: CropHandle;
  startClientX: number;
  startClientY: number;
  snapshot: VideoFraming;
  /** ドラッグ開始時点の有効映像(cropRect)表示px幅(scale換算用)。 */
  cropRectWidthPx: number;
  /** ドラッグ開始時点のフル映像(videoRect)表示px寸法(crop換算用)。 */
  videoRectWidthPx: number;
  videoRectHeightPx: number;
  /** ドラッグ開始時点の編集ビュー縮小率(スクリーンpx→キャンバス表示px換算)。 */
  viewScale: number;
};

/** クロップモードのハンドル配置(辺4+隅4)。 */
const CROP_HANDLES: Array<{ handle: CropHandle; cursor: string }> = [
  { handle: "nw", cursor: "nwse-resize" },
  { handle: "ne", cursor: "nesw-resize" },
  { handle: "sw", cursor: "nesw-resize" },
  { handle: "se", cursor: "nwse-resize" },
  { handle: "left", cursor: "ew-resize" },
  { handle: "right", cursor: "ew-resize" },
  { handle: "top", cursor: "ns-resize" },
  { handle: "bottom", cursor: "ns-resize" },
];

/** 変形モードの四隅ハンドル配置。 */
const TRANSFORM_CORNERS: Array<{ corner: TransformCorner; cursor: string }> = [
  { corner: "nw", cursor: "nwse-resize" },
  { corner: "ne", cursor: "nesw-resize" },
  { corner: "sw", cursor: "nesw-resize" },
  { corner: "se", cursor: "nwse-resize" },
];

type PxRect = { left: number; top: number; width: number; height: number };

/** キャンバス座標系の矩形→表示px(stageScale)→編集ビュー(scale+translate)の写像。 */
function framingViewRect(
  rect: { left: number; top: number; width: number; height: number },
  stageScale: number,
  view: { scale: number; translateX: number; translateY: number },
): PxRect {
  return {
    left: rect.left * stageScale * view.scale + view.translateX,
    top: rect.top * stageScale * view.scale + view.translateY,
    width: rect.width * stageScale * view.scale,
    height: rect.height * stageScale * view.scale,
  };
}

/** クロップモードのディム矩形(フル映像のうちクロップ外=上下左右の4矩形。空矩形は除外)。 */
function framingCropDimRects(videoRect: PxRect, cropRect: PxRect): PxRect[] {
  const rects: PxRect[] = [
    { left: videoRect.left, top: videoRect.top, width: videoRect.width, height: cropRect.top - videoRect.top },
    {
      left: videoRect.left,
      top: cropRect.top + cropRect.height,
      width: videoRect.width,
      height: videoRect.top + videoRect.height - (cropRect.top + cropRect.height),
    },
    { left: videoRect.left, top: cropRect.top, width: cropRect.left - videoRect.left, height: cropRect.height },
    {
      left: cropRect.left + cropRect.width,
      top: cropRect.top,
      width: videoRect.left + videoRect.width - (cropRect.left + cropRect.width),
      height: cropRect.height,
    },
  ];
  return rects.filter((rect) => rect.width > 0.5 && rect.height > 0.5);
}

/** op_static の裏で先読みしておく映像エントリ(次以降で最初に映像を持つもの)。 */
function findNextVideoEntry(entries: PlaylistEntry[], fromIndex: number): PlaylistEntry | null {
  for (let index = fromIndex + 1; index < entries.length; index += 1) {
    if (entries[index].kind !== "op_static") return entries[index];
  }
  return null;
}

export const PreviewPlayer = forwardRef<PreviewPlayerHandle, Props>(function PreviewPlayer(
  {
    videoUrl,
    keepSegments,
    keepSegmentsReady = false,
    words,
    seekMs,
    onSeekConsumed,
    onActiveWordChange,
    playbackRate = 1,
    onPlaybackRateChange,
    onTimeUpdate,
    telopText,
    telopStyle,
    telopFontSize,
    telopBaseWidth,
    telopBaseHeight,
    telopMaxCharsPerLine,
    telopY,
    telopPosition,
    onTelopPositionChange,
    onAllTelopPositionsChange,
    telopHighlightWords,
    telopAnimationIn,
    telopAnimationDurationMs,
    telopSlotKey,
    sfxUrl,
    sfxId,
    sfxVolume,
    sfxMuted,
    overlayItems,
    overlayStyles,
    onOverlayClick,
    onTelopClick,
    onPlayingChange,
    bgmClips,
    bgmMuted,
    timelineCutRanges,
    opPreview,
    timelineFps,
    opDefaultTelopStyleId,
    sfxUrls,
    seekTimelineMs,
    onSeekTimelineConsumed,
    onTimelineTimeUpdate,
    imageClips,
    onImageClipsChange,
    selectedImageClipId,
    onImageSelect,
    videoEffects,
    canvasWidth,
    canvasHeight,
    sourceWidth,
    sourceHeight,
    videoFraming,
    onVideoFramingChange,
  },
  forwardedRef,
) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // フェーズW8(キャンバス基準ステージ): ステージ(div)の実表示サイズをResizeObserverで計測し、
  // キャンバス寸法(canvasWidth/Height。無ければ動画intrinsic)のアスペクトで
  // 「キャンバスが描画される矩形(containedBox)」を求める。テロップのフォントサイズ・
  // 中央配置・オーバーレイはRemotionと同じ相対比率でこの矩形基準に計算する。
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [videoIntrinsicSize, setVideoIntrinsicSize] = useState({ width: 0, height: 0 });
  const onPlayingChangeRef = useRef(onPlayingChange);
  onPlayingChangeRef.current = onPlayingChange;
  // フェーズW9(カスタムトランスポートバー): 再生中フラグの内部state(親通知と同じ経路で更新)。
  const [transportPlaying, setTransportPlaying] = useState(false);
  const pauseBgmRef = useRef<() => void>(() => {});
  const oneShotAudioRef = useRef<ReturnType<typeof createPreviewAudioGroup> | null>(null);
  if (!oneShotAudioRef.current) oneShotAudioRef.current = createPreviewAudioGroup();
  const pausePreviewAudio = useCallback(() => {
    pauseBgmRef.current();
    oneShotAudioRef.current?.pauseAll();
  }, []);
  useEffect(() => () => pausePreviewAudio(), [pausePreviewAudio]);
  const publishPlaying = useCallback((playing: boolean) => {
    setTransportPlaying(playing);
    onPlayingChangeRef.current?.(playing);
  }, []);
  // W9: 元動画の総尺(ms。composition未生成run=タイムライン写像なしのシークバー用)。
  const [videoDurationMs, setVideoDurationMs] = useState(0);
  // W9: 現在の元動画ms(整数丸め。タイムライン写像不能run向けのシークバー・時刻表示用)。
  const [sourceNowMs, setSourceNowMs] = useState(0);
  // W9: 音量・ミュート(プレビューのみ。書き出しには影響しない)。
  const [transportMuted, setTransportMuted] = useState(false);
  const [transportVolume, setTransportVolume] = useState(1);
  // W9: フレーミング編集モード(変形・クロップ)。
  const [framingEditMode, setFramingEditMode] = useState<FramingEditMode>(null);
  const framingDragRef = useRef<FramingDragState | null>(null);
  const framingRef = useRef<VideoFraming>(videoFraming ?? IDENTITY_VIDEO_FRAMING);
  framingRef.current = videoFraming ?? IDENTITY_VIDEO_FRAMING;
  const onVideoFramingChangeRef = useRef(onVideoFramingChange);
  onVideoFramingChangeRef.current = onVideoFramingChange;
  const sortedSegments = useMemo(
    () => [...keepSegments].sort((a, b) => a.startMs - b.startMs),
    [keepSegments],
  );
  const sortedSegmentsRef = useRef(sortedSegments);
  sortedSegmentsRef.current = sortedSegments;
  const keepSegmentsReadyRef = useRef(keepSegmentsReady);
  keepSegmentsReadyRef.current = keepSegmentsReady;
  const wordsRef = useRef(words);
  wordsRef.current = words;
  const onActiveWordChangeRef = useRef(onActiveWordChange);
  onActiveWordChangeRef.current = onActiveWordChange;
  const onTimeUpdateRef = useRef(onTimeUpdate);
  onTimeUpdateRef.current = onTimeUpdate;
  const onTimelineTimeUpdateRef = useRef(onTimelineTimeUpdate);
  onTimelineTimeUpdateRef.current = onTimelineTimeUpdate;
  // フェーズV4(画像挿入トラック): 画像オーバーレイの表示判定に使う現在タイムラインms。
  // 親への通知(onTimelineTimeUpdate)と同じ値を publishTimelineMs の1箇所から発行する。
  const [timelineNowMs, setTimelineNowMs] = useState<number | null>(null);
  const publishTimelineMs = useCallback((timelineMs: number | null) => {
    onTimelineTimeUpdateRef.current?.(timelineMs);
    // 整数msへ丸めてstate更新の頻度を抑える(同値ならReactが再レンダーをスキップする)
    setTimelineNowMs(timelineMs === null ? null : Math.round(timelineMs));
  }, []);
  const lastActiveWordIdRef = useRef<string | null>(null);
  const playbackRateRef = useRef(playbackRate);
  playbackRateRef.current = playbackRate;

  function applyVideoPlaybackRate(segmentSpeed = 1) {
    const video = videoRef.current;
    if (video) video.playbackRate = playbackRateRef.current * segmentSpeed;
  }

  // ---------------------------------------------------------------------------
  // フェーズV3: 仮想プレイリスト([OPエントリ列]+[本編カット列])
  // ---------------------------------------------------------------------------
  const ranges = useMemo(() => timelineCutRanges ?? [], [timelineCutRanges]);
  const rangesRef = useRef(ranges);
  rangesRef.current = ranges;
  const playlist = useMemo(() => buildPreviewPlaylist(ranges, opPreview ?? null), [ranges, opPreview]);
  const playlistRef = useRef(playlist);
  playlistRef.current = playlist;
  const fps = timelineFps && timelineFps > 0 ? timelineFps : 30;
  const opPhases = useMemo(() => (opPreview ? opPhasesMsFor(opPreview, fps) : null), [opPreview, fps]);
  const opPreviewRef = useRef(opPreview ?? null);
  opPreviewRef.current = opPreview ?? null;
  const opPhasesRef = useRef(opPhases);
  opPhasesRef.current = opPhases;
  const sfxStateForOpRef = useRef({ urls: sfxUrls, volume: sfxVolume, muted: sfxMuted });
  sfxStateForOpRef.current = { urls: sfxUrls, volume: sfxVolume, muted: sfxMuted };

  const virtualRef = useRef<VirtualPlaybackState>({
    mode: "main",
    entryIndex: -1,
    staticOffsetMs: 0,
    staticPlaying: false,
  });
  /** OP再生中の描画用位置(null=OPモード外)。約60fpsで更新されOPオーバーレイのアニメを進める。 */
  const [opView, setOpView] = useState<{ timelineMs: number; entryIndex: number } | null>(null);
  /** OPクリップ切替の白フラッシュ再発火キー。 */
  const [opFlashKey, setOpFlashKey] = useState<string | null>(null);
  const opFlashCounterRef = useRef(0);
  /** エンジン起点のシーク(エントリ遷移・先読み)を、ユーザーのシークと区別するための保留数。 */
  const engineSeekPendingRef = useRef(0);
  /** OPのキメ音/転換音の発火済みフラグ(OPモード進入・OP内シークでリセット)。 */
  const opSfxFiredRef = useRef({ title: true, transition: true });
  const staticRafRef = useRef<number | null>(null);
  const staticLastTsRef = useRef(0);

  function engineSeekTo(sourceMs: number) {
    const video = videoRef.current;
    if (!video) return;
    engineSeekPendingRef.current += 1;
    video.currentTime = Math.max(0, sourceMs / 1000);
  }

  function stopStaticLoop() {
    if (staticRafRef.current != null) cancelAnimationFrame(staticRafRef.current);
    staticRafRef.current = null;
  }

  /** OPモードを抜けて従来の本編再生(keep_segmentsスキップ)へ戻す。 */
  function exitOpToMain() {
    stopStaticLoop();
    const virtual = virtualRef.current;
    const wasStaticPlaying = virtual.mode === "op" && virtual.staticPlaying;
    virtual.mode = "main";
    virtual.staticPlaying = false;
    setOpView(null);
    setOpFlashKey(null);
    // 静止エントリの仮想再生中に離脱するとvideoは止まったままなので、停止を親へ通知する
    if (wasStaticPlaying && (videoRef.current?.paused ?? true)) publishPlaying(false);
  }

  /** OP内シーク位置に応じてキメ音/転換音の発火済みフラグを初期化する(通過済みは再発火しない)。 */
  function resetOpSfxFlags(opMs: number) {
    const phases = opPhasesRef.current;
    if (!phases) {
      opSfxFiredRef.current = { title: true, transition: true };
      return;
    }
    opSfxFiredRef.current = { title: opMs >= phases.titleMs, transition: opMs >= phases.fadeOutMs };
  }

  /** OP再生中のキメ音(タイトル登場)・転換音(whoosh)。Remotionの opSfxVolume と同じ持ち上げ。 */
  function maybeFireOpSfx(opMs: number) {
    const op = opPreviewRef.current;
    const phases = opPhasesRef.current;
    const { urls, volume, muted } = sfxStateForOpRef.current;
    if (!op || !phases || muted) return;
    const effectiveVolume = opSfxVolume(volume ?? 0.25);
    if (effectiveVolume <= 0) return;
    const fired = opSfxFiredRef.current;
    const playById = (sfxId: string | null) => {
      const url = sfxId ? urls?.[sfxId] : null;
      if (!url) return;
      const audio = new Audio(url);
      audio.volume = Math.max(0, Math.min(1, effectiveVolume));
      oneShotAudioRef.current?.play(audio);
    };
    if (!fired.title && opMs >= phases.titleMs) {
      fired.title = true;
      playById(op.sfxHit);
    }
    if (!fired.transition && opMs >= phases.fadeOutMs && phases.fadeOutMs < op.durationMs) {
      fired.transition = true;
      playById(op.sfxTransition);
    }
  }

  /** op_static エントリの実時間タイマーループ(videoはpausedのまま進める)。 */
  function startStaticLoop() {
    stopStaticLoop();
    staticLastTsRef.current = performance.now();
    const step = () => {
      staticRafRef.current = null;
      const virtual = virtualRef.current;
      const entry = playlistRef.current[virtual.entryIndex];
      if (virtual.mode !== "op" || !entry || entry.kind !== "op_static" || !virtual.staticPlaying) return;
      const now = performance.now();
      // 静止エントリも再生速度(追い読み1.5x等)に追従させる
      virtual.staticOffsetMs +=
        (now - staticLastTsRef.current) * playbackRateRef.current * (entry.speed || 1);
      staticLastTsRef.current = now;
      const length = entry.timelineEndMs - entry.timelineStartMs;
      if (virtual.staticOffsetMs >= length) {
        advanceFromEntry(virtual.entryIndex);
        return;
      }
      const opMs = entry.timelineStartMs + virtual.staticOffsetMs;
      setOpView({ timelineMs: opMs, entryIndex: virtual.entryIndex });
      maybeFireOpSfx(opMs);
      publishTimelineMs(opMs);
      staticRafRef.current = requestAnimationFrame(step);
    };
    staticRafRef.current = requestAnimationFrame(step);
  }

  /**
   * プレイリストの指定エントリへ移動する(仮想プレイリスト再生の中核)。
   * - op_clip / main: <video>を該当元動画位置へシークして(必要なら)再生
   * - op_static: videoは止めたまま実時間タイマーで進め、裏で次の映像エントリ先頭へ先読みシーク
   */
  function enterEntry(index: number, offsetMs: number, playing: boolean, withFlash: boolean) {
    const entries = playlistRef.current;
    const entry = entries[index];
    const video = videoRef.current;
    if (!entry || !video) return;
    stopStaticLoop();
    const virtual = virtualRef.current;
    const timelineMs = entry.timelineStartMs + offsetMs;

    if (entry.kind === "main") {
      virtual.mode = "main";
      virtual.staticPlaying = false;
      setOpView(null);
      applyVideoPlaybackRate(entry.speed || 1);
      engineSeekTo(timelineMs === entry.timelineEndMs
        ? entry.sourceEndMs
        : Math.min(entry.sourceEndMs, entry.sourceStartMs + offsetMs * (entry.speed || 1)));
      publishTimelineMs(timelineMs);
      if (playing) video.play().catch(() => {});
      return;
    }

    virtual.mode = "op";
    virtual.entryIndex = index;
    resetOpSfxFlags(timelineMs);

    if (entry.kind === "op_clip") {
      applyVideoPlaybackRate(1);
      virtual.staticPlaying = false;
      engineSeekTo(entry.sourceStartMs + offsetMs);
      // 白フラッシュは再生中のクリップ切替のみ(Remotionも2本目以降のクリップ先頭で光る)
      if (withFlash && (entry.opClipIndex ?? 0) > 0) {
        opFlashCounterRef.current += 1;
        setOpFlashKey(`flash_${opFlashCounterRef.current}`);
      }
      setOpView({ timelineMs, entryIndex: index });
      publishTimelineMs(timelineMs);
      if (playing) video.play().catch(() => {});
      else video.pause();
      return;
    }

    // op_static: 映像不要。videoは次の映像エントリ先頭へ先読みしておく(切替を滑らかにする)
    virtual.staticOffsetMs = offsetMs;
    virtual.staticPlaying = playing;
    video.pause();
    const preloadTarget = findNextVideoEntry(entries, index);
    if (preloadTarget) engineSeekTo(preloadTarget.sourceStartMs);
    setOpView({ timelineMs, entryIndex: index });
    publishTimelineMs(timelineMs);
    if (playing) {
      startStaticLoop();
      publishPlaying(true);
    }
  }

  /** 現在エントリの終端に達したときの次エントリ遷移。 */
  function advanceFromEntry(index: number) {
    const entries = playlistRef.current;
    const nextIndex = index + 1 < entries.length ? index + 1 : null;
    if (nextIndex === null) {
      // プレイリスト終端(本編なしrun等)。OPモードを解いて停止する
      exitOpToMain();
      videoRef.current?.pause();
      publishPlaying(false);
      return;
    }
    enterEntry(nextIndex, 0, true, true);
  }

  /** 仮想再生中か(OP静止エントリのタイマー再生も含む)。 */
  function isVirtuallyPlaying(): boolean {
    const virtual = virtualRef.current;
    const video = videoRef.current;
    const entry = playlistRef.current[virtual.entryIndex];
    if (virtual.mode === "op" && entry?.kind === "op_static") return virtual.staticPlaying;
    return video ? !video.paused : false;
  }

  useImperativeHandle(
    forwardedRef,
    () => ({
      play: () => {
        const virtual = virtualRef.current;
        const entry = playlistRef.current[virtual.entryIndex];
        if (virtual.mode === "op" && entry?.kind === "op_static") {
          // 静止エントリはvideoを動かさずタイマー再生を再開する
          virtual.staticPlaying = true;
          startStaticLoop();
          publishPlaying(true);
          return;
        }
        videoRef.current?.play().catch(() => {});
      },
      pause: () => {
        pausePreviewAudio();
        const virtual = virtualRef.current;
        if (virtual.mode === "op" && virtual.staticPlaying) {
          virtual.staticPlaying = false;
          publishPlaying(false);
        }
        videoRef.current?.pause();
      },
      isPaused: () => {
        const virtual = virtualRef.current;
        const entry = playlistRef.current[virtual.entryIndex];
        if (virtual.mode === "op" && entry?.kind === "op_static") return !virtual.staticPlaying;
        return videoRef.current?.paused ?? true;
      },
      getCurrentTimeMs: () => (videoRef.current ? videoRef.current.currentTime * 1000 : 0),
      seekTo: (ms: number) => {
        if (!videoRef.current) return;
        // 元動画msの直接シーク(シーン行再生等)は常に本編モードとして扱う
        exitOpToMain();
        videoRef.current.currentTime = Math.max(0, ms / 1000);
      },
      seekToSourceMs: (ms: number) => {
        if (!videoRef.current) return;
        // W19-A2: ホバースクラブ用。seekMs prop消化時(seekMs effect)と同じ経路
        // (OPモード解除+currentTime設定)をstateを介さず直接実行する。
        exitOpToMain();
        videoRef.current.currentTime = Math.max(0, ms / 1000);
      },
    }),
    // エンジン関数はすべてref経由で最新状態を読むため初回レンダーのクロージャで安全
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    if (seekMs == null || !videoRef.current) return;
    // 元動画ms基準のシーク(既存UI: シーン行・波形ナビ・単語クリック)は本編モードへ
    exitOpToMain();
    videoRef.current.currentTime = Math.max(0, seekMs / 1000);
    onSeekConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSeekConsumed, seekMs]);

  // フェーズV3: タイムラインms基準のシーク(タイムラインViewのクリック)。OP区間へも入れる
  useEffect(() => {
    if (seekTimelineMs == null) return;
    const position = clampTimelineMsToPlaylist(playlistRef.current, seekTimelineMs, { allowFinalEnd: true });
    onSeekTimelineConsumed?.();
    if (!position) return;
    enterEntry(position.index, position.offsetMs, isVirtuallyPlaying(), false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekTimelineMs]);

  // プレイリスト自体が変わったら(カット編集・OP設定変更・動画切替)、OP再生中なら安全側で本編へ戻す
  useEffect(() => {
    if (virtualRef.current.mode === "op") exitOpToMain();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlist, videoUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const sourceMs = video.currentTime * 1000;
    const active = rangesRef.current.find(
      (range) => sourceMs >= range.sourceStartMs && sourceMs < range.sourceEndMs,
    );
    applyVideoPlaybackRate(active?.speed || 1);
  }, [playbackRate, videoUrl]);

  // 改善7-2/フェーズW8: ステージの表示ボックスをResizeObserverで追従する
  // (旧: video要素を直接計測。W8でステージdivがキャンバスの器になったため計測対象を変更)。
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setContainerSize({ width, height });
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [videoUrl]);

  // 改善7-2: 動画の実寸(intrinsic width/height)をloadedmetadataから取得する。
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    function updateIntrinsicSize() {
      if (!video) return;
      if (video.videoWidth && video.videoHeight) {
        setVideoIntrinsicSize({ width: video.videoWidth, height: video.videoHeight });
      }
      // W9(トランスポートバー): composition未生成runのシークバー総尺(元動画ms)
      if (Number.isFinite(video.duration) && video.duration > 0) {
        setVideoDurationMs(Math.round(video.duration * 1000));
      }
    }
    updateIntrinsicSize();
    video.addEventListener("loadedmetadata", updateIntrinsicSize);
    return () => video.removeEventListener("loadedmetadata", updateIntrinsicSize);
  }, [videoUrl]);

  // フェーズW8: キャンバス寸法指定時はキャンバスのアスペクト基準(未指定は従来のintrinsic基準)。
  const containedBox = useMemo(
    () =>
      computeStageCanvasBox(
        containerSize.width,
        containerSize.height,
        canvasWidth,
        canvasHeight,
        videoIntrinsicSize.width,
        videoIntrinsicSize.height,
      ),
    [
      containerSize.width,
      containerSize.height,
      canvasWidth,
      canvasHeight,
      videoIntrinsicSize.width,
      videoIntrinsicSize.height,
    ],
  );

  // ---------------------------------------------------------------------------
  // フェーズW9: 映像フレーミング(変形・クロップ)の描画レイアウト。
  // キャンバス座標系で videoFramingLayout(Remotionと同一の純関数)を計算し、
  // stageScale(キャンバスpx→表示px)と編集ビュー(編集モード中の全体表示ズームアウト)で
  // 表示pxへ写像する。identity framing なら cropRect=coverフィット矩形=W8と同一の見た目。
  // ---------------------------------------------------------------------------
  const framing = videoFraming ?? IDENTITY_VIDEO_FRAMING;
  const framingCanvasWidth = canvasWidth && canvasWidth > 0 ? canvasWidth : videoIntrinsicSize.width;
  const framingCanvasHeight = canvasHeight && canvasHeight > 0 ? canvasHeight : videoIntrinsicSize.height;
  const framingSourceWidth = sourceWidth && sourceWidth > 0 ? sourceWidth : videoIntrinsicSize.width;
  const framingSourceHeight = sourceHeight && sourceHeight > 0 ? sourceHeight : videoIntrinsicSize.height;
  const framingLayout = useMemo(
    () =>
      videoFramingLayout({
        canvasWidth: framingCanvasWidth,
        canvasHeight: framingCanvasHeight,
        sourceWidth: framingSourceWidth,
        sourceHeight: framingSourceHeight,
        framing,
      }),
    [framingCanvasWidth, framingCanvasHeight, framingSourceWidth, framingSourceHeight, framing],
  );
  const stageScale =
    containedBox.width > 0 && framingCanvasWidth > 0 ? containedBox.width / framingCanvasWidth : 0;
  // 編集モード中はキャンバス+フル映像の合併境界が収まるまでズームアウトする(FCP風)
  const framingEditViewState = useMemo(() => {
    if (!framingEditMode || stageScale <= 0) return { scale: 1, translateX: 0, translateY: 0 };
    return framingEditView(containedBox.width, containedBox.height, {
      left: framingLayout.videoRect.left * stageScale,
      top: framingLayout.videoRect.top * stageScale,
      width: framingLayout.videoRect.width * stageScale,
      height: framingLayout.videoRect.height * stageScale,
    });
  }, [framingEditMode, stageScale, containedBox.width, containedBox.height, framingLayout]);
  const viewCropRect =
    stageScale > 0 ? framingViewRect(framingLayout.cropRect, stageScale, framingEditViewState) : null;
  const viewVideoRect =
    stageScale > 0 ? framingViewRect(framingLayout.videoRect, stageScale, framingEditViewState) : null;
  // W13-7: 画角(キャンバス)の編集ビュー矩形。scale>1やオフセットで映像がキャンバス外へ
  // はみ出したとき「書き出しに残る範囲」を枠線+外側ディムで可視化する
  const viewCanvasRect =
    stageScale > 0
      ? framingViewRect(
          { left: 0, top: 0, width: framingCanvasWidth, height: framingCanvasHeight },
          stageScale,
          framingEditViewState,
        )
      : null;

  function handleFramingPointerDown(
    event: React.PointerEvent<HTMLElement>,
    kind: FramingDragState["kind"],
    corner?: TransformCorner,
    handle?: CropHandle,
  ) {
    if (!onVideoFramingChangeRef.current || !viewCropRect || !viewVideoRect) return;
    event.stopPropagation();
    event.preventDefault();
    framingDragRef.current = {
      kind,
      corner,
      handle,
      startClientX: event.clientX,
      startClientY: event.clientY,
      snapshot: framingRef.current,
      // 換算基準は「編集ビュー適用前」の表示px寸法(ドラッグ量は viewScale で割って戻す)
      cropRectWidthPx: framingLayout.cropRect.width * stageScale,
      videoRectWidthPx: framingLayout.videoRect.width * stageScale,
      videoRectHeightPx: framingLayout.videoRect.height * stageScale,
      viewScale: framingEditViewState.scale,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function handleFramingPointerMove(event: React.PointerEvent<HTMLElement>) {
    const drag = framingDragRef.current;
    const notify = onVideoFramingChangeRef.current;
    if (!drag || !notify) return;
    // スクリーンpx→(編集ビュー縮小前の)キャンバス表示px
    const deltaXPx = (event.clientX - drag.startClientX) / (drag.viewScale || 1);
    const deltaYPx = (event.clientY - drag.startClientY) / (drag.viewScale || 1);
    let updated = drag.snapshot;
    if (drag.kind === "move") {
      updated = dragFramingMove(drag.snapshot, deltaXPx, deltaYPx, containedBox.width, containedBox.height);
    } else if (drag.kind === "scale" && drag.corner) {
      updated = dragFramingScale(drag.snapshot, deltaXPx, deltaYPx, drag.corner, drag.cropRectWidthPx);
    } else if (drag.kind === "crop" && drag.handle) {
      updated = dragFramingCrop(
        drag.snapshot,
        deltaXPx,
        deltaYPx,
        drag.handle,
        drag.videoRectWidthPx,
        drag.videoRectHeightPx,
      );
    }
    notify(updated, false);
  }

  function handleFramingPointerUp(event: React.PointerEvent<HTMLElement>) {
    const drag = framingDragRef.current;
    framingDragRef.current = null;
    if (!drag) return;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    onVideoFramingChangeRef.current?.(framingRef.current, true);
  }

  // run(動画)切替時は編集モードを解除する
  useEffect(() => {
    setFramingEditMode(null);
    framingDragRef.current = null;
  }, [videoUrl]);

  // W9(トランスポートバー): 音量・ミュートを<video>へ反映する(videoUrl変更=再マウント時も)
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = transportMuted;
    video.volume = transportVolume;
  }, [transportMuted, transportVolume, videoUrl]);

  /** W9: トランスポートバーの再生/一時停止(仮想プレイリスト=OP静止エントリも考慮)。 */
  function handleTransportToggle() {
    const virtual = virtualRef.current;
    const entry = playlistRef.current[virtual.entryIndex];
    if (virtual.mode === "op" && entry?.kind === "op_static") {
      if (virtual.staticPlaying) {
        pausePreviewAudio();
        virtual.staticPlaying = false;
        publishPlaying(false);
      } else {
        virtual.staticPlaying = true;
        startStaticLoop();
        publishPlaying(true);
      }
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => {});
    else { pausePreviewAudio(); video.pause(); }
  }

  /** W9: シークバー(タイムラインms基準。プレイリスト無し=composition未生成は元動画ms直)。 */
  function handleTransportSeek(ms: number) {
    if (playlistRef.current.length > 0) {
      const position = clampTimelineMsToPlaylist(playlistRef.current, ms, { allowFinalEnd: true });
      if (position) enterEntry(position.index, position.offsetMs, isVirtuallyPlaying(), false);
      return;
    }
    const video = videoRef.current;
    if (video) video.currentTime = Math.max(0, ms / 1000);
  }

  // ---------------------------------------------------------------------------
  // フェーズV3: OP再生中の描画状態(テロップ差し替え・オーバーレイ抑制)
  // ---------------------------------------------------------------------------
  const opEntry = opView ? (playlist[opView.entryIndex] ?? null) : null;
  const opClip =
    opPreview && opEntry?.kind === "op_clip" && opEntry.opClipIndex !== undefined
      ? (opPreview.clips[opEntry.opClipIndex] ?? null)
      : null;
  const opClipOffsetMs = opView && opEntry ? opView.timelineMs - opEntry.timelineStartMs : 0;
  // フェーズW: display=hook のクリップはフックワード(OpPreviewOverlay側で描画)が正。
  // 従来の発話テロップ(帯)は出さない
  const opHookActive = Boolean(opClip && opClip.display === "hook" && opClip.hookText);
  // クリップテロップは白フラッシュを避けて約0.08秒遅れで入る(Remotion opClipTelopTiming と同じ)
  const opTelopVisible =
    Boolean(opClip?.text) && !opHookActive && opClipOffsetMs >= opClipTelopDelayMs(fps);
  const opTelopStyle = opClip
    ? ((opClip.style ? overlayStyles?.[opClip.style] : undefined) ??
      (opDefaultTelopStyleId ? overlayStyles?.[opDefaultTelopStyleId] : undefined) ??
      FALLBACK_TELOP_STYLE)
    : null;
  const opActive = opView !== null;

  // OP中は本編テロップ(currentScene由来)をOPクリップテロップへ差し替える(静止エントリはテロップなし)
  const activeTelopText = opActive ? (opTelopVisible && opClip ? opClip.text : "") : telopText;
  const activeTelopStyle = opActive ? (opTelopStyle ?? FALLBACK_TELOP_STYLE) : (telopStyle ?? FALLBACK_TELOP_STYLE);
  const activeHighlightWords = opActive ? undefined : telopHighlightWords;
  // フェーズV5: OPテロップの登場アニメはop_configのtext_animation(全クリップ共通)に従う
  const activeAnimationInRaw = opActive ? (opPreview?.textAnimation ?? "slide_left") : telopAnimationIn;
  const activeAnimationDurationMs = opActive
    ? ((activeTelopStyle.animation_duration_frames ?? DEFAULT_ANIMATION_DURATION_FRAMES) / fps) * 1000
    : telopAnimationDurationMs;
  const activeSlotKey = opActive
    ? opTelopVisible && opEntry
      ? `op_clip_${opEntry.opClipIndex}`
      : null
    : telopSlotKey;

  const effectiveTelopStyle = activeTelopStyle;
  // W8: canvas指定(composition meta)があればそちらを正とする(実際はtelopBaseWidthも同じ
  // meta.display_width由来なので通常は一致する。1920固定フォールバックへ落とさないための保険)。
  const baseWidth = telopBaseWidth ?? canvasWidth ?? FALLBACK_TELOP_BASE_WIDTH;
  // コンポジション高さ。旧run(未指定)は表示ボックスのアスペクト比から逆算する。
  const baseHeight =
    telopBaseHeight ??
    canvasHeight ??
    (containedBox.width > 0 && containedBox.height > 0
      ? baseWidth * (containedBox.height / containedBox.width)
      : (baseWidth * 9) / 16);

  // U1-2/U1-3(Remotionと同一のレイアウト計算): 折返し・幅フィット・縦位置クランプを
  // Remotion(Telop.tsx)と同じ computeTelopBlockLayout / clampTelopYPercent で
  // 「コンポジション座標系」のまま確定し、最後に表示スケール(実表示幅÷コンポジション幅)を掛ける。
  // これによりプレビューと書き出しMP4の折返し位置・相対サイズ・縦位置が一致する。
  const blockBackground = resolveBlockBackground(effectiveTelopStyle);
  const telopLayout = useMemo(() => {
    if (!activeTelopText) return null;
    const segmentTexts = activeTelopText.split("\n").filter((line) => line.length > 0);
    if (!segmentTexts.length) return null;
    const baseFontSize = effectiveTelopStyle.font_size || telopFontSize || FALLBACK_TELOP_FONT_SIZE;
    // フェーズW27(縦書き): 折返しせず1列・高さフィット(Remotion Telop.tsxと同一規則)
    if (effectiveTelopStyle.writing_mode === "vertical") {
      const flatText = segmentTexts.join("");
      const letterSpacingEm = parseLetterSpacingEm(effectiveTelopStyle.letter_spacing);
      const charAdvance = baseFontSize * (1 + letterSpacingEm);
      const maxColumnHeight = baseHeight * 0.5;
      const scale = Math.min(1, maxColumnHeight / Math.max(1, flatText.length * charAdvance));
      return { lineTexts: [flatText], fontSize: Math.round(baseFontSize * scale) };
    }
    return computeTelopBlockLayout({
      segmentTexts,
      maxCharsPerLine: telopMaxCharsPerLine,
      baseFontSize,
      letterSpacingEm: parseLetterSpacingEm(effectiveTelopStyle.letter_spacing),
      // フェーズW24 Phase A-2: 縦型キャンバスは右端セーフゾーン分だけ幅上限を絞る(86%。Remotionと同一)
      fitWidth:
        telopFitWidth(baseWidth, baseHeight) -
        (blockBackground ? (blockBackground.padding_x ?? 0) * 2 : 0),
      // フェーズW26: 縦型は縮小しすぎる前に折返しへ逃がす(Remotion Telop.tsxと同一)
      minFontScale: baseHeight > baseWidth ? VERTICAL_TELOP_MIN_FONT_SCALE : undefined,
      // フェーズW27: 縦型は絶対最低サイズも張る(Remotionと同一)
      minFontPx: baseHeight > baseWidth ? VERTICAL_TELOP_MIN_FONT_PX : undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTelopText, telopMaxCharsPerLine, effectiveTelopStyle, telopFontSize, baseWidth, baseHeight, blockBackground]);

  // フェーズW24 Phase A-2: 現在再生位置のカットのtelop_y(顔回避配置。main側が
  // timelineCutRanges へ転写)。カット区間外(OP再生中・カット済み無音)は undefined=グローバル値。
  const activeCutRange = useMemo(() => {
    if (timelineNowMs === null) return undefined;
    return ranges.find(
      (item) => timelineNowMs >= item.timelineStartMs && timelineNowMs < item.timelineEndMs,
    );
  }, [ranges, timelineNowMs]);
  const cutTelopY = activeCutRange?.telopY;

  // フェーズW26: 現在カットのパンチイン(交互ズーム)。Remotion(CatCutComposition)と
  // 同じ normalizePunchIn/punchInStyle で映像ラッパーへ適用する(書き出しと同じ見た目)。
  const punchCss = useMemo(() => {
    if (!activeCutRange) return null;
    const punch = normalizePunchIn(activeCutRange.punchScale, {
      x: activeCutRange.punchOriginX,
      y: activeCutRange.punchOriginY,
    });
    return punch ? punchInStyle(punch) : null;
  }, [activeCutRange]);

  // U1-3: 縦位置(中心基準%)。telop_y + プリセットy_position_offset + 上下セーフエリアクランプ。
  // telopY未指定(旧UI互換)は従来の下部固定レイアウトを維持する。
  // W24 Phase A-2: cut単位のtelop_yがあればグローバルより優先(Remotionと同じ解決)。
  const automaticTelopYPercent = useMemo(() => {
    if (telopY === undefined || !telopLayout) return null;
    // W27(縦書き): 1列の文字数ぶんの高さを行数×行高として近似する(Remotionと同一)
    const isVerticalWriting = effectiveTelopStyle.writing_mode === "vertical";
    return clampTelopYPercent({
      telopY: effectiveCutTelopY(cutTelopY, telopY),
      yOffset: effectiveTelopStyle.y_position_offset ?? 0,
      lineCount: isVerticalWriting ? telopLayout.lineTexts[0].length : telopLayout.lineTexts.length,
      lineHeight: isVerticalWriting
        ? 1 + parseLetterSpacingEm(effectiveTelopStyle.letter_spacing)
        : (effectiveTelopStyle.line_height ?? 1.4),
      fontSize: telopLayout.fontSize,
      videoHeight: baseHeight,
      lineGapPx: blockBackground || isVerticalWriting ? 0 : TELOP_LINE_GAP_PX,
      blockPaddingY: blockBackground ? (blockBackground.padding_y ?? 0) : 0,
    });
  }, [telopY, cutTelopY, telopLayout, effectiveTelopStyle, baseHeight, blockBackground]);

  const [telopPositionEditing, setTelopPositionEditing] = useState(false);
  const [telopPositionDraft, setTelopPositionDraft] = useState<TelopPosition | null>(null);
  const telopDragRef = useRef<{ pointerId: number; x: number; y: number; start: TelopPosition; latest: TelopPosition; slotKey: string | null | undefined } | null>(null);
  const positionGeometry: TelopPositionGeometry = {
    lineTexts: telopLayout?.lineTexts ?? [], fontSize: telopLayout?.fontSize ?? 52,
    lineHeight: effectiveTelopStyle.line_height ?? 1.4,
    letterSpacingEm: parseLetterSpacingEm(effectiveTelopStyle.letter_spacing),
    videoWidth: baseWidth, videoHeight: baseHeight,
    paddingX: blockBackground?.padding_x ?? (effectiveTelopStyle.background ? (telopLayout?.fontSize ?? 52) * 0.5 : 0),
    paddingY: blockBackground?.padding_y ?? (effectiveTelopStyle.background ? (telopLayout?.fontSize ?? 52) * 0.15 : 0),
    lineGapPx: blockBackground ? 0 : TELOP_LINE_GAP_PX,
    strokePx: Math.max(effectiveTelopStyle.inner_stroke?.width ?? 0, effectiveTelopStyle.outer_stroke?.width ?? 0, effectiveTelopStyle.outer_stroke2?.width ?? 0) * (telopLayout?.fontSize ?? 52) / 52,
    rotateDeg: effectiveTelopStyle.rotate ?? 0, verticalWriting: effectiveTelopStyle.writing_mode === "vertical",
  };
  const manualTelopPosition = !opActive ? normalizeTelopPosition(telopPositionDraft ?? telopPosition) : undefined;
  const displayedTelopPosition = manualTelopPosition ? clampTelopPosition(manualTelopPosition, positionGeometry) : { x: 0.5, y: (automaticTelopYPercent ?? 88) / 100 };
  const telopYPercent = manualTelopPosition ? displayedTelopPosition.y * 100 : automaticTelopYPercent;
  const telopPositionEditable = Boolean(onTelopPositionChange && !opActive && telopLayout && containedBox.width > 0);
  const commitTelopPosition = (position: TelopPosition | null) => {
    if (!telopPositionEditable) return;
    onTelopPositionChange?.(position ? clampTelopPosition(position, positionGeometry) : null);
  };
  const cancelTelopPositionDrag = () => { telopDragRef.current = null; setTelopPositionDraft(null); };
  useEffect(() => {
    cancelTelopPositionDrag();
  }, [telopSlotKey, opActive, telopPositionEditing]);
  useEffect(() => {
    if (!telopPositionEditing) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
      const undoDuringDrag = Boolean(telopDragRef.current && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z");
      if (!undoDuringDrag && event.key !== "Escape") return;
      if (!telopDragRef.current && event.target instanceof HTMLElement && event.target.closest("input,textarea,select,[contenteditable='true']")) return;
      event.preventDefault(); event.stopImmediatePropagation(); cancelTelopPositionDrag();
      if (!undoDuringDrag) setTelopPositionEditing(false);
    };
    const onBlur = () => cancelTelopPositionDrag();
    window.addEventListener("keydown", cancel, true); window.addEventListener("blur", onBlur);
    return () => { window.removeEventListener("keydown", cancel, true); window.removeEventListener("blur", onBlur); };
  }, [telopPositionEditing]);
  function handleTelopPositionPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!telopPositionEditing || !telopPositionEditable || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    pausePreviewAudio();
    videoRef.current?.pause();
    telopDragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, start: displayedTelopPosition, latest: displayedTelopPosition, slotKey: telopSlotKey };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function updateTelopPositionDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag = telopDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || drag.slotKey !== telopSlotKey) return;
    event.stopPropagation();
    drag.latest = moveTelopPosition(drag.start, event.clientX - drag.x, event.clientY - drag.y, containedBox.width, containedBox.height, positionGeometry);
    setTelopPositionDraft(drag.latest);
  }
  function finishTelopPositionDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag = telopDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    updateTelopPositionDrag(event);
    telopDragRef.current = null;
    setTelopPositionDraft(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (drag.slotKey === telopSlotKey && (Math.abs(drag.latest.x - drag.start.x) > 0.0001 || Math.abs(drag.latest.y - drag.start.y) > 0.0001)) commitTelopPosition(drag.latest);
  }

  // コンポジション座標系 → 実表示pxへのスケール。
  const displayScale = containedBox.width > 0 && baseWidth > 0 ? containedBox.width / baseWidth : 0;
  const telopDisplayFontPx = telopLayout
    ? Math.max(MIN_TELOP_FONT_PX, Math.round(telopLayout.fontSize * displayScale))
    : MIN_TELOP_FONT_PX;

  // U9(BGMトラック)/V3: BGMをHTMLAudioで並走(位置同期・フェード音量はRemotionと同一カーブ)。
  // 位置は仮想プレイリスト基準のタイムラインmsで渡すため、OP区間(クリップ・静止)でも鳴る。
  const getPlaybackForBgm = useCallback(() => {
    const virtual = virtualRef.current;
    const video = videoRef.current;
    if (virtual.mode === "op") {
      const entry = playlistRef.current[virtual.entryIndex];
      if (!entry) return { timelineMs: null, playing: false, playbackRate: playbackRateRef.current };
      if (entry.kind === "op_static") {
        return {
          timelineMs: entry.timelineStartMs + virtual.staticOffsetMs,
          playing: virtual.staticPlaying,
          playbackRate: playbackRateRef.current,
        };
      }
      const sourceMs = video ? video.currentTime * 1000 : 0;
      return {
        timelineMs: entry.timelineStartMs + Math.max(0, sourceMs - entry.sourceStartMs),
        playing: video ? !video.paused : false,
        playbackRate: playbackRateRef.current,
      };
    }
    const sourceMs = video ? video.currentTime * 1000 : 0;
    return {
      timelineMs: sourceMsToTimelineMs(rangesRef.current, sourceMs),
      playing: video ? !video.paused : false,
      playbackRate: playbackRateRef.current,
    };
  }, []);
  pauseBgmRef.current = useBgmPreviewAudio({
    clips: bgmClips ?? [],
    muted: bgmMuted ?? false,
    getPlayback: getPlaybackForBgm,
  });

  // ---------------------------------------------------------------------------
  // フェーズW2(シーン映像ギミック): 現在タイムラインmsで区間中の効果を求め、
  // Remotionと同じ純関数(videoEffectStyle)でCSS transform/filterを計算する。
  // OP再生中は本編効果を適用しない(効果のstart_msはOP尺より後なので通常は該当なし)。
  // ---------------------------------------------------------------------------
  const activeVideoEffect =
    videoEffects && videoEffects.length > 0 && timelineNowMs !== null && virtualRef.current.mode !== "op"
      ? activeVideoEffectAt(videoEffects, timelineNowMs)
      : null;
  const videoEffectCss =
    activeVideoEffect && timelineNowMs !== null ? videoEffectStyle(activeVideoEffect, timelineNowMs) : null;

  // フェーズW2: pinch開始で teen SFX を小さく鳴らす(実再生中のみ・sfxMutedトグル連動)。
  // 効果IDの変化(=効果区間への進入)をトリガーにする(テロップSFXのtelopSlotKeyと同じ方式)。
  const activeVideoEffectRef = useRef(activeVideoEffect);
  activeVideoEffectRef.current = activeVideoEffect;
  const activeVideoEffectId = activeVideoEffect?.id ?? null;
  useEffect(() => {
    const effect = activeVideoEffectRef.current;
    if (!effect || effect.type !== "pinch" || !effect.sfx) return;
    const { urls, volume, muted } = sfxStateForOpRef.current;
    if (muted || (volume ?? 0.25) <= 0) return;
    const video = videoRef.current;
    if (!video || video.paused) return;
    if (virtualRef.current.mode === "op") return;
    const url = urls?.[effect.sfx];
    if (!url) return;
    const audio = new Audio(url);
    audio.volume = VIDEO_EFFECT_SFX_VOLUME;
    oneShotAudioRef.current?.play(audio);
  }, [activeVideoEffectId]);

  // U1-6(効果音): テロップスロットの表示開始で効果音を再生する。
  // - 実再生中のみ鳴らす(一時停止中のシーク・行クリックでは鳴らさない)
  // - Remotion側(computeSfxEvents)と同じ最小間隔ガード(5秒)を元動画msで近似する
  // - V3: OP再生中は本編スロットの効果音を鳴らさない(OPのキメ音はmaybeFireOpSfxが担当)
  const lastSfxSourceMsRef = useRef<number | null>(null);
  // W13-5: 直前にsfxが解決されたスロットのsfx ID(sfxなしスロットではリセットしない=Remotion側と同じ規則)
  const prevSlotSfxIdRef = useRef<string | null>(null);
  const sfxStateRef = useRef({ url: sfxUrl, id: sfxId, volume: sfxVolume, muted: sfxMuted });
  sfxStateRef.current = { url: sfxUrl, id: sfxId, volume: sfxVolume, muted: sfxMuted };
  useEffect(() => {
    const video = videoRef.current;
    if (!video || video.paused) return;
    if (virtualRef.current.mode === "op") return;
    const { url, id, volume, muted } = sfxStateRef.current;
    if (!url || muted || !telopSlotKey) return;
    // W13-5: 直前スロットと同じ効果音は鳴らさない(Remotion computeSfxEvents と同一の共有関数で判定)
    const repeated = id ? isRepeatedSfx(prevSlotSfxIdRef.current, id) : false;
    if (id) prevSlotSfxIdRef.current = id;
    if (repeated) return;
    const nowMs = video.currentTime * 1000;
    const lastMs = lastSfxSourceMsRef.current;
    if (lastMs !== null && Math.abs(nowMs - lastMs) < PREVIEW_SFX_MIN_INTERVAL_MS) return;
    lastSfxSourceMsRef.current = nowMs;
    const audio = new Audio(url);
    audio.volume = Math.max(0, Math.min(1, volume ?? 0.25));
    oneShotAudioRef.current?.play(audio);
    // telopSlotKey(=スロット表示開始)のみをトリガーにする。url等は発火時点の最新値をrefで読む。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [telopSlotKey]);

  // B-3: ハイライト更新はrequestVideoFrameCallback（利用不可ならrAF）で
  // timeupdate（〜250ms間隔）より滑らかに追従させる。videoUrl変更時（<video>の再マウント）に
  // 新しいDOM要素へ再接続する。
  useEffect(() => {
    const maybeVideo = videoRef.current;
    if (!maybeVideo) return undefined;
    const video: HTMLVideoElement = maybeVideo;
    const supportsRvfc = typeof video.requestVideoFrameCallback === "function";
    let rafId: number | null = null;
    let rvfcId: number | null = null;

    function update() {
      let currentMs = video.currentTime * 1000;
      const virtual = virtualRef.current;

      // フェーズV3: OPクリップ再生中はkeep_segmentsスキップを行わず、クリップ終端で次エントリへ
      if (virtual.mode === "op") {
        const entry = playlistRef.current[virtual.entryIndex];
        if (!entry || entry.kind === "op_static") return; // 静止エントリはstaticループが駆動する
        if (
          currentMs < entry.sourceStartMs - OP_CLIP_SEEK_TOLERANCE_MS ||
          currentMs > entry.sourceEndMs + OP_CLIP_SEEK_TOLERANCE_MS
        ) {
          // エンジン外の大きなシーク(ネイティブ再生バー等)=OPを抜けて従来動作へ
          exitOpToMain();
          return;
        }
        if (currentMs >= entry.sourceEndMs && !video.paused && !video.seeking) {
          advanceFromEntry(virtual.entryIndex);
          return;
        }
        const opMs = entry.timelineStartMs + Math.max(0, currentMs - entry.sourceStartMs);
        setOpView({ timelineMs: opMs, entryIndex: virtual.entryIndex });
        maybeFireOpSfx(opMs);
        publishTimelineMs(opMs);
        // 単語ハイライト・onTimeUpdate(元動画ms)はOP中は更新しない
        // (シーン選択・トランスクリプトがOPクリップ位置へ飛ぶのを防ぐ)
        return;
      }

      const segments = sortedSegmentsRef.current;
      const action = resolveKeepPlaybackAction(segments, currentMs, !video.paused && !video.seeking, {
        keepSegmentsReady: keepSegmentsReadyRef.current,
      });
      if (action.seekMs !== null) {
        engineSeekTo(action.seekMs);
        currentMs = action.seekMs;
      }
      if (action.stop) video.pause();
      const activeSegment = segments.find(
        (segment) => currentMs >= segment.startMs && currentMs < segment.endMs,
      );
      applyVideoPlaybackRate(activeSegment?.speed || 1);

      const activeIndex = findActiveWordIndex(wordsRef.current, currentMs);
      const activeWordId = activeIndex >= 0 ? wordsRef.current[activeIndex].id : null;
      if (activeWordId !== lastActiveWordIdRef.current) {
        lastActiveWordIdRef.current = activeWordId;
        onActiveWordChangeRef.current(activeWordId);
      }
      onTimeUpdateRef.current?.(currentMs);
      // 「この行だけ再生」の親コールバックがOUT点へ戻した場合も、時計を同じ位置に揃える。
      currentMs = video.currentTime * 1000;
      publishTimelineMs(video.paused
        ? sourceMsToTimelineEditMs(rangesRef.current, currentMs)
        : sourceMsToTimelineMs(rangesRef.current, currentMs));
      // W9(トランスポートバー): タイムライン写像が無いrun(composition未生成)向けの現在位置
      setSourceNowMs(Math.round(currentMs));
    }

    function stopLoop() {
      if (rvfcId != null && supportsRvfc) video.cancelVideoFrameCallback(rvfcId);
      if (rafId != null) cancelAnimationFrame(rafId);
      rvfcId = null;
      rafId = null;
    }

    function loop() {
      update();
      if (video.paused) return;
      if (supportsRvfc) {
        rvfcId = video.requestVideoFrameCallback(loop);
      } else {
        rafId = requestAnimationFrame(loop);
      }
    }

    function handlePlay() {
      const virtual = virtualRef.current;
      const entry = playlistRef.current[virtual.entryIndex];
      if (virtual.mode === "op" && entry?.kind === "op_static") {
        // 静止エントリ中のネイティブ再生ボタン=OPの続きから再開(videoは先読み位置のまま止める)
        video.pause();
        virtual.staticPlaying = true;
        startStaticLoop();
        publishPlaying(true);
        return;
      }
      stopLoop();
      loop();
      publishPlaying(!video.paused);
    }
    function handlePauseOrEnded() {
      stopLoop();
      update();
      const virtual = virtualRef.current;
      const entry = playlistRef.current[virtual.entryIndex];
      const staticActive = virtual.mode === "op" && entry?.kind === "op_static" && virtual.staticPlaying;
      // 静止エントリの仮想再生中はvideoのpauseを「停止」として親へ通知しない
      publishPlaying(staticActive);
    }
    function handleSeeked() {
      if (engineSeekPendingRef.current > 0) {
        engineSeekPendingRef.current -= 1;
      } else if (virtualRef.current.mode === "op") {
        // ユーザー操作のシーク(ネイティブ再生バー等)はOPを抜けて従来動作へ
        const entry = playlistRef.current[virtualRef.current.entryIndex];
        const currentMs = video.currentTime * 1000;
        const withinClip =
          entry &&
          entry.kind === "op_clip" &&
          currentMs >= entry.sourceStartMs - OP_CLIP_SEEK_TOLERANCE_MS &&
          currentMs <= entry.sourceEndMs + OP_CLIP_SEEK_TOLERANCE_MS;
        if (!withinClip) exitOpToMain();
      }
      update();
    }

    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePauseOrEnded);
    video.addEventListener("ended", handlePauseOrEnded);
    video.addEventListener("seeked", handleSeeked);
    update();
    publishPlaying(!video.paused);
    if (!video.paused) loop();

    return () => {
      stopLoop();
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePauseOrEnded);
      video.removeEventListener("ended", handlePauseOrEnded);
      video.removeEventListener("seeked", handleSeeked);
    };
    // エンジン関数はref経由で最新状態を読むため依存はvideoUrl(要素の再マウント)のみでよい
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoUrl]);

  // アンマウント時に静止エントリのタイマーを確実に止める
  useEffect(() => () => stopStaticLoop(), []);

  // U1-6(アニメCSS近似): pop_bigの「画面中央→定位置」移動量とslide距離をCSS変数で渡す。
  const animationIn = activeAnimationInRaw && activeAnimationInRaw !== "none" ? activeAnimationInRaw : null;
  // W24 Phase B-1(typewriter): ブロックのkeyframeアニメではなく、TelopStyledText内の
  // grapheme単位のanimation-delayで近似する(タイミング規則はRemotionと共有)。
  const typewriterActive = animationIn === "typewriter";
  const blockAnimationIn = typewriterActive ? null : animationIn;
  const animationVars = useMemo(() => {
    if (!blockAnimationIn) return undefined;
    const yPercent = telopYPercent ?? 88;
    return {
      "--telop-anim-duration": `${Math.max(1, activeAnimationDurationMs ?? 400)}ms`,
      "--telop-anim-center-offset": `${((50 - yPercent) / 100) * containedBox.height}px`,
      "--telop-anim-slide-distance": `${containedBox.width * 0.18}px`,
      "--telop-anim-slide-up": `${56 * displayScale}px`,
      // W24 Phase B-1: drop_settle の落下距離(Remotionの90pxコンポジション座標を表示pxへ)
      "--telop-anim-drop": `${90 * displayScale}px`,
      // W26: バウンド系の移動量(Remotion側の画面比計算と同一: 幅0.6 / 高さ0.16 / 高さ0.2)
      "--telop-anim-bounce-x": `${containedBox.width * 0.6}px`,
      "--telop-anim-rise": `${containedBox.height * 0.16}px`,
      "--telop-anim-drop-bounce": `${containedBox.height * 0.2}px`,
    } as CSSProperties;
  }, [blockAnimationIn, activeAnimationDurationMs, telopYPercent, containedBox.height, containedBox.width, displayScale]);

  // オーバーレイのスケール。Remotion(Overlays.tsx)は「1080p高さ基準のデザイン値 × height/1080」で
  // 描くため、書き出し上のオーバーレイ実寸は design × canvasHeight/1080(キャンバスpx)。
  // これをプレビュー表示pxへ写像すると × containedBox.height/canvasHeight が掛かり、
  // canvasHeight が約分されて「design × containedBox.height/1080」になる。
  // つまり 1080 除算はキャンバス高さに依らず書き出しと一致する(W8の縦キャンバスでも同様)。
  const overlayScale = containedBox.height > 0 ? containedBox.height / 1080 : 0;

  // フェーズW8: ステージの縦横比。キャンバス指定時はキャンバス、未指定は動画intrinsic
  // (metadata未取得の間は16:9仮置き)。縦型キャンバスはCSS側でmax-heightを60vhへ広げる。
  const stageAspect =
    canvasWidth && canvasHeight
      ? `${canvasWidth} / ${canvasHeight}`
      : videoIntrinsicSize.width && videoIntrinsicSize.height
        ? `${videoIntrinsicSize.width} / ${videoIntrinsicSize.height}`
        : "16 / 9";
  const stageVertical = Boolean(canvasWidth && canvasHeight && canvasHeight > canvasWidth);

  // フェーズV3/W9(カスタムトランスポートバー): 時刻・シークバーはタイムラインms基準
  // (OP込み。写像不能な瞬間は直前の値を保持して表示のちらつきを防ぐ)。
  // composition未生成run(プレイリストなし)は元動画msをそのまま使う。
  const transportClockRef = useRef(0);
  const playlistTotalMs = useMemo(() => playlistTotalDurationMs(playlist), [playlist]);
  const hasPlaylist = playlist.length > 0;
  if (hasPlaylist) {
    const mapped = opView ? opView.timelineMs : timelineNowMs;
    if (mapped !== null && mapped !== undefined) transportClockRef.current = mapped;
  }
  const transportNowMs = hasPlaylist ? transportClockRef.current : sourceNowMs;
  const transportTotalMs = hasPlaylist ? playlistTotalMs : videoDurationMs;

  // W9: フレーミング編集中は映像ギミックのtransformを一時停止する(編集ハンドルと映像の
  // 位置ズレを防ぐ。編集を終えれば従来どおり適用される)。
  const videoEffectCssActive = framingEditMode ? null : videoEffectCss;
  const framingEditable = Boolean(onVideoFramingChange);

  return (
    <div className="transcriptPreviewPanel">
      <div className="previewViewport">
      {/* キャンバス領域ラッパー: ステージと全オーバーレイ(テロップ・画像・OP・フレーミング)の
          位置基準(position:relative)。縦型ではfit-content+中央寄せでステージにフィットさせる
          =左右の黒帯が出ない。オーバーレイはこのラッパー基準の絶対配置なので中央寄せしても
          ステージとの相対位置(containedBoxオフセット)は崩れない。 */}
      <div
        className={`previewCanvasArea${stageVertical ? " previewCanvasAreaVertical" : ""}`}
        style={stageVertical ? { aspectRatio: stageAspect } : undefined}
      >
      {/* フェーズW2: シーン映像ギミック。外側=黒背景+clip(pinchの縮小で見える余白と
          zoomのはみ出しをRemotionのコンポジション境界と同じ扱いにする)、
          内側wrapper=videoEffectStyle(Remotionと同一の純関数)のtransform/filter。
          効果なしの間はスタイルが空なので従来と完全同一の描画。 */}
      <div className="previewEffectClip" style={videoEffectCssActive ? { backgroundColor: "#000", overflow: "hidden" } : undefined}>
        <div
          className="previewEffectTransform"
          style={
            videoEffectCssActive
              ? {
                  transform: videoEffectCssActive.transform,
                  transformOrigin: videoEffectCssActive.transformOrigin,
                  filter: videoEffectCssActive.filter,
                }
              : undefined
          }
        >
          {/* フェーズW8: キャンバス基準のステージ。フェーズW9でRemotionと同じ
              「クロップラッパー(cropRect, overflow:hidden) > 映像(videoRect 絶対配置)」構造にした。
              identity framing なら cropRect=キャンバス全面・videoRect=cover矩形でW8と同一の見た目。 */}
          <div
            className={`transcriptPreviewStage${stageVertical ? " transcriptPreviewStageVertical" : ""}`}
            ref={stageRef}
            onClick={(event) => {
              if (selectedImageClipId && (event.target === event.currentTarget || event.target instanceof HTMLVideoElement)) {
                onImageSelect?.(null);
              }
            }}
            style={{ aspectRatio: stageAspect }}
          >
            {/* キャンバスレイヤー(表示px)。編集モード中はズームアウト表示のためクリップしない */}
            <div
              style={{
                position: "absolute",
                left: `${containedBox.offsetX}px`,
                top: `${containedBox.offsetY}px`,
                width: containedBox.width ? `${containedBox.width}px` : "100%",
                height: containedBox.height ? `${containedBox.height}px` : "100%",
                overflow: framingEditMode ? "visible" : "hidden",
              }}
            >
              <div
                style={{
                  ...(viewCropRect
                    ? {
                        position: "absolute" as const,
                        left: `${viewCropRect.left}px`,
                        top: `${viewCropRect.top}px`,
                        width: `${viewCropRect.width}px`,
                        height: `${viewCropRect.height}px`,
                        // クロップ編集中はフル映像を見せる(クロップ外はディムで表現)
                        overflow: framingEditMode === "crop" ? ("visible" as const) : ("hidden" as const),
                      }
                    : { position: "absolute" as const, inset: 0, overflow: "hidden" as const }),
                  // W26: パンチイン(交互ズーム)。フレーミング編集中は位置ズレ防止のため停止する
                  ...(punchCss && !framingEditMode
                    ? { transform: punchCss.transform, transformOrigin: punchCss.transformOrigin }
                    : {}),
                }}
              >
                <video
                  className="transcriptPreviewVideo"
                  key={videoUrl}
                  // V3: OPクリップの短い連続シークを滑らかにするため先読みを強める
                  preload="auto"
                  ref={videoRef}
                  src={videoUrl}
                  style={
                    viewCropRect && viewVideoRect
                      ? {
                          position: "absolute",
                          left: `${viewVideoRect.left - viewCropRect.left}px`,
                          top: `${viewVideoRect.top - viewCropRect.top}px`,
                          width: `${viewVideoRect.width}px`,
                          height: `${viewVideoRect.height}px`,
                          objectFit: "fill",
                        }
                      : { position: "absolute", left: 0, top: 0, width: "100%", height: "100%" }
                  }
                />
              </div>
            </div>
          </div>
        </div>
      </div>
      {/* フェーズV3: OPの映像外要素(ベタ背景・タイトル・フラッシュ)のDOM/CSS近似 */}
      {opActive && opPreview && opPhases && opView && containedBox.width > 0 && (
        <OpPreviewOverlay
          box={containedBox}
          clipIndex={opEntry?.kind === "op_clip" ? (opEntry.opClipIndex ?? null) : null}
          flashKey={opFlashKey}
          op={opPreview}
          opMs={opView.timelineMs}
          phases={opPhases}
        />
      )}
      {/* フェーズV4: 挿入画像。DOM順で映像の上・テロップの下(Remotionのレイヤー順と一致) */}
      {imageClips && imageClips.length > 0 && (
        <PreviewImageLayer
          box={containedBox}
          clips={imageClips}
          interactive={!telopPositionEditing}
          onClipsChange={onImageClipsChange}
          selectedClipId={selectedImageClipId}
          onSelect={(id) => {
            if (id) {
              // Keep the displayed image available for the entire drag, including OP stills.
              const virtual = virtualRef.current;
              if (virtual.mode === "op" && virtual.staticPlaying) {
                virtual.staticPlaying = false;
                publishPlaying(false);
              }
              videoRef.current?.pause();
            }
            onImageSelect?.(id);
          }}
          timelineMs={timelineNowMs}
        />
      )}
      {activeTelopText != null && activeTelopText !== "" && telopLayout && (
        <div
          className="previewTelopOverlay"
          style={{
            left: `${containedBox.offsetX + (displayedTelopPosition.x - 0.5) * containedBox.width}px`,
            width: containedBox.width ? `${containedBox.width}px` : "100%",
            // U1-3: telop_y指定時はRemotionと同じ「中心基準% + translateY(-50%)」で配置する。
            ...(telopYPercent !== null
              ? {
                  top: `${containedBox.offsetY + (telopYPercent / 100) * containedBox.height}px`,
                  transform: "translateY(-50%)",
                  bottom: "auto",
                }
              : { bottom: `${Math.max(8, containedBox.offsetY + 10)}px` }),
          }}
        >
          <div
            // key=スロットIDでテロップ表示開始のたびにCSSアニメを再発火する(U1-6)
            key={activeSlotKey ?? "static"}
            className={telopPositionEditing && telopPositionEditable ? "previewTelopPositionHandle" : blockAnimationIn ? `previewTelopAnimated previewTelopAnim-${blockAnimationIn}` : undefined}
            onPointerDown={handleTelopPositionPointerDown}
            onPointerMove={updateTelopPositionDrag}
            onPointerUp={finishTelopPositionDrag}
            onPointerCancel={cancelTelopPositionDrag}
            onLostPointerCapture={cancelTelopPositionDrag}
            // フェーズU6: テロップクリックでスタイル詳細エディタを開く。親レイヤーは
            // pointer-events:noneのため、この要素だけクリック可能にする(動画操作を妨げない)。
            // V3: OPクリップテロップはシーン由来ではないためクリック編集を無効にする。
            onClick={
              onTelopClick && !opActive && !telopPositionEditing
                ? (event) => {
                    event.stopPropagation();
                    onTelopClick();
                  }
                : undefined
            }
            style={{
              ...animationVars,
              ...(telopPositionEditing && telopPositionEditable ? { pointerEvents: "auto" as const, cursor: "move" } : onTelopClick && !opActive ? { pointerEvents: "auto" as const, cursor: "pointer" } : {}),
            }}
            title={telopPositionEditing ? "上下左右にドラッグして移動（Escで取消）" : onTelopClick && !opActive ? "クリックでテロップデザインを編集" : undefined}
          >
            <TelopStyledText
              lines={telopLayout.lineTexts}
              style={effectiveTelopStyle}
              fontSizePx={telopDisplayFontPx}
              highlightWords={activeHighlightWords}
              compositionFontSizePx={telopLayout.fontSize}
              layoutScale={displayScale}
              typewriterDurationMs={
                typewriterActive ? Math.max(1, activeAnimationDurationMs ?? 400) : null
              }
            />
          </div>
        </div>
      )}
      {!opActive && overlayItems && overlayItems.length > 0 && overlayScale > 0 && (
        <div
          className="previewOverlayLayer"
          style={{
            position: "absolute",
            left: `${containedBox.offsetX}px`,
            top: `${containedBox.offsetY}px`,
            width: `${containedBox.width}px`,
            height: `${containedBox.height}px`,
            overflow: "hidden",
            pointerEvents: "none",
          }}
        >
          <PreviewOverlays
            items={overlayItems}
            scale={overlayScale}
            styles={overlayStyles}
            onItemClick={onOverlayClick}
          />
        </div>
      )}
      {/* フェーズW9: フレーミング編集レイヤー(編集モード中のみ)。pointer-events はこのレイヤーへ
          集約し、テロップクリック等と干渉しない(下層レイヤーは pointer-events: none のまま)。 */}
      {framingEditMode && framingEditable && viewCropRect && viewVideoRect && (
        <div
          className="previewFramingEditLayer"
          style={{
            position: "absolute",
            left: `${containedBox.offsetX}px`,
            top: `${containedBox.offsetY}px`,
            width: `${containedBox.width}px`,
            height: `${containedBox.height}px`,
          }}
        >
          {framingEditMode === "transform" && (
            <>
              {/* 本体ドラッグ=中心オフセット(x/y)移動。レイヤー全面で受ける */}
              <div
                className="previewFramingMoveSurface"
                onPointerDown={(event) => handleFramingPointerDown(event, "move")}
                onPointerMove={handleFramingPointerMove}
                onPointerUp={handleFramingPointerUp}
              />
              {/* W13-7: 画角外ディム(キャンバス外にはみ出した映像は書き出しに残らないことを示す) */}
              {viewCanvasRect &&
                framingCropDimRects(
                  { left: 0, top: 0, width: containedBox.width, height: containedBox.height },
                  viewCanvasRect,
                ).map((rect, index) => (
                  <div
                    key={`canvasDim-${index}`}
                    className="previewFramingDim"
                    style={{
                      left: `${rect.left}px`,
                      top: `${rect.top}px`,
                      width: `${rect.width}px`,
                      height: `${rect.height}px`,
                    }}
                  />
                ))}
              {/* 有効映像(cropRect)外周の枠+四隅ハンドル(中心固定scale) */}
              <div
                className="previewFramingFrame"
                style={{
                  left: `${viewCropRect.left}px`,
                  top: `${viewCropRect.top}px`,
                  width: `${viewCropRect.width}px`,
                  height: `${viewCropRect.height}px`,
                }}
              >
                {TRANSFORM_CORNERS.map(({ corner, cursor }) => (
                  <div
                    key={corner}
                    className={`previewFramingHandle previewFramingHandle-${corner}`}
                    onPointerDown={(event) => handleFramingPointerDown(event, "scale", corner)}
                    onPointerMove={handleFramingPointerMove}
                    onPointerUp={handleFramingPointerUp}
                    style={{ cursor }}
                  />
                ))}
              </div>
            </>
          )}
          {framingEditMode === "crop" && (
            <>
              {/* フル映像(videoRect)の輪郭 */}
              <div
                className="previewFramingVideoOutline"
                style={{
                  left: `${viewVideoRect.left}px`,
                  top: `${viewVideoRect.top}px`,
                  width: `${viewVideoRect.width}px`,
                  height: `${viewVideoRect.height}px`,
                }}
              />
              {/* クロップ外の半透明ディム(上下左右の4矩形) */}
              {framingCropDimRects(viewVideoRect, viewCropRect).map((rect, index) => (
                <div
                  key={index}
                  className="previewFramingDim"
                  style={{
                    left: `${rect.left}px`,
                    top: `${rect.top}px`,
                    width: `${rect.width}px`,
                    height: `${rect.height}px`,
                  }}
                />
              ))}
              {/* クロップ枠+辺4/隅4ハンドル */}
              <div
                className="previewFramingFrame previewFramingFrameCrop"
                style={{
                  left: `${viewCropRect.left}px`,
                  top: `${viewCropRect.top}px`,
                  width: `${viewCropRect.width}px`,
                  height: `${viewCropRect.height}px`,
                }}
              >
                {CROP_HANDLES.map(({ handle, cursor }) => (
                  <div
                    key={handle}
                    className={`previewFramingHandle previewFramingHandle-${handle}`}
                    onPointerDown={(event) => handleFramingPointerDown(event, "crop", undefined, handle)}
                    onPointerMove={handleFramingPointerMove}
                    onPointerUp={handleFramingPointerUp}
                    style={{ cursor }}
                  />
                ))}
              </div>
            </>
          )}
          {/* W13-7: 画角(キャンバス)枠線。scale>1・オフセットではみ出しても書き出し範囲が分かる */}
          {viewCanvasRect && (
            <div
              className="previewFramingCanvasOutline"
              style={{
                left: `${viewCanvasRect.left}px`,
                top: `${viewCanvasRect.top}px`,
                width: `${viewCanvasRect.width}px`,
                height: `${viewCanvasRect.height}px`,
              }}
            />
          )}
        </div>
      )}
      {/* W9: モードボタン(ステージ左下)と編集中アクション(ステージ右上)。FCP風のダークオーバーレイ */}
      {framingEditable && containedBox.width > 0 && !telopPositionEditing && (
        <div
          className="previewFramingModeButtons"
          style={{
            left: `${containedBox.offsetX + 8}px`,
            top: `${containedBox.offsetY + containedBox.height - 8}px`,
          }}
        >
          <button
            className={`previewFramingModeButton${framingEditMode === "transform" ? " isActive" : ""}`}
            disabled={opActive}
            onClick={() => { setTelopPositionEditing(false); setFramingEditMode((mode) => (mode === "transform" ? null : "transform")); }}
            title="変形(スケール・位置)"
            type="button"
          >
            <Move size={13} />
            <span>変形</span>
          </button>
          <button
            className={`previewFramingModeButton${framingEditMode === "crop" ? " isActive" : ""}`}
            disabled={opActive}
            onClick={() => { setTelopPositionEditing(false); setFramingEditMode((mode) => (mode === "crop" ? null : "crop")); }}
            title="クロップ(切り抜き)"
            type="button"
          >
            <Crop size={13} />
            <span>クロップ</span>
          </button>
        </div>
      )}
      {framingEditMode && framingEditable && (
        <div
          className="previewFramingEditActions"
          style={{
            left: `${containedBox.offsetX + containedBox.width - 8}px`,
            top: `${containedBox.offsetY + 8}px`,
          }}
        >
          <button
            className="previewFramingModeButton"
            onClick={() => onVideoFramingChangeRef.current?.(IDENTITY_VIDEO_FRAMING, true)}
            title="フレーミングを初期状態に戻す"
            type="button"
          >
            <RotateCcw size={13} />
            <span>リセット</span>
          </button>
          <button
            className="previewFramingModeButton isPrimary"
            onClick={() => setFramingEditMode(null)}
            title="編集を終了"
            type="button"
          >
            <Check size={13} />
            <span>完了</span>
          </button>
        </div>
      )}
      </div>
      </div>
      {/* フェーズW9: カスタムトランスポートバー(ネイティブcontrolsの代替)。
          シークバーはタイムラインms基準(OP込み。composition未生成runは元動画ms)。
          V6-3の方針どおり映像矩形の上には重ねず、映像の下の帯に置く。 */}
      <div className={`previewTransportBar${onPlaybackRateChange ? " previewTransportBarWithRate" : ""}`}>
        <button
          className="previewTransportButton"
          onClick={handleTransportToggle}
          title={transportPlaying ? "一時停止" : "再生"}
          type="button"
        >
          {transportPlaying ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <span className="previewTransportTime" title={opPreview ? "OP込みの書き出し後タイムライン時刻" : undefined}>
          {formatTimelineMs(Math.min(transportNowMs, transportTotalMs || transportNowMs))} /{" "}
          {formatTimelineMs(transportTotalMs)}
        </span>
        <input
          aria-label="再生位置"
          className="previewTransportSeek"
          max={Math.max(1, transportTotalMs)}
          min={0}
          onChange={(event) => handleTransportSeek(Number(event.target.value))}
          step={1}
          type="range"
          value={Math.min(transportNowMs, Math.max(1, transportTotalMs))}
        />
        {onPlaybackRateChange && (
          <label className="previewTransportRate" title="プレビューの再生速度。書き出す動画の速度は変わりません">
            <span>速度</span>
            <select aria-label="プレビューの再生速度" value={playbackRate} onChange={(event) => onPlaybackRateChange(Number(event.target.value))}>
              {PLAYBACK_RATES.map((rate) => <option key={rate} value={rate}>{rate}×</option>)}
            </select>
          </label>
        )}
        <button
          className="previewTransportButton"
          onClick={() => setTransportMuted((muted) => !muted)}
          title={transportMuted ? "ミュート解除" : "ミュート"}
          type="button"
        >
          {transportMuted || transportVolume <= 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
        </button>
        <input
          aria-label="プレビュー音量"
          className="previewTransportVolume"
          max={1}
          min={0}
          onChange={(event) => {
            setTransportVolume(Number(event.target.value));
            if (Number(event.target.value) > 0) setTransportMuted(false);
          }}
          step={0.01}
          type="range"
          value={transportMuted ? 0 : transportVolume}
        />
      </div>
      {onTelopPositionChange && <TelopPositionControls
        key={telopSlotKey ?? "no-telop"} position={displayedTelopPosition} manual={Boolean(manualTelopPosition)}
        editing={telopPositionEditing} disabled={!telopPositionEditable}
        onEditingChange={(editing) => { setTelopPositionEditing(editing); if (editing) { pausePreviewAudio(); videoRef.current?.pause(); setFramingEditMode(null); onImageSelect?.(null); } }}
        onChange={commitTelopPosition} onApplyAll={onAllTelopPositionsChange}
      />}
    </div>
  );
});
