import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ToolsSection from './view/agentSearch/components/ToolsSection';
import McpServersSection from './view/extensions';
import ServiceSection from './view/advanced/components/ServiceSection';
import ProviderCard from './view/modelPool/components/ProviderCard';
import SettingsSidebar from './view/SettingsSidebar';
import CronSection from './view/agentSchedule/components/CronSection';
import AlwaysOnSection from './view/agentResident/components/AlwaysOnSection';
import { findCatalogProviderById } from '../../shared/catalogProviders';
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../utils/api', () => ({ authenticatedFetch: mocks.fetch }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); mocks.fetch.mockReset(); });
const searchConfig: import('./view/modelPool/types').PilotDeckConfig = { tools: { webSearch: { provider: 'custom', endpoint: 'https://search.example/api', apiKey: '********', customProvider: { auth: 'queryApiKey', method: 'GET' } } } } as any;
it('preserves configured custom search authentication when testing', async () => {
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  render(<ToolsSection config={searchConfig} onChange={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'pilotDeckConfig.panels.tools.test.button' }));
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
  expect(JSON.parse(mocks.fetch.mock.calls[0][1].body).customProvider.auth).toBe('queryApiKey');
});
it('preserves configured custom search authentication when editing endpoint', () => {
  const onChange = vi.fn();
  render(<ToolsSection config={searchConfig} onChange={onChange} />);
  fireEvent.click(screen.getAllByRole('button', { name: 'settingsPage.actions.edit' })[0]);
  fireEvent.change(screen.getByLabelText('pilotDeckConfig.panels.tools.endpoint.label'), { target: { value: 'https://search.example/new' } });
  fireEvent.click(screen.getByRole('button', { name: 'settingsPage.actions.save' }));
  expect(onChange.mock.calls[0][0].tools.webSearch.customProvider.auth).toBe('queryApiKey');
});
it('does not persist a cancelled new MCP server when saving an existing server', async () => {
  const raw = JSON.stringify({ mcpServers: { existing: { command: 'node', args: ['server.js'] } } });
  const empty = JSON.stringify({ mcpServers: {} });
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ global: { raw, path: '/global.json' }, project: { raw: empty, path: '/project.json' } }) });
  render(<McpServersSection />);
  const scope = within(screen.getByRole('region', { name: 'mcpConfig.globalTitle' }));
  await waitFor(() => expect(scope.getByRole('button', { name: /existing/ })).toBeTruthy());
  fireEvent.click(scope.getByRole('button', { name: /^STDIO$/ }));
  fireEvent.click(scope.getByRole('button', { name: 'settingsPage.actions.cancel' }));
  fireEvent.click(scope.getByRole('button', { name: /existing/ }));
  fireEvent.click(scope.getByRole('button', { name: 'settingsPage.actions.edit' }));
  fireEvent.click(scope.getByRole('button', { name: 'settingsPage.actions.save' }));
  await waitFor(() => expect(mocks.fetch.mock.calls.some(([, o]) => o?.method === 'PUT')).toBe(true));
  const put = mocks.fetch.mock.calls.find(([, o]) => o?.method === 'PUT')!;
  expect(Object.keys(JSON.parse(JSON.parse(put[1].body).raw).mcpServers)).toEqual(['existing']);
});
it('preserves retry settings saved while the service form was open', async () => {
  const config: import('./view/modelPool/types').PilotDeckConfig = { agent: { model: 'custom/model' }, model: { providers: { custom: { retry: { requestMaxRetries: 2 }, models: { model: {} } } } }, webui: { runtime: { serverPort: 3001 } } };
  const save = vi.fn().mockResolvedValue(true);
  const view = render(<ServiceSection config={config} onSave={save} saving={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'settingsPage.actions.edit' }));
  fireEvent.change(screen.getByLabelText(/pilotDeckConfig.panels.runtime.fields.serverPort.label/), { target: { value: '3002' } });
  const newer = structuredClone(config); newer.model!.providers!.custom.retry!.requestMaxRetries = 8;
  view.rerender(<ServiceSection config={newer} onSave={save} saving={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'actions.saveChanges' }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0][0].model.providers.custom.retry.requestMaxRetries).toBe(8);
});
it('keeps catalog endpoints and protocols fixed in the settings form', () => {
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ tasks: [] }) });
  render(<ProviderCard providerId="openai" provider={{ protocol: 'openai', url: 'https://proxy.example/v1', apiKey: '********', models: { 'gpt-4o': {} } }} catalogEntry={findCatalogProviderById('openai')} initialEditing onSave={vi.fn()} onRemove={vi.fn()} />);
  expect(screen.queryByDisplayValue('https://proxy.example/v1')).toBeNull();
  expect(screen.queryByRole('combobox')).toBeNull();
});
it('keeps the simplified navigation without a primary agent page', () => {
  render(<SettingsSidebar selectedKey="general" onSelect={vi.fn()} onClose={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'settingsPage.menu.agentModel' })).toBeNull();
});
it('shows scheduler defaults matching the runtime for cron: {}', () => {
  render(<CronSection config={{ cron: {} }} onChange={vi.fn()} />);
  const defaults = { timezone: 'UTC', maxConcurrentRuns: 1 };
  expect((screen.getByLabelText('pilotDeckConfig.panels.cron.timezone.label') as HTMLSelectElement).value).toBe(defaults.timezone);
  expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe(String(defaults.maxConcurrentRuns));
});
it('preserves a configured live channel while editing an unrelated resident interval', () => {
  const change = vi.fn();
  render(<AlwaysOnSection config={{ alwaysOn: { trigger: { preferChannel: 'web' } } }} projects={[]} onChange={change} />);
  fireEvent.click(screen.getByRole('button', { name: 'settingsPage.actions.edit' }));
  fireEvent.click(screen.getByRole('button', { name: 'settingsPage.actions.save' }));
  expect(change.mock.calls[0][0].alwaysOn.trigger.preferChannel).toBe('web');
});

