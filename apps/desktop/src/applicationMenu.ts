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
  const command = (id: DesktopCommand, zh: string, en: string, accelerator?: string): MenuItemConstructorOptions => ({
    id, label: text(zh, en), enabled: commandEnabled(id, state),
    ...(accelerator ? { accelerator } : {}), click: () => actions.dispatch?.(id),
  });
  const settings = command('settings', '设置…', 'Settings…', 'CmdOrCtrl+,');
  const updates = command('check-updates', '检查更新…', 'Check for Updates…');
  const about: MenuItemConstructorOptions = mac ? item('about', '关于 PilotDeck', 'About PilotDeck')
    : { id: 'help-about', label: text('关于 PilotDeck', 'About PilotDeck'), click: () => actions.help?.('about') };
  const quit: MenuItemConstructorOptions = platform === 'win32' && requestQuit
    ? { id: 'quit', label: text('退出', 'Exit'), accelerator: 'Ctrl+Q', click: requestQuit }
    : { ...item('quit', '退出 PilotDeck', 'Quit PilotDeck'), id: 'quit' };
  const help = (id: 'docs' | 'issues' | 'logs' | 'version', zh: string, en: string): MenuItemConstructorOptions => ({
    id: `help-${id}`, label: text(zh, en), click: () => actions.help?.(id),
  });
  return [
    ...(mac ? [{ label: 'PilotDeck', submenu: [
      about, updates, separator, settings, separator,
      item('services', '服务', 'Services'), separator,
      item('hide', '隐藏 PilotDeck', 'Hide PilotDeck'), item('hideOthers', '隐藏其他', 'Hide Others'),
      item('unhide', '显示全部', 'Show All'), separator, quit,
    ] }] : []),
    { id: 'menu-file', label: text('文件', mac ? 'File' : '&File'), submenu: [
      command('new-conversation', '新对话', 'New Conversation', 'CmdOrCtrl+N'),
      command('new-project', '新建项目…', 'New Project…', 'CmdOrCtrl+Shift+N'), separator,
      ...(!mac ? [settings, separator] : []),
      item('close', '关闭窗口', 'Close Window'), ...(!mac ? [quit] : []),
    ] },
    { id: 'menu-edit', label: text('编辑', mac ? 'Edit' : '&Edit'), submenu: [
      item('undo', '撤销', 'Undo'), item('redo', '重做', 'Redo'), separator,
      item('cut', '剪切', 'Cut'), item('copy', '复制', 'Copy'), item('paste', '粘贴', 'Paste'),
      item('selectAll', '全选', 'Select All'), separator,
      // Ctrl/Cmd+F stays in the renderer so focused file editors own search.
      { ...command('find', '查找…', 'Find…', 'CmdOrCtrl+F'), registerAccelerator: false },
    ] },
    { id: 'menu-view', label: text('查看', mac ? 'View' : '&View'), submenu: [
      // Do not capture editor/terminal Ctrl+B. The renderer handles this shortcut.
      { ...command('toggle-sidebar', '显示侧栏', 'Show Sidebar', 'CmdOrCtrl+B'),
        type: 'checkbox', checked: state.sidebarVisible, registerAccelerator: false }, separator,
      item('resetZoom', '实际大小', 'Actual Size'), item('zoomIn', '放大', 'Zoom In'), item('zoomOut', '缩小', 'Zoom Out'), separator,
      item('togglefullscreen', '切换全屏', 'Toggle Full Screen'), separator,
      // Normal reload preserves the existing beforeunload draft flush.
      { ...item('reload', '重新加载界面', 'Reload Interface'), accelerator: 'CmdOrCtrl+R' },
    ] },
    { id: 'menu-go', label: text('前往', mac ? 'Go' : '&Go'), submenu: [
      command('chat', '对话', 'Conversation'), command('files', '项目文件', 'Project Files'), separator,
      command('skills', '技能', 'Skills'), command('scheduled-tasks', '定时任务', 'Scheduled Tasks'),
    ] },
    ...(mac ? [{ label: text('窗口', 'Window'), role: 'windowMenu' as const, submenu: [
      item('minimize', '最小化', 'Minimize'), item('zoom', '缩放', 'Zoom'), separator,
      item('front', '全部置于前面', 'Bring All to Front'),
    ] }] : []),
    { id: 'menu-help', label: text('帮助', mac ? 'Help' : '&Help'), role: 'help', submenu: [
      help('docs', '使用文档', 'Documentation'), help('issues', '反馈问题／功能建议…', 'Report an Issue / Suggest a Feature…'), separator,
      help('logs', '打开日志文件', 'Open Log File'), help('version', '复制版本信息', 'Copy Version Information'),
      ...(!mac ? [separator, updates, about] : []),
    ] },
  ];
}
