import { describe, expect, it } from 'vitest';
import {
  boundingRect,
  clampPointInRect,
  clampPointToRegion,
  clampWindowPosition,
  distToRectSq,
  indexAtPoint,
  nearestIndex,
  pointInRect,
  rectBottom,
  rectRight,
  windowPlacementRegions,
  type DisplayWorkArea,
  type Rect,
} from './display-region';

const LEFT: Rect = { x: 0, y: 0, width: 100, height: 100 };
const RIGHT: Rect = { x: 150, y: 0, width: 100, height: 100 };
const WORK_AREAS: DisplayWorkArea[] = [
  { ...LEFT, displayId: 'left-display' },
  { ...RIGHT, displayId: 'right-display' },
];

describe('dsh-pet display-region geometry port', () => {
  it('uses half-open rectangle edges and computes bounding rectangles', () => {
    expect(rectRight(LEFT)).toBe(100);
    expect(rectBottom(LEFT)).toBe(100);
    expect(pointInRect(LEFT, 0, 0)).toBe(true);
    expect(pointInRect(LEFT, 100, 50)).toBe(false);
    expect(pointInRect(LEFT, 50, 100)).toBe(false);
    expect(boundingRect([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(boundingRect([{ x: -100, y: 20, width: 100, height: 80 }, RIGHT])).toEqual({
      x: -100,
      y: 0,
      width: 350,
      height: 100,
    });
  });

  it('finds a containing or nearest screen, including negative-origin displays', () => {
    const negative: Rect = { x: -1600, y: -100, width: 1600, height: 900 };
    expect(indexAtPoint([negative, RIGHT], -20, 0)).toBe(0);
    expect(indexAtPoint([LEFT, RIGHT], 120, 10)).toBe(-1);
    expect(distToRectSq(LEFT, -10, 50)).toBe(100);
    expect(distToRectSq(LEFT, 50, 50)).toBe(0);
    expect(nearestIndex([], 120, 10)).toBe(-1);
    expect(nearestIndex([LEFT, RIGHT], 120, 10)).toBe(0);
  });

  it('clamps gap points to the nearest display rectangle', () => {
    expect(clampPointInRect(LEFT, -10, 120)).toEqual({ x: 0, y: 99 });
    expect(clampPointToRegion([LEFT, RIGHT], 30, 40)).toEqual({ x: 30, y: 40 });
    expect(clampPointToRegion([LEFT, RIGHT], 120, 40)).toEqual({ x: 99, y: 40 });
    expect(clampPointToRegion([], 120, 40)).toEqual({ x: 120, y: 40 });
  });

  it('subtracts the window size and restores to a preferred display', () => {
    const regions = windowPlacementRegions(WORK_AREAS, 20, 30);
    expect(regions).toEqual([
      { displayId: 'left-display', x: 0, y: 0, width: 81, height: 71 },
      { displayId: 'right-display', x: 150, y: 0, width: 81, height: 71 },
    ]);
    expect(clampWindowPosition(regions, 120, 20)).toEqual({
      x: 150,
      y: 20,
      displayId: 'right-display',
      index: 1,
    });
    expect(clampWindowPosition(regions, 220, 20, 'left-display')).toEqual({
      x: 80,
      y: 20,
      displayId: 'left-display',
      index: 0,
    });
    expect(clampWindowPosition(regions, 220, 20, 'removed-display')).toEqual({
      x: 220,
      y: 20,
      displayId: 'right-display',
      index: 1,
    });
  });

  it('anchors an oversized window at the display origin and handles no displays', () => {
    const regions = windowPlacementRegions([{ x: -20, y: 5, width: 10, height: 10, displayId: 'tiny' }], 20, 20);
    expect(regions[0]).toMatchObject({ x: -20, y: 5, width: 1, height: 1 });
    expect(clampWindowPosition([], 4, 6)).toEqual({ x: 4, y: 6, displayId: null, index: -1 });
  });
});
