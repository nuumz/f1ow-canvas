import { describe, expect, it } from 'vitest';

import type { CanvasElement } from '@/types';

// ── happy-dom has no OffscreenCanvas; stub one with a no-op 2D context. ──
// The atlas's reclamation/packing/dirty logic never inspects pixels, so a
// proxy whose every method is a no-op (and which accepts any property set)
// is enough to exercise it headlessly. Installed before importing the atlas.
class FakeOffscreenCanvas {
    width: number;
    height: number;
    constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
    }
    getContext(): unknown {
        return new Proxy(
            {},
            {
                get: () => () => undefined,
                set: () => true,
            },
        );
    }
}
(globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = FakeOffscreenCanvas;

// Import AFTER the stub is installed.
const { TextureAtlas } = await import('@/webgl/textureAtlas');

const baseStyle = {
    strokeColor: '#1e1e1e',
    fillColor: 'transparent',
    strokeWidth: 2,
    opacity: 1,
    strokeStyle: 'solid' as const,
    roughness: 0,
    fontSize: 16,
    fontFamily: 'sans-serif',
};

function makeEl(id: string, over: Partial<CanvasElement> = {}): CanvasElement {
    return {
        id,
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 256,
        height: 256,
        rotation: 0,
        style: { ...baseStyle },
        isLocked: false,
        isVisible: true,
        boundElements: null,
        version: 0,
        cornerRadius: 0,
        ...over,
    } as CanvasElement;
}

describe('TextureAtlas — packing & dirty tracking', () => {
    it('packs a new element and reports an incremental dirty sub-rect', () => {
        const atlas = new TextureAtlas();
        const region = atlas.addOrUpdate(makeEl('a'), 1);

        expect(region).not.toBeNull();
        expect(atlas.getRegion('a')).not.toBeNull();
        expect(atlas.size).toBe(1);
        expect(atlas.isDirty).toBe(true);

        const dirty = atlas.consumeDirty();
        expect(dirty).not.toBeNull();
        expect(dirty!.full).toBe(false);
        expect(dirty!.width).toBeGreaterThan(0);
        expect(dirty!.height).toBeGreaterThan(0);
        // Dirty state is cleared after consumption.
        expect(atlas.isDirty).toBe(false);
        expect(atlas.consumeDirty()).toBeNull();
    });

    it('does not re-pack when the generation is unchanged (no content change)', () => {
        const atlas = new TextureAtlas();
        const first = atlas.addOrUpdate(makeEl('a'), 5);
        atlas.consumeDirty();

        const second = atlas.addOrUpdate(makeEl('a'), 5); // same generation
        expect(second).toBe(first); // same region object → no re-raster
        expect(atlas.size).toBe(1);
        expect(atlas.fragmentation).toBe(0); // nothing freed
        expect(atlas.isDirty).toBe(false); // no upload needed
    });

    it('re-rasters into a fresh slot when generation advances (old slot freed)', () => {
        const atlas = new TextureAtlas();
        atlas.addOrUpdate(makeEl('a'), 1);
        atlas.consumeDirty();

        const updated = atlas.addOrUpdate(makeEl('a', { width: 300, height: 100 }), 2);
        expect(updated).not.toBeNull();
        expect(atlas.size).toBe(1);
        expect(atlas.fragmentation).toBeGreaterThan(0); // the old slot is dead space
        expect(atlas.isDirty).toBe(true);
    });
});

describe('TextureAtlas — space reclamation (never strands an element)', () => {
    it('survives heavy single-element edit churn without overflowing', () => {
        const atlas = new TextureAtlas();
        // Each edit packs into a fresh slot and frees the old one. With a
        // 4096² atlas and ~256² slots this overflows after ~225 edits unless
        // the freed space is reclaimed.
        for (let gen = 1; gen <= 400; gen++) {
            const region = atlas.addOrUpdate(makeEl('a', { version: gen }), gen);
            expect(region).not.toBeNull(); // never stranded
        }
        expect(atlas.size).toBe(1);
        expect(atlas.getRegion('a')).not.toBeNull();
    });

    it('keeps every live element packed under many-element churn', () => {
        const atlas = new TextureAtlas();
        const ids = Array.from({ length: 80 }, (_, i) => `e${i}`);
        let gen = 0;

        // Initial population.
        for (const id of ids) {
            gen++;
            expect(atlas.addOrUpdate(makeEl(id, { version: gen }), gen)).not.toBeNull();
        }

        // Repeatedly edit every element. Total freed area far exceeds the
        // atlas, forcing multiple compactions.
        for (let round = 0; round < 5; round++) {
            for (const id of ids) {
                gen++;
                const region = atlas.addOrUpdate(makeEl(id, { version: gen }), gen);
                expect(region).not.toBeNull();
            }
        }

        expect(atlas.size).toBe(80);
        for (const id of ids) {
            expect(atlas.getRegion(id)).not.toBeNull();
        }
    });

    it('reclaims removed elements and allows re-adding', () => {
        const atlas = new TextureAtlas();
        atlas.addOrUpdate(makeEl('a'), 1);
        expect(atlas.size).toBe(1);

        atlas.remove('a');
        expect(atlas.getRegion('a')).toBeNull();
        expect(atlas.size).toBe(0);
        expect(atlas.fragmentation).toBeGreaterThan(0); // space marked reclaimable

        const region = atlas.addOrUpdate(makeEl('a'), 2);
        expect(region).not.toBeNull();
        expect(atlas.size).toBe(1);
    });

    it('rebuild compacts to live entries and forces a full upload', () => {
        const atlas = new TextureAtlas();
        const live = Array.from({ length: 30 }, (_, i) => makeEl(`k${i}`));
        // Pre-fragment the atlas with churn, then rebuild from the live set.
        for (let gen = 1; gen <= 200; gen++) {
            atlas.addOrUpdate(makeEl('churn', { version: gen }), gen);
        }
        atlas.consumeDirty();

        atlas.rebuild(live);

        expect(atlas.size).toBe(30);
        for (const el of live) {
            expect(atlas.getRegion(el.id)).not.toBeNull(); // pack succeeds post-rebuild
        }
        expect(atlas.getRegion('churn')).toBeNull();

        const dirty = atlas.consumeDirty();
        expect(dirty).not.toBeNull();
        expect(dirty!.full).toBe(true); // whole atlas changed → realloc upload
    });
});
