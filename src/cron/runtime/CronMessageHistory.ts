import type { CronListResult } from '../protocol/types.js';
import type { WebReadSessionMessagesInput, WebReadSessionMessagesResult } from '../../web/client/protocol.js';

type Reader = (input: WebReadSessionMessagesInput) => Promise<WebReadSessionMessagesResult>;

/** Present retained per-run transcripts in the task flow without copying them into model context. */
export async function readCronMessageHistory(input: WebReadSessionMessagesInput, catalog: CronListResult, read: Reader): Promise<WebReadSessionMessagesResult> {
  const task = catalog.tasks.find(item => item.sessionKey === input.sessionKey);
  if (!task) return read(input);
  const archived = [...new Set((catalog.recentRuns || []).slice().reverse()
    .filter(run => run.taskId === task.taskId && run.sessionKey.startsWith(`cron:${task.taskId}:`) && run.sessionKey !== task.sessionKey)
    .map(run => run.sessionKey))];
  if (!archived.length) return read(input);
  const current = await read({ ...input, limit: undefined, cursor: undefined, direction: undefined, includeFromId: undefined });
  const messages = [] as WebReadSessionMessagesResult['messages'];
  for (const sessionKey of archived) {
    const history = await read({ sessionKey, projectKey: input.projectKey });
    messages.push(...history.messages);
  }
  messages.push(...current.messages);
  const unique = [...new Map(messages.map(message => [message.id, message])).values()];
  const backward = input.direction === 'backward';
  const anchor = input.cursor?.startsWith('before:') ? unique.findIndex(message => message.id === input.cursor!.slice(7)) : undefined;
  const includeFrom = !input.cursor && input.includeFromId ? unique.findIndex(message => message.id === input.includeFromId) : undefined;
  const reset = anchor === -1 || includeFrom === -1;
  const offset = /^\d+$/.test(input.cursor || '') ? Number(input.cursor) : 0;
  const end = backward ? anchor !== undefined && anchor >= 0 ? anchor : input.cursor && !reset ? Math.min(offset, unique.length) : unique.length
    : input.limit ? Math.min(offset + input.limit, unique.length) : unique.length;
  let start = backward ? Math.max(0, end - (input.limit || end)) : offset;
  if (backward) {
    if (includeFrom !== undefined && includeFrom >= 0) start = Math.min(start, includeFrom);
    const turnId = unique[start]?.turnId;
    if (turnId) start = unique.findIndex(message => message.turnId === turnId);
    else while (start > 0 && !(unique[start]?.kind === 'text' && unique[start]?.role === 'user')) start--;
  }
  const page = unique.slice(start, end);
  return { ...current, messages: page, total: unique.length, historyReset: reset || undefined,
    nextCursor: backward ? start > 0 ? `before:${page[0].id}` : undefined : end < unique.length ? String(end) : undefined };
}
