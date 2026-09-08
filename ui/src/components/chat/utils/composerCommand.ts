import type { SlashCommand } from '../hooks/useSlashCommands';

/** Use the same command resolution for button availability and execution. */
export function getSubmittedCommand(input: string, selected: SlashCommand[], commands: SlashCommand[]): SlashCommand | undefined {
  if (selected.length === 1) return selected[0];
  const name = input.trim().match(/^(\/\S+)/)?.[1];
  return name ? commands.find((command) => command.name === name) : undefined;
}

export function isModelIndependentCommand(command?: SlashCommand): boolean {
  if (!command || command.path || command.metadata?.passthrough) return false;
  // Pinned/frequent are display groups; keep the underlying command type.
  const kind = command.type || command.metadata?.type || command.namespace;
  return kind === 'builtin';
}
