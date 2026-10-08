import type { IpcRenderer } from 'electron';
import type { LinuxCaptionEntry } from './linuxCaptionMenu';
import { WINDOWS_MENUS } from './windowChrome';

type MenuIpc = Pick<IpcRenderer, 'invoke' | 'on'>;

/** Linux's GTK popup cannot follow Electron's per-app theme at runtime. Keep
 * the native application menu for accelerators, and draw its title-bar popup
 * from the same current menu template in the isolated preload. */
export function createLinuxCaptionPopup(
  root: HTMLElement,
  buttons: HTMLButtonElement[],
  ipc: MenuIpc,
  setActiveMenu: (id?: string) => void,
) {
  const host = document.createElement('div');
  host.id = 'pilotdeck-linux-popup';
  host.hidden = true;
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { position:fixed; inset:0; z-index:10001; pointer-events:none; color:#262626;
      font:13px system-ui; -webkit-app-region:no-drag; }
    :host([hidden]) { display:none; }
    :host([data-dark]) { color:#eee; }
    .panel { position:fixed; box-sizing:border-box; min-width:250px; max-width:min(420px,calc(100vw - 16px));
      max-height:calc(100vh - 48px); overflow:auto; padding:6px; border-radius:9px;
      border:1px solid #dadada; background:#fff; box-shadow:0 12px 28px #0003;
      pointer-events:auto; -webkit-app-region:no-drag; }
    :host([data-dark]) .panel { border-color:#474747; background:#252525; box-shadow:0 12px 28px #0009; }
    .entry { display:flex; align-items:center; gap:20px; width:100%; min-height:30px;
      padding:4px 10px; box-sizing:border-box; border:0; border-radius:5px;
      background:transparent; color:inherit; font:inherit; text-align:left; white-space:nowrap; cursor:default; }
    .entry:hover:not(:disabled),.entry:focus-visible { background:#eae9f8; outline:0; }
    :host([data-dark]) .entry:hover:not(:disabled),:host([data-dark]) .entry:focus-visible { background:#44435d; }
    .entry:disabled { opacity:.48; }
    .check { width:14px; flex:none; text-align:center; }
    .label { flex:1; }
    .shortcut { color:#777; margin-left:auto; }
    :host([data-dark]) .shortcut { color:#aaa; }
    .separator { height:1px; margin:6px -6px; background:#e5e5e5; }
    :host([data-dark]) .separator { background:#494949; }
  `;
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.setAttribute('role', 'menu');
  shadow.append(style, panel);
  document.body.append(host);
  const captionHost = (buttons[0].getRootNode() as ShadowRoot).host;

  let activeId: string | undefined;
  let serial = 0;
  let previousFocus: HTMLElement | null = null;
  const setTheme = () => host.toggleAttribute('data-dark', root.hasAttribute('data-desktop-dark'));
  setTheme();
  new MutationObserver(setTheme).observe(root, { attributes: true, attributeFilter: ['data-desktop-dark'] });

  const close = (focusCaption = false) => {
    ++serial;
    const id = activeId;
    activeId = undefined;
    host.hidden = true;
    panel.replaceChildren();
    setActiveMenu();
    if (focusCaption && id) buttons.find(button => button.dataset.menu === id)?.focus();
  };

  const open = async (id: string, toggle = false, focusFirst = false) => {
    if (toggle && activeId === id) { close(true); return; }
    if (!activeId) previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const request = ++serial;
    activeId = id;
    setActiveMenu(id);
    let entries: LinuxCaptionEntry[];
    try { entries = await ipc.invoke('pilotdeck:linux-menu-items', id) as LinuxCaptionEntry[]; }
    catch (error) { console.warn('Could not read application menu', error); close(); return; }
    if (request !== serial || activeId !== id) return;
    panel.replaceChildren();
    const activate = (entry: LinuxCaptionEntry) => {
      const focus = previousFocus;
      close();
      if (focus?.isConnected && focus !== document.body && focus !== captionHost) focus.focus({ preventScroll: true });
      void ipc.invoke('pilotdeck:linux-menu-activate', { id, index: entry.index })
        .catch(error => console.warn('Could not run application menu action', error));
    };
    for (const entry of entries) {
      if (entry.type === 'separator') {
        const separator = document.createElement('div');
        separator.className = 'separator';
        separator.setAttribute('role', 'separator');
        panel.append(separator);
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'entry';
      button.dataset.index = String(entry.index);
      if (entry.id) button.dataset.action = entry.id;
      button.setAttribute('role', entry.type === 'checkbox' ? 'menuitemcheckbox' : 'menuitem');
      if (entry.type === 'checkbox') button.setAttribute('aria-checked', String(entry.checked));
      button.disabled = !entry.enabled;
      const check = document.createElement('span');
      check.className = 'check';
      check.textContent = entry.checked ? '✓' : '';
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = entry.label;
      button.append(check, label);
      if (entry.accelerator) {
        const shortcut = document.createElement('span');
        shortcut.className = 'shortcut';
        shortcut.textContent = entry.accelerator;
        button.append(shortcut);
      }
      button.addEventListener('pointerdown', event => event.preventDefault());
      button.addEventListener('click', () => activate(entry));
      panel.append(button);
    }
    panel.setAttribute('aria-label', buttons.find(button => button.dataset.menu === id)?.textContent ?? id);
    host.hidden = false;
    const anchor = buttons.find(button => button.dataset.menu === id)?.getBoundingClientRect();
    const top = root.hasAttribute('data-desktop-fullscreen') ? 8 : (anchor?.bottom ?? 40);
    panel.style.top = `${Math.max(0, top)}px`;
    panel.style.left = `${Math.max(8, Math.min(anchor?.left ?? 12, innerWidth - panel.offsetWidth - 8))}px`;
    if (focusFirst) panel.querySelector<HTMLButtonElement>('.entry:not(:disabled)')?.focus();
  };

  panel.addEventListener('keydown', event => {
    if (!activeId) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const index = WINDOWS_MENUS.findIndex(menu => menu.id === activeId);
      const next = (index + (event.key === 'ArrowRight' ? 1 : WINDOWS_MENUS.length - 1)) % WINDOWS_MENUS.length;
      void open(WINDOWS_MENUS[next].id, false, true);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const entries = [...panel.querySelectorAll<HTMLButtonElement>('.entry:not(:disabled)')];
    if (!entries.length) return;
    const current = entries.indexOf(shadow.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : entries.length - 1)) % entries.length;
    entries[next].focus();
  });
  document.addEventListener('pointerdown', event => {
    if (activeId && !host.contains(event.target as Node)
      && !captionHost.contains(event.target as Node)) close();
  }, true);
  window.addEventListener('keydown', event => {
    if (activeId && event.key === 'Escape') { event.preventDefault(); close(true); }
  });
  window.addEventListener('blur', () => { if (activeId) close(); });
  window.addEventListener('resize', () => { if (activeId) close(); });
  ipc.on('pilotdeck:application-menu-updated', () => { if (activeId) void open(activeId); });

  return { open, close, refresh: () => { if (activeId) void open(activeId); } };
}
