// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pilotDeckFormalComponents } from './host-components';
const { CapabilityScopeControl, CapabilityScopeLoading, Progress, StatCard, Paginator } = pilotDeckFormalComponents;
import type { ReactNode } from 'react';

afterEach(cleanup);
const mount = (content: ReactNode) => render(<>{content}</>);

describe('actual PilotDeck Host presentation injection', () => {
  it('preserves source StatCard and Progress value/aria/indicator', () => {
    mount(<><StatCard value={17} label="知识库总数" tone="green" /><Progress value={42} aria-label="入库进度" /></>);
    expect(screen.getByText('17')).toBeTruthy();
    expect(screen.getByText('知识库总数')).toBeTruthy();
    const progress = screen.getByRole('progressbar', { name: '入库进度' });
    expect(progress.getAttribute('aria-valuenow')).toBe('42');
    expect(progress.querySelector('[data-slot="progress-indicator"]')?.getAttribute('style')).toContain('translateX(-58%)');
  });

  it('mounts Scope without an App TooltipProvider and preserves loading/switch behavior', () => {
    const change = vi.fn();
    mount(<><CapabilityScopeLoading /><CapabilityScopeControl value="sop_specific" resourceType="knowledge_base" onChange={change} /></>);
    expect(screen.getByRole('status', { name: '正在加载员工能力' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '查看仅限 SOP 说明' })).toBeTruthy();
    const scope = screen.getByRole('switch', { name: '切换能力范围' });
    expect(scope.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(scope);
    expect(change).toHaveBeenCalledWith('general');
  });

  it('keeps paginator current/padding/ellipsis and next-page callbacks', () => {
    const change = vi.fn();
    mount(<Paginator aria-label="知识库分页" page={5} pageCount={12} onChange={change} />);
    const nav = screen.getByRole('navigation', { name: '知识库分页' });
    expect(within(nav).getByRole('button', { name: '05' }).getAttribute('aria-current')).toBe('page');
    expect(within(nav).getAllByText('···')).toHaveLength(2);
    fireEvent.click(within(nav).getByRole('button', { name: '下一页' }));
    expect(change).toHaveBeenCalledWith(6);
  });
});
