type PreviewAudio = Pick<HTMLAudioElement, "play" | "pause" | "addEventListener" | "removeEventListener">;

/** Track one-shot sounds so an explicit preview pause also stops effects already playing. */
export function createPreviewAudioGroup() {
  const active = new Map<PreviewAudio, () => void>();
  function release(audio: PreviewAudio) {
    const done = active.get(audio);
    if (done) {
      audio.removeEventListener("ended", done);
      audio.removeEventListener("error", done);
      active.delete(audio);
    }
  }
  return {
    play(audio: PreviewAudio) {
      const done = () => release(audio);
      active.set(audio, done);
      audio.addEventListener("ended", done);
      audio.addEventListener("error", done);
      void audio.play().then(() => { if (!active.has(audio)) audio.pause(); }).catch(done);
    },
    pauseAll() {
      for (const audio of active.keys()) { audio.pause(); release(audio); }
    },
  };
}