it('fetches catalog provider models from the configured proxy endpoint', async () => {
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ models: [], tasks: [] }) });
  render(<ProviderCard providerId="deepseek" provider={{ protocol: 'openai', url: 'https://proxy.example/v1', apiKey: '********', models: { 'deepseek-chat': {} } }} catalogEntry={findCatalogProviderById('deepseek')} onSave={vi.fn()} onRemove={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'settingsPage.actions.edit' }));
  await waitFor(() => expect(mocks.fetch.mock.calls.some(([url]) => url === '/api/config/models')).toBe(true));
  const request = mocks.fetch.mock.calls.find(([url]) => url === '/api/config/models')!;
  expect(new URL(JSON.parse(request[1].body).baseUrl).origin).toBe('https://proxy.example');
});
it.each([undefined, { enabled: false, timezone: 'UTC' }])('offers a way to enable a missing or disabled scheduler: %j', (cron) => {
  const onChange = vi.fn();
  render(<CronSection config={{ cron }} onChange={onChange} />);
  fireEvent.click(screen.getByRole('switch', { name: 'pilotDeckConfig.panels.cron.enableLabel', checked: false }));
  expect(onChange).toHaveBeenCalledOnce();
  expect(onChange.mock.calls[0][0].cron).toEqual({...cron, enabled: true});
});

it.each(['bearer', 'queryApiKey', 'bodyApiKey', 'none'] as const)('preserves %s search authentication when saving a new key', (auth) => {
  const config = structuredClone(searchConfig);
  config.tools!.webSearch!.customProvider!.auth = auth;
  const onChange = vi.fn();
  render(<ToolsSection config={config} onChange={onChange} />);
  fireEvent.click(screen.getAllByRole('button', { name: 'settingsPage.actions.edit' })[1]);
  fireEvent.change(screen.getByLabelText('pilotDeckConfig.panels.tools.apiKey.label'), { target: { value: 'new-key' } });
  fireEvent.click(screen.getByRole('button', { name: 'settingsPage.actions.save' }));
  expect(onChange.mock.calls[0][0].tools.webSearch.customProvider).toEqual({ auth, method: 'GET' });
});

it('keeps the official DeepSeek model-list URL when using the official endpoint', async () => {
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ models: [], tasks: [] }) });
  render(<ProviderCard providerId="deepseek" provider={{ protocol: 'openai', url: 'https://api.deepseek.com/v1/', apiKey: '********', models: { model: {} } }} onSave={vi.fn()} onRemove={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'settingsPage.actions.edit' }));
  await waitFor(() => expect(mocks.fetch.mock.calls.some(([url]) => url === '/api/config/models')).toBe(true));
  const request = mocks.fetch.mock.calls.find(([url]) => url === '/api/config/models')!;
  expect(JSON.parse(request[1].body).baseUrl).toBe('https://api.deepseek.com/models');
});

it('does not offer unimplemented resident notification destinations or create one while saving', () => {
  const onChange = vi.fn();
  render(<AlwaysOnSection config={{ alwaysOn: { trigger: {} } }} projects={[]} onChange={onChange} />);
  expect(screen.queryByLabelText('pilotDeckConfig.panels.alwaysOn.trigger.preferChannel.label')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'settingsPage.actions.edit' }));
  fireEvent.click(screen.getByRole('button', { name: 'settingsPage.actions.save' }));
  expect(onChange.mock.calls[0][0].alwaysOn.trigger).not.toHaveProperty('preferChannel');
});

it('allows switching an implicit UTC scheduler to Shanghai', () => {
  const onChange = vi.fn();
  render(<CronSection config={{ cron: {} }} onChange={onChange} />);
  fireEvent.click(screen.getAllByRole('button', { name: 'settingsPage.actions.edit' })[0]);
  fireEvent.change(screen.getByLabelText('pilotDeckConfig.panels.cron.timezone.label'), { target: { value: 'Asia/Shanghai' } });
  fireEvent.click(screen.getByRole('button', { name: 'settingsPage.actions.save' }));
  expect(onChange.mock.calls[0][0].cron.timezone).toBe('Asia/Shanghai');
});
