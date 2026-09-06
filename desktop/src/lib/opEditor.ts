// フェーズV2: OP編集(runs/<run>/op_config.json)のUI側純関数。
// 正規化規則は main/index.cjs の sanitizeRunOpConfig / python shared/opening.py の
// _normalize_op_clips と同一に保つ(mainが最終防衛線だが、UIでも同じ既定へ落として
// 表示と保存値のズレを防ぐ)。node --test で直接検証できるようReact非依存で置く。
import { sanitizeOpConfig, type OpConfig } from "./designExtras.ts";
import type { Scene } from "./scenes.ts";
import { normalizeTimelineOp, type TimelineOpInfo } from "./timelineLayout.ts";

/** OPクリップ1件。start_ms/end_ms は元動画の絶対ms(カット編集後もpythonが中点で再解決する)。 */
export type OpClip = {
  cut_id: string;
  start_ms: number;
  end_ms: number;
  text: string;
  style: string;
  /** フェーズW: テロップ表示方法(hook=フックワード大 / verbatim=発話テロップ)。 */
  display: "hook" | "verbatim";
  /** フェーズW: フックワード(最大2行。\nで上下2段)。 */
  hook_text: string;
  /** フェーズW: フックワード内の核心語(空=色分けなし)。 */
  keyword: string;
  /** フェーズW: 核心語の色。 */
  keyword_color: "yellow" | "red" | "white";
};

/** display(未検証値)の正規化(opTimeline.normalizeOpClipDisplayと同じ規則)。 */
function sanitizeClipDisplay(raw: unknown, hookText: string): OpClip["display"] {
  if (raw === "hook" || raw === "verbatim") {
    return raw === "hook" && !hookText ? "verbatim" : raw;
  }
  return hookText ? "hook" : "verbatim";
}

function sanitizeKeywordColor(raw: unknown): OpClip["keyword_color"] {
  return raw === "red" || raw === "white" ? raw : "yellow";
}

/** run単位のOP設定。clips=null はAI自動選定(select_highlight_clips)。 */
export type RunOpConfig = OpConfig & {
  clips: OpClip[] | null;
};

// python shared/opening.py の USER_CLIP_MIN_MS / USER_CLIP_MAX_MS と同期
export const OP_CLIP_MIN_MS = 400;
export const OP_CLIP_MAX_MS = 4000;
/** シーンピッカーから追加するクリップの既定尺(自動選定の上限2秒と揃える)。 */
export const OP_CLIP_DEFAULT_MS = 2000;

/** クリップ配列の正規化(不正エントリは捨て、有効0件は null=AI自動選定)。 */
export function sanitizeOpClips(raw: unknown): OpClip[] | null {
  if (!Array.isArray(raw)) return null;
  const clips: OpClip[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const source = entry as Record<string, unknown>;
    const startMs = Math.round(Number(source.start_ms));
    const endMs = Math.round(Number(source.end_ms));
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    const hookText = typeof source.hook_text === "string" ? source.hook_text.trim() : "";
    clips.push({
      cut_id: typeof source.cut_id === "string" ? source.cut_id : "",
      start_ms: startMs,
      end_ms: endMs,
      text: typeof source.text === "string" ? source.text.trim() : "",
      style: typeof source.style === "string" ? source.style.trim() : "",
      display: sanitizeClipDisplay(source.display, hookText),
      hook_text: hookText,
      keyword: typeof source.keyword === "string" ? source.keyword.trim() : "",
      keyword_color: sanitizeKeywordColor(source.keyword_color),
    });
  }
  return clips.length ? clips : null;
}

/** IPC op-config:get/save の生JSONを RunOpConfig へ正規化する。 */
export function sanitizeRunOpConfig(raw: unknown): RunOpConfig {
  return {
    ...sanitizeOpConfig(raw),
    clips: raw && typeof raw === "object" ? sanitizeOpClips((raw as Record<string, unknown>).clips) : null,
  };
}

/**
 * composition timeline.op(未検証JSON)からAI選定済みクリップを復元する。
 * step08(V2以降)は highlight_cuts の各要素へ cut_id / source_start_ms / source_end_ms /
 * text / style を出力するため、それをそのままOP編集の初期表示(clips=null時)に使う。
 * V2以前のcomposition(source_*なし)は復元できないため空配列(=一覧なしから編集開始)。
 */
