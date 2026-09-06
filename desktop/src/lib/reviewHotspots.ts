// 実行時(値)importのため、node --experimental-strip-types でテストを直接実行できるよう拡張子を明示する。
import { isSceneFullyDeleted, type Scene } from "./scenes.ts";
import type { SuspicionItem } from "./suspicionQueue.ts";
import { isTrivialUtteranceText } from "./trivialUtterance.ts";
// W14-2: 修正履歴に頻出する「誤」表記の決定的検出(過去に修正した表記バッジ)
import { findKnownWrongNotations, type CorrectionHistoryPair } from "./correctionPairs.ts";

/**
 * フェーズW5(要確認の再設計): 要確認パネル(ReviewHotspotsPanel)のデータ構築を担う純関数群。
 * `2026-07-07_catcut-review-hotspots-spec.md` の §5(改行の疑義)・§6-1(データ構築)に準拠する。
 */

export type LineBreakIssue = { sceneId: string; brokenWord: string };

const lineBreakSegmenter = new Intl.Segmenter("ja", { granularity: "word" });

/**
 * W5-4: 改行(\n)が単語の内部に落ちているかを決定的に判定する(LLM不要)。
 * telopText から \n を除去した文字列を Intl.Segmenter で単語分割し、各 \n の位置
 * (除去後文字列でのインデックス)がセグメントの先頭以外に落ちる場合、そのセグメント文字列を返す。
 * 記号・空白のみのセグメント(isWordLike=false)は無視する。英数字・カタカナ連続の途中の改行も
 * 同方式で拾える(Intl.Segmenterがひとまとまりのセグメントにするため)。
 */
export function detectAwkwardLineBreak(telopText: string): string | null {
  if (!telopText.includes("\n")) return null;

  // \n を除去した文字列と、各 \n の「除去後文字列でのインデックス」を同時に作る。
  let stripped = "";
  const breakIndices: number[] = [];
  let strippedLength = 0;
  for (const ch of telopText) {
    if (ch === "\n") {
      breakIndices.push(strippedLength);
      continue;
    }
    stripped += ch;
    strippedLength += 1;
  }
  if (!stripped.length || !breakIndices.length) return null;

  for (const segment of lineBreakSegmenter.segment(stripped)) {
    if (!segment.isWordLike) continue;
    const start = segment.index;
    const end = segment.index + [...segment.segment].length;
    for (const breakIndex of breakIndices) {
      if (breakIndex > start && breakIndex < end) return segment.segment;
    }
  }
  return null;
}

// ---- W13-6: シーン境界の文字切れ検出(決定的) ----

export type SceneBoundaryTruncation = {
  /** word_split=境界が単語の内部に落ちる / duplicate_head=次シーン先頭が前シーン末尾と重複。 */
  kind: "word_split" | "duplicate_head";
  /** 疑いの根拠になった文字列(境界をまたぐ単語 or 重複した文字)。 */
  fragment: string;
};

/** 文末が句読点・終端記号で閉じているか(閉じていれば境界の文字切れとは考えにくい)。 */
const SENTENCE_CLOSED_RE = /[。．.！!？?…、,，]\s*$/u;
/** 重複判定で無視する記号のみの断片。 */
const SYMBOL_ONLY_RE = /^[\p{P}\p{S}\p{Z}]+$/u;

/**
 * W13-6: 隣接シーンのテロップ表示テキストから「シーン境界の文字切れ疑い」を決定的に検出する。
 * (a) 前シーン末尾+次シーン先頭を連結して Intl.Segmenter で単語分割し、境界が単語の内部に
 *     落ちる場合(W5-4 detectAwkwardLineBreak と同じ手法の境界版)
 * (b) 次シーン先頭の1〜2文字が前シーン末尾と重複している場合(STTが境界で同じ音を二重に
 *     書き起こしたケース)
 * 前シーンが句読点等で閉じている場合・どちらかが空の場合は検出しない。
 */
