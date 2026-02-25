/**
 * performance.ts
 * Performance utilities for large canvas support.
 * ─ viewport culling, spatial indexing, efficient cloning, throttling.
 */
import type { CanvasElement, ViewportState, Point, LineElement, ArrowElement } from '@/types';

// ─── Viewport Culling ─────────────────────────────────────────

/** Bounding box in world coordinates */
export interface AABB {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

/**
 * Compute the visible world-coordinate rectangle from the viewport
 * state and the Stage pixel dimensions.
 * @param viewport - current pan/zoom state
 * @param stageWidth - pixel width of the Stage element
 * @param stageHeight - pixel height of the Stage element
 * @param padding - extra world-space padding around the visible area
 *   so that elements slightly outside the viewport are still rendered
 *   (avoids pop-in during fast pan). Default 200 world-units.
 */
export function getVisibleBounds(
    viewport: ViewportState,
    stageWidth: number,
    stageHeight: number,
    padding = 200,
): AABB {
    const { x, y, scale } = viewport;
    const minX = -x / scale - padding;
    const minY = -y / scale - padding;
    const maxX = (-x + stageWidth) / scale + padding;
    const maxY = (-y + stageHeight) / scale + padding;
    return { minX, minY, maxX, maxY };
}

/**
 * Compute the axis-aligned bounding box for a single element.
 * Handles line/arrow elements whose visual extent depends on `points`.
 */
export function getElementAABB(el: CanvasElement): AABB {
    if ((el.type === 'line' || el.type === 'arrow') && 'points' in el) {
        const pts = (el as LineElement | ArrowElement).points;
        let minX = 0, maxX = 0, minY = 0, maxY = 0;
        for (let i = 0; i < pts.length; i += 2) {
            const px = pts[i];
            const py = pts[i + 1];
            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
        }
        return {
            minX: el.x + minX,
            minY: el.y + minY,
            maxX: el.x + maxX,
            maxY: el.y + maxY,
        };
    }
    if (el.type === 'freedraw' && 'points' in el) {
        // FreeDraw uses absolute points stored relative to el.x/el.y after normalization
        // But during drawing (isComplete === false), points are in world coordinates
        // and x/y are 0. We need to compute the actual bounds from the points.
        if (el.isComplete === false) {
            const pts = el.points;
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (let i = 0; i < pts.length; i += 2) {
                const px = pts[i];
                const py = pts[i + 1];
                if (px < minX) minX = px;
                if (px > maxX) maxX = px;
                if (py < minY) minY = py;
                if (py > maxY) maxY = py;
            }
            // If no points yet, return a tiny box at x,y
            if (minX === Infinity) {
                return { minX: el.x, minY: el.y, maxX: el.x + 1, maxY: el.y + 1 };
            }
            return { minX, minY, maxX, maxY };
        }
        
        return {
            minX: el.x,
            minY: el.y,
            maxX: el.x + el.width,
            maxY: el.y + el.height,
        };
    }
    return {
        minX: el.x,
        minY: el.y,
        maxX: el.x + el.width,
        maxY: el.y + el.height,
    };
}

/** Check if two AABBs overlap */
export function aabbOverlaps(a: AABB, b: AABB): boolean {
    return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/**
 * Filter elements to only those visible in the viewport.
 * Elements currently selected are always included (for transformer handles).
 */
export function cullToViewport(
    elements: CanvasElement[],
    viewport: ViewportState,
    stageWidth: number,
    stageHeight: number,
    selectedIds: ReadonlySet<string>,
    padding?: number,
): CanvasElement[] {
    // For small canvases, skip culling overhead
    if (elements.length <= 100) return elements;

    const bounds = getVisibleBounds(viewport, stageWidth, stageHeight, padding);
    return elements.filter(el => {
        // Always render selected elements (transformer needs them)
        if (selectedIds.has(el.id)) return true;
        // Check visibility
        const elBB = getElementAABB(el);
        return aabbOverlaps(bounds, elBB);
    });
}

// ─── Element Lookup Map ───────────────────────────────────────

/** Build an id → element Map for O(1) lookups */
export function buildElementMap(elements: CanvasElement[]): Map<string, CanvasElement> {
    const map = new Map<string, CanvasElement>();
    for (const el of elements) {
        map.set(el.id, el);
    }
    return map;
}

// ─── Efficient History Cloning ────────────────────────────────

/**
 * Deep clone elements for history snapshots.
 * Uses structuredClone (native, faster than JSON roundtrip)
 * with smart handling for large image data.
 *
 * For ImageElements, we share the `src` string reference instead of
 * duplicating potentially megabytes of base64 data. This is safe
 * because src strings are immutable (never mutated in place).
 */
export function cloneElementsForHistory(elements: CanvasElement[]): CanvasElement[] {
    // Fast path: structuredClone is available in all modern browsers
    // and is significantly faster than JSON.parse(JSON.stringify())
    // because it doesn't need to serialize to text.
    if (typeof structuredClone === 'function') {
        // For memory optimization, share large immutable strings (image src)
        const srcCache = new Map<string, string>();
        const result: CanvasElement[] = new Array(elements.length);

        for (let i = 0; i < elements.length; i++) {
            const el = elements[i];
            if (el.type === 'image' && 'src' in el) {
                // Cache and reuse the src reference to avoid copying large base64 strings
                const imgEl = el as import('@/types').ImageElement;
                if (!srcCache.has(imgEl.id)) {
                    srcCache.set(imgEl.id, imgEl.src);
                }
                // Clone without src, then restore reference
                const { src, ...rest } = imgEl;
                const cloned = structuredClone(rest);
                (cloned as any).src = srcCache.get(imgEl.id)!;
                result[i] = cloned as CanvasElement;
            } else {
                result[i] = structuredClone(el);
            }
        }
        return result;
    }

    // Fallback for older environments
    return JSON.parse(JSON.stringify(elements));
}

// ─── Throttle / RAF Utilities ─────────────────────────────────

/**
 * Create a throttled function that runs at most once per animation frame.
 * Unlike lodash throttle, this syncs with the browser paint cycle.
 */
export function rafThrottle<T extends (...args: any[]) => void>(fn: T): T & { cancel: () => void } {
    let rafId: number | null = null;
    let lastArgs: Parameters<T> | null = null;

    const throttled = (...args: Parameters<T>) => {
        lastArgs = args;
        if (rafId === null) {
            rafId = requestAnimationFrame(() => {
                rafId = null;
                if (lastArgs) {
                    fn(...lastArgs);
                    lastArgs = null;
                }
            });
        }
    };

    throttled.cancel = () => {
        if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
        lastArgs = null;
    };

    return throttled as T & { cancel: () => void };
}

// ─── Batch Update Helper ──────────────────────────────────────

/**
 * Batch multiple element updates into a single store write.
 * Reduces re-renders during complex operations like paste or import.
 */
export function batchElementUpdates(
    elements: CanvasElement[],
    updates: Array<{ id: string; changes: Partial<CanvasElement> }>,
): CanvasElement[] {
    if (updates.length === 0) return elements;

    const updateMap = new Map<string, Partial<CanvasElement>>();
    for (const u of updates) {
        const existing = updateMap.get(u.id);
        updateMap.set(u.id, existing ? { ...existing, ...u.changes } : u.changes);
    }

    return elements.map(el => {
        const change = updateMap.get(el.id);
        return change ? { ...el, ...change } as CanvasElement : el;
    });
}

// ─── Set Utilities ────────────────────────────────────────────

/** Convert an array to a Set for O(1) membership checks */
export function toSet<T>(arr: readonly T[]): ReadonlySet<T> {
    return new Set(arr);
}

/**
 * Shallow compare two arrays by reference for memoization.
 * Useful for avoiding re-computation when selectedIds hasn't actually changed.
 */
export function arraysEqual<T>(a: readonly T[], b: readonly T[]): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}
