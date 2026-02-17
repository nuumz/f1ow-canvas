/**
 * useSpatialIndex.ts — React hook to maintain an R-tree spatial index
 * (with temporal coherence / fattened AABBs) synchronized with the
 * element array.
 *
 * Automatically rebuilds on element changes and provides O(log n)
 * viewport culling queries instead of O(n) linear scans.
 *
 * When the element count is small (≤ SPATIAL_INDEX_THRESHOLD), the
 * overhead of maintaining an R-tree is not worthwhile — falls back
 * to the original linear culling for simplicity.
 */
import { useMemo, useRef } from 'react';
import type { CanvasElement, ViewportState } from '@/types';
import { SpatialIndex } from '@/utils/spatialIndex';
import { cullToViewport, toSet } from '@/utils/performance';

/**
 * Below this count, skip the R-tree and use the cheaper linear scan.
 * rbush overhead only pays off when n > ~200 elements.
 */
const SPATIAL_INDEX_THRESHOLD = 200;

/**
 * Hook returning only elements visible in the current viewport,
 * using an R-tree spatial index for large canvases.
 *
 * Drop-in replacement for the original `useViewportCulling` hook —
 * same input/output contract.
 */
export function useSpatialIndex(
    elements: CanvasElement[],
    viewport: ViewportState,
    stageWidth: number,
    stageHeight: number,
    selectedIds: string[],
    padding?: number,
): CanvasElement[] {
    const indexRef = useRef<SpatialIndex>(new SpatialIndex());
    const selectedSet = useMemo(() => toSet(selectedIds), [selectedIds]);
    const prevResultRef = useRef<CanvasElement[]>([]);

    // Rebuild / incrementally update the R-tree when elements change.
    //
    // THREE strategies based on what changed:
    //
    //  1. **Structural change** (element count differs):
    //     Full rebuild O(n log n).  Only happens on add/remove.
    //
    //  2. **Position-only change** (same count, some refs differ):
    //     Incremental update via SpatialIndex.update() with temporal
    //     coherence (fattened AABBs).  ~80-95% of updates are O(1)
    //     (absorbed by fat margin), remainder are O(log n).
    //     This fixes the stale-R-tree bug where viewport culling
    //     showed wrong elements after drag completed.
    //
    //  3. **No change** (same array reference): skip entirely.
    //
    const prevElementsRef = useRef<CanvasElement[]>([]);
    const prevElementCountRef = useRef(0);
    if (elements !== prevElementsRef.current) {
        const prevElements = prevElementsRef.current;
        prevElementsRef.current = elements;
        if (elements.length > SPATIAL_INDEX_THRESHOLD) {
            const isStructuralChange = elements.length !== prevElementCountRef.current;
            if (isStructuralChange) {
                // Full rebuild on add/remove
                indexRef.current.rebuild(elements);
            } else {
                // Incremental update: find which elements changed by
                // comparing object references (O(n) but very fast —
                // only a reference equality check per element).
                const index = indexRef.current;
                for (let i = 0; i < elements.length; i++) {
                    if (elements[i] !== prevElements[i]) {
                        index.update(elements[i]);
                    }
                }
            }
        }
        prevElementCountRef.current = elements.length;
    }

    return useMemo(() => {
        // Small canvas — linear fallback (same as original useViewportCulling)
        if (elements.length <= SPATIAL_INDEX_THRESHOLD) {
            return cullToViewport(elements, viewport, stageWidth, stageHeight, selectedSet, padding);
        }

        // Large canvas — R-tree query
        const index = indexRef.current;
        const visibleIds = index.queryViewport(viewport, stageWidth, stageHeight, padding);

        // Merge visible IDs with selected IDs (always visible)
        const resultIds = new Set(visibleIds);
        for (const sid of selectedIds) {
            resultIds.add(sid);
        }

        // Resolve IDs to elements, preserving original array order
        // (important for rendering z-order)
        const result: CanvasElement[] = [];
        for (const el of elements) {
            if (resultIds.has(el.id)) {
                result.push(el);
            }
        }

        // ─── Reference stabilisation ─────────────────────────
        // When only selectedIds changes but the viewport hasn't
        // moved, the visible element set is typically identical.
        // Preserve the previous array reference to prevent
        // downstream useMemo cascades (partition → progressive
        // render → layer re-render).
        const prev = prevResultRef.current;
        if (result.length === prev.length) {
            let same = true;
            for (let i = 0; i < result.length; i++) {
                if (result[i] !== prev[i]) { same = false; break; }
            }
            if (same) return prev;
        }
        prevResultRef.current = result;
        return result;
    }, [elements, viewport.x, viewport.y, viewport.scale, stageWidth, stageHeight, selectedSet, selectedIds, padding]);
}
