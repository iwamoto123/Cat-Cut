// フェーズV3(OPのプレビュー再生): 仮想プレイリスト。
//
// プレビューは元動画1本の<video>をシークで擬似カット再生しているため、
// OP(タイムライン先頭 [0, op.duration_ms))を再生するには「どの瞬間に元動画のどこを
// 見せるか(あるいは映像なしのベタ背景を見せるか)」の再生順序が必要になる。
// それを [OPエントリ列] + [本編エントリ列(=TimelineCutRange)] の配列に一般化し、
// タイムラインms ⇔ (エントリ+エントリ内オフセット) の写像を純関数で提供する。
//
// エントリ種別:
//   op_clip   : highlight_teaser の抜粋クリップ。同じ元動画の区間なので<video>シークで再生できる
//   op_static : title_card / question_hook。映像不要(ベタ背景+DOMテキスト)のため実時間タイマーで
//               進める。<video>は次エントリ先頭へ先読みシークしておく(sourceStart/End=0で映像なしを表す)
//   main      : 本編カット(TimelineCutRange 1件と同値)
//
// 本編部分の実再生スキップは従来どおり「編集中の生きたkeep_segments」が正
// (適用前のシーン編集を即時反映するため)。mainエントリは写像・シーク先解決・総尺計算に使う。
//
// 実行時(値)importのため、node --experimental-strip-types でテストを直接実行できるよう拡張子を明示する。
import {
  normalizeOpClipDisplay,
  normalizeOpData,
  normalizeOpDecoration,
  normalizeOpHookKeywordColor,
  normalizeOpTextAnimation,
  opClipTransitionFrames,
  opQuestionHookPhases,
  opTeaserTitleFrame,
  opTitleCardPhases,
  DEFAULT_OP_ACCENT_COLOR,
  DEFAULT_OP_DECORATION,
  DEFAULT_OP_TEXT_ANIMATION,
  type OpClipDisplay,
  type OpDecoration,
  type OpHookKeywordColor,
  type OpPattern,
  type OpTextAnimation,
} from "./opTimeline.ts";
import type { TimelineCutRange } from "./previewTimeline.ts";

/** compositionにOPが無いrunでrun正本のみからteaserを組む場合のキメ音(op_patterns.yamlの既定)。 */
const TEASER_DEFAULT_SFX_HIT = "don";

// ---------------------------------------------------------------------------
// OPプレビューデータ(元動画msベース)の解決
// ---------------------------------------------------------------------------

/** OP(highlight_teaser)クリップ1件。プレビューは元動画をシークするため絶対msで持つ。 */
export type OpPreviewClip = {
  /** 元動画の絶対ms。 */
  sourceStartMs: number;
  sourceEndMs: number;
  /** クリップ中に横スライドで出すテロップ文言(空=テロップなし)。 */
  text: string;
  /** テロップのプリセットID(timeline.telop_styles のキー。空=既定スタイル)。 */
  style: string;
  /** フェーズW: テロップ表示方法(hook=フックワード大 / verbatim=発話テロップ)。 */
  display: OpClipDisplay;
  /** フェーズW: フックワード(最大2行。\nで上下2段)。 */
  hookText: string;
  /** フェーズW: 核心語(hookText内の部分文字列。空=色分けなし)。 */
  keyword: string;
  /** フェーズW: 核心語の色。 */
  keywordColor: OpHookKeywordColor;
};

export type OpPreviewData = {
  pattern: OpPattern;
  /** OP全体の尺(ms)。teaser はクリップ実尺の合計。 */
  durationMs: number;
  title: string;
  catchCopy: string;
  accentColor: string;
  sfxHit: string | null;
  sfxTransition: string | null;
  /** highlight_teaser のみ(他パターンは空配列)。 */
  clips: OpPreviewClip[];
  /** フェーズV5: 装飾パターン(プレビューのCSS近似が分岐に使う)。 */
  decoration: OpDecoration;
  /** フェーズV5: OPテロップの登場アニメ(全クリップ共通)。 */
  textAnimation: OpTextAnimation;
};

