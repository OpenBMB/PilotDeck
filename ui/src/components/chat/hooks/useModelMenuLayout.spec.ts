import { describe, expect, it } from 'vitest';
import { placeModelMenu } from './useModelMenuLayout';

const viewport = { left: 0, top: 0, width: 1000, height: 700 };
describe('model menu window boundaries', () => {
  it('opens advanced settings to the left near the right edge', () => {
    const placement = placeModelMenu({ left: 870, right: 980, top: 620, bottom: 652 }, viewport, 310, 300);
    expect(placement.side).toBe('left');
    expect(Number(placement.advanced.left) + 212).toBeLessThan(Number(placement.menu.left));
    expect(Number(placement.menu.left) + Number(placement.menu.width)).toBeLessThanOrEqual(988);
  });
  it('keeps the right-hand submenu when space is available', () => {
    const placement = placeModelMenu({ left: 200, right: 300, top: 620, bottom: 652 }, viewport, 310, 300);
    expect(placement.side).toBe('right');
    expect(Number(placement.advanced.left)).toBeGreaterThan(Number(placement.menu.left) + 256);
  });
  it('switches to an internal page when neither side fits', () => {
    const placement = placeModelMenu({ left: 225, right: 325, top: 530, bottom: 562 }, { ...viewport, width: 375, height: 600 }, 310, 300);
    expect(placement.inline).toBe(true);
    expect(placement.advanced.position).toBe('relative');
    expect(Number(placement.menu.left) + Number(placement.menu.width)).toBeLessThanOrEqual(363);
  });
  it('opens below a trigger near the top instead of extending above the window', () => {
    const placement = placeModelMenu({ left: 300, right: 400, top: 40, bottom: 72 }, viewport, 310, 300);
    expect(placement.menu.top).toBe(80);
    expect(placement.menu.maxHeight).toBe(608);
  });
  it('bounds both menus in a short window and leaves content scrollable', () => {
    const placement = placeModelMenu({ left: 870, right: 980, top: 210, bottom: 242 }, { ...viewport, height: 290 }, 310, 400);
    expect(placement.menu.maxHeight).toBe(190);
    expect(placement.menu.top).toBe(12);
    expect(placement.advanced.maxHeight).toBe(266);
    expect(placement.advanced.top).toBe(12);
  });
  it('uses the visible viewport after zoom or an on-screen keyboard', () => {
    const placement = placeModelMenu({ left: 450, right: 560, top: 320, bottom: 352 }, { left: 240, top: 100, width: 360, height: 300 }, 310, 400);
    expect(placement.inline).toBe(true);
    expect(Number(placement.menu.left)).toBeGreaterThanOrEqual(252);
    expect(Number(placement.menu.left) + Number(placement.menu.width)).toBeLessThanOrEqual(588);
    expect(placement.menu.top).toBe(112);
    expect(placement.menu.maxHeight).toBe(200);
  });
});
