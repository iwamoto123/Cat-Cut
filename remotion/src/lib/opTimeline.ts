/**
 * フェーズU8(OPジェネレーター): composition.json timeline.op の正規化と
 * OP内部のタイミング(フェーズ)計算。Remotion非依存の純関数として置き、
 * node --experimental-strip-types のユニットテストで直接検証できるようにする。
 *
 * timeline.op は step08_composition.py(--op-config)が生成する:
 *   { pattern, duration_ms, title, catch_copy, accent_color?, sfx_hit?, sfx_transition?,
 *     highlight_cuts?: [{file_path, start_ms, end_ms, text?, style?}] }
 * op が無い/不正な composition は null を返し、OPなし=従来通りの描画になる(後方互換)。
 *
 * フェーズV2: highlight_cuts の各クリップに text(該当スロットの整形済みテロップ文言)と
 * style(プリセットID)が付き、クリップ再生中に横スライド(slide_left)テロップとして描画する。
 * text 無し(旧composition・文言なしスロット)はテロップを描かない=後方互換。
 */

export const OP_PATTERNS = ["title_card", "highlight_teaser", "question_hook"] as const;

export type OpPattern = (typeof OP_PATTERNS)[number];

// ---------------------------------------------------------------------------
// フェーズV5: highlight_teaser の装飾パターンとOPテロップの登場アニメ
// ---------------------------------------------------------------------------

/**
 * フェーズV5: OP(highlight_teaser)の装飾パターン。
 * 「クリップ間の転換」「画面装飾(帯・フレーム・ラベル)」「タイトルの出し方」のセットで、
 * どれを選んでも「本編とは違う=OPだとわかる」画になるようにする。
 *   flash_pop   : 白フラッシュつなぎ+終端タイトル被せ(既定=V2までの現行相当)
 *   cinema_bars : 上下黒帯(レターボックス)+OPENINGラベル+クリップ番号。転換は白フラッシュ
 *   color_wipe  : アクセント色の斜めワイプ転換+下部ブランド色バー(タイトル常駐)
 *   neon_frame  : 画面縁のネオンフレーム+ズームイン転換(game/エンタメ向け)
 */
export const OP_DECORATIONS = ["flash_pop", "cinema_bars", "color_wipe", "neon_frame"] as const;

export type OpDecoration = (typeof OP_DECORATIONS)[number];

export const DEFAULT_OP_DECORATION: OpDecoration = "flash_pop";

/** フェーズV5: OPクリップテロップの登場アニメ(本編テロップのアニメIDのサブセット)。 */
export const OP_TEXT_ANIMATIONS = ["slide_left", "slide_up", "stamp"] as const;

export type OpTextAnimation = (typeof OP_TEXT_ANIMATIONS)[number];

export const DEFAULT_OP_TEXT_ANIMATION: OpTextAnimation = "slide_left";

/** neon_frame のフレーム色(U5のgame系プリセットと同系のシアン)。 */
export const OP_NEON_COLOR = "#3DE8FF";

/** decoration(未検証値)の正規化。未知・欠落は既定=flash_pop(旧composition後方互換)。 */
export function normalizeOpDecoration(raw: unknown): OpDecoration {
  return typeof raw === "string" && (OP_DECORATIONS as readonly string[]).includes(raw)
    ? (raw as OpDecoration)
    : DEFAULT_OP_DECORATION;
}

/** text_animation(未検証値)の正規化。未知・欠落は既定=slide_left(V2までの挙動)。 */
export function normalizeOpTextAnimation(raw: unknown): OpTextAnimation {
  return typeof raw === "string" && (OP_TEXT_ANIMATIONS as readonly string[]).includes(raw)
    ? (raw as OpTextAnimation)
    : DEFAULT_OP_TEXT_ANIMATION;
}

