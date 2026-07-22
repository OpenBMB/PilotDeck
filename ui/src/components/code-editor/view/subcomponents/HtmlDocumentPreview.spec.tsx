// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import HtmlDocumentPreview from './HtmlDocumentPreview';

afterEach(cleanup);

describe('HtmlDocumentPreview', () => {
  it('renders remote project HTML in an isolated sandbox', () => {
    render(<HtmlDocumentPreview url="/preview/index.html" title="Preview: index.html" />);

    const frame = screen.getByTitle('Preview: index.html');
    expect(frame.getAttribute('src')).toBe('/preview/index.html');
    expect(frame.getAttribute('sandbox')).toContain('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
  });
});