/** op_config.json(run正本)の構造的サブセット(opEditor.ts の RunOpConfig が満たす)。 */
export type RunOpConfigLike = {
  pattern: string;
  title: string;
  catch_copy: string;
  clips: Array<{
    start_ms: number;
    end_ms: number;
    text: string;
    style: string;
    /** フェーズW: フックワード系メタ(旧op_configには無いためoptional)。 */
    display?: string;
    hook_text?: string;
    keyword?: string;
    keyword_color?: string;
  }> | null;
  /** フェーズV5: 装飾・テキストアニメ(旧op_configには無いためoptional)。 */
  decoration?: string;
  text_animation?: string;
  /** W11-5: タイトルを表示するか(false=「表示しない」)。旧op_configには無いためoptional。 */
  title_enabled?: boolean;
};

/**
 * timeline.op の highlight_cuts 1件から元動画の絶対ms区間を復元する。
 * - V2以降のcomposition: source_start_ms / source_end_ms がそのまま入っている
 * - U8世代(source_*なし): file_path が "segments/cut_NNN.mp4" を指し、start/end_ms は
 *   そのセグメントファイル内の相対ms。cut_NNN は TimelineCutRange[NNN-1] と同順
 *   (step08がstartMs昇順で採番する)ことを利用して逆算する
 */
function resolveClipSourceRange(
  entry: Record<string, unknown>,
  ranges: TimelineCutRange[],
): { sourceStartMs: number; sourceEndMs: number } | null {
  const directStart = Number(entry.source_start_ms);
  const directEnd = Number(entry.source_end_ms);
  if (Number.isFinite(directStart) && Number.isFinite(directEnd) && directEnd > directStart) {
    return { sourceStartMs: directStart, sourceEndMs: directEnd };
  }
  const filePath = typeof entry.file_path === "string" ? entry.file_path : "";
  const match = /cut_(\d+)\.[a-zA-Z0-9]+$/.exec(filePath);
  if (!match) return null;
  const range = ranges[Number(match[1]) - 1];
  if (!range) return null;
  const relStart = Number(entry.start_ms);
  const relEnd = Number(entry.end_ms);
  if (!Number.isFinite(relStart) || !Number.isFinite(relEnd) || relEnd <= relStart) return null;
  const sourceStartMs = range.sourceStartMs + Math.max(0, relStart);
  const sourceEndMs = Math.min(range.sourceEndMs, range.sourceStartMs + relEnd);
  if (sourceEndMs <= sourceStartMs) return null;
  return { sourceStartMs, sourceEndMs };
}

/** run正本の明示クリップ(元動画絶対ms)→プレビュークリップ。不正区間は捨てる。 */
function previewClipsFromConfig(
  clips: NonNullable<RunOpConfigLike["clips"]>,
): OpPreviewClip[] {
  return clips
    .filter((clip) => Number.isFinite(clip.start_ms) && Number.isFinite(clip.end_ms) && clip.end_ms > clip.start_ms)
    .map((clip) => {
      const hookText = clip.hook_text || "";
      return {
        sourceStartMs: clip.start_ms,
        sourceEndMs: clip.end_ms,
        text: clip.text || "",
        style: clip.style || "",
        display: normalizeOpClipDisplay(clip.display, hookText),
        hookText,
        keyword: clip.keyword || "",
        keywordColor: normalizeOpHookKeywordColor(clip.keyword_color),
      };
    });
}

