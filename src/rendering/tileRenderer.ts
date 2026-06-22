/**
 * rendering/tileRenderer.ts — Tile-based rendering engine.
 *
 * Manages a grid of 256×256 pixel tiles covering the visible viewport.
 * Static (non-selected) elements are rasterised into OffscreenCanvas tiles
 * via a lightweight Canvas 2D draw. Changed tiles are invalidated and
 * re-drawn lazily.
 *
 * Architecture:
 *   - World space → tile grid mapping  (viewport → visible tile coords)
 *   - Spatial index → per-tile element lists  (which elements touch which tile)
 *   - OffscreenCanvas rasterisation per tile (draw elements → ImageBitmap)
 *   - TileCache stores bitmaps  (LRU eviction)
 *
 * Integration with FlowCanvas:
 *   - Static layer renders cached tile ImageBitmaps via Konva `Image` nodes
 *     instead of individual shape components.
 *   - Interactive (selected) elements bypass tiles and render via Konva.
 *
 * Performance:
 *   - Only visible tiles are rasterised.
 *   - Element changes invalidate only the tiles they overlap.
 *   - Zoom level is discretised to avoid re-drawing tiles on every scroll tick.
 */

import type { CanvasElement, ViewportState } from '@/types';
import { getElementAABB, type AABB } from '@/utils/performance';
import { TileCache, type TileCoord, tileKey } from './tileCache';

// ─── Constants ────────────────────────────────────────────────

/** Tile size in screen pixels */
export const TILE_SIZE = 256;

/**
 * Discrete zoom levels. We snap to the nearest level so tiles can be
 * reused across small zoom changes, avoiding constant re-rasterisation.
 */
const ZOOM_LEVELS = [
    0.1, 0.15, 0.2, 0.25, 0.33, 0.5, 0.67, 0.75,
    1, 1.25, 1.5, 2, 2.5, 3, 4, 5,
];

// ─── Helpers ──────────────────────────────────────────────────

/** Snap a continuous zoom value to the nearest discrete level. */
export function discreteZoom(scale: number): number {
    let best = ZOOM_LEVELS[0];
    let bestDist = Math.abs(scale - best);
    for (let i = 1; i < ZOOM_LEVELS.length; i++) {
        const d = Math.abs(scale - ZOOM_LEVELS[i]);
        if (d < bestDist) {
            best = ZOOM_LEVELS[i];
            bestDist = d;
        }
    }
    return best;
}

/** World-space size of one tile at a given zoom level. */
export function worldTileSize(zoom: number): number {
    return TILE_SIZE / zoom;
}

/** Compute the set of visible tile coordinates for a viewport. */
export function getVisibleTiles(
    viewport: ViewportState,
    stageWidth: number,
    stageHeight: number,
    padding = 1,
): { tiles: TileCoord[]; zoom: number } {
    const zoom = discreteZoom(viewport.scale);
    const wts = worldTileSize(zoom);

    // Visible world bounds
    const worldLeft = -viewport.x / viewport.scale;
    const worldTop = -viewport.y / viewport.scale;
    const worldRight = worldLeft + stageWidth / viewport.scale;
    const worldBottom = worldTop + stageHeight / viewport.scale;

    const colStart = Math.floor(worldLeft / wts) - padding;
    const colEnd = Math.ceil(worldRight / wts) + padding;
    const rowStart = Math.floor(worldTop / wts) - padding;
    const rowEnd = Math.ceil(worldBottom / wts) + padding;

    const tiles: TileCoord[] = [];
    for (let col = colStart; col <= colEnd; col++) {
        for (let row = rowStart; row <= rowEnd; row++) {
            tiles.push({ col, row, zoom });
        }
    }
    return { tiles, zoom };
}

/** Get the AABB for a tile coord in world space. */
export function tileBounds(coord: TileCoord): AABB {
    const wts = worldTileSize(coord.zoom);
    return {
        minX: coord.col * wts,
        minY: coord.row * wts,
        maxX: (coord.col + 1) * wts,
        maxY: (coord.row + 1) * wts,
    };
}

/** Check if two AABBs overlap. */
function aabbOverlap(a: AABB, b: AABB): boolean {
    return a.minX <= b.maxX && a.maxX >= b.minX &&
        a.minY <= b.maxY && a.maxY >= b.minY;
}

