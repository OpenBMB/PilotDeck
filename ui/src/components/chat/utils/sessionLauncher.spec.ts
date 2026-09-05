import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../../types/app';
import { createUserTurnRunId, regenerateLastSessionCommand, startSessionCommand } from './sessionLauncher';

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

  it('does not activate a new session when the command cannot be delivered', () => {
    const sendMessage = vi.fn(() => false);

    const sessionId = startSessionCommand({
      sendMessage,
      selectedProject: { name: 'PilotDeck', path: '/workspace/PilotDeck' } as Project,
      command: 'Continue.',
      temporarySessionId: 'new-session-offline',
    });

    expect(sessionId).toBeNull();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('sends an atomic same-session replacement request with preserved payload', () => {
    const sendMessage = vi.fn();

    regenerateLastSessionCommand({
      sendMessage,
      selectedProject: { name: 'PilotDeck', path: '/workspace/PilotDeck' } as Project,
      requestId: 'replace-request-1',
      sessionId: 'web:session-1',
      expectedTurnId: 'old-turn',
      command: 'Corrected request',
      userVisibleInput: 'Corrected request',
      runId: 'new-turn',
      images: [{ data: 'data:image/png;base64,abc', name: 'image.png' }],
      attachments: [{ name: 'brief.pdf', path: '/workspace/brief.pdf' }],
      uploadedAttachments: [{ uploadId: 'upload-1', attachmentIds: ['attachment-1'] }],
      displayAttachments: [{ name: 'browser.pdf', uploadId: 'upload-1', attachmentId: 'attachment-1' }],
      syntheticMessages: [{ text: 'Inspect the current workspace.', purpose: 'edit' }],
    });

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'regenerate-last-message',
      requestId: 'replace-request-1',
      sessionId: 'web:session-1',
      expectedTurnId: 'old-turn',
      command: 'Corrected request',
      options: expect.objectContaining({
        sessionId: 'web:session-1',
        runId: 'new-turn',
        userVisibleInput: 'Corrected request',
        images: [{ data: 'data:image/png;base64,abc', name: 'image.png' }],
        attachments: [{ name: 'brief.pdf', path: '/workspace/brief.pdf' }],
        uploadedAttachments: [{ uploadId: 'upload-1', attachmentIds: ['attachment-1'] }],
        displayAttachments: [{ name: 'browser.pdf', uploadId: 'upload-1', attachmentId: 'attachment-1' }],
        syntheticMessages: [{ text: 'Inspect the current workspace.', purpose: 'edit' }],
      }),
    });
  });
});
