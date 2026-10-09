import { createInstance } from 'i18next';
import { expect, it } from 'vitest';
import { languages } from '../../../../i18n/languages';
import en from '../../../../i18n/locales/en/settings.json';
import zh from '../../../../i18n/locales/zh-CN/settings.json';

const resources: Record<string, { settingsPage: { about: { desktopUpdate: typeof en.settingsPage.about.desktopUpdate } } }> = { en, 'zh-CN': zh };
function leaves(value: object, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof child === 'object' && child !== null ? leaves(child, path) : [path];
  });
}
it('has complete update translations for every supported language', async () => {
  expect(Object.keys(resources).sort()).toEqual(languages.map(language => language.value).sort());
  const keys = leaves(en.settingsPage.about.desktopUpdate).sort();
  for (const language of languages) {
    expect(leaves(resources[language.value].settingsPage.about.desktopUpdate).sort()).toEqual(keys);
    const i18n = createInstance();
    await i18n.init({ lng: language.value, fallbackLng: false, resources: { [language.value]: { settings: resources[language.value] } } });
    for (const key of keys) {
      const fullKey = `settingsPage.about.desktopUpdate.${key}`;
      expect(i18n.exists(fullKey, { ns: 'settings' })).toBe(true);
      const value = i18n.t(fullKey, { ns: 'settings' });
      expect(value.trim()).not.toBe(''); expect(value).not.toBe(fullKey);
    }
    const button = i18n.t('settingsPage.about.desktopUpdate.checkAgain', { ns: 'settings' });
    for (const reason of ['checkFailed', 'checksumMismatch', 'invalidUpdateMetadata', 'updateFailed']) {
      expect(i18n.t(`settingsPage.about.desktopUpdate.reasons.${reason}`, { ns: 'settings' })).toContain(button);
    }
  }
});