/**
 * composition timeline.op(未検証JSON)+ run正本(op_config.json)→ プレビュー用OPデータ。
 *
 * フェーズV5: 「編集後OP(run正本)」を表示・再生の正とする。
 * - run正本 pattern=none は即 null(適用前でもOPなしとして本編が前詰め表示になる)
 * - highlight_teaser + 明示clips は composition にOPが無くてもrun正本だけでOPを組む
 *   (accent/sfxはcompositionがあればそこから、無ければ既定値)
 * - highlight_teaser + clips=null(AI自動選定)は適用しないと確定しないため、
 *   composition timeline.op の表示に任せる(旧パターンのcompositionも壊さない)
 * - title / catch_copy はrun正本の非空値で上書きする
 *
 * run正本が無い場合(旧経路)は composition timeline.op のみで従来どおり解決する。
 */
export function resolveOpPreviewData(
  timelineOp: unknown,
  ranges: TimelineCutRange[],
  runOpConfig?: RunOpConfigLike | null,
): OpPreviewData | null {
  const base = normalizeOpData(timelineOp);
  const config = runOpConfig ?? null;

  // V5: OPなしへの変更は即時反映(opTimelineShiftMs が負のシフトで本編を前詰めする)
  if (config && config.pattern === "none") return null;

  const explicitClips =
    config && config.pattern === "highlight_teaser" && config.clips && config.clips.length > 0
      ? previewClipsFromConfig(config.clips)
      : null;

  // W11-5: 「表示しない」チェック(title_enabled=false)は適用前でもプレビューへ即時反映する
  // (compositionに古いタイトルが残っていても出さない)
  const titleDisabled = config?.title_enabled === false;

  // V5: 装飾・テキストアニメはrun正本を優先(未指定・旧op_configはcomposition→既定へ)
  const decoration = config?.decoration !== undefined
    ? normalizeOpDecoration(config.decoration)
    : (base?.decoration ?? DEFAULT_OP_DECORATION);
  const textAnimation = config?.text_animation !== undefined
    ? normalizeOpTextAnimation(config.text_animation)
    : (base?.text_animation ?? DEFAULT_OP_TEXT_ANIMATION);

  if (explicitClips && explicitClips.length > 0) {
    // run正本の明示クリップが正。compositionのOP有無・パターンに依存しない
    return {
      pattern: "highlight_teaser",
      durationMs: explicitClips.reduce((sum, clip) => sum + (clip.sourceEndMs - clip.sourceStartMs), 0),
      title: titleDisabled ? "" : config!.title || base?.title || "",
      catchCopy: config!.catch_copy || base?.catch_copy || "",
      accentColor: base?.accent_color || DEFAULT_OP_ACCENT_COLOR,
      sfxHit: base ? base.sfx_hit : TEASER_DEFAULT_SFX_HIT,
      sfxTransition: base ? base.sfx_transition : null,
      clips: explicitClips,
      decoration,
      textAnimation,
    };
  }

  if (!base) return null;

  const configMatches = Boolean(config && config.pattern === base.pattern);
  const title = titleDisabled ? "" : configMatches && config!.title ? config!.title : base.title;
  const catchCopy = configMatches && config!.catch_copy ? config!.catch_copy : base.catch_copy;

  let clips: OpPreviewClip[] = [];
  let durationMs = base.duration_ms;

  if (base.pattern === "highlight_teaser") {
    // compositionの highlight_cuts から元動画区間を復元する(V2 meta or U8 file_path逆算)
    const rawClips = Array.isArray((timelineOp as Record<string, unknown>).highlight_cuts)
      ? ((timelineOp as Record<string, unknown>).highlight_cuts as Array<Record<string, unknown>>)
      : [];
    for (const entry of rawClips) {
      if (!entry || typeof entry !== "object") continue;
      const range = resolveClipSourceRange(entry, ranges);
      if (!range) continue;
      const hookText = typeof entry.hook_text === "string" ? entry.hook_text : "";
      clips.push({
        ...range,
        text: typeof entry.text === "string" ? entry.text : "",
        style: typeof entry.style === "string" ? entry.style : "",
        display: normalizeOpClipDisplay(entry.display, hookText),
        hookText,
        keyword: typeof entry.keyword === "string" ? entry.keyword : "",
        keywordColor: normalizeOpHookKeywordColor(entry.keyword_color),
      });
    }
    if (clips.length === 0) return null;
    // teaserの尺はクリップ実尺の合計(step08もクリップ合計=OP尺で組む)
    durationMs = clips.reduce((sum, clip) => sum + (clip.sourceEndMs - clip.sourceStartMs), 0);
  }

  return {
    pattern: base.pattern,
    durationMs,
    title,
    catchCopy,
    accentColor: base.accent_color || DEFAULT_OP_ACCENT_COLOR,
    sfxHit: base.sfx_hit,
    sfxTransition: base.sfx_transition,
    clips,
    decoration,
    textAnimation,
  };
}

