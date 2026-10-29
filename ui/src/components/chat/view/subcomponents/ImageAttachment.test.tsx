// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestI18n } from '../../../../i18n/testInstance';
import ImageAttachment from './ImageAttachment';

vi.unmock('react-i18next');
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each(['en', 'zh-CN'])('keeps HTML-like filenames inert and readable in %s preview labels', async (locale) => {
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL() { return 'blob:local-image'; }
    static revokeObjectURL() {}
  });
  const i18n = await createTestI18n(locale);
  const name = '<img data-injected="true" onerror="alert(1)"> & {{name}} 中文.png';
  const file = new File(['image'], name, { type: 'image/png' });
  const onPreview = vi.fn();
  const view = render(<I18nextProvider i18n={i18n}>
    <ImageAttachment file={file} onRemove={vi.fn()} onPreview={onPreview} />
  </I18nextProvider>);
  const button = screen.getByRole('button', { name: `${locale === 'en' ? 'Preview' : '预览'} ${name}` });
  expect(screen.getByRole('img').getAttribute('alt')).toBe(name);
  expect(screen.getByRole('img').getAttribute('src')).toBe('blob:local-image');
  expect(button.querySelectorAll('img')).toHaveLength(1);
  expect(view.container.querySelector('[data-injected], [onerror], script')).toBeNull();
  fireEvent.click(button);
  expect(onPreview).toHaveBeenCalledTimes(1);
});

it.each(['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'https://example.invalid/image.png'])(
  'refuses an unexpected thumbnail URL %s', async (url) => {
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL() { return url; }
      static revokeObjectURL() {}
    });
    const i18n = await createTestI18n();
    render(<I18nextProvider i18n={i18n}>
      <ImageAttachment file={new File(['image'], 'image.png', { type: 'image/png' })} onRemove={vi.fn()} />
    </I18nextProvider>);
    expect(screen.getByRole('img').getAttribute('src')).toBeNull();
  },
);
