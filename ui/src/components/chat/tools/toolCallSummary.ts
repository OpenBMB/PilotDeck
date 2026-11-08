import type { TFunction } from 'i18next';
import type { ChatMessage } from '../types/types';
import { getProcessToolKind } from '../utils/processGrouping';
import { getCanonicalToolName } from './configs/toolConfigs';
import { displayText, objectValue } from './toolPresentation';

/** Share the action and target between the live group and its individual call. */
export function toolCallSummary(message: ChatMessage, running: boolean, t: TFunction<'chat'>) {
  const name = getCanonicalToolName(message.toolName || 'Tool');
  const input = objectValue(message.toolInput);
  const kind = getProcessToolKind(message);
  const file = displayText(input.file_path || input.path || input.image_path || input.file || input.filepath);
  const isEdit = ['Edit', 'Write', 'ApplyPatch'].includes(name);
  const target = name === 'Bash' ? displayText(input.description || input.command)
    : name === 'read_skill' ? displayText(input.skillName || input.skill_name || input.name)
    : isEdit || name === 'Read' || kind === 'image' ? file.split('/').pop() || file
    : displayText(input.query || input.pattern || input.url || input.description || input.command || input.prompt || message.toolName);
  const action = kind === 'image' ? 'viewImage' : kind === 'image-generation' ? 'generateImage'
    : kind === 'image-edit' ? 'editImage' : kind === 'video-generation' ? 'generateVideo'
    : kind === 'browse' ? 'browse' : kind === 'interaction' ? 'interact'
    : name === 'Bash' ? 'command' : isEdit ? (name === 'Write' ? 'write' : 'edit')
    : name === 'Read' ? 'read' : name === 'read_skill' ? 'skill'
    : ['Grep', 'Glob', 'web_search'].includes(name) ? 'search' : /^web[_-]?fetch$/i.test(name) ? 'fetch' : 'tool';
  const pending = message.toolResult == null;
  const active = pending && running;
  const label = action === 'fetch' && message.toolResult?.isError ? t('toolDisplay.fetchFailed')
    : t(`toolDisplay.${active ? 'running' : pending || message.toolResult?.isError ? 'pending' : 'done'}.${action}`);
  return { label, target };
}