// ---------------------------------------------------------------------------
// フェーズW(OP 0ベース再設計): フックワード表示
//
// 参考実例の分析(OP編集ガイド)に基づく「予告編型OP」: 本編の字幕をそのまま出すのではなく、
// 発話を1〜2語に凝縮したフックワードを画面いっぱいの極太文字で出す。核心語だけ色分けし
// (黄=結論・肯定 / 赤=ネガ・断定・警告 / 白=中立)、2行のときは上下2段に積んで対比を見せる。
// ---------------------------------------------------------------------------

/** クリップのテロップ表示方法。hook=フックワードを大きく / verbatim=発話テロップそのまま。 */
export const OP_CLIP_DISPLAYS = ["hook", "verbatim"] as const;

export type OpClipDisplay = (typeof OP_CLIP_DISPLAYS)[number];

/** OP内での役割(先頭=開幕フック / 中盤=畳みかけ / 終盤=引き)。 */
export const OP_CLIP_ROLES = ["hook_open", "punch", "cliffhanger"] as const;

export type OpClipRole = (typeof OP_CLIP_ROLES)[number];

/** フックワードの核心語の色ID(python shared/direction.py OP_KEYWORD_COLORS と同期)。 */
export const OP_HOOK_KEYWORD_COLORS = ["yellow", "red", "white"] as const;

export type OpHookKeywordColor = (typeof OP_HOOK_KEYWORD_COLORS)[number];

/** OP(highlight_teaser)の抜粋クリップ1件。file_path はカットのセグメントMP4を指す。 */
export type OpHighlightClip = {
  file_path: string;
  /** セグメントファイル内の相対ms。 */
  start_ms: number;
  end_ms: number;
  /** フェーズV2: クリップ中に横スライドで出すテロップ文言(空=テロップなし)。 */
  text: string;
  /** フェーズV2: テロップのプリセットID(timeline.telop_styles のキー。空=既定スタイル)。 */
  style: string;
  /** フェーズW: テロップ表示方法(旧composition=hook_textなし→verbatim)。 */
  display: OpClipDisplay;
  /** フェーズW: フックワード(最大2行。改行\nで上下2段に積む。空=フック表示不可)。 */
  hook_text: string;
  /** フェーズW: フックワード内の核心語(部分文字列。空=色分けなし)。 */
  keyword: string;
  /** フェーズW: 核心語の色。 */
  keyword_color: OpHookKeywordColor;
  /** フェーズW: OP内での役割。 */
  role: OpClipRole;
};

export type OpData = {
  pattern: OpPattern;
  duration_ms: number;
  title: string;
  catch_copy: string;
  accent_color: string;
  /** タイトル登場のキメ音ID(assets/sfx。null=鳴らさない)。 */
  sfx_hit: string | null;
  /** 本編への転換音ID(whoosh系。null=鳴らさない)。 */
  sfx_transition: string | null;
  highlight_cuts: OpHighlightClip[];
  /** フェーズV5: highlight_teaser の装飾パターン(旧compositionは既定=flash_pop)。 */
  decoration: OpDecoration;
  /** フェーズV5: OPテロップの登場アニメ(全クリップ共通。旧compositionは既定=slide_left)。 */
  text_animation: OpTextAnimation;
};

/** ブランド色未指定時の既定(深い紺。テロップ既定の配色と喧嘩しない)。 */
export const DEFAULT_OP_ACCENT_COLOR = "#16305E";

/** display(未検証値)の正規化。未知・欠落は「hook_textがあればhook、なければverbatim」。 */
export function normalizeOpClipDisplay(raw: unknown, hookText: string): OpClipDisplay {
  if (raw === "hook" || raw === "verbatim") {
    return raw === "hook" && !hookText ? "verbatim" : raw;
  }
  return hookText ? "hook" : "verbatim";
}

