import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { StaffDeckProjectBinding } from './StaffDeckProjectBinding';
const request = vi.hoisted(() => vi.fn());
vi.mock('../../utils/api', () => ({ authenticatedFetch: request }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('offers existing-project activation and displays a failed binding retry', async () => {
  request.mockResolvedValueOnce(Response.json({ status: 'pending' }))
    .mockResolvedValueOnce(Response.json({ status: 'failed', error: { message: 'Service unavailable' } }))
    .mockResolvedValueOnce(Response.json({ status: 'bound', agentName: 'Project A' }));
  render(<StaffDeckProjectBinding projectName="project-a" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Create and connect' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
  await screen.findByText('Project A');
  expect(screen.queryByRole('button')).toBeNull();
  expect(request.mock.calls[1][0]).toBe('/api/projects/project-a/staffdeck-binding/ensure');
});
it('keeps disabled integration invisible', async () => {
  request.mockResolvedValueOnce(Response.json({ status: 'disabled' }));
  const { container } = render(<StaffDeckProjectBinding projectName="project-a" />);
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  expect(container.textContent).toBe('');
});
it('ignores an activation response after switching projects', async () => {
  let resolveActivation: (response: Response) => void;
  request.mockResolvedValueOnce(Response.json({ status: 'pending' }))
    .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveActivation = resolve; }))
    .mockResolvedValueOnce(Response.json({ status: 'bound', agentName: 'Project B' }));
  const { rerender } = render(<StaffDeckProjectBinding projectName="project-a" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Create and connect' }));
  rerender(<StaffDeckProjectBinding projectName="project-b" />);
  await screen.findByText('Project B');
  resolveActivation!(Response.json({ status: 'bound', agentName: 'Project A' }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(screen.getByText('Project B')).toBeTruthy();
  expect(screen.queryByText('Project A')).toBeNull();
});
it('merges repeated activation clicks and disables connecting requests', async () => {
  let resolveActivation: (response: Response) => void;
  request.mockResolvedValueOnce(Response.json({ status: 'pending' }))
    .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveActivation = resolve; }));
  render(<StaffDeckProjectBinding projectName="project-a" />);
  const button = await screen.findByRole('button', { name: 'Create and connect' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(request).toHaveBeenCalledTimes(2);
  expect((button as HTMLButtonElement).disabled).toBe(true);
  resolveActivation!(Response.json({ status: 'bound', agentName: 'Project A' }));
  await screen.findByText('Project A');
});
it('ignores a delayed status body after switching projects', async () => {
  let resolveBody: (value: unknown) => void;
  request.mockResolvedValueOnce({ ok: true, json: () => new Promise(resolve => { resolveBody = resolve; }) })
    .mockResolvedValueOnce(Response.json({ status: 'bound', agentName: 'Project B' }));
  const { rerender } = render(<StaffDeckProjectBinding projectName="project-a" />);
  await waitFor(() => expect(resolveBody).toBeTypeOf('function'));
  rerender(<StaffDeckProjectBinding projectName="project-b" />);
  await screen.findByText('Project B');
  resolveBody!({ status: 'bound', agentName: 'Project A' });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(screen.queryByText('Project A')).toBeNull();
});
it('shows binding in progress with activation disabled', async () => {
  request.mockResolvedValueOnce(Response.json({ status: 'binding' }));
  render(<StaffDeckProjectBinding projectName="project-a" />);
  await screen.findByText('StaffDeck: Connecting');
  expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
});
