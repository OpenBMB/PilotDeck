import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../../types/app';
import { createUserTurnRunId, startSessionCommand } from './sessionLauncher';

describe('sessionLauncher turn identity', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates UUID identities for new user turns', () => {
    expect(createUserTurnRunId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('falls back when Web Crypto is unavailable on an insecure origin', () => {
    vi.stubGlobal('crypto', undefined);

    expect(createUserTurnRunId()).toMatch(/^web-turn-\d+-\d+$/);
  });

  it('uses getRandomValues when randomUUID is unavailable', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(0),
    });

    expect(createUserTurnRunId()).toBe('00000000-0000-4000-8000-000000000000');
  });

  it('forwards the optimistic user run id in the command options', () => {
    const sendMessage = vi.fn();

    startSessionCommand({
      sendMessage,
      selectedProject: { name: 'PilotDeck', path: '/workspace/PilotDeck' } as Project,
      command: 'Continue.',
      runId: 'run-user-1',
      sessionId: 'web:session-1',
    });

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pilotdeck-command',
      options: expect.objectContaining({
        sessionId: 'web:session-1',
        runId: 'run-user-1',
      }),
    }));
  });
});
