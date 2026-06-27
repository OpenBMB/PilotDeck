// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SubagentDetailModal from './SubagentDetailModal';

afterEach(() => {
  cleanup();
});

const renderModal = (onClose = vi.fn()) => {
  render(
    <SubagentDetailModal
      subagentId="subagent-abcdef123456"
      messages={[]}
      isLoading={false}
      error={null}
      provider="pilotdeck"
      selectedProject={null}
      createDiff={() => []}
      onClose={onClose}
    />,
  );
  return { onClose };
};

describe('SubagentDetailModal accessibility', () => {
  it('announces itself as a modal dialog labelled by the detail title', () => {
    renderModal();

    const dialog = screen.getByRole('dialog', { name: /Subagent Detail|subagent\.detailTitle/ });
    const title = screen.getByRole('heading', { name: /Subagent Detail|subagent\.detailTitle/ });

    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);
    expect(dialog.textContent).toContain('subagent');
  });

  it('uses a specific close control label and supports Escape dismissal', () => {
    const { onClose } = renderModal();
    const closeButton = screen.getByRole('button', { name: 'Close subagent detail' });

    expect(closeButton.getAttribute('title')).toBe('Close subagent detail');

    fireEvent.click(closeButton);
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
