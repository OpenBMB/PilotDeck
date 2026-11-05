// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { parse } from 'yaml';
import { PilotDeckConfigProvider } from '../../../../hooks/usePilotDeckConfig';
import MultimodalGenerationSettings from './index';
import SettingsSidebar from '../SettingsSidebar';
import en from '../../../../i18n/locales/en/settings.json';
import zh from '../../../../i18n/locales/zh-CN/settings.json';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), subscribe: vi.fn(() => () => {}) }));
vi.mock('../../../../utils/api', () => ({ authenticatedFetch: mocks.fetch }));
vi.mock('../../../../contexts/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: mocks.subscribe }) }));
vi.unmock('react-i18next');
vi.unmock('lucide-react');
let saved: any;
const snapshot = () => ({ exists: true, path: '/test/config.yaml', raw: JSON.stringify(saved), revision: JSON.stringify(saved), validation: { valid: true, errors: [], warnings: [] } });
beforeEach(() => {
  saved = { agent: { model: 'test/model' }, model: { providers: {} }, tools: {
    imageGeneration: { enabled: true, apiKey: '********', baseUrl: 'https://images.example/v1', model: 'image-model' },
    videoGeneration: { enabled: true, apiKey: '********', baseUrl: 'https://videos.example/v1', model: 'video-model', extraParams: { task: 't2va', aspect_ratio: '16:9' } },
  } };
  mocks.fetch.mockImplementation(async (url, init) => {
    if (url === '/api/config' && init?.method === 'PUT') {
      saved = parse(JSON.parse(init.body).raw);
      return { ok: true, json: async () => snapshot() };
    }
    if (String(url).endsWith('/test')) return { ok: true, json: async () => ({ ok: true, latencyMs: 1200 }) };
    return { ok: true, json: async () => snapshot() };
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function Location() { const value = useLocation(); return <output data-testid="location">{value.pathname + value.search}</output>; }
async function mount(path = '/settings/multimodal-generation', lng = 'zh-CN') {
  const i18n = createInstance();
  await i18n.init({ lng, defaultNS: 'settings', resources: { en: { settings: en }, 'zh-CN': { settings: zh } }, interpolation: { escapeValue: false } });
  render(<I18nextProvider i18n={i18n}><MemoryRouter initialEntries={[path]}><PilotDeckConfigProvider>
    <SettingsSidebar selectedKey="multimodalGeneration" onSelect={vi.fn()} onClose={vi.fn()} />
    <MultimodalGenerationSettings /><Location />
  </PilotDeckConfigProvider></MemoryRouter></I18nextProvider>);
  await screen.findByRole('tab', { name: /图像|Images/ });
}
const panel = () => within(screen.getByRole('tabpanel'));
const switchTab = (name: string | RegExp) => fireEvent.click(screen.getByRole('tab', { name }));

it('uses a single sidebar entry, valid tab links and keyboard navigation', async () => {
  await mount();
  expect(screen.getAllByRole('button', { name: '多模态' })).toHaveLength(1);
  expect(screen.queryByRole('button', { name: '图像生成' })).toBeNull();
  expect(screen.queryByRole('button', { name: '视频生成' })).toBeNull();
  const image = screen.getByRole('tab', { name: /图像/ });
  expect(image.getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(image, { key: 'ArrowRight' });
  expect(screen.getByTestId('location').textContent).toContain('?tab=video');
  expect(document.activeElement).toBe(screen.getByRole('tab', { name: /视频/ }));
  expect((panel().getByLabelText('模型名称') as HTMLInputElement).value).toBe('video-model');
  fireEvent.keyDown(document.activeElement!, { key: 'Home' });
  expect(screen.getByTestId('location').textContent).toBe('/settings/multimodal-generation');
});

it('retains both drafts across tab switches and saves each namespace without overwriting the sibling', async () => {
  await mount();
  fireEvent.change(panel().getByLabelText('模型名称'), { target: { value: 'new-image' } });
  switchTab(/视频/);
  fireEvent.change(panel().getByLabelText('模型名称'), { target: { value: 'new-video' } });
  switchTab(/图像/);
  expect((panel().getByLabelText('模型名称') as HTMLInputElement).value).toBe('new-image');
  fireEvent.click(panel().getByRole('button', { name: '保存' }));
  await waitFor(() => expect(saved.tools.imageGeneration.model).toBe('new-image'));
  expect(saved.tools.videoGeneration.model).toBe('video-model');
  switchTab(/视频/);
  expect((panel().getByLabelText('模型名称') as HTMLInputElement).value).toBe('new-video');
  await waitFor(() => expect((panel().getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(panel().getByRole('button', { name: '保存' }));
  await waitFor(() => expect(saved.tools.videoGeneration.model).toBe('new-video'));
  expect(saved.tools.imageGeneration.model).toBe('new-image');
  expect(saved.tools.videoGeneration.extraParams).toEqual({ task: 't2va', aspect_ratio: '16:9' });
  expect(saved.tools.imageGeneration.apiKey).toBe('********');
});

it('saves each switch independently and leaves the other modality and credentials unchanged', async () => {
  await mount();
  fireEvent.click(panel().getByRole('switch'));
  await waitFor(() => expect(saved.tools.imageGeneration.enabled).toBe(false));
  expect(saved.tools.videoGeneration.enabled).toBe(true);
  switchTab(/视频/);
  await waitFor(() => expect((panel().getByRole('switch') as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(panel().getByRole('switch'));
  await waitFor(() => expect(saved.tools.videoGeneration.enabled).toBe(false));
  expect(saved.tools.imageGeneration.enabled).toBe(false);
  switchTab(/图像/);
  await waitFor(() => expect((panel().getByRole('switch') as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(panel().getByRole('switch'));
  await waitFor(() => expect(saved.tools.imageGeneration.enabled).toBe(true));
  expect(saved.tools.videoGeneration.enabled).toBe(false);
});

it.each(['zh-CN', 'en'])('opens the requested video tab and sends connection tests to separate endpoints in %s', async lng => {
  await mount('/settings/multimodal-generation?tab=video', lng);
  const test = lng === 'en' ? 'Test connection' : '测试连接';
  fireEvent.click(panel().getByRole('button', { name: test }));
  await waitFor(() => expect(mocks.fetch.mock.calls.some(([url]) => url === '/api/video-generation/test')).toBe(true));
  switchTab(lng === 'en' ? /Images/ : /图像/);
  fireEvent.click(panel().getByRole('button', { name: test }));
  await waitFor(() => expect(mocks.fetch.mock.calls.some(([url]) => url === '/api/image-generation/test')).toBe(true));
  expect((panel().getByRole('switch')).getAttribute('aria-checked')).toBe('true');
});
