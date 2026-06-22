/**
 * useSpatialIndex.ts — React hook that maintains a cache-friendly
 * Structure-of-Arrays (SoA) spatial index synchronized with the
 * element array and uses it for viewport culling.
 *
 * The SoA stores each element's AABB in contiguous Float64Array buffers,
 * giving tight, branch-predictable, cache-line-friendly scans for
 * viewport queries instead of pointer-chasing the AoS element objects.
 *
 * When the element count is small (≤ SPATIAL_INDEX_THRESHOLD), the
 * overhead of maintaining a side index is not worthwhile — falls back
 * to the original linear culling for simplicity.
 *
 * Trade-off note: a flat SoA scan is O(n) per query, whereas an R-tree
 * (see `utils/spatialIndex.ts`, kept for back-compat) answers range
 * queries in ~O(log n + k). The SoA wins on small constant factors and
 * GC pressure for moderate n; the R-tree wins asymptotically for very
 * large, sparse scenes. SoA is the deliberately chosen live index here.
 */
import { useLayoutEffect, useMemo, useRef } from 'react';
import type { CanvasElement, ViewportState } from '@/types';
import { SpatialSoA } from '@/utils/spatialSoA';
import { cullToViewport, toSet } from '@/utils/performance';

/**
 * Below this count, skip the side index and use the cheaper linear scan.
 * The SoA overhead only pays off when n > ~200 elements.
 */
const SPATIAL_INDEX_THRESHOLD = 200;

/**
 * Hook returning only elements visible in the current viewport,
 * using a Structure-of-Arrays spatial index for large canvases.
 *
 * Drop-in replacement for the original `useViewportCulling` hook —
 * same input/output contract (returns `CanvasElement[]`).
 */
export function useSpatialIndex(
    elements: CanvasElement[],
    viewport: ViewportState,
    stageWidth: number,
    stageHeight: number,
    selectedIds: string[],
    padding?: number,
): CanvasElement[] {
    // Per-hook-instance index → multiple FlowCanvas instances stay isolated.
    const soaRef = useRef<SpatialSoA | null>(null);
    if (soaRef.current === null) soaRef.current = new SpatialSoA();

    const selectedSet = useMemo(() => toSet(selectedIds), [selectedIds]);
    const prevResultRef = useRef<CanvasElement[]>([]);

    // The `elements` array reference the SoA was last synced against, and the
    // id-set of that sync. These let the query below detect whether the SoA is
    // up to date with the current render, and let the effect decide between a
    // full rebuild (id-set changed) and cheap incremental updates.
    const syncedElementsRef = useRef<CanvasElement[] | null>(null);
    const syncedIdSetRef = useRef<Set<string>>(new Set());

    // ─── Index maintenance — in an effect, NOT during render ──────────
    //
    // Mutating the long-lived index during render double-applies under
    // React 19 StrictMode / concurrent rendering (work-in-progress renders
    // can be discarded, leaving the index inconsistent with the committed
    // tree). Doing it in a layout effect runs it exactly once per commit,
    // before paint.
    //
    // Strategy:
    //   1. id-SET changed (add/remove/replace, even at equal count): full
    //      rebuild. Comparing the id SET — not just the count — fixes the
    //      ghost-entry bug where a same-count add+remove left a stale id.
    //   2. id-set unchanged, some element refs differ (move/resize): O(1)
    //      per changed element via updateElement().
    //   3. Below threshold: nothing to maintain (linear path is used).
    useLayoutEffect(() => {
        const soa = soaRef.current!;

        if (elements.length <= SPATIAL_INDEX_THRESHOLD) {
            // Drop the index so re-crossing the threshold forces a rebuild.
            soa.clear();
            syncedElementsRef.current = elements;
            syncedIdSetRef.current = new Set();
            return;
        }

        const prevIdSet = syncedIdSetRef.current;
        let idSetChanged = elements.length !== prevIdSet.size;
        if (!idSetChanged) {
            for (let i = 0; i < elements.length; i++) {
                if (!prevIdSet.has(elements[i].id)) { idSetChanged = true; break; }
            }
        }

        if (idSetChanged) {
            soa.rebuild(elements);
            const idSet = new Set<string>();
            for (const el of elements) idSet.add(el.id);
            syncedIdSetRef.current = idSet;
        } else {
            // Same id-set: only positions/sizes may have changed. Detect by
            // reference (cheap) and patch those slots in place.
            const prevElements = syncedElementsRef.current;
            for (let i = 0; i < elements.length; i++) {
                if (!prevElements || elements[i] !== prevElements[i]) {
                    soa.updateElement(elements[i]);
                }
            }
        }
        syncedElementsRef.current = elements;
    }, [elements]);

    // ─── Query — pure, render-phase ──────────────────────────────────
    return useMemo(() => {
        // Linear cull when:
        //   - small canvas (index not worth maintaining), or
        //   - the SoA hasn't been synced to THIS `elements` yet (the layout
        //     effect runs after render, so on the very commit where elements
        //     change we fall back to a linear scan to avoid a stale frame).
        // The SoA scan and the linear cull use the same AABB logic, so both
        // return the identical set — no correctness divergence.
        if (
            elements.length <= SPATIAL_INDEX_THRESHOLD ||
            syncedElementsRef.current !== elements
        ) {
            return cullToViewport(elements, viewport, stageWidth, stageHeight, selectedSet, padding);
        }

        // Large canvas, index in sync — SoA viewport query.
        const visibleIds = soaRef.current!.cullViewport(viewport, stageWidth, stageHeight, padding);

        // Merge visible IDs with selected IDs (always visible for transformer).
        const resultIds = new Set(visibleIds);
        for (const sid of selectedIds) {
            resultIds.add(sid);
        }

        // Resolve IDs to elements, preserving original array order
        // (important for rendering z-order).
        const result: CanvasElement[] = [];
        for (const el of elements) {
            if (resultIds.has(el.id)) {
                result.push(el);
            }
        }

        // ─── Reference stabilisation ─────────────────────────
        // When only selectedIds changes but the viewport hasn't moved, the
        // visible element set is typically identical. Preserve the previous
        // array reference to prevent downstream useMemo cascades (partition →
        // progressive render → layer re-render).
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
