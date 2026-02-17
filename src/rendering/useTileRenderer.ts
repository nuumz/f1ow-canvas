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
import { TileRenderer, type TileDrawFn } from './tileRenderer';

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
    } = options;

    // Create or recreate renderer when config changes
    const rendererRef = useRef<TileRenderer | null>(null);

    useEffect(() => {
        rendererRef.current = new TileRenderer({
            maxCachedTiles,
            drawFn,
        });
        return () => {
            rendererRef.current?.dispose();
            rendererRef.current = null;
        };
    }, [maxCachedTiles, drawFn]);

    // Determine if tile rendering should be active
    const isActive = enabled && elements.length >= elementThreshold;

    // Compute visible tiles
    const tiles = useMemo(() => {
        if (!isActive || !rendererRef.current || stageWidth === 0 || stageHeight === 0) {
            return [];
        }
        const raw = rendererRef.current.getTiles(viewport, stageWidth, stageHeight, elements);
        return raw.map((t) => ({
            key: `${t.coord.zoom}:${t.coord.col}:${t.coord.row}`,
            bitmap: t.bitmap,
            worldX: t.worldX,
            worldY: t.worldY,
            worldSize: t.worldSize,
        }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isActive, viewport.x, viewport.y, viewport.scale, stageWidth, stageHeight, elements]);

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
