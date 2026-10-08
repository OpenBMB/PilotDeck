import type { IpcRenderer } from 'electron';
import { MAC_CAPTION_HEIGHT, WINDOWS_CAPTION_HEIGHT, WINDOWS_MENUS, windowPalette } from './windowChrome';
import { createLinuxCaptionPopup } from './linuxCaptionPopup';

/** Desktop-owned caption exists on loading, sign-in, settings and error pages too. */
export function installWindowChrome(
  platform: NodeJS.Platform,
  ipc: Pick<IpcRenderer, 'on' | 'invoke' | 'sendSync'>,
): void {
  if (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux') return;
  const install = () => {
    const root = document.documentElement;
    const appearance = ipc.sendSync('pilotdeck:get-appearance');
    if (appearance?.language === 'en' || appearance?.language === 'zh-CN') {
      root.lang = appearance.language;
    }
    root.dataset.desktopPlatform = platform;
    const host = document.createElement('div');
    host.id = 'pilotdeck-window-caption';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { position:fixed; top:0; left:0; height:var(--desktop-caption-height); z-index:10000;
        width:100%; display:block; background:var(--desktop-caption-bg); color:var(--desktop-caption-fg);
        -webkit-app-region:drag; user-select:none; }
      :host([hidden]) { display:none; }
      :host([data-platform="win32"]),:host([data-platform="linux"]) { left:env(titlebar-area-x,0px); width:env(titlebar-area-width,calc(100% - 150px)); }
      :host([data-integrated]) { width:var(--desktop-sidebar-width); box-sizing:border-box; border-right:1px solid var(--desktop-caption-border); }
      :host([data-platform="darwin"]) { width:100%; background:transparent; border:0; }
      :host([data-platform="darwin"][data-toolbar]) { width:100px; }
      nav { display:flex; align-items:center; height:100%; padding:0 8px; gap:2px; }
      button { -webkit-app-region:no-drag; padding:0 12px; height:calc(100% - 8px); max-height:32px;
        display:flex; align-items:center; border:0; border-radius:6px;
        color:inherit; background:transparent; font:13px system-ui; cursor:default; }
      button:hover,button[aria-expanded="true"] { background:color-mix(in srgb,currentColor 10%,transparent); }
      button:focus-visible { outline:2px solid #818cf8; outline-offset:-2px; }
    `;
    shadow.append(style);
    host.dataset.platform = platform;
    const nav = document.createElement('nav');
    const buttons = WINDOWS_MENUS.map(menu => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.menu = menu.id;
      button.setAttribute('aria-haspopup', 'menu');
      button.setAttribute('aria-expanded', 'false');
      nav.append(button);
      return button;
    });
    if (platform !== 'darwin') shadow.append(nav);
    let menuOpen = false;
    let activeMenu: string | undefined;
    let hoverOpenedId: string | undefined;
    let requestSerial = 0;
    const setActiveMenu = (id?: string) => {
      activeMenu = id;
      menuOpen = id !== undefined;
      buttons.forEach(button => button.setAttribute('aria-expanded', String(button.dataset.menu === id)));
    };
    const linuxPopup = platform === 'linux' ? createLinuxCaptionPopup(root, buttons, ipc, setActiveMenu) : null;
    if (!linuxPopup) ipc.on('pilotdeck:caption-menu', (_event, id: string | null) => setActiveMenu(id ?? undefined));
    const openMenu = async (button?: HTMLButtonElement, toggle = false, focusFirst = false) => {
      const id = button?.dataset.menu ?? 'all';
      if (linuxPopup) { await linuxPopup.open(button?.dataset.menu ?? WINDOWS_MENUS[0].id, toggle, focusFirst); return; }
      if (menuOpen && activeMenu === id) return;
      const serial = ++requestSerial;
      setActiveMenu(id);
      try {
        if (button) await ipc.invoke('pilotdeck:show-menu', { id, buttons: buttons.map(item => {
          const rect = item.getBoundingClientRect();
          return { id: item.dataset.menu, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }) });
        else await ipc.invoke('pilotdeck:show-menu');
      } catch (error) { console.warn('Could not open application menu', error); }
      finally { if (serial === requestSerial) setActiveMenu(); }
    };
    // Preserve the input selection for native editing actions from the popup.
    buttons.forEach((button, index) => {
      button.addEventListener('pointerdown', event => event.preventDefault());
      button.addEventListener('click', () => {
        if (linuxPopup && hoverOpenedId === button.dataset.menu) { hoverOpenedId = undefined; return; }
        hoverOpenedId = undefined;
        void openMenu(button, true);
      });
      button.addEventListener('mouseenter', () => {
        if (menuOpen && activeMenu !== button.dataset.menu) {
          if (linuxPopup) hoverOpenedId = button.dataset.menu;
          void openMenu(button);
        }
      });
      button.addEventListener('mouseleave', () => { if (hoverOpenedId === button.dataset.menu) hoverOpenedId = undefined; });
      button.addEventListener('keydown', event => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault();
          const next = buttons[(index + (event.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length];
          next.focus();
          if (menuOpen) void openMenu(next);
        } else if (event.key === 'ArrowDown') {
          event.preventDefault(); void openMenu(button, false, true);
        }
      });
    });
    window.addEventListener('keydown', event => {
      if (platform === 'darwin' || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
      if (event.key === 'F10' && !event.altKey) {
        event.preventDefault(); void openMenu(platform === 'linux' ? buttons[0] : undefined, false, platform === 'linux');
      } else if (event.altKey) {
        const index = WINDOWS_MENUS.findIndex(menu => menu.key === event.key.toLowerCase());
        if (index >= 0) { event.preventDefault(); void openMenu(buttons[index]); }
      }
    });
    const sheet = document.createElement('style');
    sheet.textContent = `
      html[data-desktop-platform] { --desktop-caption-height:${platform === 'darwin' ? MAC_CAPTION_HEIGHT : WINDOWS_CAPTION_HEIGHT}px;
        --desktop-caption-bg:#fbfaff; --desktop-caption-fg:#262626; --desktop-bg:#fff; --desktop-caption-border:#e2dff3;
        --desktop-top-inset:var(--desktop-caption-height); }
      html[data-desktop-dark] { --desktop-caption-bg:#0a0a0a; --desktop-caption-fg:#e5e5e5; --desktop-bg:#0a0a0a; --desktop-caption-border:#262626; }
      html[data-desktop-platform="win32"],html[data-desktop-platform="linux"] { --desktop-caption-height:env(titlebar-area-height,${WINDOWS_CAPTION_HEIGHT}px); --desktop-caption-bg:#f4f4f5; }
      html[data-desktop-platform="win32"][data-desktop-dark],html[data-desktop-platform="linux"][data-desktop-dark] { --desktop-caption-bg:#171717; }
      html[data-desktop-fullscreen] { --desktop-caption-height:0px; }
      html[data-desktop-integrated] { --desktop-top-inset:0px; }
      html[data-desktop-platform] body { background:var(--desktop-bg); }
    `;
    document.head.append(sheet);
    document.body.append(host);
    const update = () => {
      const integrated = root.hasAttribute('data-desktop-integrated');
      host.toggleAttribute('data-integrated', integrated);
      host.toggleAttribute('data-toolbar', root.hasAttribute('data-desktop-toolbar'));
      host.hidden = root.hasAttribute('data-desktop-fullscreen');
      if (host.hidden) linuxPopup?.close();
      const zh = root.lang.startsWith('zh');
      nav.setAttribute('aria-label', zh ? '应用菜单' : 'Application menu');
      buttons.forEach((button, index) => {
        const menu = WINDOWS_MENUS[index];
        button.textContent = zh ? menu.zh : menu.en;
        button.title = `${button.textContent} (Alt+${menu.key.toUpperCase()})`;
      });
      linuxPopup?.refresh();
    };
    new MutationObserver(update).observe(root, { attributes: true, attributeFilter: ['data-desktop-integrated', 'data-desktop-toolbar', 'data-desktop-fullscreen', 'lang'] });
    const applyState = (state: { fullscreen: boolean; dark: boolean; palette?: ReturnType<typeof windowPalette> }) => {
      // The main process uses this exact palette for the native caption buttons.
      // Inline values also survive late UI stylesheets and startup/recovery pages.
      const palette = state.palette ?? windowPalette(state.dark, platform);
      root.style.setProperty('--desktop-caption-bg', palette.caption);
      root.style.setProperty('--desktop-caption-fg', palette.symbol);
      root.toggleAttribute('data-desktop-fullscreen', state.fullscreen);
      root.toggleAttribute('data-desktop-dark', state.dark);
      update();
    };
    ipc.on('pilotdeck:window-state', (_event, state) => applyState(state));
    applyState(ipc.sendSync('pilotdeck:get-window-state'));
  };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
}
