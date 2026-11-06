/** A top-layer select owns Escape before any application dialog or shortcut.
 * Do not prevent its default: the browser must dismiss it and restore focus.
 * One listener covers dynamically mounted controls without observing the DOM.
 */
export function installFormControlEvents() {
  if (!globalThis.CSS?.supports?.('appearance: base-select')) return () => {};
  const keydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && document.querySelector('select:open')) event.stopImmediatePropagation();
  };
  window.addEventListener('keydown', keydown, true);
  return () => window.removeEventListener('keydown', keydown, true);
}
