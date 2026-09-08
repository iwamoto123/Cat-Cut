export type EditorSelection = {
  kind: "video" | "telop" | "image" | "bgm";
  id: string;
} | null;

/** preview updates do not add history; commit closes one gesture; import appends new media. */
export type MediaEditPhase = "preview" | "commit" | "import";

export function isEditorSelection(selection: EditorSelection, kind: NonNullable<EditorSelection>["kind"], id: string) {
  return selection?.kind === kind && selection.id === id;
}
