import { describe, expect, it } from 'vitest';

import type { CanvasElement } from '@/types';
import type { AtlasRegion } from '@/webgl/textureAtlas';
import { FLOATS_PER_INSTANCE, needsRaster, writeInstanceData } from '@/webgl/WebGLHybridRenderer';

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

function makeEl(
    id: string,
    over: Partial<Omit<CanvasElement, 'style'>> & { style?: Partial<typeof baseStyle> } = {},
): CanvasElement {
    const { style, ...rest } = over;
    return {
        id,
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 256,
        height: 256,
        rotation: 0,
        style: { ...baseStyle, ...style },
        isLocked: false,
        isVisible: true,
        boundElements: null,
        version: 0,
        cornerRadius: 0,
        ...rest,
    } as CanvasElement;
}

const region: AtlasRegion = {
    atlasIndex: 0,
    u: 0.1,
    v: 0.2,
    uWidth: 0.3,
    vHeight: 0.4,
    pixelWidth: 256,
    pixelHeight: 256,
};

describe('needsRaster (content signature)', () => {
    it('rasters a brand-new element (no atlas region yet)', () => {
        expect(needsRaster(makeEl('a', { version: 0 }), undefined, false)).toBe(true);
    });

    it('does NOT raster when version is unchanged and a region exists', () => {
        // This is the no-bump-without-a-content-change case.
        expect(needsRaster(makeEl('a', { version: 7 }), 7, true)).toBe(false);
    });

    it('rasters when the element version was bumped', () => {
        expect(needsRaster(makeEl('a', { version: 8 }), 7, true)).toBe(true);
    });

    it('rasters when the region was evicted even if version is unchanged', () => {
        expect(needsRaster(makeEl('a', { version: 7 }), 7, false)).toBe(true);
    });
});

describe('writeInstanceData', () => {
    it('packs per-instance floats and skips elements without a region', () => {
        const els = [
            makeEl('a', { x: 10, y: 20, width: 30, height: 40, rotation: 90, style: { opacity: 0.5 } }),
            makeEl('b'), // no region → skipped
            makeEl('c'),
        ];
        const regions = new Map<string, AtlasRegion>([
            ['a', region],
            ['c', region],
        ]);
        const target = new Float32Array(els.length * FLOATS_PER_INSTANCE);

        const count = writeInstanceData(els, (id) => regions.get(id) ?? null, target);

        expect(count).toBe(2);

        // First packed instance is element 'a'.
        expect(target[0]).toBe(10); // x
        expect(target[1]).toBe(20); // y
        expect(target[2]).toBe(30); // width
        expect(target[3]).toBe(40); // height
        expect(target[4]).toBeCloseTo(region.u);
        expect(target[5]).toBeCloseTo(region.v);
        expect(target[6]).toBeCloseTo(region.uWidth);
        expect(target[7]).toBeCloseTo(region.vHeight);
        expect(target[8]).toBeCloseTo(0.5); // opacity
        expect(target[9]).toBeCloseTo(Math.PI / 2); // 90° → radians

        // Second packed instance is element 'c' (b was skipped), at slot 1.
        expect(target[FLOATS_PER_INSTANCE + 4]).toBeCloseTo(region.u);
        expect(target[FLOATS_PER_INSTANCE + 8]).toBeCloseTo(1); // default opacity
    });

    it('returns 0 and writes nothing when no element has a region', () => {
        const target = new Float32Array(2 * FLOATS_PER_INSTANCE);
        const count = writeInstanceData([makeEl('a'), makeEl('b')], () => null, target);
        expect(count).toBe(0);
        expect(target.every((v) => v === 0)).toBe(true);
    });
});
