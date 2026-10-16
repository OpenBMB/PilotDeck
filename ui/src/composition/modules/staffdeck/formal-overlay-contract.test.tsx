// @vitest-environment jsdom
import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { pilotDeckFormalComponents } from './vendor/host-components';
const { UIButton, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, Popover, PopoverTrigger, PopoverContent, TooltipProvider, Tooltip, TooltipTrigger, TooltipContent, Accordion, AccordionItem, AccordionTrigger, AccordionContent } = pilotDeckFormalComponents;
import StaffDeckLocaleBoundary from './StaffDeckLocaleBoundary';
// Graph rendering is outside this overlay contract; its focused evidence is already delivered.
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { resolvedLanguage: 'en' } }) }));
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('Dropdown asChild keeps trigger props, keyboard selection, disabled action, Portal locale and focus return', async () => {
  const select = vi.fn();
  const disabled = vi.fn();
  const { container } = render(<StaffDeckLocaleBoundary><DropdownMenu>
    <DropdownMenuTrigger asChild><UIButton aria-label="Actions" data-owner="row">菜单</UIButton></DropdownMenuTrigger>
    <DropdownMenuContent><DropdownMenuItem disabled onSelect={disabled}>Disabled</DropdownMenuItem>
      <DropdownMenuItem onSelect={select}>编辑</DropdownMenuItem>
      <DropdownMenuItem><span data-i18n-ignore translate="no">新增</span></DropdownMenuItem></DropdownMenuContent>
  </DropdownMenu></StaffDeckLocaleBoundary>);
  const trigger = screen.getByRole('button', { name: 'Actions' });
  expect(trigger.getAttribute('data-owner')).toBe('row');
  trigger.focus(); fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const menu = await screen.findByRole('menu');
  expect(container.contains(menu)).toBe(false);
  expect(menu.getAttribute('data-staffdeck-portal-root')).toBe('true');
  expect(await screen.findByRole('menuitem', { name: 'Edit' })).toBeTruthy();
  expect(screen.getByRole('menuitem', { name: '新增' })).toBeTruthy();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Disabled' }));
  expect(disabled).not.toHaveBeenCalled();
  const enabled = screen.getByRole('menuitem', { name: 'Edit' });
  enabled.focus(); fireEvent.keyDown(enabled, { key: 'Enter' });
  await waitFor(() => expect(select).toHaveBeenCalledOnce());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  fireEvent.keyDown(trigger, { key: 'ArrowDown' }); await screen.findByRole('menu');
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  expect(document.activeElement).toBe(trigger);
});

it('controlled Popover preserves asChild, autofocus callback, custom props and Escape focus return', async () => {
  const change = vi.fn(); const auto = vi.fn();
  function Owner() {
    const [open, setOpen] = React.useState(false);
    return <Popover open={open} onOpenChange={next => { change(next); setOpen(next); }}>
      <PopoverTrigger asChild><button aria-label="Capabilities">Open</button></PopoverTrigger>
      <PopoverContent align="start" style={{ width: '420px' }} aria-label="Capability selection" onOpenAutoFocus={auto}>
        <input aria-label="Search capabilities" /><button disabled>Unavailable</button>
      </PopoverContent></Popover>;
  }
  const { container } = render(<Owner />);
  const trigger = screen.getByRole('button', { name: 'Capabilities' });
  trigger.focus(); fireEvent.click(trigger);
  const dialog = await screen.findByRole('dialog');
  expect(container.contains(dialog)).toBe(false);
  expect(dialog.style.width).toBe('420px');
  expect(dialog.getAttribute('data-align')).toBe('start');
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox')));
  expect(auto).toHaveBeenCalledOnce();
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(change.mock.calls.map(call => call[0])).toEqual([true, false]);
  expect(document.activeElement).toBe(trigger);
});

