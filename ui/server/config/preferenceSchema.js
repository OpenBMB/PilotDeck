// Shared by the browser cache and server YAML store. Authentication tokens,
// message drafts, request identifiers and caches are deliberately separate state.
const names = new Set([
  'theme', 'themeMode', 'userLanguage', 'tasks-enabled', 'uiPreferences', 'activeTab',
  'codeEditorTheme', 'codeEditorWordWrap', 'codeEditorShowMinimap', 'codeEditorLineNumbers', 'codeEditorFontSize',
  'pilotdeck-settings', 'pilotdeck-model', 'pilotdeck-notifications-v1',
  'pilotdeck-light-appearance-v1', 'pilotdeck-interface-preferences-v1',
  'autoExpandTools', 'showThinking', 'inlineThinking', 'autoScrollToBottom', 'sendByCtrlEnter', 'sidebarVisible',
  'sidebar-v2-width', 'sidebar-v2-projects-conversations-split', 'sidebar-v2-projects-conversations-split-v2',
  'pilotdeck:customProjectNames', 'pilotdeck:customSessionTitles', 'pilotdeck:files-panel-layout', 'pilotdeck:files-panel-order',
  'pilotdeck:files-assistant-width', 'pilotdeck:dashboard-panel-width', 'pilotdeck:global-search-history',
  'composer-model-global', 'pilotdeck:composer-model-global', 'composer-model-last-sent',
]);
const booleanKeys = new Set(['tasks-enabled', 'codeEditorWordWrap', 'codeEditorShowMinimap', 'codeEditorLineNumbers', 'autoExpandTools', 'showThinking', 'inlineThinking', 'autoScrollToBottom', 'sendByCtrlEnter', 'sidebarVisible']);
const objectKeys = new Set(['uiPreferences', 'pilotdeck-settings', 'pilotdeck-notifications-v1', 'pilotdeck-light-appearance-v1', 'pilotdeck-interface-preferences-v1', 'composer-model-last-sent', 'pilotdeck:customProjectNames', 'pilotdeck:customSessionTitles']);
export function isPreferenceKey(key) {
  return typeof key === 'string' && (names.has(key) || /^pilotdeck\.folder-picker\.v1:[\w-]+$/.test(key));
}
export function decodePreference(raw) {
  if (typeof raw !== 'string' || raw.length > 128 * 1024) throw new Error('Invalid preference value');
  try { return { value: JSON.parse(raw), json: true }; } catch { return { value: raw, json: false }; }
}
export function normalizePreferenceDocument(value, issue = () => {}) {
  const jsonKeys = new Set(Array.isArray(value.jsonKeys) ? value.jsonKeys : []);
  const values = {};
  for (const [key, item] of Object.entries(value.values || {})) {
    let valid = isPreferenceKey(key);
    if (key === 'theme' || key === 'themeMode') valid &&= ['light', 'dark', 'system'].includes(item);
    if (key === 'codeEditorFontSize') valid &&= Number(item) >= 8 && Number(item) <= 72;
    if (key === 'userLanguage') valid &&= ['zh-CN', 'en', 'en-US', 'zh'].includes(item);
    if (booleanKeys.has(key)) valid &&= typeof item === 'boolean';
    if (objectKeys.has(key)) valid &&= item !== null && typeof item === 'object' && !Array.isArray(item);
    if (valid && key === 'uiPreferences') {
      for (const [field, fallback] of Object.entries({ autoExpandTools: false, showThinking: true, inlineThinking: false, autoScrollToBottom: true, sendByCtrlEnter: false, sidebarVisible: true })) {
        if (Object.hasOwn(item, field) && typeof item[field] !== 'boolean') { item[field] = fallback; issue(`values.${key}.${field}`, 'Expected a boolean; using its default.'); }
      }
    }
    if (item === null || typeof item === 'number' && !Number.isFinite(item)) valid = false;
    if (valid) values[key] = item;
    else issue(`values.${key}`, 'Invalid preference; the interface will use its default.');
  }
  return { ...value, values, jsonKeys: [...jsonKeys].filter(key => Object.hasOwn(values, key)) };
}
