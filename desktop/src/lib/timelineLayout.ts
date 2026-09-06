// フェーズV1(統合タイムラインView): 横軸=出力タイムライン(書き出し後)基準の座標計算。
// ms⇔px換算・ズーム・ルーラー目盛り・シーン→ブロック写像・OPブロック展開を純関数に集約し、
// UIコンポーネント(components/timeline/)は描画とポインタイベントだけを担当する。
//
// 実行時(値)importのため、node --experimental-strip-types でテストを直接実行できるよう拡張子を明示する。
import { timelineMsToSourceMs, type TimelineCutRange } from "./previewTimeline.ts";

/** ズームの上限(px/ms)。100px=1秒まで拡大できれば十分細かい。 */
export const TIMELINE_MAX_PX_PER_MS = 0.1;
/** ズームの絶対下限(px/ms)。フィット値がこれより小さい場合はフィット値を優先する。 */
export const TIMELINE_MIN_PX_PER_MS = 0.001;

/**
 * タイムライン総尺(ms)の解決。composition の total_duration_ms を正とし、
 * 未生成(0)の場合はカット対応表・BGMクリップ末尾から推定する(表示を崩さないための保険)。
 */
export function resolveTimelineTotalMs(
  timelineDurationMs: number,
  ranges: TimelineCutRange[],
  bgmClipEndsMs: number[] = [],
): number {
  const candidates = [
    timelineDurationMs,
    ...ranges.map((range) => range.timelineEndMs),
    ...bgmClipEndsMs,
  ].filter((value) => Number.isFinite(value) && value > 0);
  return candidates.length > 0 ? Math.max(...candidates) : 60000;
}

/** 「全体が見える」初期倍率(px/ms)。ビューポート幅に総尺がちょうど収まる値。 */
export function fitPxPerMs(totalMs: number, viewportPx: number): number {
  if (totalMs <= 0 || viewportPx <= 0) return TIMELINE_MIN_PX_PER_MS;
  return viewportPx / totalMs;
}

/** ズーム倍率のクランプ。下限=フィット(全体表示より縮小しない)、上限=TIMELINE_MAX_PX_PER_MS。 */
export function clampPxPerMs(pxPerMs: number, totalMs: number, viewportPx: number): number {
  const fit = fitPxPerMs(totalMs, viewportPx);
  const min = Math.min(fit, TIMELINE_MAX_PX_PER_MS);
  return Math.max(min, Math.min(TIMELINE_MAX_PX_PER_MS, pxPerMs));
}

// ---------------------------------------------------------------------------
// フェーズV6-1: フィット基準のズーム係数(zoom factor)
//
// V1〜V5は絶対値(px/ms)でズーム状態を持っていたが、フィット値(=下限)がビューポート幅・
// 総尺の変化で動くため「フィットまで戻れない/戻った瞬間に跳ぶ」不具合の温床だった。
// V6からは「フィット=1.0」を基準にした相対係数でズーム状態を持ち、px/msは毎回
// fit×係数で導出する。これで下限(=1.0)が常に安定し、ズームアウトで確実に全体表示へ戻れる。
// ---------------------------------------------------------------------------

/**
 * どの総尺でもフィットから最低この倍率までは拡大できる。
 * 短い動画(例: 4秒)はフィット時点で TIMELINE_MAX_PX_PER_MS を超えるため、
 * 絶対上限だけだとズーム可能範囲が1倍=ゼロになり「ピンチもスライダーも効かない」状態になる。
 */
export const MIN_ZOOM_RANGE_FACTOR = 8;

/** ズーム係数の上限。フィット(=1.0)から TIMELINE_MAX_PX_PER_MS まで、最低でも8倍まで拡大できる倍率。 */
export function maxZoomFactor(totalMs: number, viewportPx: number): number {
  const fit = fitPxPerMs(totalMs, viewportPx);
  if (fit <= 0) return MIN_ZOOM_RANGE_FACTOR;
  return Math.max(MIN_ZOOM_RANGE_FACTOR, TIMELINE_MAX_PX_PER_MS / fit);
}

/** ズーム係数のクランプ。下限=1.0(全体フィット)、上限=maxZoomFactor。 */
export function clampZoomFactor(factor: number, totalMs: number, viewportPx: number): number {
  if (!Number.isFinite(factor)) return 1;
  return Math.max(1, Math.min(maxZoomFactor(totalMs, viewportPx), factor));
}

/** ズーム係数→表示倍率(px/ms)。係数1.0=フィット(総尺がビューポートにちょうど収まる)。 */
export function zoomFactorToPxPerMs(factor: number, totalMs: number, viewportPx: number): number {
  return fitPxPerMs(totalMs, viewportPx) * clampZoomFactor(factor, totalMs, viewportPx);
}

/**
 * ズーム係数→スライダー位置(0〜100)。低倍率側の操作感を確保するため対数マッピング。
 * 上限係数が1(=拡大余地なし)の場合は常に0。
 */
