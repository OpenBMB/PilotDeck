// @vitest-environment jsdom
import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Input } from '../../../../plugins/staffdeck-shared/vendor/formal-primitives/input';
import { Textarea } from '../../../../plugins/staffdeck-shared/vendor/formal-primitives/textarea';
import { Progress } from '../../../../plugins/staffdeck-shared/vendor/formal-primitives/progress';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../../../../plugins/staffdeck-shared/vendor/formal-primitives/select';
import { Checkbox } from '../../../../plugins/staffdeck-shared/vendor/formal-primitives/checkbox';
import { PilotDeckDialog, PilotDeckDialogContent, PilotDeckDialogTitle } from '../../../../plugins/staffdeck-shared/vendor/dialog-primitives';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { resolvedLanguage: 'zh-CN' } }) }));
afterEach(cleanup);

describe('PilotDeck formal primitive actual DOM contract', () => {
  it('forwards input/textarea refs, props, focus and controlled change without altering user values', () => {
    const input = React.createRef<HTMLInputElement>();
    const textarea = React.createRef<HTMLTextAreaElement>();
    const change = vi.fn();
    render(<><Input ref={input} aria-label="Name" value="新增" placeholder="名称" onChange={change} />
      <Textarea ref={textarea} aria-label="Body" value="暂无内容" onChange={change} /></>);
    expect(input.current).toBe(screen.getByRole('textbox', { name: 'Name' }));
    expect(textarea.current).toBe(screen.getByRole('textbox', { name: 'Body' }));
    input.current?.focus();
    expect(document.activeElement).toBe(input.current);
    expect(input.current?.value).toBe('新增');
    expect(textarea.current?.value).toBe('暂无内容');
    fireEvent.change(input.current!, { target: { value: '更新' } });
    expect(change).toHaveBeenCalledOnce();
  });

  it('preserves progress aria value and Checkbox mixed/disabled/controlled semantics', () => {
    const change = vi.fn();
    const { rerender } = render(<><Progress value={42} aria-label="Progress" />
      <Checkbox checked="indeterminate" aria-label="Select resources" onCheckedChange={change} /></>);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42');
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox.getAttribute('aria-checked')).toBe('mixed');
    fireEvent.click(checkbox);
    expect(change).toHaveBeenCalledWith(true);
    rerender(<Checkbox checked="indeterminate" disabled aria-label="Select resources" onCheckedChange={change} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(change).toHaveBeenCalledOnce();
  });

  it('keeps controlled Dialog Portal, content/title refs, autofocus and prevented Escape before semantic Close', async () => {
    const content = React.createRef<HTMLDivElement>();
    const title = React.createRef<HTMLHeadingElement>();
    const close = vi.fn();
    const escape = vi.fn();
    function Owner() {
      const [open, setOpen] = React.useState(true);
      return <><button>Outside</button><PilotDeckDialog open={open} onOpenChange={next => { close(next); setOpen(next); }}>
        <PilotDeckDialogContent ref={content} style={{ maxWidth: '840px' }} aria-describedby={undefined} onEscapeKeyDown={escape}>
          <PilotDeckDialogTitle ref={title} asChild><h3>Original title</h3></PilotDeckDialogTitle>
          <button>First field</button>
        </PilotDeckDialogContent>
      </PilotDeckDialog></>;
    }
    const { container } = render(<Owner />);
    const dialog = screen.getByRole('dialog');
    expect(container.contains(dialog)).toBe(false);
    expect(content.current).toBe(dialog);
    expect(title.current).toBe(screen.getByRole('heading', { name: 'Original title' }));
    expect(content.current?.style.maxWidth).toBe('840px');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First field' })));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(escape).toHaveBeenCalledOnce());
    expect(escape.mock.calls[0][0].defaultPrevented).toBe(true);
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(close).toHaveBeenCalledExactlyOnceWith(false);
  });
  it('opens Select by keyboard, selects an enabled item and restores trigger focus on Escape', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const scroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn();
    try {
      const change = vi.fn();
      const { container } = render(<Select defaultValue="a" onValueChange={change}>
        <SelectTrigger aria-label="Resource"><SelectValue /></SelectTrigger>
        <SelectContent position="popper"><SelectItem value="a">Alpha</SelectItem>
          <SelectItem value="disabled" disabled>Disabled</SelectItem><SelectItem value="b">Beta</SelectItem></SelectContent>
      </Select>);
      const trigger = screen.getByRole('combobox');
      trigger.focus();
      fireEvent.keyDown(trigger, { key: 'ArrowDown' });
      const list = await screen.findByRole('listbox');
      expect(container.contains(list)).toBe(false);
      expect(screen.getByRole('option', { name: 'Disabled' }).getAttribute('aria-disabled')).toBe('true');
      fireEvent.keyDown(document.activeElement!, { key: 'End' });
      await waitFor(() => expect(document.activeElement?.textContent).toContain('Beta'));
      fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
      await waitFor(() => expect(change).toHaveBeenCalledWith('b'));
      trigger.focus();
      fireEvent.keyDown(trigger, { key: 'ArrowDown' });
      await screen.findByRole('listbox');
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
      expect(document.activeElement).toBe(trigger);
    } finally { HTMLElement.prototype.scrollIntoView = scroll; vi.unstubAllGlobals(); }
  });

});
