import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DateTimeField, { calendarDays, localDateValue, parseLocalDate } from './DateTimeField';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('calendar dates', () => {
  it('round-trips local dates without UTC conversion and rejects invalid days', () => {
    for (const value of ['2024-02-29', '2026-03-08', '2026-11-01', '0099-01-01']) expect(localDateValue(parseLocalDate(value)!)).toBe(value);
    for (const value of ['2025-02-29', '2026-04-31', '', '2026-2-1']) expect(parseLocalDate(value)).toBeNull();
  });
  it('lays out complete Monday-first weeks across year boundaries', () => {
    const days = calendarDays(parseLocalDate('2027-01-01')!);
    expect(days).toHaveLength(42);
    expect(localDateValue(days[0])).toBe('2026-12-28');
    expect(localDateValue(days[41])).toBe('2027-02-07');
  });
});

function Harness({ type = 'date', disabled = false }: { type?: 'date' | 'time'; disabled?: boolean }) {
  const [value, setValue] = useState(type === 'date' ? '2028-02-29' : '09:15');
  return <><DateTimeField type={type} value={value} onValueChange={setValue} min={type === 'date' ? '2028-02-28' : undefined} aria-label="Value" disabled={disabled} /><button>Outside</button><output>{value}</output></>;
}

it('keeps typed date edits and native min validation', () => {
  render(<Harness />);
  const input = screen.getByLabelText('Value') as HTMLInputElement;
  fireEvent.change(input, { target: { value: '2028-03-10' } });
  expect(screen.getByRole('status').textContent).toBe('2028-03-10');
  fireEvent.change(input, { target: { value: '2028-02-20' } });
  expect(input.validity.rangeUnderflow).toBe(true);
});
it('navigates leap-day boundaries, commits once and restores focus', () => {
  render(<Harness />);
  const trigger = screen.getByRole('button', { name: 'formControls.chooseDate' });
  fireEvent.click(trigger);
  expect(screen.getByRole('button', { name: 'Sunday, February 27, 2028' }).hasAttribute('disabled')).toBe(true);
  const selected = screen.getByRole('button', { name: 'Tuesday, February 29, 2028' });
  fireEvent.keyDown(selected, { key: 'ArrowRight' });
  const next = screen.getByRole('button', { name: 'Wednesday, March 1, 2028' });
  expect(document.activeElement).toBe(next);
  fireEvent.click(next);
  expect(screen.getByRole('status').textContent).toBe('2028-03-01');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
it('clamps month navigation and cancels without committing', () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'formControls.chooseDate' }));
  fireEvent.click(screen.getByRole('button', { name: 'formControls.previousMonth' }));
  expect(document.activeElement?.textContent).toBe('28');
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.getByRole('status').textContent).toBe('2028-02-29');
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('stages arbitrary minutes until Apply and supports clearing', () => {
  render(<Harness type="time" />);
  const trigger = screen.getByRole('button', { name: 'formControls.chooseTime' });
  fireEvent.click(trigger);
  fireEvent.change(screen.getByLabelText('formControls.hour'), { target: { value: '23' } });
  fireEvent.change(screen.getByLabelText('formControls.minute'), { target: { value: '57' } });
  expect(screen.getByRole('status').textContent).toBe('09:15');
  fireEvent.click(screen.getByRole('button', { name: 'formControls.apply' }));
  expect(screen.getByRole('status').textContent).toBe('23:57');
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('button', { name: 'formControls.clear' }));
  expect(screen.getByRole('status').textContent).toBe('');
});
it('dismisses outside and does not open when disabled', () => {
  const view = render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'formControls.chooseDate' }));
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  view.rerender(<Harness disabled />);
  fireEvent.click(screen.getByRole('button', { name: 'formControls.chooseDate' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});