it('Tooltip provider supports focus, translated Portal text, user content and Escape without moving focus', async () => {
  const { container } = render(<StaffDeckLocaleBoundary><TooltipProvider delayDuration={0}><Tooltip>
    <TooltipTrigger asChild><UIButton aria-label="Details">Info</UIButton></TooltipTrigger>
    <TooltipContent side="bottom">查看详情<span data-i18n-ignore translate="no">新增</span></TooltipContent>
  </Tooltip></TooltipProvider></StaffDeckLocaleBoundary>);
  const trigger = screen.getByRole('button', { name: 'Details' });
  trigger.focus();
  const tooltip = await screen.findByRole('tooltip');
  expect(container.contains(tooltip)).toBe(false);
  await waitFor(() => expect(tooltip.textContent).toContain('View Details'));
  expect(tooltip.textContent).toContain('新增');
  expect(trigger.getAttribute('aria-describedby')).toBe(tooltip.id);
  fireEvent.keyDown(trigger, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  expect(document.activeElement).toBe(trigger);
});

it('Accordion controlled multiple values retain user content, disabled items and keyboard navigation', async () => {
  const change = vi.fn();
  function Owner() {
    const [value, setValue] = React.useState<string[]>([]);
    return <Accordion type="multiple" value={value} onValueChange={next => { change(next); setValue(next); }}>
      <AccordionItem value="a"><AccordionTrigger>Alpha</AccordionTrigger><AccordionContent><span data-i18n-ignore>新增</span></AccordionContent></AccordionItem>
      <AccordionItem value="disabled" disabled><AccordionTrigger>Disabled</AccordionTrigger><AccordionContent>Hidden</AccordionContent></AccordionItem>
      <AccordionItem value="b"><AccordionTrigger>Beta</AccordionTrigger><AccordionContent>Body</AccordionContent></AccordionItem>
    </Accordion>;
  }
  render(<Owner />);
  const alpha = screen.getByRole('button', { name: 'Alpha' });
  alpha.focus(); fireEvent.keyDown(alpha, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Beta' }));
  fireEvent.click(alpha);
  expect(change).toHaveBeenLastCalledWith(['a']);
  expect(alpha.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByText('新增')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Disabled' }));
  expect(change).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Beta' }));
  expect(change).toHaveBeenLastCalledWith(['a', 'b']);
});

it('registered DialogFooter semantic Close and loading Confirm keep original controlled close behavior', async () => {
  const { Dialog, DialogContent, DialogTitle, DialogFooter, ConfirmDialog } = pilotDeckFormalComponents;
  const close = vi.fn(); const confirm = vi.fn();
  const { rerender } = render(<Dialog open onOpenChange={close}><DialogContent aria-describedby={undefined}>
    <DialogTitle>Footer contract</DialogTitle><DialogFooter showCloseButton data-owner="footer"><button>Save</button></DialogFooter>
  </DialogContent></Dialog>);
  const footer = document.querySelector('[data-owner="footer"]')!;
  expect(footer.getAttribute('data-slot')).toBe('dialog-footer');
  fireEvent.click(footer.querySelector('button:last-child')!);
  expect(close).toHaveBeenCalledExactlyOnceWith(false);
  close.mockClear();
  rerender(<ConfirmDialog open loading title="Original item" onOpenChange={close} onConfirm={confirm} />);
  const dialog = await screen.findByRole('alertdialog');
  expect(screen.getByRole('button', { name: '取消' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: '删除' })).toHaveProperty('disabled', true);
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.getByRole('alertdialog')).toBe(dialog);
  expect(close).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
});

it('registered ModelConfigDropdown keeps user names/model IDs and title while preserving keyboard selection', async () => {
  const change = vi.fn(); const Model = pilotDeckFormalComponents.ModelConfigDropdown;
  render(<StaffDeckLocaleBoundary><Model models={[
    { id: 'a', name: '新增', model: '删除', is_default: true },
    { id: 'b', name: '取消', model: '名称' },
  ]} value="a" onChange={change} /></StaffDeckLocaleBoundary>);
  const trigger = screen.getByRole('button', { name: '新增' });
  expect(trigger.getAttribute('title')).toBe('新增');
  trigger.focus(); fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  await screen.findByRole('menu');
  expect(screen.getByText('新增', { selector: 'strong' }).textContent).toBe('新增');
  expect(screen.getByText('删除').textContent).toBe('删除');
  expect(await screen.findByText('Default')).toBeTruthy();
  const choice = screen.getByRole('menuitem', { name: '取消名称' });
  choice.focus(); fireEvent.keyDown(choice, { key: 'Enter' });
  await waitFor(() => expect(change).toHaveBeenCalledExactlyOnceWith('b'));
  expect(document.activeElement).toBe(trigger);
});

it('Popover source input retains focus when its actual onOpenAutoFocus handler prevents transfer', async () => {
  const auto = vi.fn((event: Event) => event.preventDefault());
  const change = vi.fn();
  render(<Popover><PopoverTrigger asChild><input type="text" aria-label="Action query" onChange={change} /></PopoverTrigger>
    <PopoverContent onOpenAutoFocus={auto}><button>Action option</button></PopoverContent></Popover>);
  const input = screen.getByRole('textbox');
  expect(input.getAttribute('type')).toBe('text');
  input.focus(); fireEvent.click(input);
  fireEvent.change(input, { target: { value: 'call_tool' } });
  expect(change).toHaveBeenCalledOnce();
  await screen.findByRole('dialog');
  expect(auto).toHaveBeenCalledOnce();
  expect(auto.mock.calls[0][0].defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(input);
  fireEvent.keyDown(input, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(document.activeElement).toBe(input);
});
