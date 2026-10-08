import type { BrowserWindow, Menu, MenuItemConstructorOptions, Point } from 'electron';
import { WINDOWS_CAPTION_HEIGHT, WINDOWS_MENUS } from './windowChrome';

type ButtonBounds = { id: string; x: number; y: number; width: number; height: number };
export type CaptionMenuRequest = { id?: string; buttons?: ButtonBounds[] };
const knownMenu = (id: unknown): id is string => WINDOWS_MENUS.some(menu => menu.id === id);

/** A native popup captures mouse input before it reaches the renderer. Track the
 * cursor only while menus are open, and serialize close/open across menu changes. */
export class WindowsCaptionMenu {
  private buttons: ButtonBounds[] = [];
  private popup?: Menu;
  private current?: string | null;
  private pending?: string | null;
  private closing = false;
  private scheduled?: ReturnType<typeof setImmediate>;
  private timer?: ReturnType<typeof setInterval>;
  private cursor?: Point;
  private completions: (() => void)[] = [];

  constructor(
    private owner: BrowserWindow,
    private template: () => MenuItemConstructorOptions[],
    private build: (template: MenuItemConstructorOptions[]) => Menu,
    private getCursor: () => Point,
  ) {
    owner.on('closed', () => this.finish());
    owner.on('hide', () => this.close());
    owner.on('resize', () => this.close());
    owner.on('move', () => this.close());
    owner.webContents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
      if (isMainFrame && !inPlace) this.close();
    });
  }

  show(request?: CaptionMenuRequest): Promise<void> {
    if (this.owner.isDestroyed() || (request?.id !== undefined && !knownMenu(request.id))) return Promise.resolve();
    const id = request?.id ?? null;
    if (Array.isArray(request?.buttons)) this.buttons = request.buttons.filter(button => button && knownMenu(button.id)
      && [button.x, button.y, button.width, button.height].every(Number.isFinite)
      && button.x >= 0 && button.y >= 0 && button.width > 0 && button.height > 0);
    const result = new Promise<void>(resolve => this.completions.push(resolve));
    if (!this.timer) {
      this.cursor = this.getCursor();
      this.timer = setInterval(() => this.trackHover(), 40);
    }
    this.switchTo(id);
    return result;
  }

  close(): void {
    this.pending = undefined;
    if (this.scheduled) clearImmediate(this.scheduled);
    this.scheduled = undefined;
    if (this.popup && !this.closing) {
      this.closing = true;
      this.popup.closePopup(this.owner);
    } else if (!this.popup) this.finish();
  }

  private switchTo(id: string | null): void {
    if (id === this.current && !this.closing) return;
    this.pending = id;
    if (this.popup) {
      if (!this.closing) {
        this.closing = true;
        this.popup.closePopup(this.owner);
      }
    } else if (!this.scheduled) this.openPending();
  }

  private openPending(): void {
    this.scheduled = undefined;
    const id = this.pending;
    this.pending = undefined;
    if (id === undefined || this.owner.isDestroyed()) { this.finish(); return; }
    const template = this.template();
    const items = id === null ? template : template.find(item => item.id === id)?.submenu;
    if (!Array.isArray(items)) { this.finish(); return; }
    const menu = this.build(items);
    this.popup = menu;
    this.current = id;
    this.closing = false;
    this.owner.webContents.send('pilotdeck:caption-menu', id ?? 'all');
    const bounds = this.owner.getContentBounds();
    const x = Math.round((this.buttons.find(button => button.id === id)?.x ?? 12) * this.owner.webContents.getZoomFactor());
    try {
      menu.popup({ window: this.owner, x: Math.max(0, Math.min(bounds.width, x)),
        y: this.owner.isFullScreen() ? 0 : WINDOWS_CAPTION_HEIGHT,
        callback: () => {
          if (this.popup !== menu) return;
          this.popup = undefined;
          this.current = undefined;
          this.closing = false;
          // Leave the native popup's close callback before creating its replacement.
          if (this.pending !== undefined) this.scheduled = setImmediate(() => this.openPending());
          else this.finish();
        },
      });
    } catch (error) { this.finish(); throw error; }
  }

  private trackHover(): void {
    if (this.owner.isDestroyed()) { this.finish(); return; }
    const point = this.getCursor();
    const previous = this.cursor;
    this.cursor = point;
    if (!previous || (point.x === previous.x && point.y === previous.y) || this.owner.isFullScreen()) return;
    const bounds = this.owner.getContentBounds();
    const x = point.x - bounds.x;
    const y = point.y - bounds.y;
    if (x < 0 || x >= bounds.width || y < 0 || y >= WINDOWS_CAPTION_HEIGHT) return;
    const zoom = this.owner.webContents.getZoomFactor();
    const button = this.buttons.find(button => x >= button.x * zoom && x < (button.x + button.width) * zoom
      && y >= button.y * zoom && y < (button.y + button.height) * zoom);
    if (button) this.switchTo(button.id);
  }

  private finish(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.scheduled) clearImmediate(this.scheduled);
    this.timer = undefined;
    this.scheduled = undefined;
    this.popup = undefined;
    this.current = undefined;
    this.pending = undefined;
    this.closing = false;
    if (!this.owner.isDestroyed() && !this.owner.webContents.isDestroyed()) this.owner.webContents.send('pilotdeck:caption-menu', null);
    this.completions.splice(0).forEach(resolve => resolve());
  }
}