export function detectSceneBoundaryTruncation(
  prevText: string,
  nextText: string,
): SceneBoundaryTruncation | null {
  const prev = prevText.replace(/\s+/gu, "");
  const next = nextText.replace(/\s+/gu, "");
  if (!prev || !next) return null;
  if (SENTENCE_CLOSED_RE.test(prev)) return null;

  // (b) 次シーン先頭1〜2文字の重複(長い一致を優先)
  for (const len of [2, 1]) {
    if (prev.length < len || next.length < len) continue;
    const tail = prev.slice(-len);
    const head = next.slice(0, len);
    if (tail === head && !SYMBOL_ONLY_RE.test(head)) {
      return { kind: "duplicate_head", fragment: head };
    }
  }

  // (a) 境界が単語(セグメント)の内部に落ちる
  const combined = prev + next;
  const boundaryIndex = prev.length;
  for (const segment of lineBreakSegmenter.segment(combined)) {
    if (!segment.isWordLike) continue;
    const start = segment.index;
    const end = segment.index + segment.segment.length;
    if (start < boundaryIndex && boundaryIndex < end) {
      // 「です+から→ですから」のような助詞・助動詞の偶然の連結を減らすため、
      // 境界をまたぐセグメントが漢字・カタカナ・英数字を含む場合のみ疑いとする
      // (ひらがなのみのセグメントは機能語の可能性が高くノイズになる)
      if (/[\p{sc=Han}\p{sc=Katakana}A-Za-z0-9]/u.test(segment.segment)) {
        return { kind: "word_split", fragment: segment.segment };
      }
    }
    if (start >= boundaryIndex) break;
  }
  return null;
}

export type ReviewHotspot = {
  /** シーン参照。 */
  scene: Scene;
  /** 表示用シーン番号(1始まり・全シーン中の位置)。 */
  sceneOrdinal: number;
  /** このシーンに紐づく疑義(改行疑義も統合済み)。 */
  items: SuspicionItem[];
  /** チップ強調用。 */
  flaggedWordIds: Set<string>;
};

export type BuildReviewHotspotsOptions = {
  /** tinyシーン除外の上限文字数(空白・句読点除去後)。既定2。 */
  tinyTextMaxChars?: number;
  /**
   * W14-2: ユーザーがテロップを編集済みのシーンid(run正本 edit_history.json 由来)。
   * 編集済みシーンの疑義は「ユーザー確認済み」として除外する(suggestion適用済みと同じ扱い)。
   * 現在のテロップ本文から決定的に再評価できる疑義(改行・境界文字切れ・修正履歴の残存)は
   * 編集後テキスト基準で従来どおり表示する。
   */
  editedSceneIds?: Set<string>;
  /** W14-2: 全run横断の修正履歴。頻出の「誤」表記が残るシーンを決定的に要確認へ昇格する。 */
  correctionHistoryPairs?: CorrectionHistoryPair[];
  /**
   * W16-7: AI最終チェック(finalCheck.buildFinalCheckSuspicions)の指摘。現在の本文基準の
   * 再チェックなので、編集済みシーン(editedSceneIds)の疑義除外の対象にせず常に表示する。
   */
  finalCheckItemsBySceneId?: Map<string, SuspicionItem[]>;
  /**
   * W19-B1: 弱い区間の再文字起こし(retranscribe.buildRetranscribeSuspicions)の差分候補。
   * 元のSTTテキスト基準の指摘なので、編集済みシーンでは「ユーザー確認済み」として除外する
   * (suspect_word等と同じ扱い)。
   */
  retranscribeItemsBySceneId?: Map<string, SuspicionItem[]>;
};

/** パネルに載せない疑義種別。ai_failureはsceneAiReviewBannerが担当、filler/low_confidenceはノイズ。 */
const EXCLUDED_TYPES = new Set(["ai_failure", "filler", "low_confidence"]);

/**
 * W5(§6-1): 要確認パネルのカードデータをシーン順(タイムライン順)に構築する。
 * - 1シーン=1カード(複数疑義はitemsに集約)。
 * - tinyシーン(正規化後2文字以下・フィラーのみ)は疑義があってもパネルに出さない。
 * - 各シーンのtelopTextを detectAwkwardLineBreak にかけ、検出されたら改行疑義を items に追加する
 *   (改行疑義しかないシーンもパネルに出す)。
 */
