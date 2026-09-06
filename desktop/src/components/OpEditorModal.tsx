// フェーズV2: OP編集モーダル。run単位の op_config.json(このrunのOPの正本)を編集する。
// - パターン4択+タイトル/キャッチコピーは既存の OpSection(ThemeExtrasSections)を統合
// - highlight_teaser のクリップ一覧(サムネ+シーン番号+テロップ文言+尺)を表示し、
//   差し替え(シーンピッカー)・文言編集・並び替え・削除・追加ができる
// - AIの自動選定に戻す(clips=null)ボタンつき。保存は op_config.json 更新のみで、
//   映像への反映はシーン編集と同じ「適用」(step08再実行)タイミングに乗せる
import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2, X } from "lucide-react";
import type { Scene } from "../lib/scenes";
import { DEFAULT_OP_CONFIG } from "../lib/designExtras";
import { nearestFilmstripFrame } from "../lib/timelineLayout";
import {
  moveOpClip,
  opClipDurationLabel,
  opClipFromScene,
  opClipMidpointMs,
  opClipsFromTimelineOp,
  sceneNumberForOpClip,
  type OpClip,
  type RunOpConfig,
} from "../lib/opEditor";
import { OpSection } from "./ThemeExtrasSections";

type PickerTarget = { mode: "replace"; index: number } | { mode: "add" } | null;

type Props = {
  open: boolean;
  runDir: string;
  scenes: Scene[];
  /** composition timeline.op(AI選定済みクリップの初期表示に使う)。 */
  timelineOp: unknown;
  /** App側で読み込み済みのrun単位OP設定(null=モーダル側で読み込む)。 */
  config: RunOpConfig | null;
  onClose: () => void;
  /** 保存成功時に正規化済み設定を親へ返す(タイムラインViewの表示更新に使う)。 */
  onSaved: (config: RunOpConfig) => void;
};

/** シーンの1行目テキスト(ピッカー・行ラベル用の省略表示)。 */
function sceneSnippet(scene: Scene): string {
  const line = (scene.telopText || "").split("\n")[0].trim();
  return line.length > 24 ? `${line.slice(0, 24)}…` : line || "(テロップなし)";
}

