// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SpreadsheetTabs from './SpreadsheetTabs';

afterEach(cleanup);

describe('SpreadsheetTabs', () => {
  it('shows worksheet names and switches the active worksheet', () => {
    const onSelect = vi.fn();
    render(
      <SpreadsheetTabs
        sheets={[
          { index: 0, name: '管理摘要' },
          { index: 1, name: 'KPI趋势' },
          { index: 3, name: '行动项' },
        ]}
        activeSheetIndex={1}
        onSelect={onSelect}
      />,
    );

    expect(screen.getByRole('tab', { name: 'KPI趋势' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: '行动项' }));
    expect(onSelect).toHaveBeenCalledWith(3);
  });
});
