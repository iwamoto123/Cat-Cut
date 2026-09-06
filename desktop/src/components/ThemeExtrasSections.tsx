import type { CSSProperties } from "react";
import {
  CHAPTER_TITLE_PATTERN_INFO,
  OP_DECORATION_INFO,
  OP_DECORATIONS,
  OP_PATTERN_INFO,
  OP_PATTERNS,
  OP_TEXT_ANIMATION_INFO,
  OP_TEXT_ANIMATIONS,
  type OpConfig,
  type OpDecoration,
  type OpPattern,
  type OverlayTitleConfig,
  type VideoEffectsConfig,
} from "../lib/designExtras";
import {
  CHAPTER_TITLE_DEFAULTS,
  CHAPTER_TITLE_PATTERNS,
  chapterTitleRenderSpec,
  strokeTextBaseStyle,
  type ChapterTitlePattern,
} from "../lib/overlayStyles";
import { DIRECTED_STYLE_OPTIONS, directedStyleColor } from "../lib/directedTelop";
import type { SpeakerColorsConfig } from "../lib/speakerColors";

/**
 * フェーズU7/U8: デザインテーマ設計画面(新規作成の調整ステップ・「調整」モーダル)で共有する
 * 「シーンタイトル」「オープニング」セクション。テーマとスタンダード両方の編集で同じUIを使う。
 */

const SAMPLE_TITLE_TEXT = "今日のテーマ";

/**
 * シーンタイトル1パターンのミニ実描画。書き出しと同じ chapterTitleRenderSpec を
 * 小さいscaleでDOMへ写す(スクショ画像ではなく実スタイルなので、定義変更が即反映される)。
 */
function ChapterTitlePatternSample({ pattern }: { pattern: ChapterTitlePattern }) {
  const scale = 0.42;
  const spec = chapterTitleRenderSpec(pattern, scale, CHAPTER_TITLE_DEFAULTS);
  const base = strokeTextBaseStyle(spec.text) as CSSProperties;
  const text = (
    <div style={{ position: "relative", display: "inline-block" }}>
      {spec.text.strokeWidth > 0 && (
        <div style={{ ...base, color: "transparent", WebkitTextStroke: `${spec.text.strokeWidth}px ${spec.text.strokeColor}` }}>
          {SAMPLE_TITLE_TEXT}
        </div>
      )}
      <div style={{ ...base, color: spec.text.fillColor, position: spec.text.strokeWidth > 0 ? "absolute" : "relative", inset: 0 }}>
        {SAMPLE_TITLE_TEXT}
      </div>
    </div>
  );
  const inner = (
    <>
      {text}
      {spec.underline && <div style={spec.underline as CSSProperties} />}
    </>
  );
  return (
    <span className="overlayTitleSampleStage">
      <span style={spec.container as CSSProperties}>
        {spec.plate ? <span style={{ ...(spec.plate as CSSProperties), display: "inline-block" }}>{inner}</span> : inner}
      </span>
    </span>
  );
}

type OverlayTitleSectionProps = {
  value: OverlayTitleConfig;
  disabled?: boolean;
  onChange: (value: OverlayTitleConfig) => void;
};

