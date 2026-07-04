import type { EmotionTag } from "./emotionTag.ts";
import { getPresetStyle, type TelopStyleDef } from "./telopThemes.ts";

/**
 * 改善7-3(保存済みフォントプロファイルをテーマの正とする)。
 * `desktop/main/index.cjs`の既存機構(readFontProfiles/saveFontProfile/font-profiles:list)が
 * userData/font_profiles.json に保存するプロファイル形式をここで扱う。
 *
 * このプロファイル構造は、App.tsxの`fontSceneOrder`(既存の「テロップスタイル」旧UI、
 * default/highlight/warning/question/calm/simpleの6シーン)と同じキー空間で、
 * `patternCount`が「実際に使うパターン数」(この順で先頭からN個)を表す。
 * directivesTextは常にこの順で「通常/強調/注意/質問/(落ち着き/補足)」とラベル付けされる
 * (telopStyleLabelsと同じ対応。App.tsx参照)。
 */
export type FontProfileScene = {
  font?: string;
  weight?: number;
  size?: number;
  letterSpacing?: number;
  lineHeight?: number;
  fillMode?: "solid" | "gradient";
  fillColor?: string;
  gradientFrom?: string;
  gradientTo?: string;
  strokeEnabled?: boolean;
  innerStrokeColor?: string;
  outerStrokeColor?: string;
  innerStrokeWidth?: number;
  outerStrokeWidth?: number;
};

export type FontProfile = {
  id: string;
  name: string;
  patternCount: number;
  scenes: Record<string, FontProfileScene>;
  directivesText?: string;
  createdAt?: string;
  updatedAt?: string;
};

/**
 * font_profiles.json のシーンキー順序(既存main/App.tsxのfontSceneOrderと同一)。
 * directivesTextは常にこの順で「通常/強調/注意/質問/落ち着き/補足」とラベル付けされ、
 * patternCountはこの並びの先頭から何個を「使うパターン」として扱うかを表す。
 */
export const FONT_PROFILE_SCENE_ORDER = ["default", "highlight", "warning", "question", "calm", "simple"] as const;
export type FontProfileSceneKey = (typeof FONT_PROFILE_SCENE_ORDER)[number];

/**
 * 感情タグ(4種: 通常/強調/疑問/驚き)からfont_profileのシーンキーへのマッピング規則(改善7-3)。
 *
 * 設計判断(調査結果):
 * - 通常(normal)は常にscenes.default(directivesTextの1番目=「通常」。patternCount>=1で必ず有効)。
 * - 強調(emphasis)はscenes.highlight(directivesTextの2番目=「強調」。patternCount>=2で有効)。
 * - 疑問(question)はscenes.question(directivesTextの4番目=「質問」)。シーン名が
 *   「質問」で完全に一致するため最も自然な対応。patternCount>=4のときのみ有効。
 * - 驚き(surprise)はscenes.warning(directivesTextの3番目=「注意」)。プロファイルの6シーンには
 *   「驚き」に一致する名前が存在しないため、残る強い感情表現である「注意」(実データでも
 *   赤系の警告色が定義されている)をインパクト表現として流用する。patternCount>=3のときのみ有効。
 *
 * patternCountが少なく該当パターンが無効な場合は、より弱い(defaultに近い)表現へ
 * フォールバックする: question -> warning -> highlight -> default、surprise -> highlight -> default。
 * (例: 「テスト1」のようなpatternCount=3のプロファイルではquestionパターンが無効なため
 * warningへフォールバックし、結果的にquestionとsurpriseが同じ「注意」パターンを共有する。)
 */
const EMOTION_SCENE_PREFERENCE: Record<EmotionTag, FontProfileSceneKey[]> = {
  normal: ["default"],
  emphasis: ["highlight", "default"],
  question: ["question", "warning", "highlight", "default"],
  surprise: ["warning", "highlight", "default"],
};

function activeSceneKeys(profile: FontProfile): Set<FontProfileSceneKey> {
  const count = Math.max(1, Math.min(FONT_PROFILE_SCENE_ORDER.length, Number(profile.patternCount) || 1));
  return new Set(FONT_PROFILE_SCENE_ORDER.slice(0, count));
}

function resolveSceneForEmotion(profile: FontProfile, emotion: EmotionTag): FontProfileScene | null {
  const active = activeSceneKeys(profile);
  for (const key of EMOTION_SCENE_PREFERENCE[emotion]) {
    if (active.has(key) && profile.scenes[key]) return profile.scenes[key];
  }
  return profile.scenes.default ?? null;
}

function fontFamilyCss(fontName: string | undefined): string | undefined {
  if (!fontName) return undefined;
  return `"${fontName}", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Meiryo", sans-serif`;
}

/**
 * 改善8-B-5(保存済みフォントプロファイル)の変換における「欠けている項目の穴埋め元」。
 * `main/index.cjs`の`styleFromSavedScene`(saved_font_profile直接反映経路)と同じく、
 * yamlの"default"プリセット(白谷塾青)を土台にする。これにより、プロファイル編集UIで
 * 一部項目(drop_shadow等)が未設定でも、rough-cut品質の見た目(多重縁取り+グラデ)の
 * 既定値へ自然にフォールバックする。
 */