// ---------------------------------------------------------------------------
// フェーズV5-1: 編集後タイムライン軸(表示・再生の正)への変換
// ---------------------------------------------------------------------------

/**
 * フェーズV5-1: 「編集後OP尺(run正本由来)」と「compositionのOP尺」の差分(ms)。
 * OP編集(クリップ追加・削除・OPなし化)を適用(step08再実行)する前に、本編ブロック・
 * プレイリスト・ルーラー総尺をこの分だけ後ろ(負なら前)へシフトして表示軸を統一する。
 * 適用後は composition のOP尺が編集後の値と一致するため 0 に戻る。
 */
export function opTimelineShiftMs(op: OpPreviewData | null, timelineOp: unknown): number {
  const base = normalizeOpData(timelineOp);
  return (op ? op.durationMs : 0) - (base ? base.duration_ms : 0);
}

/**
 * フェーズV5-1: 本編カット対応表を編集後タイムライン軸へシフトする。
 * sourceStart/End(元動画ms)は不変で、timelineStart/End のみ平行移動する。
 * shift=0(適用直後・OP未編集)は同一配列を返す(memo破壊を避ける)。
 * BGM・画像クリップ(タイムライン絶対ms保存)はシフトしない(BGMはOP含む先頭起点の設計)。
 */
export function shiftTimelineCutRanges(
  ranges: TimelineCutRange[],
  shiftMs: number,
): TimelineCutRange[] {
  if (!shiftMs) return ranges;
  return ranges.map((range) => ({
    ...range,
    timelineStartMs: range.timelineStartMs + shiftMs,
    timelineEndMs: range.timelineEndMs + shiftMs,
  }));
}

/**
 * フェーズV5-1: composition total_duration_ms を編集後タイムライン軸の総尺へ補正する。
 * 未生成(0以下)はそのまま返す(resolveTimelineTotalMs がシフト済みrangesから推定する)。
 */
export function shiftTimelineDurationMs(timelineDurationMs: number, shiftMs: number): number {
  if (!(timelineDurationMs > 0)) return timelineDurationMs;
  return Math.max(0, timelineDurationMs + shiftMs);
}

/**
 * V8追補(リップル削除): compositionのカット対応表を「UIの生きているkeep_segments」へ
 * 詰め直す。タイムラインタブでシーンをDeleteした瞬間に、後続ブロックが前へ詰まって
 * 表示・再生される(適用=step08再実行を待たずに書き出し後の姿になる)。
 *
 * - 各rangeの元動画区間を keepSegments と交差させ、残った断片を時系列に隙間なく再配置する
 * - 先頭のtimelineオフセット(=OP尺)は維持する
 * - 全rangeが無傷(削除なし)の場合は同一配列を返す(memo破壊を避ける。shiftTimelineCutRangesと同じ流儀)
 * - keepSegments が空でも初期化済みなら本編をすべて除く。未初期化時は旧対応表を保持する
 */