/** フェーズU7: 左上シーンタイトルのON/OFF+パターン選択(ミニ実描画つき横並びカード)。 */
export function OverlayTitleSection({ value, disabled, onChange }: OverlayTitleSectionProps) {
  return (
    <div className="themeExtrasSection">
      <div className="themeExtrasSectionHeader">
        <span className="themeExtrasSectionTitle">シーンタイトル(左上の章見出し)</span>
        <label className="themeExtrasToggle">
          <input
            checked={value.enabled}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
            type="checkbox"
          />
          表示する
        </label>
        <span
          className="helpIcon"
          title={
            "AIが章の切り替わりに出す左上のタイトルのデザインを選べます。\n" +
            "文言はプレビューでタイトルをクリックすればいつでも編集できます。"
          }
        >
          ?
        </span>
      </div>
      <div className={`overlayTitlePatternRow ${value.enabled ? "" : "themeExtrasDisabled"}`}>
        {CHAPTER_TITLE_PATTERNS.map((pattern) => {
          const info = CHAPTER_TITLE_PATTERN_INFO[pattern];
          return (
            <button
              className={`overlayTitlePatternCard ${value.style === pattern ? "selected" : ""}`}
              disabled={disabled || !value.enabled}
              key={pattern}
              onClick={() => onChange({ ...value, style: pattern })}
              title={info.description}
              type="button"
            >
              <ChapterTitlePatternSample pattern={pattern} />
              <span className="overlayTitlePatternLabel">{info.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

type SpeakerColorsSectionProps = {
  value: SpeakerColorsConfig;
  disabled?: boolean;
  onChange: (value: SpeakerColorsConfig) => void;
};

/** フェーズW1: 話者カラーで選択できる話者スロット(1人目は既定色のまま=選択肢に出さない)。 */
const SPEAKER_COLOR_SLOTS: ReadonlyArray<{ speakerId: string; label: string }> = [
  { speakerId: "speaker_1", label: "2人目の話者" },
  { speakerId: "speaker_2", label: "3人目の話者" },
];

/**
 * フェーズW1: 話者カラーのON/OFF+話者ごとのプリセット選択。
 * 対談動画で話者ごとに「基本」テロップ(説明・相槌)の色を変える設定。
 * 1人目の話者は既定色(type→presetマッピング)のままにするため選択肢を出さない。
 */
export function SpeakerColorsSection({ value, disabled, onChange }: SpeakerColorsSectionProps) {
  function updateStyle(speakerId: string, styleId: string) {
    onChange({ ...value, styles: { ...value.styles, [speakerId]: styleId } });
  }
  return (
    <div className="themeExtrasSection">
      <div className="themeExtrasSectionHeader">
        <span className="themeExtrasSectionTitle">話者カラー(対談の話者ごとの色分け)</span>
        <label className="themeExtrasToggle">
          <input
            checked={value.enabled}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
            type="checkbox"
          />
          有効にする
        </label>
        <span
          className="helpIcon"
          title={
            "対談・複数人の動画で、話者ごとに基本テロップ(説明・相槌)の色を変えます。\n" +
            "1人目の話者は今までどおりの色のまま、2人目以降だけ色が変わります。\n" +
            "強調・質問などの演出色はそのまま維持されます。\n" +
            "1人で話している動画では自動的に無効になります(色は変わりません)。"
          }
        >
          ?
        </span>
      </div>
      <div className={`speakerColorsRow ${value.enabled ? "" : "themeExtrasDisabled"}`}>
        {SPEAKER_COLOR_SLOTS.map(({ speakerId, label }) => {
          const current = value.styles[speakerId] || "";
          return (
            <label className="speakerColorsSelectLabel" key={speakerId}>
              <span
                className="speakerColorsSwatch"
                style={{ backgroundColor: directedStyleColor(current) }}
              />
              {label}
              <select
                disabled={disabled || !value.enabled}
                onChange={(event) => updateStyle(speakerId, event.target.value)}
                value={current}
              >
                {DIRECTED_STYLE_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>
    </div>
  );
}

type VideoEffectsSectionProps = {
  value: VideoEffectsConfig;
  disabled?: boolean;
  onChange: (value: VideoEffectsConfig) => void;
};

/**
 * フェーズW2: シーン演出(映像ギミック)のpinch/zoom個別トグル。
 * AIがシーンの種類(辛辣・強調など)から自動で入れる映像効果のON/OFF設定。
 */
export function VideoEffectsSection({ value, disabled, onChange }: VideoEffectsSectionProps) {
  return (
    <div className="themeExtrasSection">
      <div className="themeExtrasSectionHeader">
        <span className="themeExtrasSectionTitle">シーン演出(映像のギミック)</span>
        <span
          className="helpIcon"
          title={
            "AIがシーンの種類に合わせて本編映像に軽い演出を入れます。\n" +
            "・引き締め: 辛辣なシーンで画面が少し縮んで暗くなり「チーン」と鳴ります(最大3回)。\n" +
            "・ズーム: 強調・オチのシーンでゆっくりズームインします(最大4回)。\n" +
            "・暗転強調: 強調シーンで映像を少し暗くし、テロップを際立たせます(最大2回・連発しません)。\n" +
            "・顔ズーム: 顔が検出できたカットで顔にゆっくり寄ります(縦型の顔検出が前提)。\n" +
            "・ゆっくり寄り: 各カットで画面全体をごくゆっくり寄せ続けます(単調さの回避)。\n" +
            "設定は変更したあとの再書き出しから反映されます。"
          }
        >
          ?
        </span>
      </div>
      <div className="videoEffectsRow">
        <label className="themeExtrasToggle">
          <input
            checked={value.pinch}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, pinch: event.target.checked })}
            type="checkbox"
          />
          引き締め(縮小+暗転+チーン)
        </label>
        <label className="themeExtrasToggle">
          <input
            checked={value.zoom}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, zoom: event.target.checked })}
            type="checkbox"
          />
          ズーム(強調シーンに寄る)
        </label>
        <label className="themeExtrasToggle">
          <input
            checked={value.dim}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, dim: event.target.checked })}
            type="checkbox"
          />
          暗転強調(暗くしてテロップを立てる)
        </label>
        <label className="themeExtrasToggle">
          <input
            checked={value.face_zoom}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, face_zoom: event.target.checked })}
            type="checkbox"
          />
          顔ズーム(顔にゆっくり寄る)
        </label>
        <label className="themeExtrasToggle">
          <input
            checked={value.slow_push}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, slow_push: event.target.checked })}
            type="checkbox"
          />
          ゆっくり寄り(カット全長で寄せ続ける)
        </label>
      </div>
    </div>
  );
}

