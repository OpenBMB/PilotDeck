import type { App, BrowserWindow, IpcMain, IpcMainInvokeEvent, NativeImage, nativeImage } from 'electron';

export function normalizeCompletionCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 99) : 0;
}

// Rasterize locally: Electron's NativeImage does not decode SVG. A 2x bitmap
// keeps the Windows 16-DIP overlay legible without an image/font dependency.
const digits = [
  ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
];

export function completionBadgeBitmap(count: number): Buffer {
  const bitmap = Buffer.alloc(32 * 32 * 4);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const alpha = Math.round(255 * Math.max(0, Math.min(1, 16 - Math.hypot(x - 15.5, y - 15.5))));
    const offset = (y * 32 + x) * 4;
    // NativeImage consumes premultiplied BGRA on Windows.
    bitmap[offset] = bitmap[offset + 1] = Math.round(38 * alpha / 255);
    bitmap[offset + 2] = Math.round(220 * alpha / 255);
    bitmap[offset + 3] = alpha;
  }
  const text = String(normalizeCompletionCount(count));
  const left = (32 - (text.length * 12 - 2)) / 2;
  [...text].forEach((digit, index) => {
    digits[Number(digit)].forEach((row, y) => [...row].forEach((pixel, x) => {
      if (pixel !== '1') return;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        bitmap.fill(255, ((9 + y * 2 + dy) * 32 + left + index * 12 + x * 2 + dx) * 4,
          ((9 + y * 2 + dy) * 32 + left + index * 12 + x * 2 + dx) * 4 + 4);
      }
    }));
  });
  return bitmap;
}

type BadgeWindow = Pick<BrowserWindow, 'isDestroyed' | 'setOverlayIcon' | 'once' | 'webContents'>;

export function installCompletionBadge(options: {
  platform: NodeJS.Platform;
  app: Pick<App, 'isReady' | 'setBadgeCount' | 'on'>;
  ipcMain: Pick<IpcMain, 'handle'>;
  nativeImage: Pick<typeof nativeImage, 'createFromBitmap'>;
  getWindow: () => BadgeWindow | null;
  requireSender: (event: IpcMainInvokeEvent) => void;
}) {
  let lastImage: {count: number; image: NativeImage} | undefined;
  const set = (value: unknown) => {
    const count = normalizeCompletionCount(value);
    if (options.platform === 'win32') {
      const window = options.getWindow();
      if (!window || window.isDestroyed()) return;
      if (!count) { window.setOverlayIcon(null, ''); return; }
      if (lastImage?.count !== count) lastImage = {count, image: options.nativeImage.createFromBitmap(
        completionBadgeBitmap(count), {width: 32, height: 32, scaleFactor: 2},
      )};
      window.setOverlayIcon(lastImage.image, `${count} completed sessions waiting`);
    } else if ((options.platform === 'darwin' || options.platform === 'linux') && options.app.isReady()) {
      // Unsupported Linux launchers return false; the sidebar remains available.
      options.app.setBadgeCount(count);
    }
  };
  options.ipcMain.handle('pilotdeck:set-completion-badge', (event, count: unknown) => {
    options.requireSender(event);
    set(count);
  });
  options.app.on('will-quit', () => set(0));
  return {
    attachWindow(window: BadgeWindow) {
      window.once('closed', () => set(0));
      window.webContents.on('render-process-gone', () => set(0));
      window.webContents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
        if (isMainFrame && !inPlace) set(0);
      });
    },
  };
}
