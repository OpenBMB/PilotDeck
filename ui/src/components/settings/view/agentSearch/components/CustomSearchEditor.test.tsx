// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { useState } from 'react';
import ToolsSection from './ToolsSection';
import en from '../../../../../i18n/locales/en/settings.json';
import zh from '../../../../../i18n/locales/zh-CN/settings.json';
const Provider = I18nextProvider as any;
afterEach(cleanup);
it.each(['en', 'zh-CN'])('edits, validates, previews and persists custom templates in %s', async lng => {
  const translations = lng === 'en' ? en : zh;
  const labels = translations.customSearch;
  const i18n = createInstance(); await i18n.init({ lng, resources: { en: { settings: en }, 'zh-CN': { settings: zh } }, defaultNS: 'settings', interpolation: { escapeValue: false } });
  let saved: any = { tools: { webSearch: { enabled: true, provider: 'custom', endpoint: 'https://example.test/search', apiKey: '********', customProvider: { auth: 'bearer' } } } };
  function Harness() {
    const [config, setConfig] = useState(saved);
    return <Provider i18n={i18n}><ToolsSection config={config} onChange={next => { saved = next; setConfig(next); }} /></Provider>;
  }
  const view = render(<Harness />);
  fireEvent.change(screen.getByLabelText(labels.endpoint), { target: { value: 'https://custom.example.test/search' } });
  fireEvent.change(screen.getByLabelText(labels.requestBody), { target: { value: '{"messages":[{"content":"{{query}}"}],"count":"{{limit}}"}' } });
  fireEvent.change(screen.getByLabelText(labels.testQuery), { target: { value: '中文 "quoted" & text' } });
  fireEvent.click(screen.getByRole('button', { name: labels.preview }));
  const preview = JSON.parse(screen.getByLabelText(labels.preview).textContent!);
  expect(JSON.parse(preview.init.body).messages[0].content).toBe('中文 "quoted" & text');
  expect(JSON.parse(preview.init.body).count).toBe(3);
  expect(JSON.stringify(preview)).not.toContain('********');
  fireEvent.change(screen.getByLabelText(labels.requestBody), { target: { value: '{invalid' } });
  fireEvent.click(screen.getByRole('button', { name: labels.save }));
  expect(screen.getByRole('alert').textContent).toContain(labels.invalidJson);
  expect(saved.tools.webSearch.providers).toBeUndefined();
  fireEvent.change(screen.getByLabelText(labels.requestBody), { target: { value: '{"messages":[{"content":"{{query}}"}],"count":"{{limit}}"}' } });
  fireEvent.change(screen.getByLabelText(labels.resultsPath), { target: { value: 'payload.hits' } });
  fireEvent.click(screen.getByRole('button', { name: labels.save }));
  expect(saved.tools.webSearch.providers.custom.apiKey).toBeUndefined();
  expect(saved.tools.webSearch.providers.custom.customProvider.resultsPath).toBe('payload.hits');
  view.unmount(); render(<Harness />);
  expect((screen.getByLabelText(labels.requestBody) as HTMLTextAreaElement).value).toContain('{{query}}');
  expect((screen.getByLabelText(labels.resultsPath) as HTMLInputElement).value).toBe('payload.hits');
  fireEvent.change(screen.getByLabelText(labels.method), { target: { value: 'GET' } });
  fireEvent.click(screen.getByRole('button', { name: labels.save }));
  expect(screen.getByRole('alert').textContent).toContain('GET');
});
