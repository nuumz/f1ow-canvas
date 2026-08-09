/**
 * alignment.ts — Smart alignment guide computation.
 *
 * Detects when a dragged element's edges/center align with other elements
 * and returns snap positions + guide lines to render.
 */
import type { CanvasElement, TextElement } from '@/types';

/** Threshold in canvas pixels for snapping to alignment guides */
const SNAP_THRESHOLD = 5;

/** A single alignment guide line */
export interface AlignGuide {
    /** 'h' = horizontal line (y aligned), 'v' = vertical line (x aligned) */
    orientation: 'h' | 'v';
    /** Position on the align axis (x for vertical, y for horizontal) */
    position: number;
    /** Guide extent — start coordinate on cross axis */
    start: number;
    /** Guide extent — end coordinate on cross axis */
    end: number;
}

export interface AlignResult {
    /** Snapped x (undefined = no x snap) */
    x?: number;
    /** Snapped y (undefined = no y snap) */
    y?: number;
    /** Guides to render */
    guides: AlignGuide[];
}

interface Bounds {
    left: number;
    right: number;
    top: number;
    bottom: number;
    cx: number;
    cy: number;
}

function getBounds(el: CanvasElement): Bounds {
    // For lines/arrows, compute from points
    if ((el.type === 'line' || el.type === 'arrow' || el.type === 'freedraw') && 'points' in el) {
        const pts = (el as any).points as number[];
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < pts.length; i += 2) {
            const px = el.x + pts[i];
            const py = el.y + pts[i + 1];
            minX = Math.min(minX, px);
            maxX = Math.max(maxX, px);
            minY = Math.min(minY, py);
            maxY = Math.max(maxY, py);
        }
        return { left: minX, right: maxX, top: minY, bottom: maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
    }
    return {
        left: el.x,
        right: el.x + el.width,
        top: el.y,
        bottom: el.y + el.height,
        cx: el.x + el.width / 2,
        cy: el.y + el.height / 2,
    };
}

/**
 * Compute alignment guides for a moving element against all other elements.
 *
 * @param moving   - The element being dragged (with current position)
 * @param others   - All other canvas elements to compare against
 * @param threshold - Pixel distance for snapping (default 5)
 * @returns Snapped x/y offsets and guide lines to render
 */
