import { useState } from "react";
import { setBgmVolume } from "../../lib/bgmClips";
import type { BgmUiClip } from "./BgmTrackV2";

type Props = { clip: BgmUiClip; disabled?: boolean; onCommit: (clip: BgmUiClip) => void };

/** Keep the raw draft while typing, so clearing the field does not jump to 0.0. */
export function BgmVolumeInput({ clip, disabled, onCommit }: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  const displayedVolume = Number((clip.volume * 100).toFixed(1)).toString();
  return (
    <label className="timelineBgmVolumeControl">
      <span>音量</span>
      <input
        aria-label="BGM音量（パーセント）"
        disabled={disabled}
        max={100}
        min={0}
        onBlur={() => {
          if (draft !== null && draft.trim() !== "") {
            const percent = Number(draft);
            if (Number.isFinite(percent)) onCommit({ ...clip, ...setBgmVolume(clip, percent / 100) });
          }
          setDraft(null);
        }}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setDraft(null);
          }
        }}
        step={0.1}
        type="number"
        value={draft ?? displayedVolume}
      />
      <span>%</span>
    </label>
  );
}
