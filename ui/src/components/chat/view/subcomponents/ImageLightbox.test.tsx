// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ImageLightbox, { getLightboxNavigationLabelForTest } from './ImageLightbox';

afterEach(() => {
  cleanup();
});

const images = [
  { data: 'data:image/png;base64,first', name: 'first.png', mimeType: 'image/png' },
  { data: 'data:image/png;base64,second', name: 'second.png', mimeType: 'image/png' },
  { data: 'data:image/png;base64,third', name: 'third.png', mimeType: 'image/png' },
];

describe('ImageLightbox navigation labels', () => {
  it('names the target image and position for previous and next controls', () => {
    expect(getLightboxNavigationLabelForTest('Next', images[1], 1, 3)).toBe(
      'Next image: second.png (2 of 3)',
    );
    expect(getLightboxNavigationLabelForTest('Previous', undefined, 2, 3)).toBe(
      'Previous image: image (3 of 3)',
    );
  });

  it('updates navigation labels as the active image changes', () => {
    render(<ImageLightbox images={images} startIndex={0} onClose={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Previous image: third.png (3 of 3)' })).toBeTruthy();
    const nextButton = screen.getByRole('button', { name: 'Next image: second.png (2 of 3)' });
    expect(nextButton.getAttribute('title')).toBe('Next image: second.png (2 of 3)');

    fireEvent.click(nextButton);

    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('second.png');
    expect(screen.getByRole('button', { name: 'Previous image: first.png (1 of 3)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next image: third.png (3 of 3)' })).toBeTruthy();
  });
});
