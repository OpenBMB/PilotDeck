// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DashboardData, RoutingMetrics } from '../../hooks/useRoutingDashboard';
import DashboardV2 from './DashboardV2';

const mocked = vi.hoisted(() => ({
  result: {} as {
    data: DashboardData | null;
    loading: boolean;
    error: string | null;
    refresh: () => void;
  },
}));

vi.mock('../../hooks/useRoutingDashboard', () => ({
  useRoutingDashboard: () => mocked.result,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}));

afterEach(cleanup);

const bucket = {
  inputTokens: 40,
  outputTokens: 20,
  cacheReadTokens: 10,
  totalTokens: 60,
  requestCount: 4,
  estimatedCost: 1,
  baselineCost: 4,
  savedCost: 3,
};

function dashboard(metrics?: RoutingMetrics): DashboardData {
  return {
    projects: [],
    overall: {
      total: bucket,
      byTier: {},
      byRole: {},
      ...(metrics ? { routingMetrics: metrics } : {}),
      projectCount: 0,
      sessionCount: 0,
    },
    unmatchedSessions: [],
  } as DashboardData;
}

function show(data: DashboardData, compact = false) {
  mocked.result = { data, loading: false, error: null, refresh: vi.fn() };
  return render(<DashboardV2 compact={compact} />);
}

describe('DashboardV2 routing metrics', () => {
  it('renders complete metrics and reconciled task-card coverage', () => {
    show(dashboard({
      judgeCalls: 2,
      judgeCost: 0.25,
      shortCircuits: 7,
      taskCardRequests: 3,
      newTaskResets: 1,
      guardSavedCost: 1.5,
      guardBypassCost: 0.5,
      netSavedCost: 2.75,
    }));
    const metrics = within(screen.getByTestId('routing-metrics'));

    expect(metrics.getByText('Routing metrics')).toBeTruthy();
    expect(metrics.getByText('$0.25')).toBeTruthy();
    expect(metrics.getByText('2 calls')).toBeTruthy();
    expect(metrics.getByText('$2.75')).toBeTruthy();
    expect(metrics.getByText('7')).toBeTruthy();
    expect(metrics.getByText('75% (3/4)')).toBeTruthy();
    expect(metrics.getByText('1')).toBeTruthy();
    expect(metrics.getByText('$1.50')).toBeTruthy();
    expect(metrics.getByText('$0.50')).toBeTruthy();
  });

  it('renders defensive zero and dash values for an old bridge payload', () => {
    const { container } = show(dashboard());
    const text = screen.getByTestId('routing-metrics').textContent ?? '';

    expect(text).toContain('$0.00');
    expect(text).toContain('—');
    expect(text).not.toContain('NaN');
    expect(container.textContent).not.toContain('undefined');
  });

  it('uses the compact two-column metric grid without dropping values', () => {
    const { container } = show(dashboard({
      judgeCalls: 1,
      judgeCost: 0.01,
      shortCircuits: 2,
      taskCardRequests: 4,
      newTaskResets: 1,
      guardSavedCost: 0.02,
      guardBypassCost: 0.03,
      netSavedCost: 2.98,
    }), true);
    const section = screen.getByTestId('routing-metrics');
    const grid = section.querySelector('.grid');

    expect(grid?.className).toContain('grid-cols-2');
    expect(grid?.className).not.toContain('lg:grid-cols-7');
    expect(container.querySelector('.px-4.py-5')).toBeTruthy();
    expect(within(section).getByText('100% (4/4)')).toBeTruthy();
  });
});