export function OpEditorModal({ open, runDir, scenes, timelineOp, config, onClose, onSaved }: Props) {
  const [draft, setDraft] = useState<RunOpConfig | null>(null);
  const [frames, setFrames] = useState<Array<{ ms: number; url: string }>>([]);
  const [picker, setPicker] = useState<PickerTarget>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // 開くたびに正本(op_config.json)から下書きを作り直す(親のconfigがあればそれを初期値に)
  useEffect(() => {
    if (!open) return;
    setPicker(null);
    setSaveError(null);
    if (config) {
      setDraft({ ...config, clips: config.clips ? config.clips.map((clip) => ({ ...clip })) : null });
      return;
    }
    let cancelled = false;
    window.catcut
      .getOpConfig(runDir)
      .then((loaded) => {
        if (!cancelled) setDraft(loaded as RunOpConfig);
      })
      .catch(() => {
        if (!cancelled) setDraft({ ...DEFAULT_OP_CONFIG, clips: null });
      });
    return () => {
      cancelled = true;
    };
  }, [open, runDir, config]);

  // サムネはタイムラインViewと同じfilmstripキャッシュを流用(失敗してもサムネ無しで成立)
  useEffect(() => {
    if (!open || !runDir) return;
    let cancelled = false;
    window.catcut
      .generateFilmstrip({ runDir })
      .then((result) => {
        if (!cancelled) setFrames(result.frames);
      })
      .catch(() => {
        if (!cancelled) setFrames([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, runDir]);

  const aiClips = useMemo(() => opClipsFromTimelineOp(timelineOp), [timelineOp]);

  if (!open) return null;

  const isAuto = !draft?.clips;
  // clips=null(AI自動選定)の間は composition のAI選定結果を一覧表示し、
  // 何か編集した瞬間にそのリストを明示clipsとして引き継ぐ(見たまま編集になる)
  const displayClips: OpClip[] = draft?.clips ?? aiClips;

  const updateDraft = (patch: Partial<RunOpConfig>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setSaveError(null);
  };

  const updateClips = (next: OpClip[]) => {
    updateDraft({ clips: next });
  };

  const handleClipChange = (index: number, patch: Partial<OpClip>) => {
    updateClips(displayClips.map((clip, i) => (i === index ? { ...clip, ...patch } : clip)));
  };

  const handlePick = (scene: Scene) => {
    if (!picker) return;
    const clip = opClipFromScene(scene);
    if (picker.mode === "add") {
      updateClips([...displayClips, clip]);
    } else {
      // 差し替えでは編集済みのテロップ文言を維持しない(別シーンの文言が自然な初期値)
      updateClips(displayClips.map((current, i) => (i === picker.index ? clip : current)));
    }
    setPicker(null);
  };

  // フェーズV5-2: 保存成功でモーダルを閉じ、フィードバック(トースト)と
  // タイムライン即時更新は親のonSavedが担う。V2までは「保存後もモーダルが開いたまま・
  // 小さな文字のnoticeのみ」で、画面が動かず保存できたか分かりにくかった。
  const handleSave = async () => {
    if (!draft || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await window.catcut.saveOpConfig({ runDir, config: draft });
      onSaved(saved as RunOpConfig);
      onClose();
    } catch {
      // 失敗時はモーダルを開いたままエラーを見せる(編集内容を失わせない)
      setSaveError("保存に失敗しました。もう一度お試しください。");
    } finally {
      setSaving(false);
    }
  };

  const thumbnail = (ms: number) => nearestFilmstripFrame(frames, ms)?.url ?? null;

  return (
    <div className="commandPaletteBackdrop" onClick={onClose} role="presentation">
      <div className="opEditorModal" onClick={(event) => event.stopPropagation()} role="dialog">
        <div className="opEditorHeader">
          <span className="opEditorTitle">オープニング編集（この動画だけの設定）</span>
          <button className="opEditorCloseButton" onClick={onClose} title="閉じる" type="button">
            <X size={16} />
          </button>
        </div>
        <div className="opEditorBody">
          {draft && (
            <OpSection
              onChange={(next) => updateDraft({ ...next })}
              value={{
                pattern: draft.pattern,
                decoration: draft.decoration,
                text_animation: draft.text_animation,
                title: draft.title,
                // W11-5: 「表示しない」チェック(旧draftはsanitize済みのため常にbooleanが入る)
                title_enabled: draft.title_enabled,
                catch_copy: draft.catch_copy,
              }}
            />
          )}
          {draft?.pattern === "highlight_teaser" && (
            <div className="opEditorClipsSection">
              <div className="opEditorClipsHeader">
                <span className="themeExtrasSectionTitle">ダイジェストのクリップ</span>
                <span className="opEditorClipsMode">
                  {isAuto ? "AIが自動選定中（編集すると手動選定に切り替わります）" : "手動選定"}
                </span>
                {!isAuto && (
                  <button
                    className="opEditorResetButton"
                    onClick={() => updateDraft({ clips: null })}
                    title="手動の選定を破棄し、AIの自動選定（見どころ判定）に戻します"
                    type="button"
                  >
                    <RotateCcw size={12} />
                    AIの選定に戻す
                  </button>
                )}
              </div>
              {displayClips.length === 0 && (
                <div className="opEditorEmpty">
                  クリップがまだありません。「クリップを追加」でシーンから選ぶか、適用後にAIの選定結果が表示されます。
                </div>
              )}
              <div className="opEditorClipList">
                {displayClips.map((clip, index) => {
                  const url = thumbnail(opClipMidpointMs(clip));
                  const sceneNumber = sceneNumberForOpClip(scenes, clip);
                  return (
                    <div className="opEditorClipRow" key={`${clip.start_ms}_${index}`}>
                      <span className="opEditorClipOrder">{index + 1}</span>
                      <button
                        className="opEditorClipThumb"
                        onClick={() => setPicker({ mode: "replace", index })}
                        title="クリックで別のシーンに差し替え"
                        type="button"
                      >
                        {url ? <img alt="" src={url} /> : <span className="opEditorClipThumbEmpty" />}
                      </button>
                      <div className="opEditorClipInfo">
                        <span className="opEditorClipMeta">
                          {sceneNumber !== null ? `シーン${sceneNumber}` : "シーン対応なし"}・{opClipDurationLabel(clip)}
                          <select
                            className="opEditorClipDisplaySelect"
                            onChange={(event) => {
                              const display = event.target.value as OpClip["display"];
                              // フック切替時に空なら発話テロップ文言を初期値として引き継ぐ
                              handleClipChange(
                                index,
                                display === "hook" && !clip.hook_text
                                  ? { display, hook_text: clip.text }
                                  : { display },
                              );
                            }}
                            title="テロップの見せ方。フックワード=一言を画面いっぱいに大きく／発話テロップ=話した内容をそのまま帯で表示"
                            value={clip.display}
                          >
                            <option value="hook">フックワード（大きく表示）</option>
                            <option value="verbatim">発話テロップ（そのまま）</option>
                          </select>
                        </span>
                        {clip.display === "hook" ? (
                          <div className="opEditorHookFields">
                            <textarea
                              className="opEditorClipTextInput opEditorHookTextInput"
                              onChange={(event) => handleClipChange(index, { hook_text: event.target.value })}
                              placeholder="フックワード（1〜2語。改行で上下2段）"
                              rows={clip.hook_text.includes("\n") ? 2 : 1}
                              value={clip.hook_text}
                            />
                            <div className="opEditorHookMetaRow">
                              <input
                                className="opEditorClipTextInput opEditorHookKeywordInput"
                                onChange={(event) => handleClipChange(index, { keyword: event.target.value })}
                                placeholder="強調する語（色分け）"
                                title="フックワードの中で色を変える語（空欄=色分けなし）"
                                value={clip.keyword}
                              />
                              <select
                                className="opEditorClipDisplaySelect"
                                onChange={(event) =>
                                  handleClipChange(index, {
                                    keyword_color: event.target.value as OpClip["keyword_color"],
                                  })
                                }
                                title="強調語の色。黄=結論・肯定／赤=断定・警告／白=中立"
                                value={clip.keyword_color}
                              >
                                <option value="yellow">黄（結論・肯定）</option>
                                <option value="red">赤（断定・警告）</option>
                                <option value="white">白（中立）</option>
                              </select>
                            </div>
                          </div>
                        ) : (
                          <input
                            className="opEditorClipTextInput"
                            onChange={(event) => handleClipChange(index, { text: event.target.value })}
                            placeholder="テロップ文言（空欄=テロップなし）"
                            value={clip.text}
                          />
                        )}
                      </div>
                      <div className="opEditorClipActions">
                        <button
                          disabled={index === 0}
                          onClick={() => updateClips(moveOpClip(displayClips, index, -1))}
                          title="上へ"
                          type="button"
                        >
                          <ArrowUp size={13} />
                        </button>
                        <button
                          disabled={index === displayClips.length - 1}
                          onClick={() => updateClips(moveOpClip(displayClips, index, 1))}
                          title="下へ"
                          type="button"
                        >
                          <ArrowDown size={13} />
                        </button>
                        <button
                          onClick={() => updateClips(displayClips.filter((_, i) => i !== index))}
                          title="このクリップを削除"
                          type="button"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <button
                className="opEditorAddButton"
                onClick={() => setPicker({ mode: "add" })}
                type="button"
              >
                <Plus size={13} />
                クリップを追加
              </button>
              {picker && (
                <div className="opEditorScenePicker">
                  <div className="opEditorScenePickerHeader">
                    <span>
                      {picker.mode === "add"
                        ? "追加するシーンを選んでください"
                        : `クリップ${picker.index + 1}を差し替えるシーンを選んでください`}
                    </span>
                    <button onClick={() => setPicker(null)} type="button">
                      キャンセル
                    </button>
                  </div>
                  <div className="opEditorScenePickerList">
                    {scenes.map((scene, index) => {
                      const url = thumbnail(Math.round((scene.sourceStartMs + scene.sourceEndMs) / 2));
                      return (
                        <button
                          className="opEditorScenePickerItem"
                          key={scene.id}
                          onClick={() => handlePick(scene)}
                          type="button"
                        >
                          {url ? <img alt="" src={url} /> : <span className="opEditorClipThumbEmpty" />}
                          <span className="opEditorScenePickerLabel">
                            <span className="opEditorScenePickerNumber">シーン{index + 1}</span>
                            <span className="opEditorScenePickerText">{sceneSnippet(scene)}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="opEditorFooter">
          {saveError && <span className="opEditorSaveError">{saveError}</span>}
          <button className="secondaryButton" onClick={onClose} type="button">
            閉じる
          </button>
          <button
            className="primaryButton"
            disabled={!draft || saving}
            onClick={() => void handleSave()}
            type="button"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
