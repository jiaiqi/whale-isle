/*
 * MIT License
 *
 * Copyright (c) 2026 PC2005-cloud
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Multi-display region geometry adapted from dsh-pet/src/shared/displays.ts.
 * Work areas are treated as a union of rectangles so gaps between screens are
 * never considered valid window positions.
 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayWorkArea extends Rect {
  displayId: string;
}

export interface WindowPlacementRegion extends Rect {
  displayId: string;
}

export interface WindowPosition {
  x: number;
  y: number;
  displayId: string | null;
  index: number;
}

/** Rectangle's right edge (exclusive). */
export const rectRight = (rect: Rect): number => rect.x + rect.width;
/** Rectangle's bottom edge (exclusive). */
export const rectBottom = (rect: Rect): number => rect.y + rect.height;

/** Bounding rectangle for viewport calculations; use the rectangle union for placement. */
export const boundingRect = (rects: Rect[]): Rect => {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const rect of rects) {
    x0 = Math.min(x0, rect.x);
    y0 = Math.min(y0, rect.y);
    x1 = Math.max(x1, rectRight(rect));
    y1 = Math.max(y1, rectBottom(rect));
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
};

/** Point containment uses half-open edges so adjacent displays do not overlap. */
export const pointInRect = (rect: Rect, x: number, y: number): boolean =>
  x >= rect.x && x < rectRight(rect) && y >= rect.y && y < rectBottom(rect);

/** Return the first rectangle containing the point, or -1 when the point is in a gap. */
export const indexAtPoint = (rects: Rect[], x: number, y: number): number => {
  for (let index = 0; index < rects.length; index += 1) {
    const rect = rects[index];
    if (rect && pointInRect(rect, x, y)) return index;
  }
  return -1;
};

/** Squared distance from a point to a rectangle. */
export const distToRectSq = (rect: Rect, x: number, y: number): number => {
  const dx = Math.max(rect.x - x, 0, x - rectRight(rect));
  const dy = Math.max(rect.y - y, 0, y - rectBottom(rect));
  return dx * dx + dy * dy;
};

/** Index of the nearest rectangle; an empty list returns -1. */
export const nearestIndex = (rects: Rect[], x: number, y: number): number => {
  let best = -1;
  let bestDistance = Infinity;
  for (let index = 0; index < rects.length; index += 1) {
    const rect = rects[index];
    if (!rect) continue;
    const distance = distToRectSq(rect, x, y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
};

/** Clamp a point into one rectangle, keeping the result inside its half-open edges. */
export const clampPointInRect = (rect: Rect, x: number, y: number): { x: number; y: number } => ({
  x: Math.min(Math.max(x, rect.x), rectRight(rect) - 1),
  y: Math.min(Math.max(y, rect.y), rectBottom(rect) - 1),
});

/** Clamp a point into the rectangle union, projecting gap positions to the nearest rectangle. */
export const clampPointToRegion = (rects: Rect[], x: number, y: number): { x: number; y: number } => {
  if (indexAtPoint(rects, x, y) >= 0) return { x, y };
  const index = nearestIndex(rects, x, y);
  const rect = rects[index];
  return rect ? clampPointInRect(rect, x, y) : { x, y };
};

/** Convert display work areas into valid top-left positions for a window of the given size. */
export const windowPlacementRegions = (
  workAreas: DisplayWorkArea[],
  windowWidth: number,
  windowHeight: number,
): WindowPlacementRegion[] => workAreas.map((area) => ({
  displayId: area.displayId,
  x: area.x,
  y: area.y,
  // A window may be larger than a small display. In that case anchor it at the
  // work-area origin; otherwise include the final valid integer top-left point.
  width: Math.max(1, area.width - windowWidth + 1),
  height: Math.max(1, area.height - windowHeight + 1),
}));

/** Clamp a window origin and return the stable Electron display ID for that region. */
export const clampWindowPosition = (
  regions: WindowPlacementRegion[],
  x: number,
  y: number,
  preferredDisplayId?: string,
): WindowPosition => {
  let index = preferredDisplayId
    ? regions.findIndex((region) => region.displayId === preferredDisplayId)
    : -1;
  if (index < 0) index = indexAtPoint(regions, x, y);
  if (index < 0) index = nearestIndex(regions, x, y);

  const region = regions[index];
  if (!region) return { x, y, displayId: null, index: -1 };
  const position = clampPointInRect(region, x, y);
  return { ...position, displayId: region.displayId, index };
};