export function opClipsFromTimelineOp(raw: unknown): OpClip[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const source = raw as Record<string, unknown>;
  if (source.pattern !== "highlight_teaser" || !Array.isArray(source.highlight_cuts)) return [];
  const clips: OpClip[] = [];
  for (const entry of source.highlight_cuts as Array<Record<string, unknown>>) {
    if (!entry || typeof entry !== "object") continue;
    const startMs = Math.round(Number(entry.source_start_ms));
    const endMs = Math.round(Number(entry.source_end_ms));
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    const hookText = typeof entry.hook_text === "string" ? entry.hook_text : "";
    clips.push({
      cut_id: typeof entry.cut_id === "string" ? entry.cut_id : "",
      start_ms: startMs,
      end_ms: endMs,
      text: typeof entry.text === "string" ? entry.text : "",
      style: typeof entry.style === "string" ? entry.style : "",
      display: sanitizeClipDisplay(entry.display, hookText),
      hook_text: hookText,
      keyword: typeof entry.keyword === "string" ? entry.keyword : "",
      keyword_color: sanitizeKeywordColor(entry.keyword_color),
    });
  }
  return clips;
}

/**
 * シーンピッカーで選んだシーン→OPクリップ。
 * シーン先頭から既定2秒(シーンが短ければシーン全体)を切り出し、テロップ初期文言は
 * シーンのテロップ文言の1行目(スタイルは空=python側がテーマのhype系へ解決する)。
 */
export function opClipFromScene(scene: Scene): OpClip {
  const startMs = Math.round(scene.sourceStartMs);
  const endMs = Math.min(Math.round(scene.sourceEndMs), startMs + OP_CLIP_DEFAULT_MS);
  return {
    cut_id: scene.id,
    start_ms: startMs,
    end_ms: Math.max(endMs, startMs + 1),
    text: (scene.telopText || "").split("\n")[0].trim(),
    style: "",
    // 手動追加クリップの初期表示は発話テロップ(フックワードはユーザーが入力したら切替)
    display: "verbatim",
    hook_text: "",
    keyword: "",
    keyword_color: "yellow",
  };
}

