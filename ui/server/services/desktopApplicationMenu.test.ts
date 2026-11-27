// @vitest-environment node
import { expect, it } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { buildApplicationMenu } from '../../../apps/desktop/src/applicationMenu';

const flatten = (menu: MenuItemConstructorOptions[]) =>
  menu.flatMap(section => section.submenu as MenuItemConstructorOptions[]);
const menuState = (editSelection = false) => ({
  ready: true, blocked: false, canNewConversation: true,
  hasProject: true, canFind: true, sidebarVisible: true, editSelection,
});

for (const platform of ['darwin', 'win32', 'linux'] as const) {
  for (const language of ['en', 'zh-CN'] as const) {
    it(`keeps only Edit and Help with native reload and editing roles on ${platform}/${language}`, () => {
      const menu = buildApplicationMenu(platform, language, undefined, { state: menuState() });
      expect(menu.map(section => section.id)).toEqual(['menu-edit', 'menu-help']);
      const items = flatten(menu);
      expect(items.find(item => item.role === 'reload')).toMatchObject({
        label: language === 'zh-CN' ? '重新加载' : 'Reload', accelerator: 'CmdOrCtrl+R',
      });
      expect(items.filter(item => item.role === 'reload')).toHaveLength(1);
      for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'delete', 'selectAll', 'quit']) {
        expect(items.some(item => item.role === role)).toBe(true);
      }
      // Hidden entries keep their accelerators without cluttering the menu.
      expect(items.find(item => item.role === 'selectAll')).toMatchObject({ visible: false, accelerator: 'CmdOrCtrl+A' });
    });
  }
}

it('enables native Delete only while editable text is selected', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    const deleteItem = (editSelection: boolean) => flatten(buildApplicationMenu(platform, 'en', undefined, {
      state: menuState(editSelection),
    })).find(item => item.role === 'delete');
    expect(deleteItem(false)?.enabled).toBe(false);
    expect(deleteItem(true)?.enabled).toBe(true);
  }
});

it('routes hidden accelerators and help without resurrecting removed sections', () => {
  const commands: string[] = [];
  const help: string[] = [];
  const menu = buildApplicationMenu('win32', 'zh-CN', undefined, {
    state: menuState(), dispatch: command => commands.push(command), help: action => help.push(action),
  });
  const items = flatten(menu);
  for (const id of ['new-conversation', 'new-project', 'settings']) {
    const entry = items.find(item => item.id === id)!;
    expect(entry.visible).toBe(false);
    expect(entry.enabled).toBe(true);
    (entry.click as Function)();
    expect(commands.at(-1)).toBe(id);
  }
  (items.find(item => item.id === 'help-docs')!.click as Function)();
  expect(help.at(-1)).toBe('docs');
  for (const id of ['menu-file', 'menu-view', 'menu-go']) expect(menu.map(section => section.id)).not.toContain(id);
});

it('disables destructive editing while loading or behind a blocking dialog', () => {
  for (const state of [undefined, { ...menuState(true), blocked: true }]) {
    const items = flatten(buildApplicationMenu('darwin', 'en', undefined, { state }));
    expect(items.find(item => item.role === 'delete')?.enabled).toBe(false);
    expect(items.find(item => item.role === 'reload')?.enabled).not.toBe(false);
  }
});
