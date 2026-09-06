import { useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import { getPresetCatalog, type TelopStyleDef } from "../lib/telopThemes";
import {
  FONT_OPTIONS,
  LATIN_FONT_OPTIONS,
  formStateToStyleDef,
  matchFontOption,
  styleDefToFormState,
  type BackgroundMode,
  type StrokeForm,
  type TelopStyleFormState,
} from "../lib/telopStyleEditor";
import { ANIMATION_PICKER_OPTIONS, SFX_PICKER_OPTIONS } from "../lib/telopAnimations";
import { SEMANTIC_TYPE_INFO, type SemanticType } from "../lib/telopTypes";
import { TelopStyledText } from "./TelopStyledText";

/**
 * フェーズU6: テロップスタイル詳細エディタ(ポップアップモーダル)。
 *
 * 開く経路は3つ(プレビュー上のテロップクリック / シーン行スタイルバッジの「デザインを編集…」/
 * デザインテーマ調整画面の「編集」)。どの経路でも「ベーススタイル+文脈(シーン or type)」を
 * 受け取り、編集結果は
 *  - 「このシーンだけに適用」: onApplyToScene(custom_scene_* ID+定義) → telop_directives経由
 *  - 「テーマの◯◯スタイルとして保存」: onSaveToTheme(custom_<theme>_<type> ID+定義) →
 *    design_themes.json の custom_styles 経由
 * のどちらかで永続化される。フォーム⇔スタイル定義の変換は lib/telopStyleEditor.ts の純関数。
 */

export type TelopStyleEditorContext = {
  /** 開いた時点のベーススタイル定義(リセットの戻り先)。 */
  initialStyle: TelopStyleDef;
  /** ベースにしたスタイルID(タイトル表示・プリセット読み込みの初期値)。 */
  initialStyleId: string;
  /** ライブプレビューのサンプル文言(シーン文言。無ければ既定文言)。 */
  sampleText?: string;
  /** 「このシーンだけに適用」の対象シーンID(null=シーン文脈なし=テーマ保存のみ)。 */
  sceneId: string | null;
  /** テーマ保存先のsemantic type(シーンのtype、テーマ調整画面の行のtype)。 */
  semanticType: SemanticType | null;
};

type Props = {
  context: TelopStyleEditorContext;
  /** アクティブなデザインテーマ(null=スタンダード選択中はテーマ保存不可)。 */
  activeTheme: { id: string; name: string } | null;
  onClose: () => void;
  /** シーン個別適用。呼び出し側がsceneIdからcustom_scene_*のIDを生成して登録・保存する。 */
  onApplyToScene: (sceneId: string, def: TelopStyleDef) => Promise<void> | void;
  /** テーマのtypeスタイルとして保存(styleIdはcustom_<theme>_<type>)。 */
  onSaveToTheme: (semanticType: SemanticType, def: TelopStyleDef) => Promise<void> | void;
};

const DEFAULT_SAMPLE_TEXT = "テロップのデザインを編集";
/** ライブプレビューの表示フォントサイズ上限(px)。モーダル幅に収める。 */
const PREVIEW_MAX_FONT_PX = 44;

const STROKE_LABELS = ["第1縁(内側)", "第2縁(外側)", "第3縁(太枠・最背面)"];

function SliderRow({
  label,
  min,
  max,
  step,
  value,
  onChange,
  format,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
}) {
  return (
    <label className="styleEditorSliderRow">
      <span className="styleEditorSliderLabel">{label}</span>
      <input max={max} min={min} onChange={(event) => onChange(Number(event.target.value))} step={step} type="range" value={value} />
      <span className="styleEditorSliderValue">{format ? format(value) : value}</span>
    </label>
  );
}

function ColorRow({
  label,
  hex,
  onChangeHex,
  opacity,
  onChangeOpacity,
}: {
  label: string;
  hex: string;
  onChangeHex: (hex: string) => void;
  opacity?: number;
  onChangeOpacity?: (opacity: number) => void;
}) {
  return (
    <div className="styleEditorColorRow">
      <span className="styleEditorSliderLabel">{label}</span>
      <input onChange={(event) => onChangeHex(event.target.value)} type="color" value={hex} />
      {opacity !== undefined && onChangeOpacity ? (
        <>
          <input
            max={1}
            min={0}
            onChange={(event) => onChangeOpacity(Number(event.target.value))}
            step={0.05}
            title="不透明度"
            type="range"
            value={opacity}
          />
          <span className="styleEditorSliderValue">{Math.round(opacity * 100)}%</span>
        </>
      ) : null}
    </div>
  );
}

export function TelopStyleEditorModal({ context, activeTheme, onClose, onApplyToScene, onSaveToTheme }: Props) {
  const [form, setForm] = useState<TelopStyleFormState>(() => styleDefToFormState(context.initialStyle));
  const [busy, setBusy] = useState(false);
  const [loadPresetId, setLoadPresetId] = useState("");

  const styleDef = useMemo(() => formStateToStyleDef(form), [form]);
  const sampleText = context.sampleText?.trim() || DEFAULT_SAMPLE_TEXT;
  const previewFontPx = Math.min(PREVIEW_MAX_FONT_PX, Math.max(14, Math.round((styleDef.font_size ?? 72) * 0.5)));

  const presetOptions = useMemo(() => {
    // 「プリセットから読み込み」の選択肢(77プリセット+実行時登録済みカスタム)
    return Object.keys(getPresetCatalog()).sort();
  }, []);

  function patch(update: Partial<TelopStyleFormState>) {
    setForm((current) => ({ ...current, ...update }));
  }

  function patchStroke(index: number, update: Partial<StrokeForm>) {
    setForm((current) => {
      const strokes = [...current.strokes] as TelopStyleFormState["strokes"];
      strokes[index] = { ...strokes[index], ...update };
      return { ...current, strokes };
    });
  }

  function handleLoadPreset(presetId: string) {
    setLoadPresetId(presetId);
    if (!presetId) return;
    const preset = getPresetCatalog()[presetId];
    if (preset) setForm(styleDefToFormState(preset));
  }

  async function handleApplyToScene() {
    if (!context.sceneId || busy) return;
    setBusy(true);
    try {
      // IDはApp側(customSceneStyleId)で決めるのではなくここで固定しない:
      // 呼び出し側がシーンIDから安定IDを生成する(モーダルはシーン管理を知らない)
      await onApplyToScene(context.sceneId, styleDef);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveToTheme() {
    if (!activeTheme || busy) return;
    setBusy(true);
    try {
      await onSaveToTheme(context.semanticType ?? "default", styleDef);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  const typeLabel = SEMANTIC_TYPE_INFO[context.semanticType ?? "default"].label;
  const fontMatch = matchFontOption(form.fontFamily);

  return (
    <div className="commandPaletteBackdrop" onClick={onClose} role="presentation">
      <div className="telopStyleEditorModal" onClick={(event) => event.stopPropagation()} role="dialog">
        <div className="userDictionaryModalTitle">
          <span>テロップデザインの編集</span>
          <span className="styleEditorBaseId">ベース: {context.initialStyleId}</span>
        </div>

        {/* ライブプレビュー: 変更が即時反映される(TelopStyledText=書き出しと同じDOM描画) */}
        <div className="styleEditorPreview">
          <TelopStyledText fontSizePx={previewFontPx} lines={[sampleText]} style={styleDef} />
        </div>

        <div className="styleEditorToolbar">
          <select onChange={(event) => handleLoadPreset(event.target.value)} title="既存プリセットをベースとして読み込む" value={loadPresetId}>
            <option value="">プリセットから読み込み…</option>
            {presetOptions.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <button
            className="styleEditorResetButton"
            onClick={() => {
              setForm(styleDefToFormState(context.initialStyle));
              setLoadPresetId("");
            }}
            title="開いた時点のデザインへ戻す"
            type="button"
          >
            <RotateCcw size={12} />
            リセット
          </button>
        </div>

        <div className="styleEditorSections">
          {/* フォント */}
          <details className="styleEditorSection" open>
            <summary>フォント</summary>
            <div className="styleEditorFontList">
              {FONT_OPTIONS.map((option) => (
                <button
                  className={`styleEditorFontOption ${fontMatch?.family === option.family ? "selected" : ""}`}
                  key={option.label}
                  onClick={() => patch({ fontFamily: option.family })}
                  style={{ fontFamily: option.family }}
                  title={option.family}
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>
            <SliderRow label="サイズ" max={140} min={32} onChange={(value) => patch({ fontSize: value })} step={2} value={form.fontSize} format={(v) => `${v}px`} />
            <SliderRow label="太さ" max={900} min={100} onChange={(value) => patch({ fontWeight: value })} step={100} value={form.fontWeight} />
            <SliderRow label="字間" max={0.3} min={-0.1} onChange={(value) => patch({ letterSpacing: value })} step={0.01} value={form.letterSpacing} format={(v) => `${v.toFixed(2)}em`} />
            <SliderRow label="行間" max={2} min={1} onChange={(value) => patch({ lineHeight: value })} step={0.05} value={form.lineHeight} format={(v) => v.toFixed(2)} />
          </details>

          {/* 塗り */}
          <details className="styleEditorSection" open>
            <summary>塗り</summary>
            <div className="styleEditorRadioRow">
              <label>
                <input checked={form.fillMode === "solid"} onChange={() => patch({ fillMode: "solid" })} type="radio" />
                単色
              </label>
              <label>
                <input checked={form.fillMode === "gradient"} onChange={() => patch({ fillMode: "gradient" })} type="radio" />
                グラデーション
              </label>
            </div>
            {form.fillMode === "solid" ? (
              <ColorRow
                hex={form.fillColorHex}
                label="文字色"
                onChangeHex={(hex) => patch({ fillColorHex: hex })}
                onChangeOpacity={(opacity) => patch({ fillOpacity: opacity })}
                opacity={form.fillOpacity}
              />
            ) : (
              <>
                <ColorRow hex={form.gradientFrom} label="開始色" onChangeHex={(hex) => patch({ gradientFrom: hex })} />
                <ColorRow hex={form.gradientTo} label="終了色" onChangeHex={(hex) => patch({ gradientTo: hex })} />
                <div className="styleEditorRadioRow">
                  {([
                    ["vertical", "縦"],
                    ["horizontal", "横"],
                    ["diagonal", "斜め"],
                  ] as const).map(([direction, label]) => (
                    <label key={direction}>
                      <input
                        checked={form.gradientDirection === direction}
                        onChange={() => patch({ gradientDirection: direction })}
                        type="radio"
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </>
            )}
          </details>

          {/* 縁取り(3段) */}
          <details className="styleEditorSection" open>
            <summary>縁取り(3重まで)</summary>
            {form.strokes.map((stroke, index) => (
              <div className="styleEditorStrokeRow" key={STROKE_LABELS[index]}>
                <label className="styleEditorToggle">
                  <input checked={stroke.enabled} onChange={(event) => patchStroke(index, { enabled: event.target.checked })} type="checkbox" />
                  {STROKE_LABELS[index]}
                </label>
                {stroke.enabled ? (
                  <>
                    <input onChange={(event) => patchStroke(index, { colorHex: event.target.value })} type="color" value={stroke.colorHex} />
                    <input
                      max={40}
                      min={1}
                      onChange={(event) => patchStroke(index, { width: Number(event.target.value) })}
                      step={1}
                      title="太さ(px)"
                      type="range"
                      value={stroke.width}
                    />
                    <span className="styleEditorSliderValue">{stroke.width}px</span>
                  </>
                ) : null}
              </div>
            ))}
          </details>

          {/* 効果 */}
          <details className="styleEditorSection" open>
            <summary>効果</summary>
            <label className="styleEditorToggle">
              <input
                checked={form.dropShadow.enabled}
                onChange={(event) => patch({ dropShadow: { ...form.dropShadow, enabled: event.target.checked } })}
                type="checkbox"
              />
              ドロップシャドウ
            </label>
            {form.dropShadow.enabled ? (
              <>
                <SliderRow label="ぼかし" max={30} min={0} onChange={(value) => patch({ dropShadow: { ...form.dropShadow, blur: value } })} step={1} value={form.dropShadow.blur} format={(v) => `${v}px`} />
                <SliderRow label="距離" max={30} min={0} onChange={(value) => patch({ dropShadow: { ...form.dropShadow, distance: value } })} step={1} value={form.dropShadow.distance} format={(v) => `${v}px`} />
                <SliderRow label="角度" max={360} min={0} onChange={(value) => patch({ dropShadow: { ...form.dropShadow, angle: value } })} step={15} value={form.dropShadow.angle} format={(v) => `${v}°`} />
                <ColorRow
                  hex={form.dropShadow.colorHex}
                  label="影の色"
                  onChangeHex={(hex) => patch({ dropShadow: { ...form.dropShadow, colorHex: hex } })}
                  onChangeOpacity={(opacity) => patch({ dropShadow: { ...form.dropShadow, colorOpacity: opacity } })}
                  opacity={form.dropShadow.colorOpacity}
                />
              </>
            ) : null}
            <label className="styleEditorToggle">
              <input checked={form.glowEnabled} onChange={(event) => patch({ glowEnabled: event.target.checked })} type="checkbox" />
              光彩(グロウ)
            </label>
            {form.glowEnabled ? (
              <>
                <ColorRow hex={form.glowColorHex} label="光の色" onChangeHex={(hex) => patch({ glowColorHex: hex })} />
                <SliderRow label="半径" max={60} min={2} onChange={(value) => patch({ glowRadius: value })} step={1} value={form.glowRadius} format={(v) => `${v}px`} />
              </>
            ) : null}
            <label className="styleEditorToggle">
              <input checked={form.hardShadowEnabled} onChange={(event) => patch({ hardShadowEnabled: event.target.checked })} type="checkbox" />
              ハードシャドウ(ずらし影)
            </label>
            {form.hardShadowEnabled ? (
              <>
                <SliderRow label="X" max={20} min={-20} onChange={(value) => patch({ hardShadowX: value })} step={1} value={form.hardShadowX} format={(v) => `${v}px`} />
                <SliderRow label="Y" max={20} min={-20} onChange={(value) => patch({ hardShadowY: value })} step={1} value={form.hardShadowY} format={(v) => `${v}px`} />
                <ColorRow hex={form.hardShadowColorHex} label="影の色" onChangeHex={(hex) => patch({ hardShadowColorHex: hex })} />
              </>
            ) : null}
          </details>

          {/* 文字背景 */}
          <details className="styleEditorSection">
            <summary>文字背景</summary>
            <div className="styleEditorRadioRow">
              {([
                ["none", "なし"],
                ["band", "行帯"],
                ["box", "ボックス"],
              ] as const).map(([mode, label]) => (
                <label key={mode}>
                  <input checked={form.backgroundMode === mode} onChange={() => patch({ backgroundMode: mode as BackgroundMode })} type="radio" />
                  {label}
                </label>
              ))}
            </div>
            {form.backgroundMode !== "none" ? (
              <ColorRow
                hex={form.backgroundColorHex}
                label="背景色"
                onChangeHex={(hex) => patch({ backgroundColorHex: hex })}
                onChangeOpacity={(opacity) => patch({ backgroundOpacity: opacity })}
                opacity={form.backgroundOpacity}
              />
            ) : null}
            {form.backgroundMode === "box" ? (
              <>
                <SliderRow label="左右余白" max={120} min={0} onChange={(value) => patch({ backgroundPaddingX: value })} step={4} value={form.backgroundPaddingX} format={(v) => `${v}px`} />
                <SliderRow label="上下余白" max={80} min={0} onChange={(value) => patch({ backgroundPaddingY: value })} step={4} value={form.backgroundPaddingY} format={(v) => `${v}px`} />
                <SliderRow label="角丸" max={40} min={0} onChange={(value) => patch({ backgroundRadius: value })} step={2} value={form.backgroundRadius} format={(v) => `${v}px`} />
              </>
            ) : null}
          </details>

          {/* 詳細 */}
          <details className="styleEditorSection">
            <summary>詳細</summary>
            <SliderRow
              format={(v) => `${Math.round(v * 100)}%`}
              label="縦位置"
              max={0.3}
              min={-0.3}
              onChange={(value) => patch({ yPositionOffset: Math.round(value * 100) / 100 })}
              step={0.01}
              value={form.yPositionOffset}
            />
            <label className="styleEditorToggle">
              <input checked={form.highlightEnabled} onChange={(event) => patch({ highlightEnabled: event.target.checked })} type="checkbox" />
              強調語の色を指定
            </label>
            {form.highlightEnabled ? (
              <ColorRow hex={form.highlightColorHex} label="強調色" onChangeHex={(hex) => patch({ highlightColorHex: hex })} />
            ) : null}
            <SliderRow
              format={(v) => (v >= 0.999 ? "無効" : `${Math.round(v * 100)}%`)}
              label="助詞縮小"
              max={1}
              min={0.5}
              onChange={(value) => patch({ particleScale: value })}
              step={0.05}
              value={form.particleScale}
            />
            <label className="styleEditorSelectRow">
              <span className="styleEditorSliderLabel">欧文フォント</span>
              <select onChange={(event) => patch({ latinFontFamily: event.target.value })} value={form.latinFontFamily}>
                {LATIN_FONT_OPTIONS.map((option) => (
                  <option key={option.id || "default"} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="styleEditorSelectRow">
              <span className="styleEditorSliderLabel">登場アニメ</span>
              <select onChange={(event) => patch({ animationIn: event.target.value })} value={form.animationIn}>
                {ANIMATION_PICKER_OPTIONS.map((option) => (
                  <option key={option.id || "preset_default"} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="styleEditorSelectRow">
              <span className="styleEditorSliderLabel">効果音</span>
              <select onChange={(event) => patch({ sfx: event.target.value })} value={form.sfx}>
                {SFX_PICKER_OPTIONS.map((option) => (
                  <option key={option.id || "preset_default"} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </details>
        </div>

        <div className="telopReplaceModalActions styleEditorActions">
          {context.sceneId ? (
            <button disabled={busy} onClick={() => void handleApplyToScene()} type="button">
              {busy ? "適用中…" : "このシーンだけに適用"}
            </button>
          ) : null}
          <button
            disabled={busy || !activeTheme}
            onClick={() => void handleSaveToTheme()}
            title={activeTheme ? `テーマ「${activeTheme.name}」の${typeLabel}スタイルを置き換えます` : "デザインテーマを選択すると保存できます(スタンダードは変更不可)"}
            type="button"
          >
            {activeTheme ? `テーマの「${typeLabel}」スタイルとして保存` : "テーマ未選択(保存不可)"}
          </button>
          <button disabled={busy} onClick={onClose} type="button">
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
}