/** クリップの並び替え(範囲外は無変更の同一配列を返す)。 */
export function moveOpClip(clips: OpClip[], index: number, direction: -1 | 1): OpClip[] {
  const target = index + direction;
  if (index < 0 || index >= clips.length || target < 0 || target >= clips.length) return clips;
  const next = clips.slice();
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** クリップの中点(元動画ms)。サムネ選択・シーン対応付けに使う。 */
export function opClipMidpointMs(clip: OpClip): number {
  return Math.round((clip.start_ms + clip.end_ms) / 2);
}

/** クリップが属するシーンの1始まり番号(どのシーンにも属さなければ null)。 */
export function sceneNumberForOpClip(scenes: Scene[], clip: OpClip): number | null {
  const midpoint = opClipMidpointMs(clip);
  const index = scenes.findIndex(
    (scene) => scene.sourceStartMs <= midpoint && midpoint < scene.sourceEndMs,
  );
  return index >= 0 ? index + 1 : null;
}

/** クリップ尺の表示ラベル(例: 1.5秒)。 */
export function opClipDurationLabel(clip: OpClip): string {
  return `${((clip.end_ms - clip.start_ms) / 1000).toFixed(1)}秒`;
}

/** V8-2: OP合計尺の表示ラベル(例: 4.5秒)。OPサマリカードの見出しに使う。 */
export function opDurationLabel(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}秒`;
}

/**
 * V8-2: プレビュークリップ(元動画絶対ms)の中点が属するシーンの1始まり番号。
 * OPサマリカードが「元シーン番号+文言」の一覧表示に使う(なければ null)。
 */
export function sceneNumberForOpPreviewClip(
  scenes: Scene[],
  clip: { sourceStartMs: number; sourceEndMs: number },
): number | null {
  const midpoint = Math.round((clip.sourceStartMs + clip.sourceEndMs) / 2);
  const index = scenes.findIndex(
    (scene) => scene.sourceStartMs <= midpoint && midpoint < scene.sourceEndMs,
  );
  return index >= 0 ? index + 1 : null;
}

// ---------------------------------------------------------------------------
// フェーズW6: シーン検品先頭のOP行(OpClipRows)用の純関数
// ---------------------------------------------------------------------------

/** 各クリップのタイムライン開始オフセット(ms)。OP先頭=0、クリップは前詰めで連続する。 */
export function opClipTimelineOffsets(clips: OpClip[]): number[] {
  const offsets: number[] = [];
  let cursor = 0;
  for (const clip of clips) {
    offsets.push(cursor);
    cursor += Math.max(0, clip.end_ms - clip.start_ms);
  }
  return offsets;
}

export type OpClipTrimBounds = { minMs: number; maxMs: number };

/**
 * クリップの端ドラッグで動ける範囲。python(resolve_user_clips)がクリップ中点の属する
 * keep_segment内へクランプするため、UIでも「中点が属するシーン」の範囲へ制限して
 * 保存値と表示のズレを防ぐ。どのシーンにも属さなければ動画全体へフォールバックする。
 */
export function opClipTrimBounds(
  scenes: Scene[],
  clip: OpClip,
  videoDurationMs: number,
): OpClipTrimBounds {
  const midpoint = opClipMidpointMs(clip);
  const scene = scenes.find((item) => item.sourceStartMs <= midpoint && midpoint < item.sourceEndMs);
  if (scene) return { minMs: Math.round(scene.sourceStartMs), maxMs: Math.round(scene.sourceEndMs) };
  return { minMs: 0, maxMs: Math.max(1, Math.round(videoDurationMs)) };
}

/**
 * クリップの端ドラッグ(rawTargetMs=元動画の生ポインタ位置)を適用した新しいクリップ配列を返す。
 * 尺は USER_CLIP_MIN_MS〜USER_CLIP_MAX_MS(python resolve_user_clips と同じ400〜4000ms)、
 * 位置は bounds(中点が属するシーン)へクランプする。対象外indexは同一配列を返す。
 */
export function trimOpClipEdge(
  clips: OpClip[],
  index: number,
  edge: "start" | "end",
  rawTargetMs: number,
  bounds: OpClipTrimBounds,
): OpClip[] {
  const clip = clips[index];
  if (!clip) return clips;
  const raw = Math.round(rawTargetMs);
  let startMs = clip.start_ms;
  let endMs = clip.end_ms;
  if (edge === "start") {
    const min = Math.max(bounds.minMs, endMs - OP_CLIP_MAX_MS);
    const max = endMs - OP_CLIP_MIN_MS;
    startMs = Math.max(min, Math.min(max, raw));
  } else {
    const min = startMs + OP_CLIP_MIN_MS;
    const max = Math.min(bounds.maxMs, startMs + OP_CLIP_MAX_MS);
    endMs = Math.max(min, Math.min(max, raw));
  }
  if (endMs <= startMs) return clips;
  if (startMs === clip.start_ms && endMs === clip.end_ms) return clips;
  return clips.map((item, i) => (i === index ? { ...item, start_ms: startMs, end_ms: endMs } : item));
}

/**
 * プレビューの現在タイムラインms(OP先頭=0)が index 番目のクリップ内にあるとき、
 * そのクリップ内の元動画ms(波形ストリップの再生バー位置)を返す。範囲外は null。
 */
export function opClipPlayheadMs(
  clips: OpClip[],
  index: number,
  previewTimelineMs: number | null | undefined,
): number | null {
  if (previewTimelineMs == null) return null;
  const clip = clips[index];
  if (!clip) return null;
  const offsets = opClipTimelineOffsets(clips);
  const offset = offsets[index];
  const length = clip.end_ms - clip.start_ms;
  if (previewTimelineMs < offset || previewTimelineMs >= offset + length) return null;
  return clip.start_ms + (previewTimelineMs - offset);
}

/**
 * run単位OP設定→タイムラインViewのOPブロック表示。
 * 適用(step08再実行)前でも編集結果のクリップ数・尺をタイムラインへ反映するために使う。
 * 明示クリップ(clips指定)のある highlight_teaser のみ上書きし、それ以外
 * (AI自動選定・他パターン・OPなし)は null=composition timeline.op の表示に任せる
 * (自動選定の結果はstep08を通さないと確定しないため)。
 */
export function timelineOpInfoFromRunOpConfig(config: RunOpConfig | null): TimelineOpInfo | null {
  if (!config || config.pattern !== "highlight_teaser" || !config.clips || config.clips.length === 0) {
    return null;
  }
  const clips: TimelineOpInfo["clips"] = [];
  let cursor = 0;
  config.clips.forEach((clip, index) => {
    const length = clip.end_ms - clip.start_ms;
    clips.push({ label: `OP${index + 1}`, startMs: cursor, endMs: cursor + length });
    cursor += length;
  });
  return { pattern: "highlight_teaser", durationMs: cursor, title: config.title, clips };
}

/**
 * フェーズV5-1: タイムラインViewが表示すべきOP情報(run正本を表示の正とする)。
 * - run正本 pattern=none: OPブロックなし(compositionにOPが残っていても消す=編集の即時反映)
 * - 明示クリップあり: run正本のクリップ数・尺でブロックを組む
 * - それ以外(AI自動選定・run正本なし): composition timeline.op の表示に任せる
 */
export function effectiveTimelineOpInfo(
  config: RunOpConfig | null,
  timelineOp: unknown,
): TimelineOpInfo | null {
  if (config && config.pattern === "none") return null;
  return timelineOpInfoFromRunOpConfig(config) ?? normalizeTimelineOp(timelineOp);
}
