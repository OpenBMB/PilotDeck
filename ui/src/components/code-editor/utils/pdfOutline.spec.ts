import { describe, expect, it, vi } from 'vitest';
import { resolvePdfOutline } from './pdfOutline';

function createPdfDocument() {
  return {
    numPages: 5,
    getDestination: vi.fn(async (name: string) => (
      name === 'chapter-two' ? [{ num: 20, gen: 0 }] : null
    )),
    getPageIndex: vi.fn(async (reference: { num: number }) => (
      reference.num === 20 ? 2 : 0
    )),
  };
}

describe('resolvePdfOutline', () => {
  it('returns an empty outline when the PDF has no native outline', async () => {
    await expect(resolvePdfOutline(createPdfDocument(), null)).resolves.toEqual([]);
  });

  it('resolves direct and named destinations while preserving hierarchy', async () => {
    const pdfDocument = createPdfDocument();
    const result = await resolvePdfOutline(pdfDocument, [
      {
        title: '  Chapter 1  ',
        dest: [0],
        items: [],
      },
      {
        title: 'Chapter 2',
        dest: 'chapter-two',
        items: [{
          title: 'Details',
          dest: [3],
          items: [],
        }],
      },
    ]);

    expect(result).toEqual([
      {
        id: 'outline-0',
        title: 'Chapter 1',
        pageNumber: 1,
        items: [],
      },
      {
        id: 'outline-1',
        title: 'Chapter 2',
        pageNumber: 3,
        items: [{
          id: 'outline-1-0',
          title: 'Details',
          pageNumber: 4,
          items: [],
        }],
      },
    ]);
    expect(pdfDocument.getDestination).toHaveBeenCalledWith('chapter-two');
  });

  it('keeps structural parents and filters unusable leaf entries', async () => {
    const result = await resolvePdfOutline(createPdfDocument(), [
      {
        title: 'Section',
        dest: null,
        items: [{
          title: 'Valid child',
          dest: [1],
          items: [],
        }],
      },
      {
        title: 'Broken link',
        dest: 'missing',
        items: [],
      },
    ]);

    expect(result).toEqual([
      {
        id: 'outline-0',
        title: 'Section',
        pageNumber: null,
        items: [{
          id: 'outline-0-0',
          title: 'Valid child',
          pageNumber: 2,
          items: [],
        }],
      },
    ]);
  });
});