/** OPパターンの小さな図解(CSSのみ。構成イメージを伝えるダイアグラム)。 */
function OpPatternFigure({ pattern }: { pattern: OpPattern }) {
  switch (pattern) {
    case "highlight_teaser":
      return (
        <span className="opFigure opFigureTeaser">
          <span className="opFigureClip" />
          <span className="opFigureClip" />
          <span className="opFigureClip">
            <span className="opFigureClipTitle">タイトル</span>
          </span>
        </span>
      );
    case "none":
    default:
      return (
        <span className="opFigure opFigureNone">
          <span className="opFigureNoneText">本編から</span>
        </span>
      );
  }
}

/**
 * フェーズV5: 装飾パターン1種のミニ実描画カード(小さなCSSで装飾の構図を再現する)。
 * スクショ画像ではなくCSSで描くため、装飾の定義変更が即このプレビューへ反映される。
 */
function OpDecorationSample({ decoration }: { decoration: OpDecoration }) {
  return (
    <span className={`opDecoSample opDecoSample-${decoration}`}>
      {decoration === "flash_pop" && (
        <>
          <span className="opDecoSampleFlash" />
          <span className="opDecoSampleTitleCenter">タイトル</span>
        </>
      )}
      {decoration === "cinema_bars" && (
        <>
          <span className="opDecoSampleBarTop" />
          <span className="opDecoSampleBarBottom" />
          <span className="opDecoSampleOpening">OPENING</span>
          <span className="opDecoSampleClipNo">01</span>
        </>
      )}
      {decoration === "color_wipe" && (
        <>
          <span className="opDecoSampleWipe" />
          <span className="opDecoSampleBrandBar">タイトル</span>
        </>
      )}
      {decoration === "neon_frame" && (
        <>
          <span className="opDecoSampleNeon" />
          <span className="opDecoSampleTitleCenter">タイトル</span>
        </>
      )}
    </span>
  );
}

type OpStyleControlsProps = {
  value: OpConfig;
  disabled?: boolean;
  onChange: (value: OpConfig) => void;
};

/**
 * フェーズV5: ハイライト予告の装飾4種(ミニ実描画カード)+テロップ登場アニメ3択。
 * OpSection(テーマ設定)と OpEditorModal(run単位編集)で共有する。
 */
