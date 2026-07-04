import { useEffect, useMemo, useState } from "react";

export type DeterministicCommand =
  | "silence_stronger"
  | "silence_weaker"
  | "filler_off"
  | "filler_on"
  | "telop_font_bigger"
  | "telop_font_smaller";

type CommandOption = {
  id: DeterministicCommand;
  label: string;
  keywords: string[];
};

const COMMANDS: CommandOption[] = [
  { id: "silence_stronger", label: "無音カット 強く", keywords: ["無音", "カット", "強", "詰め"] },
  { id: "silence_weaker", label: "無音カット 弱く", keywords: ["無音", "カット", "弱", "緩"] },
  { id: "filler_off", label: "フィラーカットを全て解除", keywords: ["フィラー", "解除", "戻", "off"] },
  { id: "filler_on", label: "フィラーカットを適用", keywords: ["フィラー", "適用", "on"] },
  { id: "telop_font_bigger", label: "テロップを大きく", keywords: ["テロップ", "大き", "サイズ", "font"] },
  { id: "telop_font_smaller", label: "テロップを小さく", keywords: ["テロップ", "小さ", "サイズ", "font"] },
];

function scoreOption(option: CommandOption, query: string) {
  if (!query.trim()) return 0;
  let score = option.label.includes(query) ? 4 : 0;
  for (const keyword of option.keywords) {
    if (query.includes(keyword)) score += 2;
  }
  return score;
}

type Props = {
  open: boolean;
  onClose: () => void;
  onSubmit: (command: DeterministicCommand) => void;
};

export function CommandPalette({ open, onClose, onSubmit }: Props) {
  const [query, setQuery] = useState("");
  const options = useMemo(() => {
    if (!query.trim()) return COMMANDS;
    return [...COMMANDS]
      .map((option) => ({ option, score: scoreOption(option, query) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((item) => item.option);
  }, [query]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className="commandPaletteBackdrop" onClick={onClose} role="presentation">
      <div className="commandPalette" onClick={(event) => event.stopPropagation()} role="dialog">
        <input
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
          placeholder="コマンドを入力（例: 無音カット 強く）"
          value={query}
        />
        <div className="commandList">
          {options.map((option) => (
            <button
              key={option.id}
              onClick={() => {
                onSubmit(option.id);
                onClose();
              }}
              type="button"
            >
              {option.label}
            </button>
          ))}
          {!options.length && <span className="commandEmpty">一致するコマンドがありません</span>}
        </div>
      </div>
    </div>
  );
}
