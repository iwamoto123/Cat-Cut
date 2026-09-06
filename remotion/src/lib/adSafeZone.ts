// フェーズW24 Phase A-2: 縦型広告セーフゾーンのテロップ自動配置(顔回避)。
//
// python/shared/telop_placement.py のTSミラー実装。定数・判定順序・丸めは
// Python側と完全に同一に保つこと(両言語の同期は remotion/tests/adSafeZoneCases.json の
// 同一ケース表で node --test / pytest の双方から検証される。片方を変えたら
// 必ずもう片方とケース表も更新する)。
//
// 実行時の使われ方:
// - step08(Python)が resolve_cut_telop_y で cuts[].telop_y を書き込む
// - 描画側(CatCutComposition / PreviewPlayer)は effectiveCutTelopY で
//   「cut単位のtelop_y > グローバルtimeline.telop_y」の優先を解決する
//
// 配置の考え方(Instagram Reels / TikTok のUIセーフゾーン):
// - 縦型のテロップ許容帯は 0.30〜0.72(上部ステータス・下部キャプション/CTAを回避)
// - 顔なしは「中央少し下」0.64
// - 顔ありは顔の下に置けるなら下帯(0.58〜0.72)、顔が下寄りなら上帯(0.30〜0.42)
// - テロップブロックの概算高さ(行数×行高)と顔box+マージンが重ならない位置を選ぶ

/** 正規化顔box(0〜1、左上基準)。face_detect.py の検出結果。 */
export type FaceBox = { x: number; y: number; w: number; h: number };

// --- python/shared/telop_placement.py と同期する定数(画面高さに対する比率0〜1) ---

/** 縦型のテロップ許容帯(Instagram/TikTokの上部UI・下部キャプション/CTA/右端アイコン列を避ける)。 */
export const TELOP_BAND_TOP = 0.3;
export const TELOP_BAND_BOTTOM = 0.72;
/** 顔なし・既定の「中央少し下」。 */
export const VERTICAL_DEFAULT_TELOP_Y = 0.64;
/** 顔回避時の下帯(中央少し下)。 */
export const LOWER_BAND_TOP = 0.58;
export const LOWER_BAND_BOTTOM = 0.72;
/** 顔回避時の上帯(中央少し上)。 */
export const UPPER_BAND_TOP = 0.3;
export const UPPER_BAND_BOTTOM = 0.42;
/** 上帯に置くときの既定(中央少し上)。 */
export const VERTICAL_UPPER_DEFAULT_TELOP_Y = 0.36;
/** 顔boxとテロップブロックの間に確保するマージン。 */
export const FACE_TELOP_MARGIN = 0.03;
/** テロップブロック高さ(比率)の既定値(1080x1920でおよそ2行分)。 */
export const DEFAULT_BLOCK_HEIGHT_RATIO = 0.08;

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value));

/** 正規化顔box {x,y,w,h} の検証。不正・退化boxは null(顔なし扱い)。 */
const validFaceBox = (faceBox: unknown): FaceBox | null => {
  if (!faceBox || typeof faceBox !== "object") return null;
  const raw = faceBox as Record<string, unknown>;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const w = Number(raw.w);
  const h = Number(raw.h);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
};

/**
 * カット単位のテロップ縦位置(中心基準0〜1)を決める。telop_placement.py
 * resolve_cut_telop_y と同一ロジック。
 *
 * - vertical以外: 従来どおり baseTelopY を素通しする(横型は完全従来動作)
 * - vertical・顔なし: 既定「中央少し下」0.64
 * - vertical・顔あり: 顔の下に置けるなら下帯(0.58〜0.72)、置けなければ上帯(0.30〜0.42)。
 *   どちらにも収まらない(顔が画面をほぼ覆う)場合は顔中心から遠い側の帯の既定値
 * - styleOffset: 描画側で加算される y_position_offset の打ち消し分(最終位置が帯に入るよう
 *   先に差し引く)。step08 の自動配置では 0
 */
export function resolveCutTelopY(options: {
  orientation: string;
  baseTelopY: number;
  faceBox?: unknown;
  blockHeightRatio?: number;
  styleOffset?: number;
}): number {
  const {
    orientation,
    baseTelopY,
    faceBox = null,
    blockHeightRatio = DEFAULT_BLOCK_HEIGHT_RATIO,
    styleOffset = 0,
  } = options;
  if (orientation !== "vertical") return baseTelopY;

  const half = blockHeightRatio / 2;
  const face = validFaceBox(faceBox);
  let target: number;
  if (face === null) {
    target = VERTICAL_DEFAULT_TELOP_Y;
  } else {
    const faceTop = clamp(face.y, 0, 1);
    const faceBottom = clamp(face.y + face.h, 0, 1);
    const lowerMin = faceBottom + FACE_TELOP_MARGIN + half;
    const upperMax = faceTop - FACE_TELOP_MARGIN - half;
    if (lowerMin <= LOWER_BAND_BOTTOM) {
      // 顔の下端+マージンの直下、ただし既定0.64より上へは寄せない
      target = clamp(Math.max(VERTICAL_DEFAULT_TELOP_Y, lowerMin), LOWER_BAND_TOP, LOWER_BAND_BOTTOM);
    } else if (upperMax >= UPPER_BAND_TOP) {
      // 顔が下寄り: 上帯へ。既定0.36が顔に当たるなら顔の上端側へ寄せる
      target = clamp(Math.min(VERTICAL_UPPER_DEFAULT_TELOP_Y, upperMax), UPPER_BAND_TOP, UPPER_BAND_BOTTOM);
    } else {
      // 顔が画面をほぼ覆う: 顔中心から遠い側の帯の既定値へフォールバック
      const faceCenter = (faceTop + faceBottom) / 2;
      target = faceCenter >= 0.5 ? VERTICAL_UPPER_DEFAULT_TELOP_Y : VERTICAL_DEFAULT_TELOP_Y;
    }
  }

  const result = clamp(target - styleOffset, TELOP_BAND_TOP, TELOP_BAND_BOTTOM);
  // JSONへ書く値を安定させ、TS/Python間のケース表比較を厳密一致にするため4桁へ丸める
  return Math.round(result * 10000) / 10000;
}

/**
 * 描画側の縦位置解決: cut単位の telop_y(0〜1の有効値)があればグローバル
 * timeline.telop_y より優先する。cuts[].telop_y の無い既存composition(横型・
 * 旧縦型run)は従来どおりグローバル値で描画される(後方互換)。
 */
export function effectiveCutTelopY(cutTelopY: unknown, timelineTelopY: number): number {
  return typeof cutTelopY === "number" &&
    Number.isFinite(cutTelopY) &&
    cutTelopY >= 0 &&
    cutTelopY <= 1
    ? cutTelopY
    : timelineTelopY;
}
