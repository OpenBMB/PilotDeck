import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
// The fake server below runs the real planner so the dialog is tested against
// the exact plans the endpoint produces.
import { planModelRemoval } from '../../../../../../server/services/modelReferences.js';
import type { PilotDeckConfig } from '../types';
import { configToYamlString, safeParseYaml } from '../utils/configYaml';
import ModelsSection from './ModelsSection';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../../../../utils/api', () => ({ authenticatedFetch: mocks.fetch }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); delete window.openSettings; });

const DIALOG = 'pilotDeckConfig.panels.models.deleteDialog';

type Options = { router?: boolean; noAlternative?: boolean; emptyDefinition?: boolean; brokenUrl?: boolean; conflictOnce?: boolean; failApply?: boolean };

function setup({ router = false, noAlternative = false, emptyDefinition = false, brokenUrl = false, conflictOnce = false, failApply = false }: Options = {}) {
  const provider = { protocol: 'openai' as const, url: 'https://example.test/v1', apiKey: '********', models: { model: {}, spare: {} } };
  let disk: PilotDeckConfig = {
    agent: { model: 'openai/model', subagents: { default: 'openai/model' } },
    memory: { model: 'openai/model' } as PilotDeckConfig['memory'],
    model: { providers: {
      openai: { ...provider, url: brokenUrl ? 'aaa' : provider.url },
      replacement: { ...provider, models: { model: emptyDefinition ? null : {} } },
    } },
    ...(router ? { router: { enabled: true, scenarios: { default: 'openai/model' }, fallback: { default: ['openai/model', 'replacement/model'] } } } : {}),
  } as PilotDeckConfig;
  if (noAlternative) {
    delete disk.model!.providers!.replacement;
    disk.model!.providers!.openai.models = { model: {} };
  }
  let revision = 1;
  let conflict = conflictOnce;
  const requests: Array<Record<string, unknown>> = [];
  mocks.fetch.mockImplementation(async (url: string, init?: { body?: string }) => {
    if (!url.includes('/api/config/model-removal')) return { ok: true, json: async () => ({ tasks: [], models: [] }) };
    const body = JSON.parse(init?.body ?? '{}');
    requests.push(body);
    const plan = planModelRemoval(disk, body, { replacement: body.replacement });
    const { config: next, ...publicPlan } = plan;
    const reply = (status: number, data: unknown) => ({ ok: status < 400, status, json: async () => data });
    if (body.dryRun) return reply(200, { ...publicPlan, revision: String(revision) });
    if (conflict) { conflict = false; revision += 1; return reply(409, { code: 'CONFIG_CONFLICT', message: 'changed' }); }
    if (body.baseRevision !== String(revision)) return reply(409, { code: 'CONFIG_CONFLICT', message: 'changed' });
    if (failApply) return reply(400, { code: 'CONFIG_VALIDATION_FAILED', message: 'Save rejected' });
    if (plan.blocked) return reply(409, { code: plan.blocked.code, message: plan.blocked.message });
    disk = next;
    revision += 1;
    return reply(200, { exists: true, path: '/tmp/pilotdeck.yaml', raw: configToYamlString(disk), revision: String(revision), validation: { valid: true, errors: [], warnings: [] } });
  });
  const saves = vi.fn();
  function Harness() {
    const [config, setConfig] = useState(disk);
    return <ModelsSection
      config={config}
      onChange={async next => { saves(next); disk = next; setConfig(next); return { ok: true }; }}
      onServerConfig={response => setConfig(safeParseYaml(response.raw)!)}
    />;
  }
  render(<Harness />);
  return { saves, requests, config: () => disk };
}

async function openProviderDelete() {
  fireEvent.click(screen.getByRole('button', { name: 'pilotDeckConfig.actions.remove' }));
  const dialog = within(await screen.findByRole('dialog'));
  await waitFor(() => expect(dialog.queryByText(`${DIALOG}.checking`)).toBeNull());
  return dialog;
}

it.each([false, true])('previews and atomically removes a referenced provider, including null model definitions: %s', async (emptyDefinition) => {
  const { saves, requests, config } = setup({ emptyDefinition, brokenUrl: true });
  const dialog = await openProviderDelete();
  // Only usable models from other providers are offered, preselected.
  const select = dialog.getByRole('combobox') as HTMLSelectElement;
  expect(within(select).queryByRole('option', { name: 'openai/spare' })).toBeNull();
  await waitFor(() => expect(select.value).toBe('replacement/model'));
  expect(dialog.getByText(`${DIALOG}.groupReplace`)).toBeTruthy();
  expect(dialog.getByText(`${DIALOG}.groupInherit`)).toBeTruthy();
  expect(dialog.getAllByText('common:modelUsage.primaryModel')).toHaveLength(1);

  const confirm = dialog.getByRole('button', { name: `${DIALOG}.replaceAndDelete` }) as HTMLButtonElement;
  await waitFor(() => expect(confirm.disabled).toBe(false));
  fireEvent.click(confirm);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

  expect(saves).not.toHaveBeenCalled();
  const apply = requests.find(request => !request.dryRun);
  expect(apply).toMatchObject({ providerId: 'openai', replacement: 'replacement/model', baseRevision: '1' });
  expect(config().agent?.model).toBe('replacement/model');
  expect(config().agent?.subagents?.default).toBe('inherit');
  expect(config().model?.providers?.openai).toBeUndefined();
  expect(config().model?.providers?.replacement.models?.model).toEqual(emptyDefinition ? null : {});
});

