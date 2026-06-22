/**
 * rendering/tileCache.ts — LRU cache for rasterised tile bitmaps.
 *
 * Each tile is a 256×256 OffscreenCanvas bitmap capturing a region of world
 * space at a given discrete zoom level. Tiles are keyed by "zoom:col:row".
 *
 * Eviction: LRU — least-recently-accessed tiles are dropped when count exceeds
 * maxTiles. Recency is tracked via the Map's own insertion order: `get()` and
 * `set()` move the touched key to the tail, so the head is always the LRU
 * victim. Eviction is therefore O(k) in the number of tiles removed rather than
 * O(n log n) per insert.
 * Memory budget: ~200 tiles × 256 × 256 × 4 bytes ≈ 50 MB.
 *
 * Owners (e.g. TileRenderer) can register an eviction callback to keep any
 * external indexes (reverse element→tile maps) in sync when a tile is dropped.
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
    /** Generation counter — incremented when the tile's contents change */
    generation: number;
}

/** Called with a tile key when that tile is dropped from the cache. */
export type TileEvictionCallback = (key: string) => void;

/** Serialise a TileCoord to a string key */
export function tileKey(coord: TileCoord): string {
    return `${coord.zoom}:${coord.col}:${coord.row}`;
}

export class TileCache {
    private _cache = new Map<string, TileEntry>();
    private _maxTiles: number;
    private _onEvict: TileEvictionCallback | null = null;

    constructor(maxTiles = 200) {
        this._maxTiles = maxTiles;
    }

    /**
     * Register (or clear) the eviction callback. Fired with the tile key
     * whenever a tile leaves the cache via LRU eviction or `invalidate()`,
     * so owners can prune external reverse indexes. Not fired by `clear()`
     * or `dispose()` — owners are expected to reset their own state there.
     */
    setEvictionCallback(cb: TileEvictionCallback | null): void {
        this._onEvict = cb;
    }

    /** Retrieve a tile bitmap. Returns `null` on miss. */
    get(coord: TileCoord): ImageBitmap | null {
        const key = tileKey(coord);
        const entry = this._cache.get(key);
        if (!entry) return null;
        // Move to the tail to mark it most-recently-used (LRU ordering).
        this._cache.delete(key);
        this._cache.set(key, entry);
        return entry.bitmap;
    }

    /** Store a tile bitmap, evicting LRU entries if over capacity. */
    set(coord: TileCoord, bitmap: ImageBitmap, generation = 0): void {
        const key = tileKey(coord);
        const existing = this._cache.get(key);
        if (existing) {
            existing.bitmap.close(); // free GPU memory
            // Delete so the re-insert below moves the key to the tail.
            this._cache.delete(key);
        }
        this._cache.set(key, { key, bitmap, generation });
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
            this._onEvict?.(key);
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

    /** Distinct discrete zoom levels currently represented in the cache. */
    zoomLevels(): number[] {
        const zooms = new Set<number>();
        for (const key of this._cache.keys()) {
            const sep = key.indexOf(':');
            zooms.add(Number(key.slice(0, sep)));
        }
        return [...zooms];
    }

    /** Dispose all resources */
    dispose(): void {
        this.clear();
    }

    // ── LRU eviction ─────────────────────────────────────────
    private _evict(): void {
        // The Map iterates in insertion order; `get`/`set` re-insert the
        // touched key at the tail, so the head is always the least-recently
        // used tile. Drop from the head until back within capacity — O(k).
        while (this._cache.size > this._maxTiles) {
            const oldest = this._cache.keys().next();
            if (oldest.done) break;
            const key = oldest.value;
            const entry = this._cache.get(key);
            entry?.bitmap.close();
            this._cache.delete(key);
            this._onEvict?.(key);
        }
    }
}
