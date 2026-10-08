import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from 'electron';

type Options = {
  platform: NodeJS.Platform;
  shouldConfirm: () => boolean;
  canHide: () => boolean;
  isQuitting: () => boolean;
  setQuitting: (value: boolean) => void;
  getWindow: () => BrowserWindow | null;
  restoreWindow: () => Promise<void>;
  hideWindow: () => void;
  isChinese: () => boolean;
  showDialog: (owner: BrowserWindow, options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;
  stopRuntime: () => Promise<void>;
  quit: () => void;
  reportError: (error: unknown) => void;
  reportStopError: (error: unknown) => void;
};

/** All native quit entry points meet here, including Dock Quit and Cmd+Q. */
export function createDesktopLifecycle(options: Options) {
  let phase: 'idle' | 'confirming' | 'stopping' | 'ready' | 'disposed' = 'idle';
  let generation = 0;
  const pendingHides = new WeakSet<BrowserWindow>();
  async function restore() {
    const window = options.getWindow();
    if (window) pendingHides.delete(window);
    await options.restoreWindow();
  }

  async function open() {
    if (options.isQuitting() || phase === 'disposed') return;
    try { await restore(); }
    catch (error) { options.reportError(error); }
  }

  async function stop() {
    if (phase === 'stopping' || phase === 'ready' || phase === 'disposed') return;
    ++generation; // Invalidate any dialog still open when system/update quit starts.
    phase = 'stopping';
    options.setQuitting(true);
    // Acknowledge quit before potentially slow process-tree cleanup. Keep the
    // renderer alive so a failed stop can restore the window and its draft.
    try { options.hideWindow(); }
    catch (error) { options.reportError(error); }
    try {
      await options.stopRuntime();
      phase = 'ready';
      options.quit(); // Re-enter before-quit only after cleanup succeeds.
    } catch (error) {
      phase = 'idle';
      options.setQuitting(false);
      await open();
      options.reportStopError(error);
    }
  }

  async function requestQuit(bypassConfirmation = false) {
    if (phase === 'stopping' || phase === 'ready' || phase === 'disposed') return;
    if (bypassConfirmation || options.isQuitting() || !options.shouldConfirm()) {
      await stop();
      return;
    }
    if (phase === 'confirming') return;
    phase = 'confirming';
    const attempt = ++generation;
    try {
      await restore();
      const owner = options.getWindow();
      if (attempt !== generation || options.isQuitting() || !owner || owner.isDestroyed()) return;
      const zh = options.isChinese();
      const { response } = await options.showDialog(owner, {
        type: 'question', title: 'PilotDeck',
        message: zh ? '是否要退出 PilotDeck？' : 'Quit PilotDeck?',
        detail: zh
          ? '退出后，后台服务和正在运行的任务将停止。关闭主窗口可以继续在后台运行。'
          : 'Quitting stops background services and running tasks. Close the main window to keep running in the background.',
        buttons: zh ? ['取消', '退出程序'] : ['Cancel', 'Quit'],
        defaultId: 0, cancelId: 0, noLink: true,
      });
      if (attempt !== generation || options.isQuitting()) return;
      if (response === 1) await stop();
    } catch (error) {
      options.reportError(error);
    } finally {
      if (attempt === generation && phase === 'confirming') phase = 'idle';
    }
  }

  return {
    open, requestQuit,
    beforeQuit(event: { preventDefault: () => void }) {
      if (phase === 'ready' || phase === 'disposed') return;
      event.preventDefault();
      void requestQuit();
    },
    attachWindow(window: BrowserWindow) {
      if (options.platform === 'darwin') {
        // Cocoa cannot reliably hide a window while it occupies a full-screen
        // Space. Finish leaving that Space before hiding, including a close
        // request that races the enter-full-screen animation.
        window.on('enter-full-screen', () => {
          if (pendingHides.has(window) && !options.isQuitting()) window.setFullScreen(false);
        });
        window.on('leave-full-screen', () => {
          if (pendingHides.has(window) && !options.isQuitting()) window.hide();
        });
      }
      window.on('close', event => {
        if (options.isQuitting() || !options.canHide()) return;
        event.preventDefault();
        // A confirmation sheet must retain its visible owner.
        if (phase === 'confirming') return;
        pendingHides.add(window);
        if (options.platform === 'darwin' && window.isFullScreen()) window.setFullScreen(false);
        else window.hide();
      });
    },
    dispose() { ++generation; phase = 'disposed'; },
  };
}
