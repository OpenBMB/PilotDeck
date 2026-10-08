import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { placeFloatingPanel, useFloatingPanel } from './useFloatingPanel';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('floating panel boundaries', () => {
  it.each([
    { left: 0, top: 0, width: 1280, height: 600 },
    { left: 0, top: 0, width: 320, height: 300 },
    { left: 120, top: 100, width: 260, height: 220 },
  ])('stays inside the visual viewport $width x $height', viewport => {
    const anchor = { left: viewport.left + viewport.width - 30, right: viewport.left + viewport.width - 8, top: viewport.top + viewport.height - 50, bottom: viewport.top + viewport.height - 20 };
    const style = placeFloatingPanel(anchor, viewport, 400, 400);
    expect(Number(style.left)).toBeGreaterThanOrEqual(viewport.left + 8);
    expect(Number(style.left) + Number(style.width)).toBeLessThanOrEqual(viewport.left + viewport.width - 8);
    expect(Number(style.top) - Number(style.maxHeight)).toBeGreaterThanOrEqual(viewport.top + 8);
  });

  it('flips below a trigger near the top edge', () => {
    const style = placeFloatingPanel({ left: 10, right: 40, top: 10, bottom: 40 }, { left: 0, top: 0, width: 800, height: 600 }, 300, 400);
    expect(style.transform).toBeUndefined();
    expect(style.top).toBe(48);
  });

  it('tracks ancestor resizing and supports interaction inside a portal', () => {
    let resize!: () => void;
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
    let top = 500;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 20, y: top, left: 20, right: 60, top, bottom: top + 30, width: 40, height: 30, toJSON() {} }));
    function Harness() {
      const ref = useRef<HTMLButtonElement>(null);
      const [open, setOpen] = useState(false);
      const menu = useFloatingPanel(open, ref, () => setOpen(false));
      return <><button ref={ref} onClick={() => setOpen(true)}>Open</button><button>Outside</button>{open && createPortal(<div ref={menu.panelRef} style={menu.style} role="dialog"><input aria-label="Search" /></div>, document.body)}</>;
    }
    render(<Harness />);
    fireEvent.click(screen.getByText('Open'));
    const menu = screen.getByRole('dialog');
    expect(menu.parentElement).toBe(document.body);
    const previousTop = menu.style.top;
    top = 350;
    act(() => resize());
    expect(menu.style.top).not.toBe(previousTop);
    fireEvent.pointerDown(screen.getByRole('textbox'));
    fireEvent.focusIn(screen.getByRole('textbox'));
    expect(screen.getByRole('dialog')).toBe(menu);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByText('Open'));
    fireEvent.click(screen.getByText('Open'));
    fireEvent.pointerDown(screen.getByText('Outside'));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByText('Open'));
    screen.getByText('Open').style.visibility = 'hidden';
    act(() => resize());
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