/** Find tiles that an element overlaps. */
export function getElementTiles(el: CanvasElement, zoom: number): TileCoord[] {
    const aabb = getElementAABB(el);
    const wts = worldTileSize(zoom);
    const tiles: TileCoord[] = [];

    const colStart = Math.floor(aabb.minX / wts);
    const colEnd = Math.floor(aabb.maxX / wts);
    const rowStart = Math.floor(aabb.minY / wts);
    const rowEnd = Math.floor(aabb.maxY / wts);

    for (let col = colStart; col <= colEnd; col++) {
        for (let row = rowStart; row <= rowEnd; row++) {
            tiles.push({ col, row, zoom });
        }
    }
    return tiles;
}

// ─── TileRenderer ─────────────────────────────────────────────

/**
 * Custom draw function provided by the consumer to rasterise elements
 * onto a 2D canvas context. The context is already translated/scaled
 * so that world coordinates map to pixel coordinates inside the tile.
 */
export type TileDrawFn = (
    ctx: OffscreenCanvasRenderingContext2D,
    elements: CanvasElement[],
    tileWorldBounds: AABB,
) => void;

/**
 * Optional spatial query function. If provided, TileRenderer uses it to
 * fetch only the elements overlapping a tile's AABB instead of scanning
 * the full element array per tile. Recommended for canvases with many
 * elements (drives per-tile rasterise cost from O(n) to O(log n) with
 * an R-tree).
 */
export type TileSpatialQuery = (aabb: AABB) => CanvasElement[];

export interface TileRendererOptions {
    /** Max tiles to cache (default 200) */
    maxCachedTiles?: number;
    /** Custom draw function; if not provided, a simple fallback is used */
    drawFn?: TileDrawFn;
    /**
     * Optional spatial query to avoid scanning all elements per tile.
     * If omitted, falls back to a linear scan of the elements passed to
     * `getTiles()`.
     */
    spatialQuery?: TileSpatialQuery;
}

export class TileRenderer {
    private _cache: TileCache;
    private _drawFn: TileDrawFn;
    private _spatialQuery: TileSpatialQuery | null;
    /** Element → tile keys mapping for incremental invalidation */
    private _elementTiles = new Map<string, string[]>();
    /**
     * Reverse of `_elementTiles`: tile key → element ids drawn into it.
     * Lets us prune `_elementTiles` in O(elements-in-tile) when a tile is
     * evicted, instead of scanning every element (and prevents the reverse
     * map from growing unbounded / going stale over long pan sessions).
     */
    private _tileElements = new Map<string, Set<string>>();
    /** Global generation counter — bumped on bulk changes */
    private _generation = 0;

    constructor(options: TileRendererOptions = {}) {
        this._cache = new TileCache(options.maxCachedTiles ?? 200);
        this._drawFn = options.drawFn ?? defaultDrawFn;
        this._spatialQuery = options.spatialQuery ?? null;
        // Keep the element→tile indexes in sync when tiles leave the cache.
        this._cache.setEvictionCallback((key) => this._onTileEvicted(key));
    }

    /** Update the spatial query at runtime (e.g. when a new R-tree is built). */
    setSpatialQuery(query: TileSpatialQuery | null): void {
        this._spatialQuery = query;
    }

    // ── Public API ────────────────────────────────────────────

    /**
     * Get tile bitmaps for the visible viewport region.
     * Missing tiles are rasterised on-the-fly; cached tiles are reused.
     *
     * @returns Array of `{ coord, bitmap }` entries for rendering.
     */
    getTiles(
        viewport: ViewportState,
        stageWidth: number,
        stageHeight: number,
        elements: CanvasElement[],
    ): { coord: TileCoord; bitmap: ImageBitmap; worldX: number; worldY: number; worldSize: number }[] {
        const { tiles, zoom } = getVisibleTiles(viewport, stageWidth, stageHeight);
        const result: { coord: TileCoord; bitmap: ImageBitmap; worldX: number; worldY: number; worldSize: number }[] = [];

        for (const coord of tiles) {
            let bitmap = this._cache.get(coord);
            if (!bitmap) {
                bitmap = this._rasterise(coord, elements);
                this._cache.set(coord, bitmap, this._generation);
            }
            const wts = worldTileSize(zoom);
            result.push({
                coord,
                bitmap,
                worldX: coord.col * wts,
                worldY: coord.row * wts,
                worldSize: wts,
            });
        }
        return result;
    }