/** keyword_color(未検証値)の正規化。未知・欠落は yellow(基本色)。 */
export function normalizeOpHookKeywordColor(raw: unknown): OpHookKeywordColor {
  return typeof raw === "string" && (OP_HOOK_KEYWORD_COLORS as readonly string[]).includes(raw)
    ? (raw as OpHookKeywordColor)
    : "yellow";
}

/** role(未検証値)の正規化。未知・欠落は punch(畳みかけ)。 */
export function normalizeOpClipRole(raw: unknown): OpClipRole {
  return typeof raw === "string" && (OP_CLIP_ROLES as readonly string[]).includes(raw)
    ? (raw as OpClipRole)
    : "punch";
}

/** フックワードを表示行(最大2行・空行除去)へ分解する。 */
export function opHookLines(hookText: string): string[] {
  return hookText
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 2);
}

export type OpHookSegment = {
  text: string;
  /** true=核心語(keyword_colorで着色)。false=通常(白)。 */
  keyword: boolean;
};

/**
 * フックワード1行を「通常/核心語」の区間に分解する(最初の出現のみ着色)。
 * keyword が行に含まれない場合は行全体が通常区間1つになる。
 */
export function opHookSegments(line: string, keyword: string): OpHookSegment[] {
  if (!keyword) return [{ text: line, keyword: false }];
  const index = line.indexOf(keyword);
  if (index < 0) return [{ text: line, keyword: false }];
  const segments: OpHookSegment[] = [];
  if (index > 0) segments.push({ text: line.slice(0, index), keyword: false });
  segments.push({ text: keyword, keyword: true });
  if (index + keyword.length < line.length) {
    segments.push({ text: line.slice(index + keyword.length), keyword: false });
  }
  return segments;
}

/** 全角換算の行長(ASCII=0.55字扱い。フォントサイズ計算用のラフな見積もり)。 */
function hookLineWeight(line: string): number {
  let weight = 0;
  for (const ch of line) {
    weight += ch.charCodeAt(0) > 0x7f ? 1 : 0.55;
  }
  return weight;
}

/**
 * フックワードのフォントサイズ(px)。「画面の1/3を占める極太文字」を目安に、
 * 最長行が画面幅92%に収まるサイズと画面高さの16%の小さい方(下限は高さの7%)。
 */
export function opHookFontPx(lines: string[], width: number, height: number): number {
  const maxWeight = Math.max(1, ...lines.map((line) => hookLineWeight(line)));
  const fitToWidth = (width * 0.92) / maxWeight;
  return Math.round(Math.max(height * 0.07, Math.min(height * 0.16, fitToWidth)));
}

/**
 * フェーズW: クリップ映像のゆっくりズーム(1.0→1.06)。予告編らしい「動きのある画」を
 * 全クリップに薄く掛ける(neon_frameの高速ズームイン転換とは別物で、常時進行する)。
 */
export function opClipSlowZoomScale(localFrame: number, durationInFrames: number): number {
  if (durationInFrames <= 0) return 1;
  const progress = Math.max(0, Math.min(1, localFrame / durationInFrames));
  return 1 + 0.06 * progress;
}

/**
 * フェーズW: フックワード各行の登場開始フレーム(クリップ相対)。
 * 1行目はクリップ頭(白フラッシュ後)、2行目は約0.3秒遅れてスタンプ=積み上げの勢い。
 */
