/** The existing LCS calculator allocates one cell for every old/new line pair. */
export function needsLargeChangePreview(oldText: string, newText: string): boolean {
  if (oldText.length + newText.length > 160_000) return true;
  const oldLines = (oldText.match(/\n/g)?.length ?? 0) + 1;
  const newLines = (newText.match(/\n/g)?.length ?? 0) + 1;
  return oldLines * newLines > 250_000;
}
