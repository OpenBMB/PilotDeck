// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import CronSection from './CronSection';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

it('enables and disables scheduling while preserving runtime parameters', () => {
  const onChange = vi.fn();
  const config = { cron: { enabled: false, timezone: 'Asia/Tokyo', maxConcurrentRuns: 3 } };
  const view = render(<CronSection config={config} onChange={onChange} />);
  fireEvent.click(screen.getByRole('switch'));
  expect(onChange).toHaveBeenLastCalledWith({ cron: { ...config.cron, enabled: true } });
  view.rerender(<CronSection config={{ cron: { ...config.cron, enabled: true } }} onChange={onChange} />);
  fireEvent.click(screen.getByRole('switch'));
  expect(onChange).toHaveBeenLastCalledWith(config);
});
