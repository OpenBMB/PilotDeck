import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createModelContextSnapshot, readModelContextSnapshot, writeModelContextSnapshot } from '../../src/session/context/ModelContextSnapshot.js';
import { TokenAccountingRuntime } from '../../src/context/budget/TokenAccountingRuntime.js';
import { readWebSessionMessages } from '../../src/web/server/readSessionMessages.js';
import { getPilotProjectChatDir } from '../../src/pilot/index.js';
import { mkdir } from 'node:fs/promises';
import type { CanonicalModelRequest } from '../../src/model/index.js';

const request: CanonicalModelRequest = { provider: 'test', model: 'm', systemPrompt: 'System <instructions> 系统',
  tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { raw: { type: 'string' } } } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Actual synthetic context' },
    { type: 'image', source: 'base64', data: 'binary-body', mimeType: 'image/png' }] }] };

test('snapshot preserves assembled text/tools and omits binary media without changing model input', () => {
  const accounting = new TokenAccountingRuntime({ modelConfig: { providers: {} } });
  const breakdown = accounting.estimateRequestBreakdown(request);
  assert.equal(Object.values(breakdown).reduce((sum, tokens) => sum + tokens, 0), accounting.estimateRequestInput(request));
  const snapshot = createModelContextSnapshot(request, 'turn-1', breakdown);
  assert.equal(snapshot.systemPrompt, request.systemPrompt);
  assert.deepEqual(snapshot.tools, request.tools);
  assert.equal(snapshot.mediaOmitted, true);
  assert.ok(!JSON.stringify(snapshot).includes('binary-body'));
  assert.equal(JSON.stringify(request).includes('binary-body'), true);
});

test('latest snapshot is atomic, opt-in on history reads and invalidated by a replaced/new turn', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pilotdeck-model-context-'));
  try {
    const projectRoot = join(home, 'project');
    const chatDir = getPilotProjectChatDir(projectRoot, home);
    await mkdir(chatDir, { recursive: true });
    const transcript = join(chatDir, 's.jsonl');
    const input = (turnId: string) => JSON.stringify({ type: 'accepted_input', sessionId: 's', turnId,
      sequence: 1, createdAt: new Date().toISOString(), messages: request.messages }) + '\n';
    await writeFile(transcript, input('turn-1'));
    assert.equal(await readModelContextSnapshot(transcript), null);
    await writeModelContextSnapshot(transcript, createModelContextSnapshot(request, 'turn-1'));
    const options = { projectRoot, pilotHome: home };
    assert.equal((await readWebSessionMessages({ sessionKey: 's' }, options)).modelContext, undefined);
    assert.equal((await readWebSessionMessages({ sessionKey: 's', includeModelContext: true }, options)).modelContext?.turnId, 'turn-1');
    await writeFile(transcript, input('turn-2'));
    assert.equal((await readWebSessionMessages({ sessionKey: 's', includeModelContext: true }, options)).modelContext, null);
    await writeModelContextSnapshot(transcript, createModelContextSnapshot({ ...request, systemPrompt: 'Updated' }, 'turn-2'));
    assert.equal((await readModelContextSnapshot(transcript))?.systemPrompt, 'Updated');
    assert.ok((await readFile(`${transcript}.context.json`, 'utf8')).includes('Updated'));
  } finally { await rm(home, { recursive: true, force: true }); }
});
