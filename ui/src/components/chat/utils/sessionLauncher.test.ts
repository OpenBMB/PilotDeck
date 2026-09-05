import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../../../types/app';
import { regenerateLastSessionCommand, startSessionCommand } from './sessionLauncher';

const generalProject: Project = {
  name: 'general',
  displayName: 'general',
  kind: 'general',
  fullPath: '/state/pilot-home',
  workspaceCwd: '/workspaces/general',
};

describe('General session launching', () => {
  it('keeps the session project key while sending the isolated execution cwd', () => {
    const sendMessage = vi.fn(() => true);

    startSessionCommand({
      sendMessage,
      selectedProject: generalProject,
      command: 'hello',
      toolsSettings: {} as never,
    });

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        projectPath: '/state/pilot-home',
        cwd: '/state/pilot-home',
        workspaceCwd: '/workspaces/general',
      }),
    }));
  });

  it('uses the isolated cwd when regenerating an existing General turn', () => {
    const sendMessage = vi.fn(() => true);

    regenerateLastSessionCommand({
      sendMessage,
      selectedProject: generalProject,
      command: 'hello again',
      requestId: 'request-1',
      sessionId: 'web:session-1',
      expectedTurnId: 'turn-1',
      toolsSettings: {} as never,
    });

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        projectPath: '/state/pilot-home',
        workspaceCwd: '/workspaces/general',
      }),
    }));
  });
});
