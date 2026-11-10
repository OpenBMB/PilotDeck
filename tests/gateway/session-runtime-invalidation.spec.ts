import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionRouter } from '../../src/gateway/SessionRouter.js';
import { AgentSession } from '../../src/agent/session/AgentSession.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function session(id: string, onDispose: () => void = () => {}) {
  return new AgentSession({ sessionId: id, turnRunner: { dispose: async () => { onDispose(); } } as never });
}

for (const scope of ['project', 'global'] as const) {
  test(`${scope} reload during initialization invalidates only the affected projects`, async t => {
    const pending = { a: deferred<AgentSession>(), b: deferred<AgentSession>() };
    const disposed: string[] = [];
    const recreated: string[] = [];
    const initial = { a: session('a', () => { disposed.push('a'); }), b: session('b', () => { disposed.push('b'); }) };
    const replacement = { a: session('a-next'), b: session('b-next') };
    const contexts = {
      a: { sessionKey: 'a', projectKey: '/project-a', channelKey: 'web' },
      b: { sessionKey: 'b', projectKey: '/project-b', channelKey: 'web' },
    };
    const router = new SessionRouter({ idleSweepIntervalMs: 0,
      createSession: ({ sessionKey }) => pending[sessionKey as 'a' | 'b'].promise,
      recreateSession: ({ sessionKey }) => {
        recreated.push(sessionKey);
        return replacement[sessionKey as 'a' | 'b'];
      },
    });
    t.after(() => router.shutdown());
    const a = router.getOrCreate(contexts.a), b = router.getOrCreate(contexts.b);
    if (scope === 'global') router.markAllDirty('config_changed');
    else router.markProjectDirty(contexts.a.projectKey, 'extension_changed');
    pending.a.resolve(initial.a);
    pending.b.resolve(initial.b);
    assert.deepEqual(await Promise.all([a, b]), [initial.a, initial.b]);
    assert.deepEqual(disposed, [], 'An initializing session must not be disposed during reload');
    assert.equal(await router.getOrCreate(contexts.a), replacement.a);
    assert.equal(await router.getOrCreate(contexts.b), scope === 'global' ? replacement.b : initial.b);
    assert.deepEqual(recreated, scope === 'global' ? ['a', 'b'] : ['a']);
    assert.deepEqual(disposed, recreated);
  });
}

for (const scope of ['other-project', 'same-project', 'global'] as const) {
  test(`${scope} reload while recreating a session preserves the applicable revision`, async t => {
    const entered = deferred<void>(), pending = deferred<AgentSession>();
    const initial = session('initial'), replacement = session('replacement'), final = session('final');
    let recreations = 0;
    const context = { sessionKey: 'session-b', projectKey: '/project-b', channelKey: 'web' };
    const router = new SessionRouter({ idleSweepIntervalMs: 0,
      createSession: () => initial,
      recreateSession: () => {
        if (++recreations === 1) { entered.resolve(); return pending.promise; }
        return final;
      },
    });
    t.after(() => router.shutdown());
    await router.getOrCreate(context);
    router.markProjectDirty(context.projectKey);
    // A caller resuming by session identity may omit the project. The cached
    // session's project must still determine which revision applies.
    const resumeContext = { sessionKey: context.sessionKey, channelKey: 'web' };
    const refreshing = router.getOrCreate(resumeContext);
    await entered.promise;
    if (scope === 'global') router.markAllDirty();
    else router.markProjectDirty(scope === 'same-project' ? context.projectKey : '/project-a');
    pending.resolve(replacement);
    assert.equal(await refreshing, replacement);
    assert.equal(await router.getOrCreate(resumeContext), scope === 'other-project' ? replacement : final);
    assert.equal(recreations, scope === 'other-project' ? 1 : 2);
  });
}
