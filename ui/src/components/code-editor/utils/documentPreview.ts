export type PdfNavigationMode = 'none' | 'pages' | 'slides';

const getExtension = (filename: string): string =>
  filename.split('.').pop()?.toLowerCase() ?? '';

export function getPdfNavigationMode(filename: string): PdfNavigationMode {
  const extension = getExtension(filename);
  if (extension === 'pdf' || ['doc', 'docx', 'wps', 'odt'].includes(extension)) {
    return 'pages';
  }
  if (['ppt', 'pptx', 'dps', 'odp'].includes(extension)) {
    return 'slides';
  }
  return 'none';
}
