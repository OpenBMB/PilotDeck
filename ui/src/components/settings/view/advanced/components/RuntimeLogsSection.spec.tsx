// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestI18n } from '../../../../../i18n/testInstance';
import RuntimeLogsSection from './RuntimeLogsSection';

afterEach(() => { cleanup(); delete window.pilotdeckDesktop; });
it('defaults to a week and saves only the preference without discarding new or secret configuration', async () => {
  const i18n = await createTestI18n();
  const config = { model: { providers: { test: { apiKey: 'preserve-this' } } }, customEnv: { FEATURE: 'new' }, webui: { runtime: { serverPort: 3001 } } };
  const onSave = vi.fn().mockResolvedValue(true);
  Object.defineProperty(window, 'pilotdeckDesktop', { configurable: true, value: { getRuntimeInfo: vi.fn().mockResolvedValue({ logPath: '/logs/runtime.log' }) } });
  render(<I18nextProvider i18n={i18n}><RuntimeLogsSection config={config} onSave={onSave} saving={false} /></I18nextProvider>);
  const select = screen.getByRole('combobox') as HTMLSelectElement;
  expect(select.value).toBe('7'); expect(select.options.length).toBe(5);
  fireEvent.change(select, { target: { value: '30' } });
  await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  expect(onSave.mock.calls[0][0]).toEqual({ ...config, webui: { runtime: { serverPort: 3001, logRetentionDays: 30 } } });
  expect(config.webui.runtime).toEqual({ serverPort: 3001 });
});
