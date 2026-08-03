import { describe, expect, it } from 'vitest';
import { getFloatingActionPosition } from './floatingSelectionAction';

describe('getFloatingActionPosition', () => {
  it('centers the action above the selection anchor when space is available', () => {
    expect(getFloatingActionPosition({
      anchorX: 300,
      anchorY: 200,
      hostWidth: 800,
      hostHeight: 600,
      actionWidth: 160,
      actionHeight: 36,
    })).toEqual({ left: 220, top: 154 });
  });

  it('moves the action below an anchor near the top edge', () => {
    expect(getFloatingActionPosition({
      anchorX: 80,
      anchorY: 20,
      hostWidth: 800,
      hostHeight: 600,
      actionWidth: 160,
      actionHeight: 36,
    })).toEqual({ left: 8, top: 30 });
  });

  it('keeps the action inside the host at the right and bottom edges', () => {
    expect(getFloatingActionPosition({
      anchorX: 790,
      anchorY: 590,
      hostWidth: 800,
      hostHeight: 600,
      actionWidth: 160,
      actionHeight: 36,
    })).toEqual({ left: 632, top: 544 });
  });

  it('keeps a region action below the selection when there is room', () => {
    expect(getFloatingActionPosition({
      anchorX: 300,
      anchorY: 200,
      hostWidth: 800,
      hostHeight: 600,
      actionWidth: 288,
      actionHeight: 44,
      preferredPlacement: 'below',
    })).toEqual({ left: 156, top: 210 });
  });
});
