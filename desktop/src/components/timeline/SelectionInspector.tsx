import { useRef, useState } from "react";
import { Film, Image as ImageIcon, Music, SlidersHorizontal, Trash2, Type } from "lucide-react";
import type { EditorSelection, MediaEditPhase } from "../../lib/editorSelection";
import { normalizeSceneSpeed, SCENE_SPEEDS, type Scene } from "../../lib/scenes";
import type { TimelineCutRange } from "../../lib/previewTimeline";
import { sceneTimelineBlocks } from "../../lib/timelineLayout";
import { setBgmFade, setBgmVolume } from "../../lib/bgmClips";
import { clampImageScale } from "../../lib/imageOverlay";
import { formatPrecisionTime, parsePrecisionTime, setPrecisionBgmTime, setPrecisionImageTime, stepPrecisionFrame, type MediaTimeField } from "../../lib/precisionMedia";
import type { BgmState, BgmUiClip } from "./BgmTrackV2";
import type { ImagesState, ImageUiClip } from "./ImageTrack";
import { BgmGainControl } from "./BgmGainControl";
import "./precisionTimeline.css";

type PrecisionInputProps = {
  label: string;
  ariaLabel?: string;
  value: number;
  onCommit: (value: number) => void;
  disabled?: boolean;
  unit?: string;
  time?: boolean;
  fps?: number;
  min?: number;
  max?: number;
  step?: number;
};

/** One focus session is one history entry, including repeated arrow-key adjustments. */
function PrecisionInput({ label, ariaLabel, value, onCommit, disabled, unit, time, fps = 30, min = 0, max = Infinity, step = 0.1 }: PrecisionInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const format = (next: number) => time ? formatPrecisionTime(next) : String(Number(next.toFixed(3)));
  const parse = (raw: string) => time ? parsePrecisionTime(raw) : /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw.trim()) ? Number(raw) : null;
  const updateDraft = (raw: string | null) => { draftRef.current = raw; setDraft(raw); setInvalid(false); };
  function commitDraft() {
    const raw = draftRef.current;
    // Clear synchronously: Enter and the ensuing blur must share a single commit.
    updateDraft(null);
    if (raw === null) return;
    const parsed = parse(raw);
    if (parsed === null || !Number.isFinite(parsed)) { setInvalid(true); return; }
    const next = Math.max(min, Math.min(max, parsed));
    if (next !== value) onCommit(next);
  }
  return (
    <label className="precisionField">
      <span className="precisionFieldLabel">{label}</span>
      <span className={`precisionFieldInput${invalid ? " invalid" : ""}`}>
        <input
          aria-label={ariaLabel ?? label}
          aria-invalid={invalid || undefined}
          autoComplete="off"
          disabled={disabled}
          inputMode={time ? "text" : "decimal"}
          spellCheck={false}
          type="text"
          value={draft ?? format(value)}
          title={time ? "秒、分:秒.ミリ秒で入力。↑↓で1フレーム、Shiftで10フレーム。Enterで確定、Escで取消" : `↑↓で${step}${unit ?? ""}、Shiftで10倍。Enterで確定、Escで取消`}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => updateDraft(event.target.value)}
          onBlur={commitDraft}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Escape") {
              event.preventDefault(); event.stopPropagation();
              updateDraft(null); event.currentTarget.blur();
            } else if (event.key === "Enter") {
              event.preventDefault(); event.stopPropagation();
              commitDraft(); event.currentTarget.blur();
            } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault(); event.stopPropagation();
              const current = draftRef.current === null ? value : parse(draftRef.current) ?? value;
              const direction = event.key === "ArrowUp" ? 1 : -1;
              const amount = event.shiftKey ? 10 : 1;
              const next = time ? stepPrecisionFrame(current, direction, fps, amount) : current + direction * step * amount;
              updateDraft(format(Math.max(min, Math.min(max, next))));
            }
          }}
        />
        {unit && <span>{unit}</span>}
      </span>
    </label>
  );
}

export type SelectionInspectorProps = {
  selection: EditorSelection;
  scenes: Scene[];
  timelineCutRanges: TimelineCutRange[];
  timelineDurationMs: number;
  bgmState: BgmState | null;
  imagesState: ImagesState | null;
  fps?: number;
  disabled?: boolean;
  onBgmStateChange: (state: BgmState, phase?: MediaEditPhase) => void;
  onImagesStateChange: (state: ImagesState, phase?: MediaEditPhase) => void;
  getBgmState?: () => BgmState | null;
  getImagesState?: () => ImagesState | null;
  onSeekTimeline?: (ms: number) => void;
  onSetSceneSpeed?: (sceneId: string, speed: number) => void;
  onSetAllScenesSpeed?: (speed: number) => void;
  onEditSceneStyle?: (sceneId: string) => void;
  onDeleteSelection?: () => void;
};

