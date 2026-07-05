// 実行時(値)importのため、node --experimental-strip-types でテストを直接実行できるよう拡張子を明示する。
import type { Scene } from "./scenes.ts";
import {
  isSemanticType,
  resolveStyleForType,
  type TelopTypeMapping,
} from "./telopTypes.ts";

/**
 * フェーズT2(シーン演出決定エンジン / directedモード)のUI側純関数。
 *
 * directedモードでは、AIパス3(python/step06c_direction.py)が生成した
 * telop_directives.json のスロットがテロップの正であり、UIのシーン行は
 * 「1シーン = 1スロット」で初期化される(main側がcompositionの明示start/endから
 * telopPageBoundariesを組み立てる)。編集の適用時は、scenes配列から
 * スロット編集リスト(deriveDirectedSlots)を導出してmainへ送り、mainが
 * telop_directives.json のslotsを差し替えてから step08 を再実行する。
 *
 * フェーズT2.5-4: スタイルの正は「シーン種類(semantic type) × type→presetマッピング」
 * になった。directedStyleId は「個別プリセット上書き」のときだけ設定され、
 * マッピングより優先される(python側の style_overridden と同じ意味)。
 */

/** ディレクティブが指定できるスタイルID(python/shared/direction.py の ALLOWED_DIRECTIVE_STYLES と同期)。
 *  color はスタイルバッジの色見本(telop_presets.yamlの文字色/箱色の代表色)。 */
export const DIRECTED_STYLE_OPTIONS: Array<{ id: string; label: string; color: string }> = [
  { id: "fact_yellow", label: "事実", color: "#ffdd00" },
  { id: "neutral_white", label: "中立", color: "#ffffff" },
  { id: "neutral_white_pink", label: "中立(ピンク)", color: "#ffc0cb" },
  { id: "emotion_red", label: "感情", color: "#ff3b30" },
  { id: "question_blue", label: "質問", color: "#4da6ff" },
  { id: "reply_cyan", label: "軽い返し", color: "#5ce1e6" },
  { id: "special_purple", label: "煽り", color: "#b366ff" },
  { id: "box_yellow", label: "要点", color: "#ffdd00" },
  { id: "box_red", label: "プラン名", color: "#e02020" },
  { id: "cta_yellow", label: "CTA", color: "#ffb300" },
  // フェーズT2.5-3: 明朝体プリセット
  { id: "serif_quote", label: "名言(明朝)", color: "#f5f5f5" },
  { id: "serif_harsh", label: "辛辣(明朝)", color: "#333333" },
];

export const DEFAULT_DIRECTED_STYLE_ID = "fact_yellow";

const OPTION_BY_ID = new Map(DIRECTED_STYLE_OPTIONS.map((option) => [option.id, option]));

/** スタイルバッジに表示する日本語ラベル(未知のIDはIDをそのまま表示する)。 */
export function directedStyleLabel(styleId: string | null | undefined): string {
  if (!styleId) return OPTION_BY_ID.get(DEFAULT_DIRECTED_STYLE_ID)?.label ?? DEFAULT_DIRECTED_STYLE_ID;
  return OPTION_BY_ID.get(styleId)?.label ?? styleId;
}

/** スタイルバッジの色見本(未知のIDは既定スタイルの色)。 */
export function directedStyleColor(styleId: string | null | undefined): string {
  return (
    OPTION_BY_ID.get(styleId || DEFAULT_DIRECTED_STYLE_ID)?.color ??
    OPTION_BY_ID.get(DEFAULT_DIRECTED_STYLE_ID)!.color
  );
}

/**
 * シーンの有効directedスタイルID。優先順位(python/shared/direction.py の
 * effective_slot_style と同じ):
 * 1. directedStyleId(個別プリセット上書き。T2旧runのstyleスナップショットも含む)
 * 2. directedType × type→presetマッピング
 * 3. 既定 fact_yellow
 */
export function effectiveDirectedStyleId(
  scene: Pick<Scene, "directedStyleId" | "directedType">,
  typeMapping?: Partial<TelopTypeMapping> | null,
): string {
  if (scene.directedStyleId) return scene.directedStyleId;
  if (isSemanticType(scene.directedType)) return resolveStyleForType(scene.directedType, typeMapping);
  return DEFAULT_DIRECTED_STYLE_ID;
}

/**
 * main経由で telop_directives.json のslotsへ書き戻す1スロット分の編集内容。
 * startMs/endMs は元動画の絶対ms(directivesのsource_*_msと同じアンカー)。
 */
export type DirectedSlotEdit = {
  startMs: number;
  endMs: number;
  text: string;
  styleId: string;
  /** フェーズT2.5-4: シーンの意味種類(旧runのtype無しシーンはnull)。 */
  typeId: string | null;
  /** フェーズT2.5-4: styleId が個別上書き(マッピングより優先)かどうか。 */
  styleOverridden: boolean;
  /**
   * フェーズT3: 登場アニメの個別上書き(シーン行のアニメーションピッカー)。
   * null なら上書きなし(type→マッピング → プリセット既定へフォールバック)。
   */
  animationIn: string | null;
  highlightWords: string[];
};

/**
 * scenes配列からdirectedスロット編集リストを導出する(1シーン=1スロット)。
 * - 全単語が削除されたシーンも含めて送ってよい(python側の select_slots_for_cut が
 *   現在のkeep_segmentsとの照合で自動的に落とす)
 * - highlightWords は現在のテロップ文言に実在する語のみ残す(python側の検証と同じ規則)
 * - styleId は常に解決済みの値を書く(typeを読めない旧経路との後方互換)。typeがあり
 *   個別上書きでないスロットは、python側(effective_slot_style)が最新マッピングで再解決する
 */
export function deriveDirectedSlots(
  scenes: Scene[],
  typeMapping?: Partial<TelopTypeMapping> | null,
): DirectedSlotEdit[] {
  return [...scenes]
    .sort((a, b) => a.sourceStartMs - b.sourceStartMs)
    .map((scene) => {
      const text = scene.telopText.trim();
      const highlightWords = (scene.directedHighlightWords || []).filter(
        (word) => word && text.includes(word),
      );
      return {
        startMs: scene.sourceStartMs,
        endMs: scene.sourceEndMs,
        text,
        styleId: effectiveDirectedStyleId(scene, typeMapping),
        typeId: isSemanticType(scene.directedType) ? scene.directedType : null,
        styleOverridden: Boolean(scene.directedStyleId),
        animationIn: scene.directedAnimationIn ?? null,
        highlightWords,
      };
    })
    .filter((slot) => slot.endMs > slot.startMs);
}
