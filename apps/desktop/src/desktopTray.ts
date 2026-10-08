import type { Menu, MenuItemConstructorOptions, Tray } from 'electron';

type Options = {
  platform: NodeJS.Platform;
  createTray: () => Tray;
  buildMenu: (items: MenuItemConstructorOptions[]) => Menu;
  isChinese: () => boolean;
  open: () => Promise<void>;
  requestQuit: () => Promise<void>;
  reportError: (error: unknown) => void;
};

/** Keep the native tray/status item referenced until the application really exits. */
export function createDesktopTray(options: Options) {
  let tray: Tray | null = null;
  let quitting = false;
  const available = () => tray !== null && !tray.isDestroyed();
  const invoke = (action: () => Promise<void>) => {
    if (!quitting) void action().catch(options.reportError);
  };
  function refreshMenu() {
    if (!available()) return;
    const zh = options.isChinese();
    const quittingLabel = zh ? '正在退出…' : 'Quitting…';
    tray!.setToolTip(quitting ? `PilotDeck — ${quittingLabel}` : 'PilotDeck');
    tray!.setContextMenu(options.buildMenu([
      { label: zh ? '打开主界面' : 'Open main window', enabled: !quitting, click: () => invoke(options.open) },
      { type: 'separator' },
      { label: quitting ? quittingLabel : zh ? '退出程序' : 'Quit', enabled: !quitting, click: () => invoke(options.requestQuit) },
    ]));
  }
  function dispose() {
    if (available()) tray!.destroy();
    tray = null;
  }
  try {
    tray = options.createTray();
    // macOS opens its native status menu on click. Do not also activate a window.
    if (options.platform === 'win32' || options.platform === 'linux') {
      tray.on('click', () => invoke(options.open));
    }
    if (options.platform === 'win32') {
      tray.on('double-click', () => invoke(options.open));
    }
    refreshMenu();
  } catch (error) {
    dispose();
    options.reportError(error);
  }
  return { available, refreshMenu, dispose,
    setQuitting(value: boolean) { quitting = value; refreshMenu(); },
  };
}