function fontProfileBaseStyle(): TelopStyleDef {
  return (
    getPresetStyle("default") ?? {
      font_family: '"Zen Kaku Gothic Antique", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Meiryo", sans-serif',
      font_size: 72,
      font_weight: 900,
      letter_spacing: "0.02em",
      line_height: 1.4,
      fill: { type: "gradient", gradient_from: "#7BB8DC", gradient_to: "#1E5DA8", gradient_direction: "vertical" },
      inner_stroke: { color: "#FFFFFF", width: 10 },
      outer_stroke: { color: "#1E3A5F", width: 18 },
      drop_shadow: "drop-shadow(0px 4px 6px rgba(0,0,0,0.4))",
    }
  );
}

/**
 * font_profiles.json の1シーン設定をTelopStyleDefへ変換する(改善8-B-5)。
 * プレビュー近似(T-4)と書き出し(T-5)の両方がこの1つの変換から導出される。
 *
 * 設計判断(改善8-B: TelopStyleDefが絶対px多重縁取り仕様へ全面刷新されたことに伴う変更):
 * 旧来のsizeRatio(相対値)方式を廃止し、`main/index.cjs`のsaved_font_profile直接反映経路
 * (`styleFromSavedScene`)と同じく、scene.sizeをそのまま絶対font_sizeとして扱う。
 * これによりプレビューと書き出しが同じ絶対px基準で完全に一致する(旧来のtelopFontSize基準の
 * 正規化は、プレビュー側の相対サイズ計算(telopPreviewSize.ts)が動画表示幅に対する
 * フォントサイズクランプ(改善8-B-4)を別途行うようになったため、もはや不要)。
 */
export function fontProfileSceneToStyle(scene: FontProfileScene): TelopStyleDef {
  const base = fontProfileBaseStyle();
  const isSolid = scene.fillMode === "solid";
  const strokeEnabled = scene.strokeEnabled !== false;
  return {
    font_family: fontFamilyCss(scene.font) ?? base.font_family,
    font_size: Number(scene.size) || base.font_size || 72,
    font_weight: Number(scene.weight) || base.font_weight || 900,
    letter_spacing:
      scene.letterSpacing !== undefined ? `${Number(scene.letterSpacing).toFixed(2)}em` : base.letter_spacing || "0.02em",
    line_height: Number(scene.lineHeight) || base.line_height || 1.35,
    fill: isSolid
      ? { type: "solid", color: scene.fillColor || "#FFFFFF" }
      : {
          type: "gradient",
          gradient_from: scene.gradientFrom || "#FFFFFF",
          gradient_to: scene.gradientTo || "#1E5DA8",
          gradient_direction: "vertical",
        },
    inner_stroke: strokeEnabled
      ? { color: scene.innerStrokeColor || "#FFFFFF", width: Number(scene.innerStrokeWidth) || 10 }
      : null,
    outer_stroke: strokeEnabled
      ? { color: scene.outerStrokeColor || "#1E3A5F", width: Number(scene.outerStrokeWidth) || 18 }
      : null,
    drop_shadow: strokeEnabled ? base.drop_shadow ?? null : "drop-shadow(0px 3px 5px rgba(0,0,0,0.35))",
  };
}

/** プロファイル全体を4感情のTelopStyleDefへ変換する(改善8-B-5)。 */
export function mapFontProfileToEmotionStyles(profile: FontProfile): Record<EmotionTag, TelopStyleDef> {
  const emotions: EmotionTag[] = ["normal", "emphasis", "question", "surprise"];
  const result = {} as Record<EmotionTag, TelopStyleDef>;
  for (const emotion of emotions) {
    const scene = resolveSceneForEmotion(profile, emotion) ?? profile.scenes?.default ?? {};
    result[emotion] = fontProfileSceneToStyle(scene);
  }
  return result;
}

/**
 * 保存済みフォントプロファイルの中から「テーマの正」として採用する1件を選ぶ(改善7-3)。
 *
 * 選定規則: patternCountが多い(=より作り込まれた)プロファイルを優先し、同数ならupdatedAt
 * (無ければcreatedAt)が新しい方を優先する。プロファイルが0件ならnull。
 *
 * 設計判断: 既存のプロファイル選択UI(App.tsxのfontProfileMode/selectedFontProfileId、
 * `desktop/main/index.cjs`のsettings.selectedFontProfileId)は本タスクとは別の目的
 * (旧テロップスタイル編集フローでの選択保持)のために存在し、必ずしも「テーマとして
 * 最も作り込まれたプロファイル」を指しているとは限らない(実際、手元の環境では
 * fontProfileMode="new"かつselectedFontProfileIdがpatternCount=3の「テスト1」を指しており、
 * ユーザーが実際に作り込んだpatternCount=4の「字幕フォント設定」ではなかった)。
 * そのため本関数は既存の選択状態に依存せず、プロファイル自体の完成度(patternCount)から
 * 独立して「テーマの正」を決定する。
 */
export function pickPrimaryFontProfile(profiles: FontProfile[]): FontProfile | null {
  if (!profiles || !profiles.length) return null;
  return [...profiles].sort((a, b) => {
    const countDiff = (Number(b.patternCount) || 0) - (Number(a.patternCount) || 0);
    if (countDiff !== 0) return countDiff;
    const bTime = Date.parse(b.updatedAt || b.createdAt || "") || 0;
    const aTime = Date.parse(a.updatedAt || a.createdAt || "") || 0;
    return bTime - aTime;
  })[0];
}
