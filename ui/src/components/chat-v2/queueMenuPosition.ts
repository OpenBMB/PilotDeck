export type QueueMenuAnchor = Pick<DOMRect, 'top' | 'right' | 'bottom'>;

export function getQueueMenuPosition({
  anchor,
  viewportWidth,
  viewportHeight,
  menuWidth = 144,
  menuHeight = 44,
  gap = 6,
  margin = 8,
}: {
  anchor: QueueMenuAnchor;
  viewportWidth: number;
  viewportHeight: number;
  menuWidth?: number;
  menuHeight?: number;
  gap?: number;
  margin?: number;
}) {
  const fitsAbove = anchor.top - menuHeight - gap >= margin;
  const preferredTop = fitsAbove
    ? anchor.top - menuHeight - gap
    : anchor.bottom + gap;

  return {
    left: Math.max(margin, Math.min(viewportWidth - menuWidth - margin, anchor.right - menuWidth)),
    top: Math.max(margin, Math.min(viewportHeight - menuHeight - margin, preferredTop)),
    placement: fitsAbove ? 'top' as const : 'bottom' as const,
  };
}
