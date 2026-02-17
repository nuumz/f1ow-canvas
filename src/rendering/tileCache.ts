/**
 * rendering/tileCache.ts — LRU cache for rasterised tile bitmaps.
 *
 * Each tile is a 256×256 OffscreenCanvas bitmap capturing a region of world
 * space at a given discrete zoom level. Tiles are keyed by "zoom:col:row".
 *
 * Eviction: LRU — oldest-accessed tiles are dropped when count exceeds maxTiles.
 * Memory budget: ~200 tiles × 256 × 256 × 4 bytes ≈ 50 MB.
 */

/** Coordinates identifying a tile in the grid */
export interface TileCoord {
    col: number;
    row: number;
    zoom: number;
}

/** Internal cache entry */
interface TileEntry {
    key: string;
    bitmap: ImageBitmap;
    /** Monotonic counter for LRU ordering */
    accessOrder: number;
    /** Generation counter — incremented when the tile's contents change */
    generation: number;
}

/** Serialise a TileCoord to a string key */
export function tileKey(coord: TileCoord): string {
    return `${coord.zoom}:${coord.col}:${coord.row}`;
}

export class TileCache {
    private _cache = new Map<string, TileEntry>();
    private _accessCounter = 0;
    private _maxTiles: number;

    constructor(maxTiles = 200) {
        this._maxTiles = maxTiles;
    }

    /** Retrieve a tile bitmap. Returns `null` on miss. */
    get(coord: TileCoord): ImageBitmap | null {
        const entry = this._cache.get(tileKey(coord));
        if (!entry) return null;
        entry.accessOrder = ++this._accessCounter;
        return entry.bitmap;
    }

    /** Store a tile bitmap, evicting LRU entries if over capacity. */
    set(coord: TileCoord, bitmap: ImageBitmap, generation = 0): void {
        const key = tileKey(coord);
        const existing = this._cache.get(key);
        if (existing) {
            existing.bitmap.close(); // free GPU memory
        }
        this._cache.set(key, {
            key,
            bitmap,
            accessOrder: ++this._accessCounter,
            generation,
        });
        this._evict();
    }

    /** Check whether tile exists and is at or above the given generation. */
    isFresh(coord: TileCoord, generation: number): boolean {
        const entry = this._cache.get(tileKey(coord));
        return entry != null && entry.generation >= generation;
    }

    /** Invalidate a specific tile (e.g. when an element inside it changes). */
    invalidate(coord: TileCoord): void {
        const key = tileKey(coord);
        const entry = this._cache.get(key);
        if (entry) {
            entry.bitmap.close();
            this._cache.delete(key);
        }
    }

    /** Invalidate all tiles (e.g. after a bulk edit). */
    clear(): void {
        for (const entry of this._cache.values()) {
            entry.bitmap.close();
        }
        this._cache.clear();
    }

    /** Number of tiles currently cached */
    get size(): number {
        return this._cache.size;
    }

    /** Dispose all resources */
    dispose(): void {
        this.clear();
    }

    // ── LRU eviction ─────────────────────────────────────────
    private _evict(): void {
        if (this._cache.size <= this._maxTiles) return;

        // Sort entries by accessOrder and evict oldest
        const entries = Array.from(this._cache.values())
            .sort((a, b) => a.accessOrder - b.accessOrder);

        const toEvict = entries.length - this._maxTiles;
        for (let i = 0; i < toEvict; i++) {
            entries[i].bitmap.close();
            this._cache.delete(entries[i].key);
        }
    }
}
