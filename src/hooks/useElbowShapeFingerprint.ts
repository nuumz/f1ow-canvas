import { useMemo, useRef } from 'react';
import type { CanvasElement } from '@/types';

/**
 * Shape types whose position/size affects elbow routing.
 * Only connectable shapes act as obstacles — lines, arrows,
 * freedraw elements are transparent to the router.
 */
const OBSTACLE_TYPES = new Set(['rectangle', 'ellipse', 'diamond', 'text', 'image']);

/**
 * Compute a stable fingerprint string from the spatial properties
 * (x, y, width, height, rotation) of all connectable shapes.
 *
 * Used as a `useMemo` dependency in ArrowShape/LineShape instead of
 * the raw `allElements` array — which gets a new reference on every
 * render cycle and causes unnecessary elbow recomputation.
 *
 * The fingerprint only changes when a connectable shape's position,
 * size, rotation, or visibility changes — style changes, text content
 * changes, etc. are ignored since they don't affect routing.
 *
 * Returns both the fingerprint string AND the elements array ref.
 * The elements ref is stable (won't trigger re-renders) and is used
 * to pass to `computeElbowPoints` when the fingerprint changes.
 */
export function useElbowShapeFingerprint(
    allElements: CanvasElement[] | undefined,
): { fingerprint: string; elementsRef: React.MutableRefObject<CanvasElement[]> } {
    const elementsRef = useRef<CanvasElement[]>(allElements ?? []);
    elementsRef.current = allElements ?? [];

    const fingerprint = useMemo(() => {
        if (!allElements || allElements.length === 0) return '';

        // Round to 0.5px to absorb sub-pixel jitter
        const r = (v: number) => Math.round(v * 2) / 2;

        const parts: string[] = [];
        for (const el of allElements) {
            if (!OBSTACLE_TYPES.has(el.type)) continue;
            if (!el.isVisible) continue;
            parts.push(
                `${el.id}:${r(el.x)},${r(el.y)},${r(el.width)},${r(el.height)},${r(el.rotation || 0)}`,
            );
        }
        return parts.join(';');
    }, [allElements]);

    return { fingerprint, elementsRef };
}