export function opHookLineStartFrame(lineIndex: number, fps: number): number {
  return Math.round(fps * 0.08) + lineIndex * Math.round(fps * 0.3);
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/**
 * timeline.op(未検証JSON)を OpData へ正規化する。
 * pattern が3種以外(none含む)・duration不正は null(=OPなし)。
 */
export function normalizeOpData(raw: unknown): OpData | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const pattern = source.pattern;
  if (!isNonEmptyString(pattern) || !(OP_PATTERNS as readonly string[]).includes(pattern)) {
    return null;
  }
  const durationMs = Number(source.duration_ms);
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;

  const clips: OpHighlightClip[] = [];
  if (Array.isArray(source.highlight_cuts)) {
    for (const entry of source.highlight_cuts as Array<Record<string, unknown>>) {
      if (!entry || typeof entry !== "object") continue;
      const filePath = entry.file_path;
      const startMs = Number(entry.start_ms);
      const endMs = Number(entry.end_ms);
      if (!isNonEmptyString(filePath)) continue;
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
      const hookText = typeof entry.hook_text === "string" ? entry.hook_text : "";
      clips.push({
        file_path: filePath,
        start_ms: startMs,
        end_ms: endMs,
        text: typeof entry.text === "string" ? entry.text : "",
        style: typeof entry.style === "string" ? entry.style : "",
        display: normalizeOpClipDisplay(entry.display, hookText),
        hook_text: hookText,
        keyword: typeof entry.keyword === "string" ? entry.keyword : "",
        keyword_color: normalizeOpHookKeywordColor(entry.keyword_color),
        role: normalizeOpClipRole(entry.role),
      });
    }
  }
  // highlight_teaser はクリップが無いと成立しない(step08側でtitle_cardへフォールバック済みの
  // はずだが、手編集されたcompositionでも壊れないよう二重に守る)
  if (pattern === "highlight_teaser" && clips.length === 0) return null;

  return {
    pattern: pattern as OpPattern,
    duration_ms: durationMs,
    title: typeof source.title === "string" ? source.title : "",
    catch_copy: typeof source.catch_copy === "string" ? source.catch_copy : "",
    accent_color: isNonEmptyString(source.accent_color)
      ? (source.accent_color as string)
      : DEFAULT_OP_ACCENT_COLOR,
    sfx_hit: isNonEmptyString(source.sfx_hit) ? (source.sfx_hit as string) : null,
    sfx_transition: isNonEmptyString(source.sfx_transition) ? (source.sfx_transition as string) : null,
    highlight_cuts: clips,
    decoration: normalizeOpDecoration(source.decoration),
    text_animation: normalizeOpTextAnimation(source.text_animation),
  };
}

// ---------------------------------------------------------------------------
// フェーズ(タイミング)計算
// ---------------------------------------------------------------------------

export type OpTitleCardPhases = {
  /** タイトルがドンと出るフレーム(=キメ音)。 */
  titleFrame: number;
  /** キャッチコピーのフェード開始フレーム。 */
  catchFrame: number;
  /** 本編への転換フェード開始フレーム(=whoosh)。 */
  fadeOutFrame: number;
};

/**
 * title_card / question_hook 共通のフェーズ計算。
 * 音と絵の同期が命(調査: タイトルが出る瞬間にキメ音)のため、フレーム単位で決定的に返す。
 * - タイトル: 開始0.4秒(question_hook は問いを先に見せるため全体の55%地点)
 * - キャッチ: 全体の45%地点(title_card のみ)
 * - 転換フェード: 終端の0.5秒前
 */
export function opTitleCardPhases(durationFrames: number, fps: number): OpTitleCardPhases {
  const titleFrame = Math.min(Math.round(fps * 0.4), Math.max(0, durationFrames - 1));
  const fadeOutFrame = Math.max(titleFrame + 1, durationFrames - Math.round(fps * 0.5));
  const catchFrame = Math.min(Math.max(titleFrame + 1, Math.round(durationFrames * 0.45)), fadeOutFrame);
  return { titleFrame, catchFrame, fadeOutFrame };
}

export function opQuestionHookPhases(durationFrames: number, fps: number): OpTitleCardPhases {
  // 問いテキストのfadeが先(0.3秒)、タイトルは全体の55%地点で被せる
  const questionFrame = Math.min(Math.round(fps * 0.3), Math.max(0, durationFrames - 1));
  const fadeOutFrame = Math.max(questionFrame + 1, durationFrames - Math.round(fps * 0.5));
  const titleFrame = Math.min(Math.max(questionFrame + 1, Math.round(durationFrames * 0.55)), fadeOutFrame);
  return { titleFrame, catchFrame: questionFrame, fadeOutFrame };
}