it('previews deleted fallback references and preserves the replacement as a backup', async () => {
  const { config } = setup({ router: true });
  const dialog = await openProviderDelete();
  expect(dialog.queryByText(`${DIALOG}.redundant`)).toBeNull();
  expect(dialog.getByText(`${DIALOG}.groupRemove`)).toBeTruthy();
  fireEvent.click(dialog.getByRole('button', { name: `${DIALOG}.replaceAndDelete` }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(config().router?.scenarios?.default).toBe('replacement/model');
  expect(config().router?.fallback).toEqual({ default: ['replacement/model'] });
});

it('re-previews when the replacement changes', async () => {
  const { requests } = setup();
  // Delete a single model so the provider's other model is also an option.
  fireEvent.click(screen.getByRole('button', { name: 'settingsPage.actions.edit' }));
  fireEvent.click(screen.getAllByRole('button', { name: 'pilotDeckConfig.panels.models.removeModelAria' })[0]);
  const dialog = within(await screen.findByRole('dialog'));
  const select = await dialog.findByRole('combobox') as HTMLSelectElement;
  await waitFor(() => expect(select.value).toBe('openai/spare'));
  fireEvent.change(select, { target: { value: 'replacement/model' } });
  await waitFor(() => expect(requests.at(-1)).toMatchObject({ dryRun: true, replacement: 'replacement/model' }));
});

it('keeps the provider when the write fails and shows the server error', async () => {
  const { config } = setup({ failApply: true });
  const dialog = await openProviderDelete();
  const confirm = dialog.getByRole('button', { name: `${DIALOG}.replaceAndDelete` }) as HTMLButtonElement;
  await waitFor(() => expect(confirm.disabled).toBe(false));
  fireEvent.click(confirm);
  expect((await dialog.findByRole('alert')).textContent).toBe('Save rejected');
  expect(config().model?.providers?.openai).toBeDefined();
  expect(screen.getByRole('dialog')).toBeTruthy();
});

it('refreshes the preview after a concurrent change instead of writing a stale plan', async () => {
  const { requests, config } = setup({ conflictOnce: true });
  const dialog = await openProviderDelete();
  const confirm = dialog.getByRole('button', { name: `${DIALOG}.replaceAndDelete` }) as HTMLButtonElement;
  await waitFor(() => expect(confirm.disabled).toBe(false));
  fireEvent.click(confirm);
  expect((await dialog.findByRole('status')).textContent).toBe(`${DIALOG}.conflict`);
  await waitFor(() => expect(confirm.disabled).toBe(false));
  fireEvent.click(confirm);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(requests.filter(request => !request.dryRun).map(request => request.baseRevision)).toEqual(['1', '2']);
  expect(config().model?.providers?.openai).toBeUndefined();
});

it('removes an unreferenced model from the draft without writing', async () => {
  const { requests, saves } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'settingsPage.actions.edit' }));
  fireEvent.click(screen.getAllByRole('button', { name: 'pilotDeckConfig.panels.models.removeModelAria' })[1]);
  const dialog = within(await screen.findByRole('dialog'));
  const remove = dialog.getByRole('button', { name: `${DIALOG}.delete` }) as HTMLButtonElement;
  await waitFor(() => expect(remove.disabled).toBe(false));
  fireEvent.click(remove);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(requests.every(request => request.dryRun)).toBe(true);
  expect(saves).not.toHaveBeenCalled();
  expect(screen.getAllByRole('button', { name: 'pilotDeckConfig.panels.models.removeModelAria' })).toHaveLength(1);
});

it.each(['model', 'provider'])('clears the main model when the final %s is removed', async (kind) => {
  const { config } = setup({ noAlternative: true });
  if (kind === 'model') {
    fireEvent.click(screen.getByRole('button', { name: 'settingsPage.actions.edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'pilotDeckConfig.panels.models.removeModelAria' }));
  } else fireEvent.click(screen.getByRole('button', { name: 'pilotDeckConfig.actions.remove' }));
  const dialog = within(await screen.findByRole('dialog'));
  const remove = dialog.getByRole('button', { name: `${DIALOG}.delete` }) as HTMLButtonElement;
  await waitFor(() => expect(remove.disabled).toBe(false));
  expect(dialog.queryByRole('combobox')).toBeNull();
  expect(dialog.getByText(`${DIALOG}.groupClear`)).toBeTruthy();
  fireEvent.click(remove);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(config().agent?.model).toBe('');
  expect(config().model?.providers).toEqual(kind === 'provider' ? {} : { openai: expect.objectContaining({ models: {} }) });
});

it('blocks removing the last model while smart routing needs it', async () => {
  setup({ noAlternative: true, router: true });
  const dialog = await openProviderDelete();
  expect((await dialog.findByRole('alert')).textContent).toBe(`${DIALOG}.routerRequiresModel`);
  const confirm = dialog.getByRole('button', { name: `${DIALOG}.replaceAndDelete` }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
});


it.each([
  ['common:modelUsage.primaryModel', 'models', 'agent.model'],
  ['common:modelUsage.subagentModel', 'agent-route', 'agent.subagents.default'],
  ['common:modelUsage.memoryModel', 'agent-memory', 'memory.model'],
])('closes the preview and opens the current owner of %s', async (label, tab, reference) => {
  const open = vi.fn();
  window.openSettings = open;
  const { requests } = setup();
  const dialog = await openProviderDelete();
  const row = dialog.getByText(label).closest('li')!;
  fireEvent.click(within(row).getByRole('button', { name: `${DIALOG}.openSettings` }));
  expect(open).toHaveBeenCalledWith(`${tab}?${new URLSearchParams({ reference })}`);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(requests.every(request => request.dryRun)).toBe(true);
});
