/**
 * useEfficientZoom.ts
 *
 * Efficient zoom level quantisation for rendering optimisation.
 * Returns a stable, discretized zoom value that only changes in
 * power-of-2 steps.  This prevents excessive re-renders (and LOD
 * flicker) during smooth pinch/scroll zoom gestures.
 *
 * Use this value for:
 * - LOD (level-of-detail) decisions in CanvasElement
 * - Stroke-width scaling
 * - Grid density calculations
 */
import { useMemo } from 'react';

// ─── Discrete zoom steps (powers of 2) ───────────────────────
const EFFICIENT_ZOOM_LEVELS = [
    0.0625, 0.125, 0.25, 0.5, 1, 2, 4, 8,
] as const;

/**
 * Snap a continuous zoom value to the nearest efficient level.
 *
 * Algorithm: binary-search the midpoints between adjacent levels.
 * O(log n) with n = 8 levels ≈ 3 comparisons.
 */
export function computeEfficientZoom(zoom: number): number {
    const levels = EFFICIENT_ZOOM_LEVELS;
    if (zoom <= levels[0]) return levels[0];
    if (zoom >= levels[levels.length - 1]) return levels[levels.length - 1];

    for (let i = 0; i < levels.length - 1; i++) {
        const mid = (levels[i] + levels[i + 1]) / 2;
        if (zoom <= mid) return levels[i];
    }
    return levels[levels.length - 1];
}

/**
 * React hook wrapping `computeEfficientZoom`.
 * The returned value is memoised — it only changes when the zoom
 * crosses a level boundary, keeping downstream consumers (LOD,
 * stroke scaling) stable during rapid zoom gestures.
 */
export function useEfficientZoom(zoom: number): number {
    return useMemo(() => computeEfficientZoom(zoom), [zoom]);
}
