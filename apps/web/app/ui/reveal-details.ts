/** Reveal an existing focus target without remounting or clearing any form. */
export function revealDetailsFor(element: Element | null) {
  let ancestor = element?.parentElement ?? null;
  while (ancestor) {
    if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
    ancestor = ancestor.parentElement;
  }
}
