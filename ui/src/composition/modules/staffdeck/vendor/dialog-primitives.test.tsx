// @vitest-environment jsdom
import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PilotDeckDialog, PilotDeckDialogContent, PilotDeckDialogTitle } from './dialog-primitives';
import { pilotDeckSkillsPageHost } from './skills-host-adapter';
import { SkillsPageHostProvider as SkillsPageHostProvider, Dialog as SkillsDialog, DialogContent as SkillsContent, DialogTitle as SkillsTitle } from './SkillsPageHost';

afterEach(cleanup);
describe('formal Dialog primitive mounted by PilotDeck', () => {
  it('is injected into the SOP host and forwards content/title refs, style and aria while Close controls the owner', async () => {
    for (const host of [pilotDeckSkillsPageHost]) {
      expect(host.components?.Dialog).toBe(PilotDeckDialog);
      expect(host.components?.DialogContent).toBe(PilotDeckDialogContent);
      expect(host.components?.DialogTitle).toBe(PilotDeckDialogTitle);
    }
    const content = React.createRef<HTMLDivElement>();
    const title = React.createRef<HTMLHeadingElement>();
    const change = vi.fn();
    const escape = vi.fn();
    function Owner() {
      const [open, setOpen] = React.useState(true);
      return <SkillsPageHostProvider value={pilotDeckSkillsPageHost}><SkillsDialog open={open} onOpenChange={(next: boolean) => { change(next); setOpen(next); }}>
        <SkillsContent ref={content} style={{ maxWidth: '840px' }} aria-describedby={undefined} aria-label="Formal details" onEscapeKeyDown={escape}>
          <SkillsTitle ref={title} asChild><h3>Original document details</h3></SkillsTitle>
          <p>Complete original body</p>
        </SkillsContent>
      </SkillsDialog></SkillsPageHostProvider>;
    }
    render(<Owner />);
    expect(content.current).toBe(screen.getByRole('dialog'));
    expect(content.current?.style.maxWidth).toBe('840px');
    expect(content.current?.getAttribute('aria-label')).toBe('Formal details');
    expect(content.current?.hasAttribute('aria-describedby')).toBe(false);
    expect(title.current).toBe(screen.getByRole('heading', { name: 'Original document details' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(escape).toHaveBeenCalledOnce());
    expect(escape.mock.calls[0][0].defaultPrevented).toBe(true);
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(change).toHaveBeenCalledExactlyOnceWith(false);
  });
  it('preserves the explicit showCloseButton=false contract', () => {
    render(<PilotDeckDialog open><PilotDeckDialogContent showCloseButton={false} aria-describedby={undefined}><PilotDeckDialogTitle>Original editor</PilotDeckDialogTitle></PilotDeckDialogContent></PilotDeckDialog>);
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });
});
