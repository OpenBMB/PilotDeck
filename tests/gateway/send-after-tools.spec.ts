import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSession } from '../../src/agent/session/AgentSession.js';
import { TurnRunner } from '../../src/agent/turn/TurnRunner.js';
import type { AgentLoop, AgentLoopInput, AgentLoopRunResult } from '../../src/agent/loop/AgentLoop.js';
import type { AgentEvent } from '../../src/agent/protocol/events.js';
import { InMemoryTranscriptWriter } from '../../src/session/transcript/InMemoryTranscriptWriter.js';
import { InProcessGateway } from '../../src/gateway/client/InProcessGateway.js';
import { SessionRouter } from '../../src/gateway/SessionRouter.js';
import { createRegisteredWebProjectResolver } from '../../src/web/server/listProjects.js';
import { createProjectId } from '../../src/pilot/index.js';
import { currentRequestContext } from '../../src/network/requestContext.js';

test('tool task followed by explicit models and Auto accepts each turn once and releases the session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilotdeck-fast-send-'));
  const pilotHome = join(root, 'home');
  const project = join(root, 'project');
  const transcript = new InMemoryTranscriptWriter();
  const requestedModels: Array<string | undefined> = [];
  let router: SessionRouter | undefined;
  try {
    await mkdir(project);
    const registration = join(pilotHome, 'projects', createProjectId(project));
    await mkdir(registration, {recursive: true});
    await writeFile(join(registration, '.cwd'), project);
    const resolver = createRegisteredWebProjectResolver({pilotHome});
    const loop = {
      async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
        const context = currentRequestContext();
        assert.equal(context.sessionId, input.sessionId);
        assert.equal(context.turnId, input.turnId);
        assert.equal(context.projectPath, project);
        assert.equal(context.userId, 'a'.repeat(32));
        assert.equal(context.parentRequestId, `request-${input.turnId}`);
        requestedModels.push(input.modelOverride?.model);
        if (input.turnId === 'tools') {
          await writeFile(join(project, 'game.html'), '<h1>Game</h1>');
          yield {type:'tool_result',sessionId:input.sessionId,turnId:input.turnId,result:{
            type:'success',toolCallId:'write',toolName:'write_file',content:[{type:'file',path:join(project,'game.html')}],
            startedAt:new Date().toISOString(),completedAt:new Date().toISOString(),
          }};
        }
        const result = {type:'success' as const,sessionId:input.sessionId,turnId:input.turnId,stopReason:'completed' as const,
          usage:{},permissionDenials:[],turns:1,startedAt:new Date().toISOString(),completedAt:new Date().toISOString()};
        yield {type:'turn_completed',sessionId:input.sessionId,turnId:input.turnId,result};
        return {result,messages:input.messages};
      },
    } as unknown as AgentLoop;
    router = new SessionRouter({createSession: async ({sessionKey}) => new AgentSession({sessionId:sessionKey,
      turnRunner:new TurnRunner(loop,transcript,undefined,undefined,undefined,{cwd:project,transcriptPath:''},{autoGenerateSessionTitle:false}),
    })});
    const gateway = new InProcessGateway(router, {resolveTurnModelSelection: async input => {
      assert.equal(await resolver(input.projectKey!), project);
      return input.modelSelection?.mode === 'model' ? {source:'turn',selection:input.modelSelection} : {source:'router'};
    }});
    for (const [index, model] of ['minicpm5-2b', 'minicpm5-2b', 'qwen3.8-27b', undefined].entries()) {
      const runId = index === 0 ? 'tools' : `follow-${index}`;
      const events = [];
      for await (const event of gateway.submitTurn({sessionKey:'test-session',projectKey:project,channelKey:'web',runId,message:'Continue',
        requestContext: { userId: 'a'.repeat(32), parentRequestId: `request-${runId}` },
        modelSelection:model ? {mode:'model',provider:'test',model} : {mode:'auto'},
      })) events.push(event);
      assert.equal(events.filter(e => e.type === 'input_accepted').length, 1);
      assert.equal(events.filter(e => e.type === 'turn_completed').length, 1);
      assert.equal(events.filter(e => e.type === 'error').length, 0);
      assert.equal(router.hasActiveTurn('test-session'), false);
      assert.equal((await gateway.getActiveTurnSnapshot({sessionKey:'test-session'})).active, false);
    }
    assert.deepEqual(requestedModels, ['minicpm5-2b','minicpm5-2b','qwen3.8-27b',undefined]);
    assert.equal(transcript.entries.filter(e => e.type === 'accepted_input').length, 4);
  } finally { router?.shutdown(); await rm(root,{recursive:true,force:true}); }
});
