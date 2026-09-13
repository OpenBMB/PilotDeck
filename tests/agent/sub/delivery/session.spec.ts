import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SubAgentSession } from '../../../../src/agent/sub/SubAgentSession.js';
import { SUBAGENT_DEFINITIONS } from '../../../../src/agent/sub/builtinSubagentTypes.js';
import { ToolRegistry } from '../../../../src/tool/registry/ToolRegistry.js';
import type { AgentRouterRuntime } from '../../../../src/agent/runtime/AgentRuntimeDependencies.js';
import type { CanonicalModelRequest } from '../../../../src/model/index.js';

async function harness(t: test.TestContext, deliveries: unknown[], options: Record<string, any> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'pilot-delivery-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const requests: CanonicalModelRequest[] = [];
  const router: AgentRouterRuntime = {
    decide: async ({ request }) => ({ provider: request.provider, model: request.model, scenarioType: 'default', isSubagent: true, orchestrating: false, resolvedFrom: 'fallback', mutations: {} }),
    execute: async function* (_decision, request) {
      requests.push(request);
      if (requests.length > 1 && options.repairFile) await writeFile(join(cwd, 'answer.md'), 'Repaired answer');
      yield { type: 'text_delta', text: typeof deliveries[Math.min(requests.length - 1, deliveries.length - 1)] === 'string' ? deliveries[Math.min(requests.length - 1, deliveries.length - 1)] as string : JSON.stringify(deliveries[Math.min(requests.length - 1, deliveries.length - 1)]) };
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
    },
    stream: async function* () { throw new Error('unexpected direct stream'); },
  };
  const session = new SubAgentSession({
    definition: SUBAGENT_DEFINITIONS['general-purpose'], directive: 'Deliver the assigned result.',
    parentConfig: {
      provider: 'main', model: 'main-model', cwd, runMode: 'agent', permissionMode: 'bypassPermissions',
      permissionContext: { mode: 'bypassPermissions', cwd, additionalWorkingDirectories: [], canPrompt: false, bypassAvailable: true, rules: { allow: [], deny: [], ask: [] } },
      ...options.config,
    },
    parentDependencies: { router, tools: { registry: new ToolRegistry(), scheduler: {} as never }, ...options.dependencies },
    parentSessionId: 'parent', parentTurnId: 'turn', subagentSessionId: 'child-session', subagentId: 'child-001',
    ...options.session,
  });
  return { cwd, requests, session };
}

test('Auto archives text-only output independently of the session', async t => {
  const { cwd, session, requests } = await harness(t, ['A useful conversational result.']);
  const report = await session.run();
  assert.ok(report.delivery, 'Auto must attach an independent delivery result');
  assert.equal(report.delivery!.status, 'skipped');
  assert.equal(requests.length, 1);
  assert.match(requests[0].systemPrompt ?? '', /delivery/i);
  const saved = JSON.parse(await readFile(report.delivery!.deliveryFile, 'utf8'));
  assert.equal(saved.delivery_file, report.delivery!.deliveryFile);
  assert.match(JSON.stringify(saved), /A useful conversational result/);
  assert.ok(report.delivery!.deliveryFile.startsWith(cwd));
});

test('Off preserves normal output without delivery guidance, files or Judge calls', async t => {
  let reviews = 0;
  const { cwd, session, requests } = await harness(t, ['Ordinary answer.'], {
    config: { delivery: { mode: 'off' } }, session: { delivery: { review: true } },
    dependencies: { deliveryReviewer: async () => { reviews++; throw new Error('should not review'); } },
  });
  const report = await session.run();
  assert.equal(report.delivery, undefined);
  assert.equal(report.markdown, 'Ordinary answer.');
  assert.equal(reviews, 0);
  assert.doesNotMatch(requests[0].systemPrompt ?? '', /delivery_file/);
  await assert.rejects(access(join(cwd, '.pilotdeck/deliveries')));
});

test('Auto repairs a supplied missing file in the same child context', async t => {
  const { session, requests } = await harness(t, [{ result: { file: 'answer.md' } }, { result: { file: 'answer.md' } }], { repairFile: true });
  const report = await session.run();
  assert.ok(report.delivery);
  assert.equal(report.delivery!.status, 'passed');
  assert.equal(report.delivery!.repairs, 1);
  assert.equal(requests.length, 2);
  assert.equal(report.delivery!.attempts[0].checks.status, 'failed');
  assert.equal(report.delivery!.attempts[1].checks.status, 'passed');
  assert.notEqual(report.delivery!.attempts[0].deliveryFile, report.delivery!.attempts[1].deliveryFile);
  assert.ok(requests[1].messages.length > requests[0].messages.length);
  assert.match(JSON.stringify(requests[1].messages), /answer\.md/);
  assert.equal(report.delivery!.producerUsage.totalTokens, 240);
});

