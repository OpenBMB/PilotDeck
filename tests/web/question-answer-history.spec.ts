import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenCanonicalMessage } from '../../src/web/server/readSessionMessages.js';
import { applyWebGatewayEvent, createWebMessageReducerState } from '../../src/web/client/webMessage.js';
import { toCanonicalToolResultBlock } from '../../src/tool/protocol/result.js';
import { createAskUserQuestionTool } from '../../src/tool/builtin/askUserQuestion.js';
import { InMemoryElicitationChannel } from '../../src/tool/elicitation/PilotDeckElicitationChannel.js';

for (const toolName of ['ask_user_question', 'AskUserQuestion']) {
  test(`${toolName} preserves real elicitation answers through canonical history and live projection`, async () => {
    const questions = [{ header: 'Scope', question: 'Which paths?', multiSelect: true,
      options: [{ label: 'A, B', description: 'Combined path' }, { label: 'C', description: 'Another path' }] }];
    const answers = { 'Which paths?': ['A, B', 'C', 'Custom, answer'] };
    const output = await createAskUserQuestionTool().execute({ questions }, {
      sessionId: 'session-id', turnId: 'question-turn', cwd: process.cwd(), permissionMode: 'bypassPermissions',
      permissionContext: { mode: 'bypassPermissions', cwd: process.cwd(), additionalWorkingDirectories: [],
        canPrompt: true, bypassAvailable: true, rules: { allow: [], deny: [], ask: [] } },
      elicitation: new InMemoryElicitationChannel(answers),
    });
    const block = toCanonicalToolResultBlock({ type: 'success', toolCallId: 'question-call', toolName,
      content: output.content, data: output.data, startedAt: '', completedAt: '' });
    const [row] = flattenCanonicalMessage({ role: 'user', content: [block] }, { index: 0, sessionKey: 'session-id' });
    assert.equal(row?.kind, 'tool_result');
    assert.deepEqual(row?.payload, { questions, answers });

    for (const withStart of [false, true]) {
      const options = { sessionKey: 'session-id', newId: () => 'message-id' };
      let state = createWebMessageReducerState();
      if (withStart) state = applyWebGatewayEvent(state, {
        type: 'tool_call_started', toolCallId: 'question-call', name: toolName,
      }, options);
      state = applyWebGatewayEvent(state, { type: 'tool_call_finished', toolCallId: 'question-call',
        ok: true, data: output.data }, options);
      assert.deepEqual(state.messages[0]?.payload, row?.payload);
    }
  });
}
