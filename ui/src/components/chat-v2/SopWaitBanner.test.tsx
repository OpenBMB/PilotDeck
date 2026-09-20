import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '../../utils/api';
import SopWaitBanner from './SopWaitBanner';

vi.mock('../../utils/api', () => ({
  api: {
    sopStatus: vi.fn(),
    resumeSop: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SopWaitBanner', () => {
  it('prepares an accepted handoff message for the ordinary composer', async () => {
    vi.mocked(api.sopStatus).mockResolvedValue(new Response(JSON.stringify({
      status: {
        sessionId: 'session-1',
        revision: 4,
        state: { status: 'handoff' },
        wait: { id: 'wait-1', kind: 'handoff' },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.mocked(api.resumeSop).mockResolvedValue(new Response(JSON.stringify({
      accepted: true,
      duplicate: false,
      sessionId: 'session-1',
      requestId: 'resume-1',
      revision: 5,
      message: 'Approved by operator.',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const onPrepared = vi.fn();

    render(<SopWaitBanner sessionKey="session-1" projectKey="/project" refreshKey="idle" onPrepared={onPrepared} onError={vi.fn()} />);

    expect(await screen.findByTestId('sop-wait-banner')).not.toBeNull();
    fireEvent.change(screen.getByLabelText('SOP continuation message'), { target: { value: 'Approved by operator.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(onPrepared).toHaveBeenCalledWith('Approved by operator.'));
    expect(api.resumeSop).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: 'session-1',
      projectKey: '/project',
      waitId: 'wait-1',
      source: 'human',
      message: 'Approved by operator.',
      expectedRevision: 4,
    }));
  });

  it('stays hidden when the session has no active wait', async () => {
    vi.mocked(api.sopStatus).mockResolvedValue(new Response(JSON.stringify({ status: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    render(<SopWaitBanner sessionKey="session-1" projectKey="/project" refreshKey="idle" onPrepared={vi.fn()} onError={vi.fn()} />);

    await waitFor(() => expect(api.sopStatus).toHaveBeenCalled());
    expect(screen.queryByTestId('sop-wait-banner')).toBeNull();
  });

  it('submits a continuation only once when Continue is clicked twice before the response returns', async () => {
    vi.mocked(api.sopStatus).mockResolvedValue(new Response(JSON.stringify({
      status: { sessionId: 'session-1', revision: 4, state: { status: 'handoff' }, wait: { id: 'wait-1', kind: 'handoff' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    let resolveResume: ((response: Response) => void) | undefined;
    vi.mocked(api.resumeSop).mockImplementation(() => new Promise((resolve) => { resolveResume = resolve; }));

    render(<SopWaitBanner sessionKey="session-1" projectKey="/project" refreshKey="idle" onPrepared={vi.fn()} onError={vi.fn()} />);
    await screen.findByTestId('sop-wait-banner');
    fireEvent.change(screen.getByLabelText('SOP continuation message'), { target: { value: 'Approved' } });
    const continueButton = screen.getByRole('button', { name: 'Continue' });
    fireEvent.click(continueButton);
    fireEvent.click(continueButton);

    expect(api.resumeSop).toHaveBeenCalledTimes(1);
    resolveResume?.(new Response(JSON.stringify({ message: 'Approved' }), { status: 200 }));
  });

  it('ignores a delayed status response from a session that is no longer selected', async () => {
    let resolveOld: ((response: Response) => void) | undefined;
    vi.mocked(api.sopStatus)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: { sessionId: 'session-new', revision: 2, state: { status: 'handoff' }, wait: { id: 'wait-new', kind: 'handoff' } },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const rendered = render(<SopWaitBanner sessionKey="session-old" projectKey="/project" refreshKey="idle" onPrepared={vi.fn()} onError={vi.fn()} />);
    await waitFor(() => expect(api.sopStatus).toHaveBeenCalledTimes(1));
    rendered.rerender(<SopWaitBanner sessionKey="session-new" projectKey="/project" refreshKey="idle" onPrepared={vi.fn()} onError={vi.fn()} />);
    await screen.findByTestId('sop-wait-banner');
    expect(screen.getByLabelText('SOP continuation message').getAttribute('placeholder')).toBe('Enter the handoff response');

    resolveOld?.(new Response(JSON.stringify({
      status: { sessionId: 'session-old', revision: 1, state: { status: 'handoff' }, wait: { id: 'wait-old', kind: 'external_task' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await waitFor(() => expect(api.sopStatus).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText('SOP continuation message').getAttribute('placeholder')).toBe('Enter the handoff response');
  });
});
