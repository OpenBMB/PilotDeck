export type ComposerPrimaryAction = 'stop' | 'resume' | 'send';

export function getComposerPrimaryAction({
  isLoading,
  isInputQueuePaused,
  hasDraftContent,
}: {
  isLoading: boolean;
  isInputQueuePaused: boolean;
  hasDraftContent: boolean;
}): ComposerPrimaryAction {
  if (isLoading && !hasDraftContent) return 'stop';
  if (isInputQueuePaused && !hasDraftContent) return 'resume';
  return 'send';
}