test('Auto skips absent parent fields and all-empty payload without retry or Judge', async t => {
  let reviews = 0;
  const { session, requests } = await harness(t, [{}], {
    session: { delivery: { schema: { type: 'object', properties: { source: { type: 'string', 'x-file': true } } }, review: true } },
    dependencies: { deliveryReviewer: async () => { reviews++; throw new Error('no content'); } },
  });
  const report = await session.run();
  assert.equal(report.delivery?.status, 'skipped');
  assert.equal(report.delivery?.repairs, 0);
  assert.equal(requests.length, 1);
  assert.equal(reviews, 0);
});

test('Per-task Judge is opt-in, inherits main model and can repair a semantic error', async t => {
  const calls: any[] = [];
  const review = async (input: any) => {
    calls.push(input);
    return calls.length === 1
      ? { status: 'rejected', summary: 'Incorrect result', issues: [{ path: '$.result.text', code: 'requirement', message: 'Two plus two is four.' }], usage: { totalTokens: 30 }, durationMs: 1 }
      : { status: 'accepted', summary: 'Correct result', issues: [], usage: { totalTokens: 20 }, durationMs: 1 };
  };
  const { session } = await harness(t, [{ result: { text: '2+2=5' } }, { result: { text: '2+2=4' } }], {
    session: { delivery: { review: true } }, dependencies: { deliveryReviewer: review },
    config: { subagentModel: { provider: 'worker', model: 'cheap' } },
  });
  const report = await session.run();
  assert.equal(report.delivery?.status, 'passed');
  assert.equal(report.delivery?.repairs, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].model, { provider: 'main', model: 'main-model' });
  assert.equal(calls[0].producerMessages, undefined);
  assert.equal(report.delivery?.reviewUsage.totalTokens, 50);
  const other = await harness(t, [{ result: { text: '2+2=4' } }], { dependencies: { deliveryReviewer: review } });
  await other.session.run();
  assert.equal(calls.length, 2);
});

test('Editable guidance is injected once and an empty custom prompt omits the example', async t => {
  const custom = await harness(t, [{}], { config: { delivery: { prompt: 'CUSTOM DELIVERY EXAMPLE: adapt fields freely.' } } });
  await custom.session.run();
  assert.match(custom.requests[0].systemPrompt ?? '', /CUSTOM DELIVERY EXAMPLE/);
  assert.doesNotMatch(custom.requests[0].systemPrompt ?? '', /Output format \(mandatory/);
  const empty = await harness(t, [{}], { config: { delivery: { prompt: '' } } });
  await empty.session.run();
  assert.match(empty.requests[0].systemPrompt ?? '', /delivery_file/);
  assert.doesNotMatch(empty.requests[0].systemPrompt ?? '', /CUSTOM DELIVERY EXAMPLE/);
});

test('A requested review on empty content is explicitly skipped, not unrequested', async t => {
  const { session } = await harness(t, [{}], { session: { delivery: { review: true } } });
  const report = await session.run();
  assert.equal(report.delivery?.attempts[0].review?.status, 'skipped');
});

test('An injected reviewer failure is archived and never reported as accepted', async t => {
  const { session } = await harness(t, [{ result: { text: 'answer' } }], {
    session: { delivery: { review: true } }, dependencies: { deliveryReviewer: async () => { throw new Error('unavailable'); } },
  });
  const report = await session.run();
  assert.equal(report.delivery?.status, 'error');
  const stored = JSON.parse(await readFile(report.delivery!.deliveryFile, 'utf8'));
  assert.equal(stored.review.status, 'error');
});

test('Repair limit and total turn limit stop repeated failures', async t => {
  const limited = await harness(t, [{ result: { file: 'missing.txt' } }], { config: { delivery: { maxRepairs: 1 } } });
  const report = await limited.session.run();
  assert.equal(report.delivery?.status, 'failed');
  assert.equal(limited.requests.length, 2);
  assert.equal(report.delivery?.repairs, 1);
  const turns = await harness(t, [{ result: { file: 'missing.txt' } }], { config: { delivery: { maxTurns: 1 } } });
  await turns.session.run();
  assert.equal(turns.requests.length, 1);
});

test('Memory observer errors do not change the delivery result', async t => {
  const { session } = await harness(t, [{}], { dependencies: { deliveryObserver: () => { throw new Error('memory unavailable'); } } });
  assert.equal((await session.run()).delivery?.status, 'skipped');
});