export function OpStyleControls({ value, disabled, onChange }: OpStyleControlsProps) {
  return (
    <>
      <div className="opDecorationBlock">
        <span className="opSubsectionLabel">装飾パターン</span>
        <div className="opDecorationRow">
          {OP_DECORATIONS.map((decoration) => {
            const info = OP_DECORATION_INFO[decoration];
            return (
              <button
                className={`opDecorationCard ${value.decoration === decoration ? "selected" : ""}`}
                disabled={disabled}
                key={decoration}
                onClick={() => onChange({ ...value, decoration })}
                title={info.description}
                type="button"
              >
                <OpDecorationSample decoration={decoration} />
                <span className="opPatternLabel">{info.label}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="opTextAnimBlock">
        <span className="opSubsectionLabel">テロップの登場アニメ</span>
        <div className="opTextAnimRow">
          {OP_TEXT_ANIMATIONS.map((animation) => {
            const info = OP_TEXT_ANIMATION_INFO[animation];
            return (
              <button
                className={`opTextAnimChip ${value.text_animation === animation ? "selected" : ""}`}
                disabled={disabled}
                key={animation}
                onClick={() => onChange({ ...value, text_animation: animation })}
                title={info.description}
                type="button"
              >
                {info.label}
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

type OpSectionProps = {
  value: OpConfig;
  disabled?: boolean;
  onChange: (value: OpConfig) => void;
};

/** フェーズU8→V5: OP(オープニング)の2択カード+装飾・アニメ選択+タイトル/キャッチコピー入力。 */
export function OpSection({ value, disabled, onChange }: OpSectionProps) {
  const editable = value.pattern !== "none";
  return (
    <div className="themeExtrasSection">
      <div className="themeExtrasSectionHeader">
        <span className="themeExtrasSectionTitle">オープニング(動画の冒頭3〜7秒)</span>
        <span
          className="helpIcon"
          title={
            "動画の先頭に「番組が始まる」とわかる短いOPを自動生成します。\n" +
            "タイトル未入力のときはAIが動画の内容からタイトルを作ります。\n" +
            "「表示しない」にチェックするとタイトルなしのOPになります。\n" +
            "ハイライト予告はAIが見どころと判定したカットを自動で選びます。"
          }
        >
          ?
        </span>
      </div>
      <div className="opPatternRow">
        {OP_PATTERNS.map((pattern) => {
          const info = OP_PATTERN_INFO[pattern];
          return (
            <button
              className={`opPatternCard ${value.pattern === pattern ? "selected" : ""}`}
              disabled={disabled}
              key={pattern}
              onClick={() => onChange({ ...value, pattern })}
              title={info.description}
              type="button"
            >
              <OpPatternFigure pattern={pattern} />
              <span className="opPatternLabel">
                {info.label}
                {info.durationLabel && <span className="opPatternDuration">{info.durationLabel}</span>}
              </span>
              <span className="opPatternDescription">{info.description}</span>
            </button>
          );
        })}
      </div>
      {/* フェーズV5: 装飾・テキストアニメはハイライト予告のときだけ意味を持つ */}
      {editable && <OpStyleControls disabled={disabled} onChange={onChange} value={value} />}
      <div className={`opTextInputs ${editable ? "" : "themeExtrasDisabled"}`}>
        <label className="opTextInputLabel">
          タイトル
          <input
            disabled={disabled || !editable || !value.title_enabled}
            onChange={(event) => onChange({ ...value, title: event.target.value })}
            placeholder="空欄=AIが内容からタイトルを作る"
            value={value.title}
          />
        </label>
        {/* W11-5: タイトルを出さない選択肢(op_config.title_enabled=false)。 */}
        <label className="themeExtrasToggle">
          <input
            checked={!value.title_enabled}
            disabled={disabled || !editable}
            onChange={(event) => onChange({ ...value, title_enabled: !event.target.checked })}
            type="checkbox"
          />
          表示しない
        </label>
        <label className="opTextInputLabel">
          キャッチコピー
          <input
            disabled={disabled || !editable}
            onChange={(event) => onChange({ ...value, catch_copy: event.target.value })}
            placeholder="空欄=キャッチコピーなし"
            value={value.catch_copy}
          />
        </label>
      </div>
    </div>
  );
}
