// @vitest-environment node
import { expect, it } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { buildApplicationMenu } from '../../../apps/desktop/src/applicationMenu';

for (const platform of ['darwin', 'win32', 'linux'] as const) {
  for (const language of ['en', 'zh-CN'] as const) {
    it(`provides localized native reload and editing roles on ${platform}/${language}`, () => {
      const menu = buildApplicationMenu(platform, language);
      const items = menu.flatMap(section => section.submenu as MenuItemConstructorOptions[]);
      expect(items.find(item => item.role === 'reload')).toMatchObject({
        label: language === 'zh-CN' ? '重新加载界面' : 'Reload Interface', accelerator: 'CmdOrCtrl+R',
      });
      expect(items.filter(item => item.role === 'reload')).toHaveLength(1);
      for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'quit']) {
        expect(items.some(item => item.role === role)).toBe(true);
      }
      expect(menu.some(item => item.label === 'PilotDeck')).toBe(platform === 'darwin');
    });
  }
}

it('routes product actions and platform-specific help without enabling missing contexts', () => {
  const commands: string[] = [];
  const help: string[] = [];
  const state = { ready: true, blocked: false, canNewConversation: true, hasProject: false, canFind: false, sidebarVisible: true };
  for (const platform of ['darwin', 'win32'] as const) {
    const menu = buildApplicationMenu(platform, 'zh-CN', undefined, {
      state, dispatch: command => commands.push(command), help: action => help.push(action),
    });
    const items = menu.flatMap(section => section.submenu as MenuItemConstructorOptions[]);
    expect(items.find(item => item.id === 'files')?.enabled).toBe(false);
    expect(items.find(item => item.id === 'find')?.enabled).toBe(false);
    expect(items.find(item => item.id === 'toggle-sidebar')).toMatchObject({ checked: true, registerAccelerator: false });
    for (const id of ['new-conversation', 'new-project', 'settings', 'skills', 'scheduled-tasks', 'check-updates']) {
      const entry = items.find(item => item.id === id)!;
      expect(entry.enabled).toBe(true);
      (entry.click as Function)();
      expect(commands.at(-1)).toBe(id);
    }
    (items.find(item => item.id === 'help-docs')!.click as Function)();
    expect(help.at(-1)).toBe('docs');
    const settingsSection = menu.find(section => (section.submenu as MenuItemConstructorOptions[]).some(item => item.id === 'settings'));
    expect(settingsSection?.label).toBe(platform === 'darwin' ? 'PilotDeck' : '文件');
  }
});

it('disables application actions while loading or behind a blocking dialog', () => {
  for (const state of [undefined, { ready: true, blocked: true, canNewConversation: true, hasProject: true, canFind: true, sidebarVisible: true }]) {
    const items = buildApplicationMenu('darwin', 'en', undefined, { state }).flatMap(section => section.submenu as MenuItemConstructorOptions[]);
    for (const id of ['new-conversation', 'new-project', 'settings', 'files', 'find']) expect(items.find(item => item.id === id)?.enabled).toBe(false);
    expect(items.find(item => item.role === 'reload')?.enabled).not.toBe(false);
  }
});