export function compactRangesToKeepSegments(
  ranges: TimelineCutRange[],
  keepSegments: Array<{ startMs: number; endMs: number; speed?: number }>,
  options: { keepSegmentsReady?: boolean } = {},
): TimelineCutRange[] {
  if (!ranges.length) return ranges;
  if (!keepSegments.length) return options.keepSegmentsReady ? [] : ranges;
  const sortedRanges = [...ranges].sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  const sortedKeeps = [...keepSegments].sort((a, b) => a.startMs - b.startMs);

  let cursor = sortedRanges[0].timelineStartMs;
  const result: TimelineCutRange[] = [];
  for (const range of sortedRanges) {
    for (const keep of sortedKeeps) {
      const start = Math.max(range.sourceStartMs, keep.startMs);
      const end = Math.min(range.sourceEndMs, keep.endMs);
      if (end <= start) continue;
      const speed = keep.speed || 1;
      const duration = (end - start) / speed;
      result.push({
        sourceStartMs: start,
        sourceEndMs: end,
        timelineStartMs: cursor,
        timelineEndMs: cursor + duration,
        ...(speed === 1 ? {} : { speed }),
        // W24 Phase A-2: cut単位テロップ縦位置は断片化後もそのまま引き継ぐ
        ...(range.telopY !== undefined ? { telopY: range.telopY } : {}),
        ...(range.punchScale !== undefined ? { punchScale: range.punchScale } : {}),
        ...(range.punchOriginX !== undefined ? { punchOriginX: range.punchOriginX } : {}),
        ...(range.punchOriginY !== undefined ? { punchOriginY: range.punchOriginY } : {}),
      });
      cursor += duration;
    }
  }
  const identical =
    result.length === sortedRanges.length &&
    result.every((item, index) => {
      const original = sortedRanges[index];
      return (
        item.sourceStartMs === original.sourceStartMs &&
        item.sourceEndMs === original.sourceEndMs &&
        item.timelineStartMs === original.timelineStartMs &&
        item.timelineEndMs === original.timelineEndMs &&
        (item.speed || 1) === (original.speed || 1)
      );
    });
  return identical ? ranges : result;
}

/** タイムライン総尺(ms)をrangesの実長へ合わせて補正する(リップル削除で縮んだ分を引く)。 */
export function compactedTimelineDurationMs(
  timelineDurationMs: number,
  originalRanges: TimelineCutRange[],
  compactedRanges: TimelineCutRange[],
): number {
  if (!(timelineDurationMs > 0) || compactedRanges === originalRanges) return timelineDurationMs;
  const total = (list: TimelineCutRange[]) =>
    list.reduce((sum, range) => sum + (range.timelineEndMs - range.timelineStartMs), 0);
  const removed = total(originalRanges) - total(compactedRanges);
  return Math.max(0, timelineDurationMs - Math.max(0, removed));
}

// ---------------------------------------------------------------------------
// プレイリスト構築
// ---------------------------------------------------------------------------

export type PlaylistEntryKind = "op_clip" | "op_static" | "main";

export type PlaylistEntry = {
  kind: PlaylistEntryKind;
  /** 元動画の絶対ms。op_static は映像を使わないため両方0。 */
  sourceStartMs: number;
  sourceEndMs: number;
  /** 出力タイムラインms(OP先頭=0)。 */
  timelineStartMs: number;
  timelineEndMs: number;
  /** 本編素材速度。OPは常に等速。 */
  speed?: number;
  /** op_clip のみ: OP内クリップ番号(0始まり)。フラッシュ・テロップ選択に使う。 */
  opClipIndex?: number;
};

/**
 * 仮想プレイリストの構築。OPエントリ(あれば)が先頭、本編エントリ(TimelineCutRange)が続く。
 * op=null(OPなし)なら本編エントリのみ=従来のカット対応表と同値。
 *
 * 注意: run正本のクリップ編集(適用前)でOP尺がcompositionのオフセットとズレる場合、
 * OP末尾と本編先頭の間に隙間/重なりが生じるが、再生はエントリ順(OP終端→本編先頭へシーク)
 * なので破綻しない。写像は「先に一致したエントリ」を採用する(OPが先頭なのでOP優先)。
 */