    /**
     * Invalidate tiles affected by specific element IDs.
     * Call when elements are moved, restyled, or deleted.
     */
    invalidateElements(ids: string[]): void {
        const keysToInvalidate = new Set<string>();
        for (const id of ids) {
            const tileKeys = this._elementTiles.get(id);
            if (tileKeys) {
                for (const k of tileKeys) keysToInvalidate.add(k);
                this._elementTiles.delete(id);
            }
        }
        // Parse keys back to coords
        for (const key of keysToInvalidate) {
            const [z, c, r] = key.split(':').map(Number);
            this._cache.invalidate({ zoom: z, col: c, row: r });
        }
    }

    /**
     * Invalidate tiles affected by a frame-to-frame element diff so edits
     * repaint immediately rather than waiting for LRU eviction.
     *
     * - `changed` (added or visually modified elements): invalidates the tiles
     *   they *previously* occupied via the reverse index AND the tiles they
     *   *currently* overlap at every cached zoom level, so moves/resizes
     *   repaint both source and destination tiles.
     * - `removedIds` (deleted elements): invalidates their previously-occupied
     *   tiles via the reverse index.
     */
    invalidateChangedElements(changed: CanvasElement[], removedIds: string[] = []): void {
        if (changed.length === 0 && removedIds.length === 0) return;

        // Old positions (changed elements + deletions) via the reverse index.
        const oldIds: string[] = removedIds.length ? [...removedIds] : [];
        for (const el of changed) oldIds.push(el.id);
        this.invalidateElements(oldIds);

        if (changed.length === 0) return;

        // New positions: invalidate cached tiles overlapping the current bounds
        // of each changed/added element, across every zoom level in the cache.
        const zooms = this._cache.zoomLevels();
        if (zooms.length === 0) return;
        for (const zoom of zooms) {
            for (const el of changed) {
                for (const coord of getElementTiles(el, zoom)) {
                    this._cache.invalidate(coord);
                }
            }
        }
    }

    /** Invalidate all tiles (e.g. after undo or bulk import). */
    invalidateAll(): void {
        this._generation++;
        this._cache.clear();
        this._elementTiles.clear();
        this._tileElements.clear();
    }

    /** Free all resources */
    dispose(): void {
        this._cache.dispose();
        this._elementTiles.clear();
        this._tileElements.clear();
    }

    /** Number of cached tiles */
    get cacheSize(): number {
        return this._cache.size;
    }

    // ── Internal ──────────────────────────────────────────────

    /**
     * Eviction hook fired by {@link TileCache} when a tile is dropped.
     * Removes the tile key from the reverse `_elementTiles` index and clears
     * the forward `_tileElements` entry so neither map grows unbounded or
     * retains stale tile keys.
     */
    private _onTileEvicted(key: string): void {
        const ids = this._tileElements.get(key);
        if (!ids) return;
        for (const id of ids) {
            const tiles = this._elementTiles.get(id);
            if (!tiles) continue;
            const idx = tiles.indexOf(key);
            if (idx !== -1) tiles.splice(idx, 1);
            if (tiles.length === 0) this._elementTiles.delete(id);
        }
        this._tileElements.delete(key);
    }

    private _rasterise(coord: TileCoord, allElements: CanvasElement[]): ImageBitmap {
        const bounds = tileBounds(coord);
        const wts = worldTileSize(coord.zoom);
        const key = tileKey(coord);

        // Find elements overlapping this tile.
        // Prefer the spatial query (O(log n) with R-tree) when available;
        // otherwise fall back to the legacy linear scan.
        let tileElements: CanvasElement[];
        if (this._spatialQuery) {
            tileElements = this._spatialQuery(bounds);
        } else {
            tileElements = [];
            for (const el of allElements) {
                const elAABB = getElementAABB(el);
                if (aabbOverlap(elAABB, bounds)) tileElements.push(el);
            }
        }
        // Track element ↔ tile mapping (both directions) for incremental
        // invalidation. This tile is being rasterised fresh, so rebuild its
        // forward entry from scratch.
        const tileSet = new Set<string>();
        for (const el of tileElements) {
            const existing = this._elementTiles.get(el.id);
            if (existing) {
                if (!existing.includes(key)) existing.push(key);
            } else {
                this._elementTiles.set(el.id, [key]);
            }
            tileSet.add(el.id);
        }
        this._tileElements.set(key, tileSet);

        // Create OffscreenCanvas and draw
        const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
        const ctx = canvas.getContext('2d')!;

        // Transform: world → tile pixel space
        // world origin (bounds.minX, bounds.minY) → pixel (0,0)
        // world size wts → pixel size TILE_SIZE
        const pixelScale = TILE_SIZE / wts;
        ctx.scale(pixelScale, pixelScale);
        ctx.translate(-bounds.minX, -bounds.minY);

        // Draw elements using the provided draw function
        this._drawFn(ctx, tileElements, bounds);

        // Transfer to ImageBitmap (GPU-friendly)
        return canvas.transferToImageBitmap();
    }
}

