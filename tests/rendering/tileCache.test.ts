/**
 * tileCache LRU behaviour.
 * Verifies: insertion-order LRU (least-recently-GOT evicted first), that
 * access (`get`) and update (`set`) reorder to the tail, evicted/invalidated
 * bitmaps are freed, and the eviction callback fires with the right keys.
 */
import { describe, it, expect } from 'vitest';
import { TileCache, tileKey, type TileCoord } from '@/rendering/tileCache';

// ─── Helpers ──────────────────────────────────────────────────

/** Tile coord at zoom 1 in row 0, distinguished by column. */
const C = (col: number): TileCoord => ({ zoom: 1, col, row: 0 });
const K = (col: number): string => tileKey(C(col));

interface FakeBitmap {
    closed: boolean;
    close: () => void;
}

function makeBitmap(): ImageBitmap {
    const bmp: FakeBitmap = {
        closed: false,
        close() {
            bmp.closed = true;
        },
    };
    return bmp as unknown as ImageBitmap;
}

const isClosed = (b: ImageBitmap): boolean => (b as unknown as FakeBitmap).closed;

// ─── Tests ────────────────────────────────────────────────────

describe('TileCache LRU eviction', () => {
    it('evicts the least-recently-set tile when no access has occurred', () => {
        const cache = new TileCache(2);
        const evicted: string[] = [];
        cache.setEvictionCallback((k) => evicted.push(k));

        cache.set(C(0), makeBitmap());
        cache.set(C(1), makeBitmap());
        cache.set(C(2), makeBitmap()); // over capacity → evict head (C0)

        expect(evicted).toEqual([K(0)]);
        expect(cache.get(C(0))).toBeNull();
        expect(cache.get(C(1))).not.toBeNull();
        expect(cache.get(C(2))).not.toBeNull();
        expect(cache.size).toBe(2);
    });

    it('get() reorders, so the least-recently-GOT tile is evicted', () => {
        const cache = new TileCache(2);
        const evicted: string[] = [];
        cache.setEvictionCallback((k) => evicted.push(k));

        cache.set(C(0), makeBitmap());
        cache.set(C(1), makeBitmap());
        // Touch C0 → it becomes most-recently-used; C1 is now the LRU victim.
        expect(cache.get(C(0))).not.toBeNull();
        cache.set(C(2), makeBitmap());

        expect(evicted).toEqual([K(1)]);
        expect(cache.get(C(1))).toBeNull();
        expect(cache.get(C(0))).not.toBeNull();
    });

    it('set() on an existing key moves it to the tail and frees the old bitmap', () => {
        const cache = new TileCache(2);
        const evicted: string[] = [];
        cache.setEvictionCallback((k) => evicted.push(k));

        const oldBmp = makeBitmap();
        cache.set(C(0), oldBmp);
        cache.set(C(1), makeBitmap());
        cache.set(C(0), makeBitmap()); // re-set C0 → tail; old bitmap freed

        expect(isClosed(oldBmp)).toBe(true);
        cache.set(C(2), makeBitmap()); // C1 is now LRU

        expect(evicted).toEqual([K(1)]);
        expect(cache.get(C(0))).not.toBeNull();
        expect(cache.get(C(1))).toBeNull();
    });

    it('evicts multiple tiles in one set when far over capacity', () => {
        const cache = new TileCache(2);
        const evicted: string[] = [];
        cache.setEvictionCallback((k) => evicted.push(k));

        cache.set(C(0), makeBitmap());
        cache.set(C(1), makeBitmap());
        cache.set(C(2), makeBitmap());
        cache.set(C(3), makeBitmap());

        // Oldest-first eviction: C0 then C1.
        expect(evicted).toEqual([K(0), K(1)]);
        expect(cache.size).toBe(2);
    });
});

describe('TileCache eviction callback & cleanup', () => {
    it('fires the eviction callback and frees the bitmap on invalidate()', () => {
        const cache = new TileCache(10);
        const evicted: string[] = [];
        cache.setEvictionCallback((k) => evicted.push(k));

        const bmp = makeBitmap();
        cache.set(C(0), bmp);
        cache.invalidate(C(0));

        expect(evicted).toEqual([K(0)]);
        expect(isClosed(bmp)).toBe(true);
        expect(cache.size).toBe(0);
    });

    it('does not fire the callback when invalidating a missing tile', () => {
        const cache = new TileCache(10);
        const evicted: string[] = [];
        cache.setEvictionCallback((k) => evicted.push(k));

        cache.invalidate(C(99));
        expect(evicted).toEqual([]);
    });

    it('frees evicted bitmaps', () => {
        const cache = new TileCache(1);
        const first = makeBitmap();
        cache.set(C(0), first);
        cache.set(C(1), makeBitmap()); // evicts C0

        expect(isClosed(first)).toBe(true);
    });
});

describe('TileCache zoomLevels', () => {
    it('reports the distinct discrete zoom levels present', () => {
        const cache = new TileCache(10);
        cache.set({ zoom: 1, col: 0, row: 0 }, makeBitmap());
        cache.set({ zoom: 1, col: 1, row: 0 }, makeBitmap());
        cache.set({ zoom: 2, col: 0, row: 0 }, makeBitmap());

        expect(cache.zoomLevels().sort((a, b) => a - b)).toEqual([1, 2]);
    });

    it('is empty for an empty cache', () => {
        expect(new TileCache().zoomLevels()).toEqual([]);
    });
});
