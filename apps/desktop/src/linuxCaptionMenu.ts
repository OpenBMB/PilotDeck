import type { MenuItemConstructorOptions } from 'electron';
import { WINDOWS_MENUS } from './windowChrome';

export type LinuxCaptionEntry = {
  index: number;
  id?: string;
  label: string;
  accelerator?: string;
  type: 'normal' | 'separator' | 'checkbox';
  enabled: boolean;
  checked: boolean;
};

function submenu(template: MenuItemConstructorOptions[], id: unknown): MenuItemConstructorOptions[] | undefined {
  if (!WINDOWS_MENUS.some(menu => menu.id === id)) return;
  const items = template.find(item => item.id === id)?.submenu;
  return Array.isArray(items) ? items : undefined;
}

export function linuxCaptionEntries(template: MenuItemConstructorOptions[], id: unknown): LinuxCaptionEntry[] {
  return (submenu(template, id) ?? []).flatMap((item, index) => item.visible === false ? [] : [{
    index,
    ...(item.id ? { id: item.id } : {}),
    label: item.label ?? '',
    ...(item.accelerator ? { accelerator: item.accelerator.replace(/CmdOrCtrl/g, 'Ctrl').replace(/Comma/g, ',') } : {}),
    type: item.type === 'separator' ? 'separator' : item.type === 'checkbox' ? 'checkbox' : 'normal',
    enabled: item.type !== 'separator' && item.enabled !== false,
    checked: item.checked === true,
  }]);
}

export function linuxCaptionAction(template: MenuItemConstructorOptions[], id: unknown, index: unknown): MenuItemConstructorOptions | undefined {
  if (!Number.isSafeInteger(index) || (index as number) < 0) return;
  const item = submenu(template, id)?.[index as number];
  if (!item || item.visible === false || item.enabled === false || item.type === 'separator') return;
  return item;
}