export function buildPreviewPlaylist(
  ranges: TimelineCutRange[],
  op: OpPreviewData | null,
): PlaylistEntry[] {
  const entries: PlaylistEntry[] = [];
  if (op) {
    if (op.pattern === "highlight_teaser") {
      let cursor = 0;
      op.clips.forEach((clip, index) => {
        const length = clip.sourceEndMs - clip.sourceStartMs;
        entries.push({
          kind: "op_clip",
          sourceStartMs: clip.sourceStartMs,
          sourceEndMs: clip.sourceEndMs,
          timelineStartMs: cursor,
          timelineEndMs: cursor + length,
          opClipIndex: index,
        });
        cursor += length;
      });
    } else {
      entries.push({
        kind: "op_static",
        sourceStartMs: 0,
        sourceEndMs: 0,
        timelineStartMs: 0,
        timelineEndMs: op.durationMs,
      });
    }
  }
  const sortedRanges = [...ranges].sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  for (const range of sortedRanges) {
    entries.push({
      kind: "main",
      sourceStartMs: range.sourceStartMs,
      sourceEndMs: range.sourceEndMs,
      timelineStartMs: range.timelineStartMs,
      timelineEndMs: range.timelineEndMs,
      ...(range.speed ? { speed: range.speed } : {}),
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// 写像・探索
// ---------------------------------------------------------------------------

export type PlaylistPosition = {
  index: number;
  /** エントリ先頭からのオフセット(ms)。 */
  offsetMs: number;
};

/**
 * タイムラインms → 再生位置。[start, end) の半開区間で最初に一致したエントリを返す
 * (OPエントリが先頭にあるため、run正本編集で区間が重なった場合はOP側を優先する)。
 * どのエントリにも属さない(隙間・末尾余白)場合は null。
 */
export function playlistPositionForTimelineMs(
  entries: PlaylistEntry[],
  timelineMs: number,
): PlaylistPosition | null {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (timelineMs >= entry.timelineStartMs && timelineMs < entry.timelineEndMs) {
      return { index, offsetMs: timelineMs - entry.timelineStartMs };
    }
  }
  return null;
}

/**
 * タイムラインms → 再生位置(最寄りへクランプ)。タイムラインViewのクリックシーク用で、
 * 隙間・末尾余白は最も近いエントリの端へ丸める(V1の seekSourceMsForTimelineMs と同じ考え方。
 * 終端側は end-1ms へ寄せて半開区間の外に出ないようにする)。エントリなし=null。
 */
export function clampTimelineMsToPlaylist(
  entries: PlaylistEntry[],
  timelineMs: number,
  options: { allowFinalEnd?: boolean } = {},
): PlaylistPosition | null {
  const exact = playlistPositionForTimelineMs(entries, timelineMs);
  if (exact) return exact;
  const finalEndMs = options.allowFinalEnd ? playlistTotalDurationMs(entries) : null;
  let bestDistance = Infinity;
  let bestPosition: PlaylistPosition | null = null;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const candidate =
      timelineMs < entry.timelineStartMs
        ? { distance: entry.timelineStartMs - timelineMs, position: { index, offsetMs: 0 } }
        : {
            distance: timelineMs - entry.timelineEndMs,
            position: {
              index,
              offsetMs: Math.max(0, entry.timelineEndMs - entry.timelineStartMs - (entry.timelineEndMs === finalEndMs ? 0 : 1)),
            },
          };
    if (candidate.distance < bestDistance) {
      bestDistance = candidate.distance;
      bestPosition = candidate.position;
    }
  }
  return bestPosition;
}

/** 再生位置 → タイムラインms。 */
export function timelineMsForPlaylistPosition(
  entries: PlaylistEntry[],
  position: PlaylistPosition,
): number {
  const entry = entries[position.index];
  if (!entry) return 0;
  const length = entry.timelineEndMs - entry.timelineStartMs;
  return entry.timelineStartMs + Math.max(0, Math.min(length, position.offsetMs));
}

/** 次エントリのindex(最終エントリなら null)。 */
export function nextPlaylistIndex(entries: PlaylistEntry[], index: number): number | null {
  return index + 1 < entries.length ? index + 1 : null;
}

/** プレイリストの総尺(=タイムライン終端ms)。空なら fallback。 */
export function playlistTotalDurationMs(entries: PlaylistEntry[], fallbackMs = 0): number {
  let total = fallbackMs;
  for (const entry of entries) total = Math.max(total, entry.timelineEndMs);
  return total;
}

/**
 * 元動画ms → それを含む本編(main)エントリのindex。OPクリップと本編は同じ元動画区間を
 * 共有し得るため「本編側」として解決したいとき(ネイティブシーク・シーン行クリック)に使う。
 */
export function mainEntryIndexForSourceMs(entries: PlaylistEntry[], sourceMs: number): number | null {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.kind !== "main") continue;
    if (sourceMs >= entry.sourceStartMs && sourceMs < entry.sourceEndMs) return index;
  }
  return null;
}

