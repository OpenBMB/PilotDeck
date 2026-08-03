export const floatingSelectionSurfaceClassName = [
  'border border-neutral-200 bg-white text-neutral-900 shadow-lg',
  'dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100',
].join(' ');

export const floatingSelectionSingleActionClassName = [
  floatingSelectionSurfaceClassName,
  'rounded-full px-3 py-1.5 text-[12px] font-medium transition',
  'hover:bg-neutral-50 dark:hover:bg-neutral-900',
].join(' ');

export const floatingSelectionGroupClassName = [
  floatingSelectionSurfaceClassName,
  'flex items-center gap-1 rounded-2xl p-1.5',
].join(' ');

type FloatingActionPositionInput = {
  anchorX: number;
  anchorY: number;
  hostWidth: number;
  hostHeight: number;
  actionWidth: number;
  actionHeight: number;
  gap?: number;
  padding?: number;
  preferredPlacement?: 'above' | 'below';
};

export function getFloatingActionPosition({
  anchorX,
  anchorY,
  hostWidth,
  hostHeight,
  actionWidth,
  actionHeight,
  gap = 10,
  padding = 8,
  preferredPlacement = 'above',
}: FloatingActionPositionInput) {
  const maxLeft = Math.max(padding, hostWidth - actionWidth - padding);
  const left = Math.min(
    maxLeft,
    Math.max(padding, anchorX - actionWidth / 2),
  );
  const above = anchorY - actionHeight - gap;
  const below = anchorY + gap;
  const maxTop = Math.max(padding, hostHeight - actionHeight - padding);
  const preferredTop = preferredPlacement === 'below' ? below : above;
  const fallbackTop = preferredPlacement === 'below' ? above : below;
  const top = preferredTop >= padding && preferredTop <= maxTop
    ? preferredTop
    : Math.min(maxTop, Math.max(padding, fallbackTop));

  return { left, top };
}
