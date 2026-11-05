/** Keep manually inspected children visible through automatic parent phase changes. */
export function disclosureAncestorKeys(trigger: HTMLElement, scope: string): string[] {
  const block = trigger.closest<HTMLElement>('[data-process-block]');
  // Its own button must perform the toggle once, using the pre-click value.
  const process = block?.querySelector(':scope > button') === trigger ? undefined : block?.dataset.processBlock;
  const turn = trigger.closest<HTMLElement>('[data-turn-process-region]')?.dataset.turnProcessRegion;
  return [process, turn].filter((id): id is string => Boolean(id)).map(id => `${scope}:${id}`);
}
