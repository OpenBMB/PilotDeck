import { randomUUID } from 'node:crypto';
import { readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { CanonicalContentBlock, CanonicalMessage, CanonicalModelRequest, CanonicalToolSchema, CanonicalToolResultContentBlock } from '../../model/index.js';
import type { ContextBreakdown } from '../../context/budget/TokenBudgetManager.js';

export type ModelContextSnapshot = {
  version: 1;
  turnId: string;
  capturedAt: string;
  provider: string;
  model: string;
  systemPrompt: string;
  tools: CanonicalToolSchema[];
  messages: CanonicalMessage[];
  breakdown?: ContextBreakdown;
  mediaOmitted: boolean;
};

export function createModelContextSnapshot(request: CanonicalModelRequest, turnId: string,
  breakdown?: ContextBreakdown): ModelContextSnapshot {
  let mediaOmitted = false;
  const inspectBlock = (block: CanonicalContentBlock): CanonicalContentBlock => {
    if (['image', 'pdf', 'audio'].includes(block.type) && 'source' in block && block.source === 'base64') {
      mediaOmitted = true;
      return { ...block, data: '[binary payload omitted]' };
    }
    if (block.type === 'tool_result') {
      const { raw: _raw, ...result } = block;
      return { ...result, content: block.content.map(inspectBlock) as CanonicalToolResultContentBlock[] };
    }
    if (block.type === 'tool_call') {
      const { raw: _raw, ...call } = block;
      return call;
    }
    return block;
  };
  const snapshot = JSON.parse(JSON.stringify({ version: 1, turnId, capturedAt: new Date().toISOString(),
    provider: request.provider, model: request.model, systemPrompt: request.systemPrompt ?? '',
    tools: request.tools ?? [], messages: request.messages.map(message => ({ ...message, content: message.content.map(inspectBlock) })),
    breakdown })) as ModelContextSnapshot;
  return { ...snapshot, mediaOmitted };
}

// Only the latest assembled request is retained, separately from JSONL history.
// Full context is fetched on demand, never broadcast to all streaming clients.
export async function writeModelContextSnapshot(transcriptPath: string, snapshot: ModelContextSnapshot): Promise<void> {
  const target = `${transcriptPath}.context.json`;
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function readModelContextSnapshot(transcriptPath: string, snapshotRoot: string): Promise<ModelContextSnapshot | null> {
  const root = resolve(snapshotRoot);
  const target = resolve(`${transcriptPath}.context.json`);
  if (!target.startsWith(`${root}${sep}`)) throw new Error('Context snapshot is outside session storage.');
  try {
    const canonicalRoot = await realpath(root);
    const canonicalTarget = await realpath(target);
    if (!canonicalTarget.startsWith(`${canonicalRoot}${sep}`)) throw new Error('Context snapshot resolves outside session storage.');
    const value = JSON.parse(await readFile(canonicalTarget, 'utf8')) as ModelContextSnapshot;
    return value && value.version === 1 && typeof value.turnId === 'string' && typeof value.systemPrompt === 'string'
      && Array.isArray(value.tools) && Array.isArray(value.messages) ? value : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}
