import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentLoop } from '../../src/agent/loop/AgentLoop.js';
import { DefaultContextRuntime } from '../../src/context/DefaultContextRuntime.js';
import { ToolRegistry } from '../../src/tool/registry/ToolRegistry.js';
import { createDefaultPermissionContext } from '../../src/permission/index.js';
import { buildOpenAIRequest } from '../../src/model/providers/openai/request.js';
import type { PythonRuntimeStatus } from '../../src/runtime/pythonRuntime.js';

test('actual model requests retain verified Python capabilities with custom prompts and compacted history', async () => {
  const status: PythonRuntimeStatus = { enabled: true, state: 'ready', executable: '/app user/python', environment: '/app user', version: '3.12.16', packages: { mcp: '1.30.0' } };
  for (const custom of [undefined, '', 'Custom assistant']) for (const compacted of [false, true]) {
    const config = { provider: 'test', model: 'test', cwd: '/workspace', systemPrompt: custom,
      env: { PRIVATE_KEY: 'do-not-publish' }, pythonRuntime: status, permissionMode: 'default' as const,
      permissionContext: createDefaultPermissionContext({ cwd: '/workspace', mode: 'default', canPrompt: false, bypassAvailable: false }) };
    const loop = new AgentLoop(config, {
      router: {} as never, context: new DefaultContextRuntime(),
      tools: { registry: new ToolRegistry(), scheduler: { executeAll: async () => [] } as never },
    });
    const messages = [{ role: 'user', content: [{ type: 'text', text: compacted ? '[CONTEXT COMPACTION - REFERENCE ONLY]\nContinue with Python' : 'Use Python' }] }];
    const request = await (loop as any).createModelRequest(messages, { sessionId: 'python-test', turnId: 'turn', messages }, { emitInstructionEvents: false });
    const serialized = JSON.stringify(buildOpenAIRequest(request, { capabilities: { maxOutputTokens: 1024 } } as never));
    assert.match(serialized, /Bundled Python 3\.12\.16 is ready/);
    assert.match(serialized, /mcp==1\.30\.0/);
    assert.match(serialized, /app user/);
    assert.ok(!serialized.includes('do-not-publish'));
    if (custom) assert.ok(serialized.includes(custom));
  }
});
