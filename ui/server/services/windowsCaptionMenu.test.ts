// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { WindowsCaptionMenu } from '../../../apps/desktop/src/windowsCaptionMenu';

afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers();
  const owner = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, isFullScreen: () => false,
    getContentBounds: () => ({ x: 100, y: 100, width: 1000, height: 700 }),
    webContents: Object.assign(new EventEmitter(), { getZoomFactor: () => 1.25, isDestroyed: () => false, send: vi.fn() }),
  });
  const popups: any[] = [];
  let cursor = { x: 110, y: 110 };
  const template = () => ['file', 'edit', 'view'].map(id => ({ id: `menu-${id}`, submenu: [{ label: id }] }));
  const build = (items: unknown[]) => {
    const popup = { items, options: undefined as any, popup: vi.fn(options => { popup.options = options; }), closePopup: vi.fn() };
    popups.push(popup);
    return popup as any;
  };
  const controller = new WindowsCaptionMenu(owner as any, template, build, () => cursor);
  const buttons = ['file', 'edit', 'view'].map((id, index) => ({ id: `menu-${id}`, x: index * 60, y: 0, width: 60, height: 32 }));
  return { owner, controller, buttons, popups, move: (x: number, y: number) => { cursor = { x, y }; vi.advanceTimersByTime(40); } };
}

it('switches on native cursor hover at zoomed coordinates without renderer events', async () => {
  const f = fixture();
  let closed = false;
  const done = f.controller.show({ id: 'menu-file', buttons: f.buttons }).then(() => { closed = true; });
  f.move(185, 110); // second button at x=100+60*1.25
  expect(f.popups[0].closePopup).toHaveBeenCalledOnce();
  expect(f.popups).toHaveLength(1); // wait for native close callback
  f.popups[0].options.callback();
  await vi.advanceTimersByTimeAsync(1);
  expect(closed).toBe(false);
  expect(f.popups[1].items).toEqual([{ label: 'edit' }]);
  expect(f.popups[1].options.x).toBe(75);
  expect(f.owner.webContents.send).toHaveBeenLastCalledWith('pilotdeck:caption-menu', 'menu-edit');
  f.move(270, 170); // outside caption: do not switch
  expect(f.popups[1].closePopup).not.toHaveBeenCalled();
  f.popups[1].options.callback(); // Escape/outside click completes the session
  await done;
  expect(closed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('coalesces repeated click requests during native close and ignores stale callbacks', async () => {
  const f = fixture();
  const first = f.controller.show({ id: 'menu-file', buttons: f.buttons });
  const second = f.controller.show({ id: 'menu-edit', buttons: f.buttons });
  const third = f.controller.show({ id: 'menu-view', buttons: f.buttons });
  expect(f.popups[0].closePopup).toHaveBeenCalledOnce();
  f.popups[0].options.callback();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.popups[1].items).toEqual([{ label: 'view' }]);
  f.popups[0].options.callback();
  expect(f.owner.webContents.send).toHaveBeenLastCalledWith('pilotdeck:caption-menu', 'menu-view');
  f.controller.close();
  f.popups[1].options.callback();
  await Promise.all([first, second, third]);
  expect(vi.getTimerCount()).toBe(0);
});

it('cancels pending transitions when navigating away and rejects unknown menus', async () => {
  const f = fixture();
  await f.controller.show({ id: 'unknown', buttons: f.buttons });
  expect(f.popups).toHaveLength(0);
  const first = f.controller.show({ id: 'menu-file', buttons: f.buttons });
  const second = f.controller.show({ id: 'menu-edit', buttons: f.buttons });
  f.owner.webContents.emit('did-start-navigation', {}, 'https://example.test', false, true);
  f.popups[0].options.callback();
  await Promise.all([first, second]);
  await vi.advanceTimersByTimeAsync(100);
  expect(f.popups).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});
