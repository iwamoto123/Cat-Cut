/** 一覧ペインだけをスクロールし、プレビューやページ全体は動かさない。 */
export function revealSceneRow(row: HTMLElement, onlyWhenOutside = false) {
  const pane = row.closest<HTMLElement>(".sceneRowListPane");
  if (!pane) return;
  const bounds = pane.getBoundingClientRect();
  const rect = row.getBoundingClientRect();
  const visibleTop = bounds.top + pane.clientTop;
  if (onlyWhenOutside && rect.top >= visibleTop && rect.top < visibleTop + pane.clientHeight &&
      (rect.bottom <= visibleTop + pane.clientHeight || rect.height > pane.clientHeight)) return;
  pane.style.paddingBottom = `${Math.max(72, pane.clientHeight - rect.height + 16)}px`;
  pane.scrollTo({ top: pane.scrollTop + rect.top - visibleTop, behavior: "instant" });
}
