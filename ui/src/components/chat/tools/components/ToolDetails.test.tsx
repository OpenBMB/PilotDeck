// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createTestI18n } from '../../../../i18n/testInstance';
import { ToolDetails } from './ToolDetails';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('ToolDetails overflow', () => {
  it('only offers full expansion when content exceeds the viewport', async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(320);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 600 } as DOMRect);
    const i18n = await createTestI18n();
    render(<I18nextProvider i18n={i18n}><ToolDetails title="Shell">long output</ToolDetails></I18nextProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Expand fully' }));
    expect((screen.getByRole('region') as HTMLElement).style.maxHeight).toBe('612px');
    fireEvent.click(screen.getByRole('button', { name: 'Limit height' }));
    expect((screen.getByRole('region') as HTMLElement).style.maxHeight).toBe('320px');
  });
  it('does not add an expansion control to short output', async () => {
    const i18n = await createTestI18n('zh-CN');
    render(<I18nextProvider i18n={i18n}><ToolDetails title="Shell">ok</ToolDetails></I18nextProvider>);
    expect(screen.queryByRole('button', { name: '展开完整内容' })).toBeNull();
  });
});
