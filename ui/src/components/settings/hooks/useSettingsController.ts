import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_CODE_EDITOR_SETTINGS } from '../constants/constants';
import type {
  CodeEditorSettingsState,
  ProjectSortOrder,
  SettingsMainTab,
} from '../types/types';

type UseSettingsControllerArgs = {
  isOpen: boolean;
  initialTab: string;
};

type PilotDeckSettingsStorage = {
  projectSortOrder?: ProjectSortOrder;
};

const KNOWN_MAIN_TABS: SettingsMainTab[] = ['appearance', 'permissions', 'config'];

const normalizeMainTab = (tab: string): SettingsMainTab => {
  // Older callers may still pass legacy ids ('agents', 'git', 'api', etc.) —
  // collapse anything we no longer support down to 'appearance' so the
  // settings dialog always lands on a valid tab.
  return KNOWN_MAIN_TABS.includes(tab as SettingsMainTab)
    ? (tab as SettingsMainTab)
    : 'appearance';
};

const parseJson = <T>(value: string | null, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const readCodeEditorSettings = (): CodeEditorSettingsState => ({
  // `theme` is kept in the state shape for backwards compatibility but the
  // editor now always mirrors the global app theme (see useCodeEditorSettings).
  theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  wordWrap: localStorage.getItem('codeEditorWordWrap') === 'true',
  showMinimap: localStorage.getItem('codeEditorShowMinimap') !== 'false',
  lineNumbers: localStorage.getItem('codeEditorLineNumbers') !== 'false',
  fontSize: localStorage.getItem('codeEditorFontSize') ?? DEFAULT_CODE_EDITOR_SETTINGS.fontSize,
});

/**
 * Slim controller for the Settings dialog. Only Appearance and Config tabs
 * remain, so this hook just tracks the active tab and the tiny bit of
 * Appearance-tab state (project sort order + code-editor preferences).
 */
export function useSettingsController({ isOpen, initialTab }: UseSettingsControllerArgs) {
  const [activeTab, setActiveTab] = useState<SettingsMainTab>(() => normalizeMainTab(initialTab));
  const [saveStatus, setSaveStatus] = useState<'success' | 'error' | null>(null);
  const [projectSortOrder, setProjectSortOrder] = useState<ProjectSortOrder>('name');
  const [codeEditorSettings, setCodeEditorSettings] = useState<CodeEditorSettingsState>(
    () => readCodeEditorSettings(),
  );

  // Reset to the requested tab whenever the dialog re-opens. Done with a
  // dedicated effect so we don't re-fire when only `activeTab` changes.
  useEffect(() => {
    if (!isOpen) return;
    setActiveTab(normalizeMainTab(initialTab));

    const stored = parseJson<PilotDeckSettingsStorage>(
      localStorage.getItem('pilotdeck-settings'),
      {},
    );
    setProjectSortOrder(stored.projectSortOrder === 'date' ? 'date' : 'name');
  }, [isOpen, initialTab]);

  // Persist code-editor preferences as the user toggles them — the editor
  // listens for the `codeEditorSettingsChanged` event to re-read.
  useEffect(() => {
    localStorage.setItem('codeEditorTheme', codeEditorSettings.theme);
    localStorage.setItem('codeEditorWordWrap', String(codeEditorSettings.wordWrap));
    localStorage.setItem('codeEditorShowMinimap', String(codeEditorSettings.showMinimap));
    localStorage.setItem('codeEditorLineNumbers', String(codeEditorSettings.lineNumbers));
    localStorage.setItem('codeEditorFontSize', codeEditorSettings.fontSize);
    window.dispatchEvent(new Event('codeEditorSettingsChanged'));
  }, [codeEditorSettings]);

  // Auto-save the Appearance preferences (currently only `projectSortOrder`)
  // back into the same `pilotdeck-settings` storage key the Settings
  // panel used. Other consumers still read from this key, so we keep the
  // shape stable.
  const isInitialLoadRef = useRef(true);
  useEffect(() => {
    if (isInitialLoadRef.current) {
      isInitialLoadRef.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      try {
        const existing = parseJson<Record<string, unknown>>(
          localStorage.getItem('pilotdeck-settings'),
          {},
        );
        localStorage.setItem(
          'pilotdeck-settings',
          JSON.stringify({
            ...existing,
            projectSortOrder,
            lastUpdated: new Date().toISOString(),
          }),
        );
        // Sidebar listens for this event to live-resort the project list,
        // and the Permissions tab uses the same channel to refresh after
        // imports. Without the dispatch the dropdown looks dead until you
        // reload the page.
        window.dispatchEvent(new Event('pilotdeck-settings-changed'));
        setSaveStatus('success');
      } catch (err) {
        console.error('Failed to persist Appearance settings:', err);
        setSaveStatus('error');
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [projectSortOrder]);

  // Reset save indicator after 2s.
  useEffect(() => {
    if (saveStatus === null) return;
    const timer = window.setTimeout(() => setSaveStatus(null), 2000);
    return () => window.clearTimeout(timer);
  }, [saveStatus]);

  // Reset the "first run" guard whenever the dialog re-opens so the first
  // change after re-opening still triggers an auto-save.
  useEffect(() => {
    if (isOpen) isInitialLoadRef.current = true;
  }, [isOpen]);

  const updateCodeEditorSetting = useCallback(
    <K extends keyof CodeEditorSettingsState>(key: K, value: CodeEditorSettingsState[K]) => {
      setCodeEditorSettings((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  return {
    activeTab,
    setActiveTab,
    saveStatus,
    projectSortOrder,
    setProjectSortOrder,
    codeEditorSettings,
    updateCodeEditorSetting,
  };
}
