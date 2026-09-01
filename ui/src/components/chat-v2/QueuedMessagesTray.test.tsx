import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InputQueueState } from '../chat/types/queuedInput';
import QueuedMessagesTray from './QueuedMessagesTray';
import { getQueueMenuPosition } from './queueMenuPosition';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue || _key,
  }),
}));

afterEach(cleanup);

const item = (id: string, displayText: string) => ({
  id,
  displayText,
  createdAt: '2026-08-26T00:00:00.000Z',
  status: 'queued' as const,
  attachmentCount: 0,
});

function renderTray(state: InputQueueState) {
  return render(
    <QueuedMessagesTray
      state={state}
      isLoading
      onResume={vi.fn()}
      onSteer={vi.fn()}
      onDelete={vi.fn()}
      onMoveToFront={vi.fn()}
    />,
  );
}

describe('QueuedMessagesTray overflow menu', () => {
  it('does not show a meaningless more menu when the queue has one item', () => {
    renderTray({
      sessionId: 'web:s_test',
      revision: 1,
      paused: false,
      items: [item('one', 'Only item')],
    });

    expect(screen.queryByRole('button', { name: 'More queue actions' })).toBeNull();
  });

  it('portals the move-to-front menu outside the scroll region for later items', () => {
    renderTray({
      sessionId: 'web:s_test',
      revision: 1,
      paused: false,
      items: [item('one', 'First item'), item('two', 'Second item')],
    });

    const moreButton = screen.getByRole('button', { name: 'More queue actions' });
    fireEvent.click(moreButton);

    const menu = screen.getByRole('menu', { name: 'More queue actions' });
    expect(screen.getByTestId('queue-scroll-region').contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
    expect((screen.getByRole('menuitem', { name: 'Move to front' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('warns before retrying a delivery whose restart status is uncertain', () => {
    renderTray({
      sessionId: 'web:s_test',
      revision: 1,
      paused: true,
      pauseReason: 'restart_recovery',
      items: [{ ...item('one', 'Maybe sent'), status: 'delivery_uncertain' }],
    });

    expect(screen.getByText('A message may already have been sent before restart. Retry only if needed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.getByLabelText('Delivery status uncertain')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Adjust direction' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('getQueueMenuPosition', () => {
  it('opens above the trigger when there is enough space', () => {
    expect(getQueueMenuPosition({
      anchor: { top: 200, right: 300, bottom: 230 },
      viewportWidth: 500,
      viewportHeight: 500,
    })).toEqual({ left: 156, top: 150, placement: 'top' });
  });

  it('opens below the trigger near the top edge and stays inside the viewport', () => {
    expect(getQueueMenuPosition({
      anchor: { top: 20, right: 100, bottom: 50 },
      viewportWidth: 120,
      viewportHeight: 100,
    })).toEqual({ left: 8, top: 48, placement: 'bottom' });
  });
});