export function zoomSliderRatio(factor: number, maxFactor: number): number {
  if (maxFactor <= 1) return 0;
  const clamped = Math.max(1, Math.min(maxFactor, factor));
  return Math.max(0, Math.min(100, (Math.log(clamped) / Math.log(maxFactor)) * 100));
}

/** スライダー位置(0〜100)→ズーム係数(対数マッピングの逆変換)。 */
export function zoomFactorForSliderRatio(ratio: number, maxFactor: number): number {
  if (maxFactor <= 1) return 1;
  const clamped = Math.max(0, Math.min(100, ratio));
  return Math.pow(maxFactor, clamped / 100);
}

/**
 * ズーム変更後のscrollLeft。カーソル直下のタイムラインmsが変わらないように追従させる
 * (⌘スクロールでのズームが「見ていた場所」を保つため)。
 */
export function zoomedScrollLeft(
  cursorXInViewport: number,
  scrollLeft: number,
  oldPxPerMs: number,
  newPxPerMs: number,
): number {
  if (oldPxPerMs <= 0) return 0;
  const msAtCursor = (scrollLeft + cursorXInViewport) / oldPxPerMs;
  return Math.max(0, msAtCursor * newPxPerMs - cursorXInViewport);
}

export type RulerTick = {
  ms: number;
  /** true=ラベル付きの主目盛り。false=補助目盛り。 */
  major: boolean;
};

/** 主目盛り間隔の候補(ms)。mm:ss表示が切りの良い値になるものだけ。 */
const MAJOR_TICK_CANDIDATES_MS = [
  1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 1200000,
];

/**
 * ルーラー目盛り。主目盛り(ラベル付き)の間隔がminMajorPx以上になる最小の候補を選び、
 * 補助目盛りは主目盛りの1/5間隔で敷く。
 */
export function buildRulerTicks(
  totalMs: number,
  pxPerMs: number,
  minMajorPx = 72,
): { majorMs: number; ticks: RulerTick[] } {
  const majorMs =
    MAJOR_TICK_CANDIDATES_MS.find((candidate) => candidate * pxPerMs >= minMajorPx) ??
    MAJOR_TICK_CANDIDATES_MS[MAJOR_TICK_CANDIDATES_MS.length - 1];
  const minorMs = majorMs / 5;
  const ticks: RulerTick[] = [];
  if (totalMs <= 0 || pxPerMs <= 0) return { majorMs, ticks };
  for (let ms = 0; ms <= totalMs; ms += minorMs) {
    // 浮動小数の蓄積誤差を丸めてから主目盛り判定する
    const rounded = Math.round(ms);
    ticks.push({ ms: rounded, major: rounded % majorMs === 0 });
  }
  return { majorMs, ticks };
}

/** mm:ss 表示(ルーラーラベル・時間表示用)。 */
export function formatTimelineMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** シーン1件をタイムライン軸上のブロックに写像した結果。 */
export type SceneTimelineBlock = {
  sceneId: string;
  /** scenes配列上の並び順(0始まり。表示は+1したシーン番号)。 */
  sceneIndex: number;
  timelineStartMs: number;
  timelineEndMs: number;
  telopText: string;
  /** サムネ選択用: シーンの元動画上の先頭ms。 */
  sourceStartMs: number;
  speed: number;
};

type SceneLike = {
  id: string;
  sourceStartMs: number;
  sourceEndMs: number;
  telopText: string;
  /** V6-2: 単語のdeleted状態。全単語deletedのシーンはブロックを作らない(タイムライン即時連動)。 */
  words?: Array<{ deleted: boolean }>;
  speed?: number;
};

/**
 * scenes(元動画ms基準)→タイムラインブロック。
 * シーンの元動画区間と重なるカット対応表(TimelineCutRange)を集め、写像後の最小開始〜最大終了を
 * ブロック区間にする。編集適用前にシーンを分割/結合していても、旧compositionの対応表の範囲内で
 * 近似表示できる。どのカットとも重ならない(全カット済み等)シーンはブロックを作らない。
 * V6-2: 全単語がdeletedのシーン(タイムライン/検品でのシーン削除済み)は、編集適用前でも
 * ブロックを消す(カット対応表はcomposition由来で古いままのため、シーン側の状態で判定する)。
 */
