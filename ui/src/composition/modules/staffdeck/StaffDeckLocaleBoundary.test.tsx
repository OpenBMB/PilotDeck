// @vitest-environment jsdom
import { createPortal } from 'react-dom';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

let currentLanguage = 'zh-CN';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { resolvedLanguage: currentLanguage } }) }));
import StaffDeckLocaleBoundary from './StaffDeckLocaleBoundary';
import { PilotDeckDialog, PilotDeckDialogContent, PilotDeckDialogTitle } from './vendor/dialog-primitives';

afterEach(() => { cleanup(); currentLanguage = 'zh-CN'; });

function Fixture() {
  return <StaffDeckLocaleBoundary>
    <button type="button">新增</button>
    <span data-i18n-ignore="true" translate="no">新增</span>
    {createPortal(<div data-staffdeck-portal-root="true" role="dialog">
      <h2>版本详情</h2>
      <button type="button">取消</button>
      <span data-i18n-ignore="true" translate="no" title="名称">暂无内容</span>
    </div>, document.body)}
  </StaffDeckLocaleBoundary>;
}

describe('formal StaffDeck locale boundary', () => {
  it('protects production source headings without suppressing the system fallback', async () => {
    function Overview({ title }: { title: string }) {
      return <StaffDeckLocaleBoundary>{title ? <strong data-i18n-ignore translate="no">{title}</strong> : <span>引用来源</span>}</StaffDeckLocaleBoundary>;
    }
    currentLanguage = 'en';
    const { rerender } = render(<Overview title="规范化 Source" />);
    expect(screen.getByText('规范化 Source').tagName).toBe('STRONG');
    expect(screen.queryByText('Normalize Source')).toBeNull();
    rerender(<Overview title="" />);
    await waitFor(() => expect(screen.queryByText('引用来源')).toBeNull());
    expect(screen.getAllByText('Citation sources').length).toBeGreaterThan(0);
    currentLanguage = 'zh-CN';
    rerender(<Overview title="写入 OKF Wiki" />);
    expect(screen.getByText('写入 OKF Wiki')).toBeTruthy();
  });
  it('translates ingestion system metadata and dynamic stats while preserving document names', async () => {
    currentLanguage = 'en';
    const { rerender } = render(<StaffDeckLocaleBoundary>
      <span>规范化 Source</span><span>写入 Source Document</span><span>规划 Wiki 页面</span>
      <span>写入 OKF Wiki</span><span>刷新 PageIndex</span>
      <span>完成入库：3 个 Wiki 页面，2 个内部索引，7 个引用来源</span>
      <span data-i18n-ignore translate="no">规划 Wiki 页面</span>
    </StaffDeckLocaleBoundary>);
    expect(await screen.findByText('Normalize Source')).toBeTruthy();
    expect(screen.getByText('Write Source Document')).toBeTruthy();
    expect(screen.getByText('Plan Wiki pages')).toBeTruthy();
    expect(screen.getByText('Write OKF Wiki')).toBeTruthy();
    expect(screen.getByText('Refresh PageIndex')).toBeTruthy();
    expect(screen.getByText('Ingestion complete: 3 Wiki pages, 2 internal indexes, 7 citation sources')).toBeTruthy();
    expect(screen.getByText('规划 Wiki 页面')).toBeTruthy();
    currentLanguage = 'zh-CN';
    rerender(<StaffDeckLocaleBoundary><span>刷新 PageIndex</span></StaffDeckLocaleBoundary>);
    expect(await screen.findByText('刷新 PageIndex')).toBeTruthy();
  });
  it('localizes only formal labels inside the page and its Portal while keeping user text and attributes unchanged', async () => {
    const { rerender } = render(<Fixture />);
    const dialog = screen.getByRole('dialog');
    const resource = within(dialog).getByText('暂无内容');
    currentLanguage = 'en';
    rerender(<Fixture />);
    expect(await screen.findByRole('button', { name: 'Add' })).toBeTruthy();
    expect(within(dialog).getByRole('heading', { name: 'Version Details' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(resource.textContent).toBe('暂无内容');
    expect(resource.getAttribute('title')).toBe('名称');
    currentLanguage = 'zh-CN';
    rerender(<Fixture />);
    await waitFor(() => expect(screen.getByRole('button', { name: '新增' })).toBeTruthy());
    expect(within(dialog).getByRole('heading', { name: '版本详情' })).toBeTruthy();
    expect(resource.textContent).toBe('暂无内容');
  });
  it('preserves user slots in dynamic Dialog titles and aria templates through locale and value changes', async () => {
    function Dynamic({ value }: { value: string }) {
      return <StaffDeckLocaleBoundary>
        <PilotDeckDialog open><PilotDeckDialogContent aria-describedby={undefined}>
        <PilotDeckDialogTitle>{`版本管理：${value}`}</PilotDeckDialogTitle>
        <h3>{`确认删除 Node 1：${value}？`}</h3>
        <button aria-label={`选择流转 ${value}`} title={`编辑节点 ${value}`}>编辑节点</button>
        </PilotDeckDialogContent></PilotDeckDialog>
      </StaffDeckLocaleBoundary>;
    }
    const { rerender } = render(<Dynamic value="新增" />);
    currentLanguage = 'en'; rerender(<Dynamic value="新增" />);
    expect(await screen.findByRole('heading', { name: 'Version Management: 新增' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Confirm Delete Node 1: 新增?' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Select transition 新增' }).getAttribute('title')).toBe('Edit node 新增');
    rerender(<Dynamic value="删除" />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Version Management: 删除' })).toBeTruthy());
    currentLanguage = 'zh-CN'; rerender(<Dynamic value="删除" />);
    expect(await screen.findByRole('heading', { name: '版本管理：删除' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '选择流转 删除' }).getAttribute('title')).toBe('编辑节点 删除');
  });

  it('keeps a user title on a mixed control without blocking nearby labels or aria templates', async () => {
    function Mixed({ value }: { value: string }) {
      return <StaffDeckLocaleBoundary><button title={value} data-i18n-ignore-title aria-label={`选择 ${value}`}>
        <span data-i18n-ignore translate="no">{value}</span><span>强制</span>
      </button></StaffDeckLocaleBoundary>;
    }
    currentLanguage = 'en';
    const { rerender } = render(<Mixed value="新增" />);
    let control = await screen.findByRole('button', { name: 'Select 新增' });
    expect(control.title).toBe('新增');
    expect(screen.getByText('Required')).toBeTruthy();
    rerender(<Mixed value="删除" />);
    control = await screen.findByRole('button', { name: 'Select 删除' });
    expect(control.title).toBe('删除');
    currentLanguage = 'zh-CN'; rerender(<Mixed value="删除" />);
    control = await screen.findByRole('button', { name: '选择 删除' });
    expect(control.title).toBe('删除');
    expect(screen.getByText('强制')).toBeTruthy();
  });

});