// ---------------------------------------------------------------------------
// OP内フェーズ(ms)計算 — Remotion(opTimeline.ts)のフレーム計算をmsへ変換して共有する
// ---------------------------------------------------------------------------

export type OpPhasesMs = {
  /** タイトル登場(=キメ音)。 */
  titleMs: number;
  /** キャッチコピー/問いテキストのフェード開始。 */
  catchMs: number;
  /** 本編への転換フェード開始(=whoosh)。teaser はフェードなし=durationMs。 */
  fadeOutMs: number;
};

const framesToMs = (frames: number, fps: number) => (frames / fps) * 1000;

/** OPパターンごとのフェーズ境界(OP先頭からのms)。Remotionと同じフレーム計算を経由する。 */
export function opPhasesMsFor(op: OpPreviewData, fps: number): OpPhasesMs {
  const safeFps = fps > 0 ? fps : 30;
  const durationFrames = Math.max(1, Math.round((op.durationMs / 1000) * safeFps));
  if (op.pattern === "highlight_teaser") {
    return {
      titleMs: framesToMs(opTeaserTitleFrame(durationFrames, safeFps), safeFps),
      catchMs: op.durationMs,
      fadeOutMs: op.durationMs,
    };
  }
  const phases =
    op.pattern === "question_hook"
      ? opQuestionHookPhases(durationFrames, safeFps)
      : opTitleCardPhases(durationFrames, safeFps);
  return {
    titleMs: framesToMs(phases.titleFrame, safeFps),
    catchMs: framesToMs(phases.catchFrame, safeFps),
    fadeOutMs: framesToMs(phases.fadeOutFrame, safeFps),
  };
}

/**
 * highlight_teaser クリップ内テロップの表示開始遅延(ms)。
 * opClipTelopTiming(白フラッシュ2フレームを避けて約0.08秒遅れ)のms版。
 */
export function opClipTelopDelayMs(fps: number): number {
  const safeFps = fps > 0 ? fps : 30;
  return framesToMs(Math.round(safeFps * 0.08), safeFps);
}

/** クリップ切替の白フラッシュ長(ms)。Remotion ClipFlash の2フレーム相当。 */
export function opClipFlashMs(fps: number): number {
  const safeFps = fps > 0 ? fps : 30;
  return framesToMs(2, safeFps);
}

/**
 * フェーズV5: 装飾ごとのクリップ転換演出の長さ(ms)。
 * Remotionの opClipTransitionFrames と同じフレーム計算を経由してプレビューと揃える。
 */
export function opClipTransitionMs(decoration: OpDecoration, fps: number): number {
  const safeFps = fps > 0 ? fps : 30;
  return framesToMs(opClipTransitionFrames(decoration, safeFps), safeFps);
}
