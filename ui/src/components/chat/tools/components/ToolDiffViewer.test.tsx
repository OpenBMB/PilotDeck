// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestI18n } from '../../../../i18n/testInstance';
import { copyTextToClipboard } from '../../../../utils/clipboard';
import { ToolDiffViewer } from './ToolDiffViewer';

vi.mock('../../../../utils/clipboard', () => ({ copyTextToClipboard: vi.fn(async () => true) }));
afterEach(cleanup);

it('bounds a minified single-line file in the DOM while retaining its full copy value', async () => {
  const i18n = await createTestI18n();
  const content = 'x'.repeat(250_000);
  const view = render(<I18nextProvider i18n={i18n}><ToolDiffViewer filePath="large.json" oldContent={undefined}
    newContent={content} badge="Write" createDiff={() => []} /></I18nextProvider>);
  expect(view.container.querySelector('[data-file-preview-line]')!.textContent!.length).toBeLessThan(2050);
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
  expect(copyTextToClipboard).toHaveBeenLastCalledWith(content);
});

it.each(['en', 'zh-CN'])('bounds large file previews and copies all content without allocating an LCS matrix (%s)', async language => {
  const i18n = await createTestI18n(language);
  const createDiff = vi.fn(() => { throw new Error('Large diffs must not allocate an LCS matrix'); });
  const content = Array.from({ length: 10_000 }, (_, index) => `line ${index}`).join('\n');
  const view = render(<I18nextProvider i18n={i18n}><ToolDiffViewer filePath="src/large.ts" oldContent={'old\n'.repeat(1000)}
    newContent={content} createDiff={createDiff} /></I18nextProvider>);
  expect(view.container.querySelectorAll('[data-file-preview-line]')).toHaveLength(200);
  expect(screen.getByText(i18n.t('chat:toolDisplay.largeChangePreview'))).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: i18n.t('chat:toolDisplay.copy') }));
  expect(copyTextToClipboard).toHaveBeenLastCalledWith(content);
  fireEvent.click(screen.getByRole('button', { name: i18n.t('chat:toolDisplay.moreLines') }));
  expect(view.container.querySelectorAll('[data-file-preview-line]')).toHaveLength(400);
  expect(createDiff).not.toHaveBeenCalled();
});
