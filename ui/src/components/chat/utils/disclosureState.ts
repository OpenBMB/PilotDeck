import { turnProcessKey, type RenderableMessageItem } from './processGrouping';

export type ProcessExpansionChoice = { expanded: boolean; defaultExpanded: boolean };

export function processDisclosureDefaults(items: RenderableMessageItem[], scope: string): Map<string, boolean> {
  const defaults = new Map<string, boolean>();
  for (const item of items) {
    if (item.turnTrace) defaults.set(`${scope}:${item.turnTrace.id}`, item.turnTrace.defaultExpanded);
    for (const group of [item.processRun, item.beforeTurnProcess, item.afterTurnProcess]) {
      if (group) defaults.set(turnProcessKey(scope, group), group.defaultExpanded);
    }
  }
  return defaults;
}

export function resolveProcessExpansion(choice: ProcessExpansionChoice | undefined, defaultExpanded: boolean): boolean {
  // A reply or full batch closes choices made during work; reopening it records a new phase.
  if (choice?.expanded && choice.defaultExpanded && !defaultExpanded) return false;
  return choice?.expanded ?? defaultExpanded;
}

/** Open the ancestors of a deliberately inspected child. */
export function disclosureAncestorKeys(trigger: HTMLElement, scope: string): string[] {
  const block = trigger.closest<HTMLElement>('[data-process-block]');
  // Its own button must perform the toggle once, using the pre-click value.
  const process = block?.querySelector(':scope > button') === trigger ? undefined : block?.dataset.processBlock;
  const turn = trigger.closest<HTMLElement>('[data-turn-process-region]')?.dataset.turnProcessRegion;
  return [process, turn].filter((id): id is string => Boolean(id)).map(id => `${scope}:${id}`);
}
