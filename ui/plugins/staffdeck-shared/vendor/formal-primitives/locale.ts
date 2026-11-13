import { useTranslation } from 'react-i18next';
import catalog from '../locale/staffdeck-source-translations.json';

// Source labels only; never translate field values or user document content.
export function useI18n() {
  const { i18n } = useTranslation();
  return { t: (source: string) => i18n.resolvedLanguage?.startsWith('zh') ? source : (catalog as Record<string, string>)[source] || source };
}