// ─── Default draw function ────────────────────────────────────

/**
 * Simple fallback draw function. Draws basic shapes using Canvas 2D API.
 * For production use, consumers should provide a more detailed draw function
 * that matches the Konva rendering output.
 */
function defaultDrawFn(
    ctx: OffscreenCanvasRenderingContext2D,
    elements: CanvasElement[],
    _bounds: AABB,
): void {
    for (const el of elements) {
        ctx.save();

        // Apply rotation
        if (el.rotation) {
            const cx = el.x + el.width / 2;
            const cy = el.y + el.height / 2;
            ctx.translate(cx, cy);
            ctx.rotate((el.rotation * Math.PI) / 180);
            ctx.translate(-cx, -cy);
        }

        // Apply opacity
        ctx.globalAlpha = el.style?.opacity ?? 1;

        // Stroke / fill
        const strokeColor = el.style?.strokeColor ?? '#000000';
        const fillColor = el.style?.fillColor ?? 'transparent';
        const strokeWidth = el.style?.strokeWidth ?? 2;
        ctx.strokeStyle = strokeColor;
        ctx.fillStyle = fillColor;
        ctx.lineWidth = strokeWidth;

        switch (el.type) {
            case 'rectangle':
                ctx.beginPath();
                ctx.rect(el.x, el.y, el.width, el.height);
                if (fillColor !== 'transparent') ctx.fill();
                ctx.stroke();
                break;

            case 'ellipse':
                ctx.beginPath();
                ctx.ellipse(
                    el.x + el.width / 2,
                    el.y + el.height / 2,
                    el.width / 2,
                    el.height / 2,
                    0, 0, Math.PI * 2,
                );
                if (fillColor !== 'transparent') ctx.fill();
                ctx.stroke();
                break;

            case 'diamond': {
                const cx = el.x + el.width / 2;
                const cy = el.y + el.height / 2;
                ctx.beginPath();
                ctx.moveTo(cx, el.y);
                ctx.lineTo(el.x + el.width, cy);
                ctx.lineTo(cx, el.y + el.height);
                ctx.lineTo(el.x, cy);
                ctx.closePath();
                if (fillColor !== 'transparent') ctx.fill();
                ctx.stroke();
                break;
            }

            case 'line':
            case 'arrow': {
                const pts = (el as { points: number[] }).points;
                if (pts.length >= 4) {
                    ctx.beginPath();
                    ctx.moveTo(el.x + pts[0], el.y + pts[1]);
                    for (let i = 2; i < pts.length; i += 2) {
                        ctx.lineTo(el.x + pts[i], el.y + pts[i + 1]);
                    }
                    ctx.stroke();
                }
                break;
            }

            case 'freedraw': {
                const pts = (el as { points: number[] }).points;
                if (pts.length >= 4) {
                    ctx.beginPath();
                    ctx.moveTo(el.x + pts[0], el.y + pts[1]);
                    for (let i = 2; i < pts.length; i += 2) {
                        ctx.lineTo(el.x + pts[i], el.y + pts[i + 1]);
                    }
                    ctx.stroke();
                }
                break;
            }

            case 'text': {
                const textEl = el as { text: string; style?: { fontSize?: number; fontFamily?: string } };
                ctx.font = `${textEl.style?.fontSize ?? 16}px ${textEl.style?.fontFamily ?? 'sans-serif'}`;
                ctx.fillStyle = strokeColor;
                ctx.fillText(textEl.text, el.x, el.y + (textEl.style?.fontSize ?? 16));
                break;
            }

            case 'image':
                // Images require async loading — draw placeholder rect
                ctx.strokeStyle = '#ccc';
                ctx.setLineDash([4, 4]);
                ctx.strokeRect(el.x, el.y, el.width, el.height);
                break;
        }

        ctx.restore();
    }
}