export function sceneTimelineBlocks(scenes: SceneLike[], ranges: TimelineCutRange[]): SceneTimelineBlock[] {
  const blocks: SceneTimelineBlock[] = [];
  scenes.forEach((scene, sceneIndex) => {
    if (scene.words && scene.words.length > 0 && scene.words.every((word) => word.deleted)) return;
    let startMs = Infinity;
    let endMs = -Infinity;
    for (const range of ranges) {
      const overlapStart = Math.max(scene.sourceStartMs, range.sourceStartMs);
      const overlapEnd = Math.min(scene.sourceEndMs, range.sourceEndMs);
      if (overlapEnd <= overlapStart) continue;
      const speed = range.speed || 1;
      startMs = Math.min(startMs, range.timelineStartMs + (overlapStart - range.sourceStartMs) / speed);
      endMs = Math.max(endMs, range.timelineStartMs + (overlapEnd - range.sourceStartMs) / speed);
    }
    if (!Number.isFinite(startMs) || endMs <= startMs) return;
    blocks.push({
      sceneId: scene.id,
      sceneIndex,
      timelineStartMs: Math.round(startMs),
      timelineEndMs: Math.round(endMs),
      telopText: scene.telopText,
      sourceStartMs: scene.sourceStartMs,
      speed: scene.speed || 1,
    });
  });
  return blocks;
}

/**
 * タイムライン上のクリック位置(ms)→プレビューのシーク先(元動画ms)。
 * カット区間内なら正確に写像し、区間外(OP区間・末尾余白など)は最も近いカットの端へ丸める
 * (プレビューはOPを再生できないため、OPクリック=本編先頭へ寄せるのが自然)。
 */
export function seekSourceMsForTimelineMs(ranges: TimelineCutRange[], timelineMs: number): number | null {
  const exact = timelineMsToSourceMs(ranges, timelineMs);
  if (exact !== null) return exact;
  if (ranges.length === 0) return null;
  let best: { distance: number; sourceMs: number } | null = null;
  for (const range of ranges) {
    const candidates =
      timelineMs < range.timelineStartMs
        ? { distance: range.timelineStartMs - timelineMs, sourceMs: range.sourceStartMs }
        : { distance: timelineMs - range.timelineEndMs, sourceMs: Math.max(range.sourceStartMs, range.sourceEndMs - 1) };
    if (!best || candidates.distance < best.distance) best = candidates;
  }
  return best ? best.sourceMs : null;
}

/** フィルムストリップのフレーム(元動画ms+URL)から、指定msに最も近い1枚を選ぶ。 */
export function nearestFilmstripFrame<T extends { ms: number }>(frames: T[], targetMs: number): T | null {
  let best: T | null = null;
  let bestDistance = Infinity;
  for (const frame of frames) {
    const distance = Math.abs(frame.ms - targetMs);
    if (distance < bestDistance) {
      best = frame;
      bestDistance = distance;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// OPブロック(映像トラック先頭の紫系グループブロック)
// ---------------------------------------------------------------------------

/** タイムラインView表示用のOP情報(remotion opTimeline.ts の OpData の表示用サブセット)。 */
export type TimelineOpInfo = {
  pattern: "title_card" | "highlight_teaser" | "question_hook";
  durationMs: number;
  title: string;
  /** グループ内部のサブブロック(タイムラインms基準。OP先頭=0)。 */
  clips: Array<{ label: string; startMs: number; endMs: number }>;
};

const OP_PATTERN_LABELS: Record<TimelineOpInfo["pattern"], string> = {
  title_card: "タイトル",
  highlight_teaser: "ダイジェスト",
  question_hook: "問いかけ",
};

/**
 * composition timeline.op(未検証JSON)→タイムラインView用のOP情報。
 * highlight_teaser はクリップの実尺比で [0, durationMs) を分割してサブブロック化
 * (step08はクリップ合計=OP尺で組むが、手編集compositionでも比率で崩れないようスケールする)。
 * title_card / question_hook は1ブロック。op無し・不正は null(=OPブロックなし)。
 */
export function normalizeTimelineOp(raw: unknown): TimelineOpInfo | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const pattern = source.pattern;
  if (pattern !== "title_card" && pattern !== "highlight_teaser" && pattern !== "question_hook") return null;
  const durationMs = Number(source.duration_ms);
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  const title = typeof source.title === "string" ? source.title : "";

  if (pattern === "highlight_teaser") {
    const rawClips = Array.isArray(source.highlight_cuts) ? source.highlight_cuts : [];
    const lengths: number[] = [];
    for (const entry of rawClips as Array<Record<string, unknown>>) {
      if (!entry || typeof entry !== "object") continue;
      const startMs = Number(entry.start_ms);
      const endMs = Number(entry.end_ms);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
      lengths.push(endMs - startMs);
    }
    if (lengths.length === 0) return null;
    const totalLength = lengths.reduce((sum, value) => sum + value, 0);
    const scale = totalLength > 0 ? durationMs / totalLength : 0;
    const clips: TimelineOpInfo["clips"] = [];
    let cursor = 0;
    lengths.forEach((length, index) => {
      const startMs = Math.round(cursor);
      cursor += length * scale;
      const endMs = index === lengths.length - 1 ? durationMs : Math.round(cursor);
      clips.push({ label: `OP${index + 1}`, startMs, endMs });
    });
    return { pattern, durationMs, title, clips };
  }

  return {
    pattern,
    durationMs,
    title,
    clips: [{ label: OP_PATTERN_LABELS[pattern], startMs: 0, endMs: durationMs }],
  };
}
