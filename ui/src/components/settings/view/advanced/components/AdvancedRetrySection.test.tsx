import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import AdvancedRetrySection from './AdvancedRetrySection';
import type { PilotDeckConfig } from '../../modelPool/types';
import { MODEL_RETRY_DEFAULTS } from '../../../../../../../src/model/config/retryDefaults';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
const config = { schemaVersion: 1, agent: { model: 'selected/model' }, model: { providers: { first: { models: { model: {} }, retry: { requestMaxRetries: 7 } }, selected: { models: { model: {} }, retry: { requestMaxRetries: 2 } } } } } as PilotDeckConfig;
it('shows runtime defaults and preserves them when saving an unconfigured provider', async () => {
  const save = vi.fn().mockResolvedValue(true);
  render(<AdvancedRetrySection config={{ agent: { model: 'test/model' }, model: { providers: { test: { models: { model: {} } } } } }} onSave={save} saving={false} />);
  expect(screen.getAllByRole('spinbutton').map(input => Number((input as HTMLInputElement).value))).toEqual([
    MODEL_RETRY_DEFAULTS.requestMaxRetries, MODEL_RETRY_DEFAULTS.streamMaxRetries,
    MODEL_RETRY_DEFAULTS.streamIdleTimeoutMs, 15000, MODEL_RETRY_DEFAULTS.baseDelayMs, MODEL_RETRY_DEFAULTS.maxDelayMs,
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'settingsPage.actions.edit' }));
  fireEvent.click(screen.getByRole('button', { name: 'actions.saveChanges' }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0][0].model.providers.test.retry.streamMaxRetries).toBe(5);
});
it('edits only the current main model provider, even when another provider is listed first', async () => {
  const save = vi.fn().mockResolvedValue(true);
  render(<AdvancedRetrySection config={config} onSave={save} saving={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'settingsPage.actions.edit' }));
  fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '4' } });
  fireEvent.click(screen.getByRole('button', { name: 'actions.saveChanges' }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0][0].model.providers.selected.retry.requestMaxRetries).toBe(4);
  expect(save.mock.calls[0][0].model.providers.first).toEqual(config.model!.providers!.first);
  expect(save.mock.calls[0][0].router?.tokenSaver).toBeUndefined();
});
it('does not carry an old provider’s unsaved draft into a newly selected model', () => {
  const save = vi.fn();
  const view = render(<AdvancedRetrySection config={config} onSave={save} saving={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'settingsPage.actions.edit' }));
  fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '99' } });
  view.rerender(<AdvancedRetrySection config={{ ...config, agent: { ...config.agent, model: 'first/model' } }} onSave={save} saving={false} />);
  expect(screen.queryByRole('button', { name: 'actions.saveChanges' })).toBeNull();
  expect((screen.getAllByRole('spinbutton')[0] as HTMLInputElement).value).toBe('7');
  expect(save).not.toHaveBeenCalled();
});

it('can save a judge timeout without enabling an unconfigured router', async () => {
  const save = vi.fn().mockResolvedValue(true);
  render(<AdvancedRetrySection config={config} onSave={save} saving={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'settingsPage.actions.edit' }));
  fireEvent.change(screen.getAllByRole('spinbutton')[3], { target: { value: '20000' } });
  fireEvent.click(screen.getByRole('button', { name: 'actions.saveChanges' }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0][0].router.tokenSaver).toEqual({ enabled: false, judgeTimeoutMs: 20000 });
});
