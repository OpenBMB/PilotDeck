import { describe, expect, it } from 'vitest';
import { startSessionCommand } from './sessionLauncher';
import type { Project } from '../../../types/app';

const project = {
  name: 'demo',
  path: '/workspace/demo',
  fullPath: '/workspace/demo',
} as Project;

describe('startSessionCommand', () => {
  it('reports successful websocket sends', () => {
    const result = startSessionCommand({
      sendMessage: () => true,
      selectedProject: project,
      command: 'hello',
      temporarySessionId: 'new-session-test',
    });

    expect(result).toEqual({
      sessionId: 'new-session-test',
      sent: true,
    });
  });

  it('reports when the websocket command could not be sent', () => {
    const result = startSessionCommand({
      sendMessage: () => false,
      selectedProject: project,
      command: 'hello',
      temporarySessionId: 'new-session-test',
    });

    expect(result).toEqual({
      sessionId: 'new-session-test',
      sent: false,
    });
  });
});