export function buildReviewHotspots(
  scenes: Scene[],
  suspicionsBySceneId: Map<string, SuspicionItem[]>,
  options: BuildReviewHotspotsOptions = {},
): ReviewHotspot[] {
  const tinyTextMaxChars = options.tinyTextMaxChars ?? 2;
  const hotspots: ReviewHotspot[] = [];

  // W13-6: 隣接シーン(丸ごと削除済みは飛ばす)の境界で文字切れ疑いを検出し、
  // 「次シーン」(断片が現れる側)のカードに載せる。
  const boundaryItemsBySceneId = new Map<string, SuspicionItem[]>();
  const visibleScenes = scenes.filter((scene) => !isSceneFullyDeleted(scene));
  for (let i = 0; i + 1 < visibleScenes.length; i += 1) {
    const prevScene = visibleScenes[i];
    const nextScene = visibleScenes[i + 1];
    const truncation = detectSceneBoundaryTruncation(prevScene.telopText, nextScene.telopText);
    if (!truncation) continue;
    const detail =
      truncation.kind === "duplicate_head"
        ? `前のシーン末尾と同じ「${truncation.fragment}」がこのシーンの先頭にも入っています(二重書き起こしの疑い)`
        : `シーン境界が「${truncation.fragment}」という単語の途中に落ちています(文字切れの疑い)`;
    const list = boundaryItemsBySceneId.get(nextScene.id) || [];
    list.push({
      id: `scene_boundary_truncation:${prevScene.id}:${nextScene.id}`,
      type: "boundary_truncation",
      severity: "medium",
      label: "シーン境界の文字切れ疑い",
      text: truncation.fragment,
      timestampMs: nextScene.sourceStartMs,
      wordIds: [],
      detail,
    });
    boundaryItemsBySceneId.set(nextScene.id, list);
  }

  scenes.forEach((scene, index) => {
    // W10-7でtiny判定はtrivialUtterance.tsへ共有関数化した(シーン初期化の空欄化と同一規則)。
    if (isTrivialUtteranceText(scene.telopText, tinyTextMaxChars)) return;

    // W14-2: 編集済みシーンの既存疑義(編集前テキスト由来)は「ユーザー確認済み」として除外する。
    // 以降の決定的検出(改行・境界文字切れ・修正履歴の残存)は現在の本文基準なのでそのまま行う。
    const userEdited = Boolean(options.editedSceneIds?.has(scene.id));
    const items = userEdited
      ? []
      : (suspicionsBySceneId.get(scene.id) || []).filter((item) => !EXCLUDED_TYPES.has(item.type));

    // W19-B1: 再文字起こしの差分候補(元STTテキスト基準なので編集済みシーンでは出さない)
    if (!userEdited) {
      items.push(...(options.retranscribeItemsBySceneId?.get(scene.id) || []));
    }

    // W14-2: 修正履歴に頻出する「誤」表記が本文に残っていれば決定的に要確認へ昇格する
    // (suggestionを付けるので既存の「候補: ○○ [適用]」ボタンがそのまま使える)。
    for (const known of findKnownWrongNotations(scene.telopText, options.correctionHistoryPairs)) {
      items.push({
        id: `correction_history:${scene.id}:${known.before}`,
        type: "correction_history",
        severity: "medium",
        label: "過去に修正した表記",
        text: known.before,
        timestampMs: scene.sourceStartMs,
        wordIds: [],
        detail: `過去に「${known.before}」→「${known.after}」と修正しています(${known.count}回)`,
        suggestion: known.after,
      });
    }

    const brokenWord = detectAwkwardLineBreak(scene.telopText);
    if (brokenWord) {
      items.push({
        id: `line_break:${scene.id}`,
        type: "telop_review",
        severity: "medium",
        label: "改行が単語の途中",
        text: brokenWord,
        timestampMs: scene.sourceStartMs,
        wordIds: [],
        detail: `「${brokenWord}」の途中で改行されています`,
      });
    }

    // W13-6: シーン境界の文字切れ疑い(境界検出しかないシーンもパネルに出す)
    items.push(...(boundaryItemsBySceneId.get(scene.id) || []));

    // W16-7: AI最終チェックの指摘(現在の本文基準。編集済みシーンでも表示する)
    items.push(...(options.finalCheckItemsBySceneId?.get(scene.id) || []));

    if (!items.length) return;
    hotspots.push({
      scene,
      sceneOrdinal: index + 1,
      items,
      flaggedWordIds: new Set(items.flatMap((item) => item.wordIds)),
    });
  });

  return hotspots;
}
