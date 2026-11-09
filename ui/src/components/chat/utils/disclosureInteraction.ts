/** Identify an intentional opening before React/native disclosure handlers run. */
export function expandingDisclosure(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const trigger = target.closest<HTMLElement>('button[aria-expanded][aria-controls], summary');
  if (!trigger) return null;
  return trigger.matches('summary')
    ? trigger.closest('details')?.open === false ? trigger : null
    : trigger.getAttribute('aria-expanded') === 'false' ? trigger : null;
}