export type OpTeaserClip = {
  clip: OpHighlightClip;
  from: number;
  durationInFrames: number;
};

/** highlight_teaser: 抜粋クリップを隙間なく直列に並べたフレーム配置。 */
export function opTeaserClipFrames(clips: OpHighlightClip[], fps: number): OpTeaserClip[] {
  const result: OpTeaserClip[] = [];
  let cursor = 0;
  for (const clip of clips) {
    const frames = Math.max(1, Math.round(((clip.end_ms - clip.start_ms) / 1000) * fps));
    result.push({ clip, from: cursor, durationInFrames: frames });
    cursor += frames;
  }
  return result;
}

/** highlight_teaser: タイトル被せの開始フレーム(終端の1.4秒前。=キメ音)。 */
export function opTeaserTitleFrame(durationFrames: number, fps: number): number {
  return Math.max(0, durationFrames - Math.round(fps * 1.4));
}

export type OpClipTelopTiming = {
  /** クリップ相対の表示開始フレーム(横スライド入りの起点)。 */
  startFrame: number;
  /** クリップ相対の表示終了フレーム(クリップ終端まで出しっぱなし)。 */
  endFrame: number;
};

/**
 * フェーズV2: highlight_teaser クリップ内テロップの表示窓(クリップ相対フレーム)。
 * 白フラッシュ(先頭2フレーム)と登場が重ならないよう約0.08秒遅らせて slide_left で入り、
 * クリップ終端まで表示し続ける(1〜2秒の短いクリップで退場アニメを入れると忙しないため)。
 */
export function opClipTelopTiming(durationInFrames: number, fps: number): OpClipTelopTiming {
  const startFrame = Math.min(Math.round(fps * 0.08), Math.max(0, durationInFrames - 1));
  return { startFrame, endFrame: Math.max(startFrame + 1, durationInFrames) };
}

/**
 * フェーズV5: 装飾ごとのクリップ転換(2本目以降のクリップ先頭)の演出フレーム数。
 * flash_pop / cinema_bars: 白フラッシュは「一瞬の残像」が命なので2フレーム固定(fps非依存)。
 * color_wipe: 斜めワイプは軌跡が見える約0.28秒。neon_frame: ズームインは勢い重視の約0.2秒。
 */
export function opClipTransitionFrames(decoration: OpDecoration, fps: number): number {
  switch (decoration) {
    case "color_wipe":
      return Math.max(2, Math.round(fps * 0.28));
    case "neon_frame":
      return Math.max(2, Math.round(fps * 0.2));
    default:
      return 2;
  }
}

/**
 * フェーズV5: color_wipe の下部ブランド色バーの高さ(画面高さ比)。
 * タイトル1行が常駐できる高さで、かつ本編テロップ位置(下1/4)を大きく覆わない値。
 */
export const OP_COLOR_WIPE_BAR_RATIO = 0.12;

/**
 * フェーズV5: タイトルを「終端に被せる」装飾か(color_wipe のみバー上に常駐=被せない)。
 * プレビュー(CSS近似)とRemotionでタイトルの出し方を揃えるための判定を1箇所に集約する。
 */
export function opDecorationHasEndTitle(decoration: OpDecoration): boolean {
  return decoration !== "color_wipe";
}

/**
 * OPのSFX音量。キメ音はOPの印象を決めるため、テロップSFXの既定(0.25)より持ち上げる。
 * ただしユーザーが効果音を0(ミュート)にしている場合は鳴らさない意図を尊重する。
 */
export function opSfxVolume(timelineSfxVolume: number): number {
  if (!(timelineSfxVolume > 0)) return 0;
  return Math.min(1, Math.max(0.4, timelineSfxVolume));
}
