import type { ChatMessage } from '../types/types';
import { objectValue } from './toolPresentation';

export type ImagePurpose = 'intermediate' | 'deliverable';

export const isDrawingTool = (name: string) => name === 'generate_image' || name === 'edit_image';

export function hasImageAttachment(message: ChatMessage): boolean {
  const image = objectValue(objectValue(message.toolResult?.toolUseResult).imageGeneration);
  return typeof image.imageId === 'string' && image.imageId.length > 0
    && typeof image.sessionId === 'string' && image.sessionId.length > 0;
}

/** Read the same durable choice during execution and history replay. */
export function imagePurpose(message: ChatMessage): ImagePurpose {
  const input = objectValue(message.toolInput);
  const image = objectValue(objectValue(message.toolResult?.toolUseResult).imageGeneration);
  for (const purpose of [image.purpose, input.purpose]) {
    if (purpose === 'intermediate' || purpose === 'deliverable') return purpose;
  }
  // Older calls did not declare intent. Keep their project assets in the
  // process; an explicit purpose always takes priority, even for saved drawings.
  return [input.output_path, image.savedTo].some(path => typeof path === 'string' && path.trim() !== '')
    ? 'intermediate' : 'deliverable';
}

export function isImageDeliverable(message: ChatMessage): boolean {
  return Boolean(message.isToolUse && isDrawingTool(String(message.toolName))
    && !message.toolResult?.isError && imagePurpose(message) === 'deliverable'
    && (!message.toolResult || hasImageAttachment(message)));
}
