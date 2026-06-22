/**
 * TileRenderer correctness:
 *   - element-change invalidation re-rasterises exactly the affected tiles
 *     (source + destination of a move) and leaves unrelated tiles cached;
 *   - the element↔tile indexes are pruned on LRU eviction so they neither
 *     grow unbounded nor retain stale tile keys over a long pan session.
 *
 * OffscreenCanvas / ImageBitmap don't exist in the test env, so we stub the
 * minimal surface TileRenderer touches.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TileRenderer, type TileDrawFn } from '@/rendering/tileRenderer';
import { diffElements } from '@/rendering/useTileRenderer';
import type { AABB } from '@/utils/performance';
import type { CanvasElement, RectangleElement, ViewportState } from '@/types';

// ─── OffscreenCanvas / ImageBitmap stubs ──────────────────────

class FakeImageBitmap {
    closed = false;
    close(): void {
        this.closed = true;
    }
}

class FakeOffscreenCanvas {
    constructor(public width: number, public height: number) {}
    getContext(): unknown {
        // _rasterise only uses scale()/translate(); the (no-op) draw fns we
        // pass in tests never touch the rest of the 2D API.
        return { scale() {}, translate() {} };
    }
    transferToImageBitmap(): FakeImageBitmap {
        return new FakeImageBitmap();
    }
}

let origOffscreen: unknown;
let origBitmap: unknown;

beforeAll(() => {
    origOffscreen = (globalThis as Record<string, unknown>).OffscreenCanvas;
    origBitmap = (globalThis as Record<string, unknown>).ImageBitmap;
    (globalThis as Record<string, unknown>).OffscreenCanvas = FakeOffscreenCanvas;
    (globalThis as Record<string, unknown>).ImageBitmap = FakeImageBitmap;
});

afterAll(() => {
    (globalThis as Record<string, unknown>).OffscreenCanvas = origOffscreen;
    (globalThis as Record<string, unknown>).ImageBitmap = origBitmap;
});

// ─── Factories ────────────────────────────────────────────────

function rect(id: string, x: number, y: number, overrides: Partial<RectangleElement> = {}): RectangleElement {
    return {
        id,
        type: 'rectangle',
        x,
        y,
        width: 50,
        height: 50,
        rotation: 0,
        cornerRadius: 0,
        version: 0,
        style: {
            strokeColor: '#000',
            fillColor: '#fff',
            strokeWidth: 2,
            opacity: 1,
            strokeStyle: 'solid',
            roughness: 0,
            fontSize: 16,
            fontFamily: 'Arial',
        },
        isLocked: false,
        isVisible: true,
        boundElements: null,
        ...overrides,
    };
}

// At zoom 1, worldTileSize === TILE_SIZE (256). Derive the tile key a draw
// call rasterised from its world-space bounds origin.
const tileKeyForBounds = (b: AABB): string => `1:${Math.round(b.minX / 256)}:${Math.round(b.minY / 256)}`;

const VP: ViewportState = { x: 0, y: 0, scale: 1 };

// ─── Tests ────────────────────────────────────────────────────

describe('TileRenderer element-change invalidation', () => {
    it('re-rasterises the source and destination tiles of a moved element, but not unrelated tiles', () => {
        const drawn: string[] = [];
        const drawFn: TileDrawFn = (_ctx, _els, bounds) => {
            drawn.push(tileKeyForBounds(bounds));
        };
        const renderer = new TileRenderer({ drawFn, maxCachedTiles: 1000 });

        // A in tile (0,0); B in tile (2,2). Both inside a 1024×1024 viewport.
        const a = rect('A', 10, 10);
        const b = rect('B', 600, 600);
        const frame1 = [a, b];

        const base = diffElements(new Map(), frame1);
        renderer.invalidateChangedElements(base.changed, base.removed); // cache empty → no-op
        renderer.getTiles(VP, 1024, 1024, frame1); // full rasterise

        // Move A from (10,10) → (700,10): source tile (0,0), dest tile (2,0).
        const movedA = rect('A', 700, 10, { version: 1 });
        const frame2 = [movedA, b];
        const d2 = diffElements(base.next, frame2);

        expect(d2.changed.map((e) => e.id)).toEqual(['A']);
        expect(d2.removed).toEqual([]);

        drawn.length = 0; // only capture re-rasterises triggered by the move
        renderer.invalidateChangedElements(d2.changed, d2.removed);
        renderer.getTiles(VP, 1024, 1024, frame2);

        expect(drawn).toContain('1:0:0'); // source repainted (A removed)
        expect(drawn).toContain('1:2:0'); // destination repainted (A added)
        expect(drawn).not.toContain('1:2:2'); // B's tile untouched (cache hit)
    });

    it('repaints the tile a deleted element occupied', () => {
        const drawn: string[] = [];
        const drawFn: TileDrawFn = (_ctx, _els, bounds) => {
            drawn.push(tileKeyForBounds(bounds));
        };
        const renderer = new TileRenderer({ drawFn, maxCachedTiles: 1000 });

        const a = rect('A', 10, 10);
        const b = rect('B', 600, 600);
        const base = diffElements(new Map(), [a, b]);
        renderer.getTiles(VP, 1024, 1024, [a, b]);

        const frame2 = [b];
        const d2 = diffElements(base.next, frame2);
        expect(d2.removed).toEqual(['A']);

        drawn.length = 0;
        renderer.invalidateChangedElements(d2.changed, d2.removed);
        renderer.getTiles(VP, 1024, 1024, frame2);

        expect(drawn).toContain('1:0:0'); // A's old tile repainted
        expect(drawn).not.toContain('1:2:2'); // B untouched
    });
});

describe('TileRenderer index pruning under eviction', () => {
    it('keeps element↔tile indexes bounded and free of stale tile keys after a long pan', () => {
        const maxCachedTiles = 12;
        const renderer = new TileRenderer({ drawFn: () => {}, maxCachedTiles });

        // 20 elements, one per column-tile at zoom 1 (x = i*256 + 10).
        const elements: CanvasElement[] = [];
        for (let i = 0; i < 20; i++) elements.push(rect(`e${i}`, i * 256 + 10, 10));

        // Pan across all 20 element-tiles. Each step rasterises a fresh band of
        // tiles, evicting old ones (cache holds only `maxCachedTiles`).
        for (let i = 0; i < 20; i++) {
            const vp: ViewportState = { x: -(i * 256), y: 0, scale: 1 };
            renderer.getTiles(vp, 200, 200, elements);
        }

        const elementTiles = (renderer as unknown as { _elementTiles: Map<string, string[]> })._elementTiles;
        const tileElements = (renderer as unknown as { _tileElements: Map<string, Set<string>> })._tileElements;

        // Eviction happened and stayed within budget.
        expect(renderer.cacheSize).toBeLessThanOrEqual(maxCachedTiles);

        // Forward index tracks exactly the live tiles — no leak.
        expect(tileElements.size).toBe(renderer.cacheSize);

        // Reverse index is bounded (would be ~20 without pruning).
        expect(elementTiles.size).toBeLessThanOrEqual(renderer.cacheSize);

        // No stale tile keys: every key the reverse index references is a live
        // tile, and no element maps to an empty list.
        for (const [, keys] of elementTiles) {
            expect(keys.length).toBeGreaterThan(0);
            for (const k of keys) {
                expect(tileElements.has(k)).toBe(true);
            }
        }
    });

    it('prunes the reverse index when an element is invalidated', () => {
        const renderer = new TileRenderer({ drawFn: () => {}, maxCachedTiles: 1000 });
        const a = rect('A', 10, 10);
        renderer.getTiles(VP, 512, 512, [a]);

        const elementTiles = (renderer as unknown as { _elementTiles: Map<string, string[]> })._elementTiles;
        expect(elementTiles.has('A')).toBe(true);

        renderer.invalidateElements(['A']);
        expect(elementTiles.has('A')).toBe(false);
    });
});
