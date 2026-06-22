/**
 * rendering/useTileRenderer.ts — React hook for tile-based rendering.
 *
 * Wraps TileRenderer in a React-friendly API.
 * Provides visible tile bitmaps and invalidation helpers.
 *
 * Usage:
 * ```tsx
 * const { tiles, invalidateElements, invalidateAll } = useTileRenderer(
 *   elements, viewport, stageWidth, stageHeight, { enabled: true }
 * );
 * // Render tiles on the Konva static layer via <Image> nodes
 * ```
 */
import { useRef, useMemo, useCallback, useEffect } from 'react';
import type { CanvasElement, ViewportState } from '@/types';
import { TileRenderer, type TileDrawFn, type TileSpatialQuery } from './tileRenderer';

export interface UseTileRendererOptions {
    /** Enable/disable tile rendering. Default false. */
    enabled?: boolean;
    /** Max cached tiles. Default 200. */
    maxCachedTiles?: number;
    /** Custom draw function for rasterising elements into tiles. */
    drawFn?: TileDrawFn;
    /**
     * Minimum element count before tile rendering kicks in.
     * Below this threshold, standard Konva rendering is used.
     * Default 500.
     */
    elementThreshold?: number;
    /**
     * Optional spatial query (e.g. backed by an R-tree) for fetching
     * elements overlapping a tile bounds. When provided, tile rasterise
     * cost drops from O(n) to O(log n) per tile.
     */
    spatialQuery?: TileSpatialQuery;
}

/**
 * Build a change-detection signature for an element.
 *
 * `version` is bumped by the store on geometry/point mutations, but style,
 * visibility, and text edits are NOT version-tracked — so fold those into the
 * signature explicitly. Large point arrays are intentionally excluded: any
 * change to them already bumps `version`.
 */
function elementSignature(el: CanvasElement): string {
    const s = el.style;
    const style = `${s.fillColor}|${s.strokeColor}|${s.strokeWidth}|${s.opacity}|${s.strokeStyle}|${s.roughness}|${s.fontSize}|${s.fontFamily}`;
    const text = el.type === 'text' ? el.text : '';
    return `${el.version}|${el.isVisible ? 1 : 0}|${style}|${text}`;
}

/** Result of diffing the previous frame's elements against the current frame. */
export interface ElementDiffResult {
    /** Elements added since the last frame or whose visual signature changed. */
    changed: CanvasElement[];
    /** Ids of elements present last frame but gone this frame. */
    removed: string[];
    /** Signature map for the current frame, to carry into the next diff. */
    next: Map<string, string>;
}

/**
 * Diff the current elements against the previous frame's signatures.
 * Pure helper extracted from the hook so the invalidation logic is testable
 * without a React renderer.
 */
export function diffElements(
    prev: Map<string, string>,
    elements: CanvasElement[],
): ElementDiffResult {
    const next = new Map<string, string>();
    const changed: CanvasElement[] = [];
    for (const el of elements) {
        const sig = elementSignature(el);
        next.set(el.id, sig);
        if (prev.get(el.id) !== sig) changed.push(el);
    }
    const removed: string[] = [];
    for (const id of prev.keys()) {
        if (!next.has(id)) removed.push(id);
    }
    return { changed, removed, next };
}

export interface UseTileRendererReturn {
    /** Whether tile rendering is active for the current frame */
    isActive: boolean;
    /** Visible tile bitmaps with world-space positions */
    tiles: {
        key: string;
        bitmap: ImageBitmap;
        worldX: number;
        worldY: number;
        worldSize: number;
    }[];
    /** Invalidate tiles overlapping specific elements */
    invalidateElements: (ids: string[]) => void;
    /** Invalidate all tiles */
    invalidateAll: () => void;
    /** Number of cached tiles */
    cacheSize: number;
}

export function useTileRenderer(
    elements: CanvasElement[],
    viewport: ViewportState,
    stageWidth: number,
    stageHeight: number,
    options: UseTileRendererOptions = {},
): UseTileRendererReturn {
    const {
        enabled = false,
        maxCachedTiles = 200,
        drawFn,
        elementThreshold = 500,
        spatialQuery,
    } = options;

    // Create or recreate renderer when config changes
    const rendererRef = useRef<TileRenderer | null>(null);
    // Per-element signatures from the previous frame, for change detection.
    const prevSignaturesRef = useRef<Map<string, string>>(new Map());

    useEffect(() => {
        // Skip allocation entirely when disabled so the default Konva path
        // pays nothing for an unused tile engine.
        if (!enabled) return;
        rendererRef.current = new TileRenderer({
            maxCachedTiles,
            drawFn,
            spatialQuery,
        });
        return () => {
            rendererRef.current?.dispose();
            rendererRef.current = null;
        };
        // We intentionally only recreate when factory inputs change; spatialQuery
        // updates are forwarded inside the tiles memo / the effect below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, maxCachedTiles, drawFn]);

    // Forward spatial query updates without recreating the renderer.
    useEffect(() => {
        rendererRef.current?.setSpatialQuery(spatialQuery ?? null);
    }, [spatialQuery]);

    // Determine if tile rendering should be active
    const isActive = enabled && elements.length >= elementThreshold;

    // Compute visible tiles
    const tiles = useMemo(() => {
        const renderer = rendererRef.current;
        if (!isActive || !renderer || stageWidth === 0 || stageHeight === 0) {
            return [];
        }
        // Apply the latest spatial query BEFORE rasterising. Doing this here (in
        // the render-phase memo) rather than only in the effect below guarantees
        // tiles rasterised on the same commit the query/elements changed use the
        // current index — no one-frame-stale tile.
        renderer.setSpatialQuery(spatialQuery ?? null);
        // Diff against the previous frame and invalidate affected tiles BEFORE
        // fetching, so element edits/moves/adds/removes repaint immediately
        // instead of waiting for LRU eviction (stale cached bitmaps).
        const { changed, removed, next } = diffElements(prevSignaturesRef.current, elements);
        prevSignaturesRef.current = next;
        if (changed.length > 0 || removed.length > 0) {
            renderer.invalidateChangedElements(changed, removed);
        }
        const raw = renderer.getTiles(viewport, stageWidth, stageHeight, elements);
        return raw.map((t) => ({
            key: `${t.coord.zoom}:${t.coord.col}:${t.coord.row}`,
            bitmap: t.bitmap,
            worldX: t.worldX,
            worldY: t.worldY,
            worldSize: t.worldSize,
        }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isActive, viewport.x, viewport.y, viewport.scale, stageWidth, stageHeight, elements, spatialQuery]);

    const invalidateElementsCb = useCallback((ids: string[]) => {
        rendererRef.current?.invalidateElements(ids);
    }, []);

    const invalidateAllCb = useCallback(() => {
        rendererRef.current?.invalidateAll();
    }, []);

    return {
        isActive,
        tiles,
        invalidateElements: invalidateElementsCb,
        invalidateAll: invalidateAllCb,
        cacheSize: rendererRef.current?.cacheSize ?? 0,
    };
}
