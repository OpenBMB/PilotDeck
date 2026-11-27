import type { MenuItemConstructorOptions } from 'electron';
import type { DesktopAppearance } from './appearance';
import { commandEnabled, emptyMenuState, type DesktopCommand, type DesktopMenuState } from './desktopCommands';

export type MenuActions = {
  state?: DesktopMenuState;
  dispatch?: (command: DesktopCommand) => void;
  help?: (action: 'docs' | 'issues' | 'logs' | 'version' | 'about') => void;
};

/** Native roles preserve platform editing, window management and shortcuts. */
export function buildApplicationMenu(
  platform: NodeJS.Platform,
  language: DesktopAppearance['language'],
  requestQuit?: () => void,
  actions: MenuActions = {},
): MenuItemConstructorOptions[] {
  const mac = platform === 'darwin';
  const state = actions.state ?? emptyMenuState;
  const text = (zh: string, en: string) => language === 'zh-CN' ? zh : en;
  const item = (role: MenuItemConstructorOptions['role'], zh: string, en: string): MenuItemConstructorOptions => ({ role, label: text(zh, en) });
  const separator: MenuItemConstructorOptions = { type: 'separator' };
  const command = (id: DesktopCommand, zh: string, en: string, accelerator?: string, visible = true): MenuItemConstructorOptions => ({
    id, label: text(zh, en), enabled: commandEnabled(id, state), visible,
    ...(accelerator ? { accelerator } : {}), click: () => actions.dispatch?.(id),
  });
  const quit: MenuItemConstructorOptions = platform === 'win32' && requestQuit
    ? { id: 'quit', label: text('退出', 'Exit'), accelerator: 'Ctrl+Q', click: requestQuit, visible: false }
    : { ...item('quit', '退出 PilotDeck', 'Quit PilotDeck'), id: 'quit', visible: false };
  const help = (id: 'docs' | 'issues' | 'logs' | 'version', zh: string, en: string): MenuItemConstructorOptions => ({
    id: `help-${id}`, label: text(zh, en), click: () => actions.help?.(id),
  });
  const updates = command('check-updates', '检查更新…', 'Check for Updates…', undefined, false);
  const about: MenuItemConstructorOptions = mac ? item('about', '关于 PilotDeck', 'About PilotDeck')
    : { id: 'help-about', label: text('关于 PilotDeck', 'About PilotDeck'), click: () => actions.help?.('about') };
  return [
    { id: 'menu-edit', label: text('编辑', mac ? 'Edit' : '&Edit'), submenu: [
      item('undo', '撤销', 'Undo'), item('redo', '重做', 'Redo'), separator,
      item('cut', '剪切', 'Cut'), item('copy', '复制', 'Copy'), item('paste', '粘贴', 'Paste'),
      // Native Delete acts on the focused editor; only enable it while text is selected.
      { ...item('delete', '删除', 'Delete'), enabled: state.ready && !state.blocked && state.editSelection }, separator,
      { ...item('reload', '重新加载', 'Reload'), accelerator: 'CmdOrCtrl+R' },
      // Hidden accelerator-only entries — keep shortcuts registered but hide from menu
      { ...item('selectAll', '全选', 'Select All'), accelerator: 'CmdOrCtrl+A', visible: false },
      { ...command('find', '查找…', 'Find…', 'CmdOrCtrl+F'), registerAccelerator: false, visible: false },
      command('new-conversation', '新对话', 'New Conversation', 'CmdOrCtrl+N', false),
      command('new-project', '新建项目…', 'New Project…', 'CmdOrCtrl+Shift+N', false),
      command('settings', '设置…', 'Settings…', 'CmdOrCtrl+,', false),
      quit,
    ] },
    { id: 'menu-help', label: text('帮助', mac ? 'Help' : '&Help'), role: 'help', submenu: [
      help('docs', '使用文档', 'Documentation'),
      help('issues', '反馈问题', 'Report an Issue'),
      help('logs', '打开日志文件', 'Open Log File'),
      ...(!mac ? [updates, about] : [about]),
    ] },
  ];
}
