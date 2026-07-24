import type { PDFDocumentProxy } from 'pdfjs-dist';

type PdfReference = {
  num: number;
  gen: number;
};

type RawPdfOutlineItem = {
  title: string;
  dest: string | unknown[] | null;
  items: RawPdfOutlineItem[];
};

type PdfOutlineDocument = Pick<
  PDFDocumentProxy,
  'getDestination' | 'getPageIndex' | 'numPages'
>;

export type PdfOutlineItem = {
  id: string;
  title: string;
  pageNumber: number | null;
  items: PdfOutlineItem[];
};

function isPdfReference(value: unknown): value is PdfReference {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PdfReference>;
  return Number.isInteger(candidate.num) && Number.isInteger(candidate.gen);
}

async function resolveDestinationPage(
  pdfDocument: PdfOutlineDocument,
  destination: RawPdfOutlineItem['dest'],
): Promise<number | null> {
  try {
    const resolvedDestination = typeof destination === 'string'
      ? await pdfDocument.getDestination(destination)
      : destination;
    if (!Array.isArray(resolvedDestination) || resolvedDestination.length === 0) {
      return null;
    }

    const pageReference = resolvedDestination[0];
    const pageIndex = typeof pageReference === 'number'
      ? pageReference
      : isPdfReference(pageReference)
        ? await pdfDocument.getPageIndex(pageReference)
        : null;
    if (pageIndex === null || !Number.isInteger(pageIndex)) return null;

    const pageNumber = pageIndex + 1;
    return pageNumber >= 1 && pageNumber <= pdfDocument.numPages
      ? pageNumber
      : null;
  } catch {
    return null;
  }
}

async function resolveOutlineLevel(
  pdfDocument: PdfOutlineDocument,
  items: RawPdfOutlineItem[],
  parentId: string,
): Promise<PdfOutlineItem[]> {
  const resolvedItems = await Promise.all(items.map(async (item, index) => {
    const id = `${parentId}-${index}`;
    const title = item.title.replace(/\s+/g, ' ').trim();
    const [pageNumber, children] = await Promise.all([
      resolveDestinationPage(pdfDocument, item.dest),
      resolveOutlineLevel(pdfDocument, item.items || [], id),
    ]);

    if (!title) return children;
    if (pageNumber === null && children.length === 0) return [];

    return [{
      id,
      title,
      pageNumber,
      items: children,
    }];
  }));

  return resolvedItems.flat();
}

export async function resolvePdfOutline(
  pdfDocument: PdfOutlineDocument,
  outline: RawPdfOutlineItem[] | null,
): Promise<PdfOutlineItem[]> {
  if (!outline || outline.length === 0) return [];
  return resolveOutlineLevel(pdfDocument, outline, 'outline');
}
