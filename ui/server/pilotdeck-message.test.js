import { describe, expect, it } from 'vitest';
import { createOptimisticUserFrames } from './pilotdeck-message.js';

describe('sibling optimistic user frames', () => {
  it('preserves the command run id, images, and attachments', () => {
    const [userFrame, statusFrame] = createOptimisticUserFrames({
      sessionId: 'web:session-1',
      userVisibleInput: 'Review these.',
      timestamp: '2026-08-18T00:00:00.000Z',
      options: {
        runId: 'run-user-1',
        images: [{ data: 'data:image/png;base64,one' }],
        attachments: [{ name: 'report.pdf', path: '/tmp/report.pdf' }],
      },
    });

    expect(userFrame).toMatchObject({
      kind: 'text',
      role: 'user',
      runId: 'run-user-1',
      images: ['data:image/png;base64,one'],
      attachments: [{ name: 'report.pdf', path: '/tmp/report.pdf' }],
    });
    expect(statusFrame).toMatchObject({
      kind: 'status',
      runId: 'run-user-1',
    });
  });

  it('keeps legacy sibling frames identity-less when the command has no run id', () => {
    const [userFrame] = createOptimisticUserFrames({
      sessionId: 'web:session-1',
      userVisibleInput: 'Continue.',
    });

    expect(userFrame.runId).toBeUndefined();
  });
});
