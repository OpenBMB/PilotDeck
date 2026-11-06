import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, expect, it, vi } from 'vitest';
import en from '../../../i18n/locales/en/settings.json';
import zh from '../../../i18n/locales/zh-CN/settings.json';
import SettingsToggle from './view/SettingsToggle';
import { notifySettingsSaveSuccess, SettingsSuccessToastProvider, showSettingsSuccess, takeSettingsSaveSuccess } from './SettingsSuccessToast';

afterEach(() => { cleanup(); vi.useRealTimers(); while (takeSettingsSaveSuccess()) { /* drain queued fixtures */ } });

async function setup(language: string, toggle?: { checked: boolean; queued?: boolean; silent?: boolean }) {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({ lng: language, fallbackLng: 'en', resources: {
    en: { settings: en }, 'zh-CN': { settings: zh },
  }, interpolation: { escapeValue: false } });
  const change = vi.fn();
  render(<I18nextProvider i18n={i18n}><SettingsSuccessToastProvider>
    {toggle && <SettingsToggle checked={toggle.checked} onChange={change} ariaLabel="Feature"
      suppressNextSaveToast={toggle.queued} showSuccessToast={!toggle.silent} />}
  </SettingsSuccessToastProvider></I18nextProvider>);
  return { i18n, change };
}

it.each(['en', 'zh-CN'])('localizes default save notifications in %s and after a language change', async language => {
  const { i18n } = await setup(language);
  act(() => showSettingsSuccess());
  expect(screen.getByRole('status').textContent).toBe(language === 'en' ? en.saveStatus.success : zh.saveStatus.success);
  await act(() => i18n.changeLanguage(language === 'en' ? 'zh-CN' : 'en'));
  act(() => notifySettingsSaveSuccess());
  expect(screen.getByRole('status').textContent).toBe(language === 'en' ? zh.saveStatus.success : en.saveStatus.success);
  act(() => showSettingsSuccess('Custom message'));
  expect(screen.getByRole('status').textContent).toBe('Custom message');
});

it.each([
  ['en', false, 'Feature enabled'], ['en', true, 'Feature disabled'],
  ['zh-CN', false, 'Feature已开启'], ['zh-CN', true, 'Feature已关闭'],
] as const)('localizes toggle confirmation in %s for checked=%s', async (language, checked, expected) => {
  const { change } = await setup(language, { checked });
  fireEvent.click(screen.getByRole('switch'));
  expect(change).toHaveBeenCalledWith(!checked);
  expect(screen.getByRole('status').textContent).toBe(expected);
});

it('defers queued confirmations until the save succeeds', async () => {
  await setup('en', { checked: false, queued: true });
  fireEvent.click(screen.getByRole('switch'));
  expect(screen.queryByRole('status')).toBeNull();
  act(() => notifySettingsSaveSuccess(takeSettingsSaveSuccess()));
  expect(screen.getByRole('status').textContent).toBe('Feature enabled');
});

it('keeps notifications disabled for controls with their own save feedback', async () => {
  const { change } = await setup('en', { checked: false, silent: true });
  fireEvent.click(screen.getByRole('switch'));
  expect(change).toHaveBeenCalledWith(true);
  expect(screen.queryByRole('status')).toBeNull();
  expect(takeSettingsSaveSuccess()).toBeUndefined();
});

it('still dismisses a visible notification after changing languages', async () => {
  const { i18n } = await setup('en');
  vi.useFakeTimers();
  act(() => showSettingsSuccess());
  await act(() => i18n.changeLanguage('zh-CN'));
  act(() => vi.advanceTimersByTime(2400));
  expect(screen.queryByRole('status')).toBeNull();
});
