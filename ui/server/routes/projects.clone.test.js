import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('cloneGitHubRepository', () => {
  it('terminates the Git process when its caller aborts', async () => {
    const child = createChildProcess();
    const cloneGitHubRepository = await loadCloneHelper(child);
    const controller = new AbortController();
    const pending = cloneGitHubRepository('https://github.com/openbmb/PilotDeck.git', '/tmp/PilotDeck', null, {
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });

    controller.abort();

    await rejected;
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('terminates the Git process after the clone timeout', async () => {
    vi.useFakeTimers();
    const child = createChildProcess();
    const cloneGitHubRepository = await loadCloneHelper(child);
    const pending = cloneGitHubRepository('https://github.com/openbmb/PilotDeck.git', '/tmp/PilotDeck', null, { timeoutMs: 100 });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'GIT_CLONE_TIMEOUT' });

    await vi.advanceTimersByTimeAsync(100);

    await rejected;
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

function createChildProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn((signal) => {
    queueMicrotask(() => child.emit('close', null, signal));
    return true;
  });
  return child;
}

async function loadCloneHelper(child) {
  vi.doMock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    const spawn = vi.fn(() => child);
    return { ...actual, spawn, default: { ...(actual.default || actual), spawn } };
  });
  vi.doMock('../projects.js', () => ({ addProjectManually: vi.fn(), extractProjectDirectory: vi.fn() }));
  vi.doMock('../discovery-plans.js', () => ({
    getProjectDiscoveryContext: vi.fn(),
    getProjectDiscoveryPlansOverview: vi.fn(),
    getProjectDiscoveryPlanReport: vi.fn(),
    rerunDiscoveryPlan: vi.fn(),
    getProjectWorkCycles: vi.fn(),
    applyWorkCycle: vi.fn(),
    archiveWorkCycle: vi.fn(),
  }));
  return (await import('./projects.js')).cloneGitHubRepository;
}