export function computeAlignGuides(
    movingBounds: { x: number; y: number; width: number; height: number },
    others: CanvasElement[],
    excludeIds: Set<string>,
    threshold = SNAP_THRESHOLD,
): AlignResult {
    const m = {
        left: movingBounds.x,
        right: movingBounds.x + movingBounds.width,
        top: movingBounds.y,
        bottom: movingBounds.y + movingBounds.height,
        cx: movingBounds.x + movingBounds.width / 2,
        cy: movingBounds.y + movingBounds.height / 2,
    };

    // Collect snap candidates from all other elements
    const xSnaps: { value: number; edge: 'left' | 'cx' | 'right'; other: Bounds }[] = [];
    const ySnaps: { value: number; edge: 'top' | 'cy' | 'bottom'; other: Bounds }[] = [];

    for (const el of others) {
        if (excludeIds.has(el.id) || !el.isVisible) continue;
        // Skip bound text
        if (el.type === 'text' && (el as any).containerId) continue;

        const o = getBounds(el);

        // Vertical alignment (x axis): left-left, left-right, right-left, right-right, center-center
        const xChecks: [number, 'left' | 'cx' | 'right', number][] = [
            [m.left, 'left', o.left],
            [m.left, 'left', o.right],
            [m.right, 'right', o.left],
            [m.right, 'right', o.right],
            [m.cx, 'cx', o.cx],
            [m.left, 'left', o.cx],
            [m.right, 'right', o.cx],
            [m.cx, 'cx', o.left],
            [m.cx, 'cx', o.right],
        ];
        for (const [mVal, edge, oVal] of xChecks) {
            if (Math.abs(mVal - oVal) < threshold) {
                xSnaps.push({ value: oVal, edge, other: o });
            }
        }

        // Horizontal alignment (y axis): top-top, top-bottom, bottom-top, bottom-bottom, center-center
        const yChecks: [number, 'top' | 'cy' | 'bottom', number][] = [
            [m.top, 'top', o.top],
            [m.top, 'top', o.bottom],
            [m.bottom, 'bottom', o.top],
            [m.bottom, 'bottom', o.bottom],
            [m.cy, 'cy', o.cy],
            [m.top, 'top', o.cy],
            [m.bottom, 'bottom', o.cy],
            [m.cy, 'cy', o.top],
            [m.cy, 'cy', o.bottom],
        ];
        for (const [mVal, edge, oVal] of yChecks) {
            if (Math.abs(mVal - oVal) < threshold) {
                ySnaps.push({ value: oVal, edge, other: o });
            }
        }
    }

    const result: AlignResult = { guides: [] };

    // Pick best X snap (smallest distance)
    if (xSnaps.length > 0) {
        xSnaps.sort((a, b) => Math.abs(a.value - m[a.edge]) - Math.abs(b.value - m[b.edge]));
        const best = xSnaps[0];
        const dx = best.value - m[best.edge];
        result.x = movingBounds.x + dx;

        // Build vertical guide lines at this x
        const snapX = best.value;
        // Collect all matching snaps at this x (±1px)
        const matching = xSnaps.filter((s) => Math.abs(s.value - snapX) < 1);
        let guideTop = m.top + (result.y !== undefined ? result.y - movingBounds.y : 0);
        let guideBottom = m.bottom + (result.y !== undefined ? result.y - movingBounds.y : 0);
        for (const s of matching) {
            guideTop = Math.min(guideTop, s.other.top);
            guideBottom = Math.max(guideBottom, s.other.bottom);
        }
        result.guides.push({
            orientation: 'v',
            position: snapX,
            start: guideTop - 10,
            end: guideBottom + 10,
        });
    }

    // Pick best Y snap
    if (ySnaps.length > 0) {
        ySnaps.sort((a, b) => Math.abs(a.value - m[a.edge]) - Math.abs(b.value - m[b.edge]));
        const best = ySnaps[0];
        const dy = best.value - m[best.edge];
        result.y = movingBounds.y + dy;

        const snapY = best.value;
        const matching = ySnaps.filter((s) => Math.abs(s.value - snapY) < 1);
        let guideLeft = m.left + (result.x !== undefined ? result.x - movingBounds.x : 0);
        let guideRight = m.right + (result.x !== undefined ? result.x - movingBounds.x : 0);
        for (const s of matching) {
            guideLeft = Math.min(guideLeft, s.other.left);
            guideRight = Math.max(guideRight, s.other.right);
        }
        result.guides.push({
            orientation: 'h',
            position: snapY,
            start: guideLeft - 10,
            end: guideRight + 10,
        });
    }

    return result;
}

export interface MultiSelectAlignSnap {
    /** Delta to apply to every selected element's position */
    dx: number;
    dy: number;
    guides: AlignGuide[];
}

/**
 * Snap a multi-selection as one unit using the union AABB.
 *
 * `movingBounds` is the live (Konva) bounds of the element currently
 * reporting drag; other selected elements are projected by the same
 * live delta from their store positions so the union tracks the group.
 */
export function computeMultiSelectAlignSnap(
    movingId: string,
    movingBounds: { x: number; y: number; width: number; height: number },
    elements: CanvasElement[],
    selectedIds: string[],
    threshold = SNAP_THRESHOLD,
): MultiSelectAlignSnap {
    const excludeIds = new Set(selectedIds);
    const selSet = new Set(selectedIds);
    const movingEl = elements.find((e) => e.id === movingId);
    if (!movingEl) {
        return { dx: 0, dy: 0, guides: [] };
    }

    const liveDx = movingBounds.x - movingEl.x;
    const liveDy = movingBounds.y - movingEl.y;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let count = 0;

    for (const el of elements) {
        if (!selSet.has(el.id)) continue;
        if (el.type === 'text' && (el as TextElement).containerId) continue;

        let left: number;
        let top: number;
        let right: number;
        let bottom: number;

        if (el.id === movingId) {
            left = movingBounds.x;
            top = movingBounds.y;
            right = movingBounds.x + movingBounds.width;
            bottom = movingBounds.y + movingBounds.height;
        } else {
            const b = getBounds(el);
            left = b.left + liveDx;
            top = b.top + liveDy;
            right = b.right + liveDx;
            bottom = b.bottom + liveDy;
        }

        minX = Math.min(minX, left);
        minY = Math.min(minY, top);
        maxX = Math.max(maxX, right);
        maxY = Math.max(maxY, bottom);
        count++;
    }

    if (count === 0 || !Number.isFinite(minX)) {
        return { dx: 0, dy: 0, guides: [] };
    }

    const union = {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
    };
    const result = computeAlignGuides(union, elements, excludeIds, threshold);
    return {
        dx: result.x !== undefined ? result.x - union.x : 0,
        dy: result.y !== undefined ? result.y - union.y : 0,
        guides: result.guides,
    };
}