/** Stable, dedicated controls keep small track clips available for fast selection and movement. */
export function SelectionInspector({ selection, scenes, timelineCutRanges, timelineDurationMs, bgmState, imagesState, fps = 30, disabled = false, onBgmStateChange, onImagesStateChange, getBgmState, getImagesState, onSeekTimeline, onSetSceneSpeed, onSetAllScenesSpeed, onEditSceneStyle, onDeleteSelection }: SelectionInspectorProps) {
  const bgm = selection?.kind === "bgm" ? bgmState?.clips.find((clip) => clip.id === selection.id) : undefined;
  const image = selection?.kind === "image" ? imagesState?.clips.find((clip) => clip.id === selection.id) : undefined;
  const scene = selection?.kind === "video" || selection?.kind === "telop" ? scenes.find((candidate) => candidate.id === selection.id) : undefined;
  const block = scene ? sceneTimelineBlocks([scene], timelineCutRanges)[0] : undefined;
  const media = bgm ?? image;
  const start = media?.start_ms ?? block?.timelineStartMs;
  const end = media?.end_ms ?? block?.timelineEndMs;
  const title = bgm ? "BGM" : image ? "画像" : selection?.kind === "telop" ? "テロップ" : scene ? "映像" : "調整";
  const Icon = bgm ? Music : image ? ImageIcon : selection?.kind === "telop" ? Type : scene ? Film : SlidersHorizontal;
  const name = media?.file ?? (scene ? `シーン ${scenes.findIndex((candidate) => candidate.id === scene.id) + 1}` : "対象を選択");

  function updateBgm(change: (clip: BgmUiClip) => BgmUiClip, phase: MediaEditPhase = "commit") {
    if (!bgm || disabled) return;
    const state = getBgmState?.() ?? bgmState;
    const latest = state?.clips.find((clip) => clip.id === bgm.id);
    if (!state || !latest) return;
    const next = change(latest);
    onBgmStateChange({ ...state, clips: state.clips.map((clip) => clip.id === latest.id ? next : clip) }, phase);
  }
  function updateImage(change: (clip: ImageUiClip) => ImageUiClip) {
    if (!image || disabled) return;
    const state = getImagesState?.() ?? imagesState;
    const latest = state?.clips.find((clip) => clip.id === image.id);
    if (!state || !latest) return;
    const next = change(latest);
    onImagesStateChange({ ...state, clips: state.clips.map((clip) => clip.id === latest.id ? next : clip) }, "commit");
  }
  function setTime(field: MediaTimeField, value: number) {
    if (bgm) updateBgm((clip) => setPrecisionBgmTime(clip, field, value, timelineDurationMs));
    if (image) updateImage((clip) => setPrecisionImageTime(clip, field, value, timelineDurationMs));
  }

  return (
    <aside className={`selectionInspector${selection ? ` selectionInspector-${selection.kind}` : ""}`} aria-label="選択対象の調整">
      <div className="selectionInspectorHeader">
        <span className="selectionInspectorIcon"><Icon size={17} /></span>
        <div><span className="selectionInspectorType">{title}</span><strong title={name}>{name}</strong></div>
        {selection && onDeleteSelection && <button type="button" className="selectionInspectorDelete" disabled={disabled} onClick={onDeleteSelection} title={selection.kind === "telop" ? "テロップだけを削除（Delete）" : "選択対象を削除（Delete）"} aria-label="選択対象を削除"><Trash2 size={16} /></button>}
      </div>
      {!media && !scene ? (
        <div className="selectionInspectorEmpty"><SlidersHorizontal size={24} /><p>クリップを選択すると<br />時間や見た目を数値で調整できます</p><span>クリックで選択 · ドラッグで移動</span></div>
      ) : (
        <div className="selectionInspectorBody" key={`${selection?.kind}:${selection?.id}`}>
          {start !== undefined && end !== undefined && (
            <section className="precisionSection">
              <div className="precisionSectionTitle"><span>タイミング</span><span>仕上がり時間</span></div>
              {media ? (
                <><div className="precisionFields">
                  <PrecisionInput label="開始" ariaLabel={`${title}開始時刻`} time fps={fps} value={start} disabled={disabled} onCommit={(value) => setTime("start", value)} />
                  <PrecisionInput label="終了" ariaLabel={`${title}終了時刻`} time fps={fps} value={end} disabled={disabled} onCommit={(value) => setTime("end", value)} />
                  <PrecisionInput label="長さ" ariaLabel={`${title}の長さ`} time fps={fps} value={end - start} disabled={disabled} onCommit={(value) => setTime("duration", value)} />
                  <div className="precisionSeekButtons"><button type="button" disabled={disabled || !onSeekTimeline} onClick={() => onSeekTimeline?.(start)}>開始へ</button><button type="button" disabled={disabled || !onSeekTimeline} onClick={() => onSeekTimeline?.(Math.max(start, end - 1000 / fps))}>終了へ</button></div>
                </div><p className="precisionHelp">開始は長さを保って移動。終了・長さは末尾を調整。</p></>
              ) : <div className="precisionReadout"><span>{formatPrecisionTime(start)} → {formatPrecisionTime(end)}</span><span>{((end - start) / 1000).toFixed(3)} 秒</span></div>}
            </section>
          )}
          {bgm && <section className="precisionSection">
            <div className="precisionSectionTitle"><span>オーディオ</span>{bgm.audioDurationMs > 0 && <span>音源 {(bgm.audioDurationMs / 1000).toFixed(1)} 秒</span>}</div>
            <div className="precisionFields">
              <PrecisionInput label="音量" ariaLabel="BGM音量（パーセント）" value={bgm.volume * 100} max={100} step={0.1} unit="%" disabled={disabled} onCommit={(value) => updateBgm((clip) => ({ ...clip, ...setBgmVolume(clip, value / 100) }))} />
              <BgmGainControl
                value={bgm.volume}
                getValue={() => (getBgmState?.() ?? bgmState)?.clips.find((clip) => clip.id === bgm.id)?.volume ?? bgm.volume}
                disabled={disabled}
                onChange={(value, phase) => updateBgm((clip) => ({ ...clip, ...setBgmVolume(clip, value) }), phase)}
              />
              <PrecisionInput label="フェードイン" ariaLabel="BGMフェードイン" time fps={fps} value={bgm.fade_in_ms} max={bgm.end_ms - bgm.start_ms} disabled={disabled} onCommit={(value) => updateBgm((clip) => ({ ...clip, ...setBgmFade(clip, "start", value) }))} />
              <PrecisionInput label="フェードアウト" ariaLabel="BGMフェードアウト" time fps={fps} value={bgm.fade_out_ms} max={bgm.end_ms - bgm.start_ms} disabled={disabled} onCommit={(value) => updateBgm((clip) => ({ ...clip, ...setBgmFade(clip, "end", value) }))} />
            </div>
          </section>}
          {image && <section className="precisionSection">
            <div className="precisionSectionTitle"><span>配置とサイズ</span><span>画面に対する比率</span></div>
            <div className="precisionFields">
              <PrecisionInput label="中心 X" ariaLabel="画像の中心X" value={image.x * 100} max={100} unit="%" disabled={disabled} onCommit={(value) => updateImage((clip) => ({ ...clip, x: value / 100 }))} />
              <PrecisionInput label="中心 Y" ariaLabel="画像の中心Y" value={image.y * 100} max={100} unit="%" disabled={disabled} onCommit={(value) => updateImage((clip) => ({ ...clip, y: value / 100 }))} />
              <PrecisionInput label="表示幅" ariaLabel="画像の表示幅" value={image.scale * 100} min={10} max={100} unit="%" disabled={disabled} onCommit={(value) => updateImage((clip) => ({ ...clip, scale: clampImageScale(value / 100) }))} />
              <PrecisionInput label="不透明度" ariaLabel="画像の不透明度" value={image.opacity * 100} max={100} unit="%" disabled={disabled} onCommit={(value) => updateImage((clip) => ({ ...clip, opacity: value / 100 }))} />
            </div>
          </section>}
          {scene && <section className="precisionSection">
            <div className="precisionSectionTitle"><span>{selection?.kind === "video" ? "再生速度" : "テロップ"}</span></div>
            {selection?.kind === "video" && onSetSceneSpeed && <div className="precisionSpeedButtons">{SCENE_SPEEDS.map((speed) => <button type="button" key={speed} disabled={disabled} className={normalizeSceneSpeed(scene.speed) === speed ? "active" : ""} onClick={() => onSetSceneSpeed(scene.id, speed)}>{speed}×</button>)}</div>}
            {selection?.kind === "video" && onSetAllScenesSpeed && <button type="button" className="precisionTextButton precisionApplySpeed" disabled={disabled} onClick={() => onSetAllScenesSpeed(normalizeSceneSpeed(scene.speed))}>全シーンを {normalizeSceneSpeed(scene.speed)}× に</button>}
            <p className="precisionSceneText">{scene.telopText || "テロップはありません"}</p>
            {onEditSceneStyle && <button type="button" className="precisionTextButton" disabled={disabled} onClick={() => onEditSceneStyle(scene.id)}>テロップの見た目を調整</button>}
          </section>}
          {media && <p className="precisionKeyboardHelp"><kbd>↑↓</kbd> 微調整 <kbd>Shift</kbd> 10倍 <kbd>Enter</kbd> 確定 <kbd>Esc</kbd> 取消</p>}
        </div>
      )}
    </aside>
  );
}
