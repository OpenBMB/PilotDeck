// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const state = vi.hoisted(() => ({ hold: false }));
vi.mock('../../utils/api', () => ({ authenticatedFetch: async () => {
  if (state.hold) return new Promise(() => {});
  return new Response(JSON.stringify({ status: { sessionId: 'owned', revision: 1,
    approval: { waitId: 'wait', revision: 1, skillId: 'sop', version: '1', nodeId: 'human', assigneeUserId: 'pilotdeck:owner' } } }));
} }));
vi.mock('./staffdeck/vendor/DistillPage', () => ({ SkillFlow: () => null }));
vi.mock('./staffdeck/vendor/SopVersionDetailDialog', () => ({ default: () => null }));
vi.mock('./staffdeck/StaffDeckLocaleBoundary', () => ({ default: ({ children }: any) => children }));
import { PilotDeckSopApproval } from './pilotdeck-sop';
afterEach(() => { cleanup(); state.hold = false; sessionStorage.clear(); });
it('preserves a pinned approval draft across chat remounts', async () => {
  const view = render(<PilotDeckSopApproval sessionId="owned" projectKey="project" />);
  fireEvent.change(await screen.findByLabelText('人工回复'), { target: { value: 'Owner draft across remount' } });
  view.unmount();
  render(<PilotDeckSopApproval sessionId="owned" projectKey="project" />);
  expect((await screen.findByLabelText('人工回复') as HTMLTextAreaElement).value).toBe('Owner draft across remount');
});
it('preserves an owner reply during same-session refresh and hides it on session switch', async () => {
  const { rerender } = render(<PilotDeckSopApproval sessionId="owned" projectKey="project" refreshKey="1" />);
  const input = await screen.findByLabelText('人工回复');
  fireEvent.change(input, { target: { value: 'Approved draft' } });
  state.hold = true;
  rerender(<PilotDeckSopApproval sessionId="owned" projectKey="project" refreshKey="2" />);
  expect((screen.getByLabelText('人工回复') as HTMLTextAreaElement).value).toBe('Approved draft');
  rerender(<PilotDeckSopApproval sessionId="foreign" projectKey="project" refreshKey="3" />);
  await waitFor(() => expect(screen.queryByLabelText('人工回复')).toBeNull());
});
