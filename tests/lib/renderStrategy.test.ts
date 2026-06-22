/**
 * resolveRenderStrategy — the static-layer renderer gating / fallback decision.
 *
 * These tests pin the contract that protects the default experience:
 *   - 'konva' (the default) ALWAYS uses the Konva static layer.
 *   - accelerated strategies activate only when their engine is available AND
 *     the element count meets the threshold; otherwise they fall back to Konva.
 *
 * Pure decision only — no GL / pixel work (happy-dom has no WebGL).
 */
import { describe, it, expect } from 'vitest';
import {
    resolveRenderStrategy,
    DEFAULT_RENDERER_ELEMENT_THRESHOLD,
    type RenderStrategyDecisionInput,
} from '@/lib/FlowCanvasProps';

/** Defaults that, on their own, WOULD activate an accelerated path. */
function input(overrides: Partial<RenderStrategyDecisionInput> = {}): RenderStrategyDecisionInput {
    return {
        renderer: undefined,
        staticElementCount: 5000,
        elementThreshold: 1000,
        webglAvailable: true,
        tileActive: true,
        ...overrides,
    };
}

describe('resolveRenderStrategy — default Konva path', () => {
    it('uses the Konva static layer when renderer is undefined (the default)', () => {
        const d = resolveRenderStrategy(input({ renderer: undefined }));
        expect(d.strategy).toBe('konva');
        expect(d.useAccelerated).toBe(false);
        expect(d.useKonvaStatic).toBe(true);
    });

    it('uses the Konva static layer for explicit "konva" regardless of counts/engines', () => {
        const d = resolveRenderStrategy(
            input({ renderer: 'konva', staticElementCount: 1_000_000, webglAvailable: true, tileActive: true }),
        );
        expect(d.useAccelerated).toBe(false);
        expect(d.useKonvaStatic).toBe(true);
    });
});

describe('resolveRenderStrategy — webgl-hybrid gating', () => {
    it('activates when WebGL is available and the threshold is met', () => {
        const d = resolveRenderStrategy(input({ renderer: 'webgl-hybrid' }));
        expect(d.useAccelerated).toBe(true);
        expect(d.useKonvaStatic).toBe(false);
    });

    it('falls back to Konva below the element threshold', () => {
        const d = resolveRenderStrategy(
            input({ renderer: 'webgl-hybrid', staticElementCount: 999, elementThreshold: 1000 }),
        );
        expect(d.meetsThreshold).toBe(false);
        expect(d.useAccelerated).toBe(false);
        expect(d.useKonvaStatic).toBe(true);
    });

    it('falls back to Konva when WebGL2 is unavailable (e.g. no context)', () => {
        const d = resolveRenderStrategy(input({ renderer: 'webgl-hybrid', webglAvailable: false }));
        expect(d.useAccelerated).toBe(false);
        expect(d.useKonvaStatic).toBe(true);
    });

    it('ignores tileActive for the webgl strategy', () => {
        const d = resolveRenderStrategy(
            input({ renderer: 'webgl-hybrid', webglAvailable: false, tileActive: true }),
        );
        expect(d.useAccelerated).toBe(false);
    });
});

describe('resolveRenderStrategy — tiled gating', () => {
    it('activates when the tile engine is active and the threshold is met', () => {
        const d = resolveRenderStrategy(input({ renderer: 'tiled' }));
        expect(d.useAccelerated).toBe(true);
        expect(d.useKonvaStatic).toBe(false);
    });

    it('falls back to Konva when the tile engine reports inactive', () => {
        const d = resolveRenderStrategy(input({ renderer: 'tiled', tileActive: false }));
        expect(d.useAccelerated).toBe(false);
        expect(d.useKonvaStatic).toBe(true);
    });

    it('falls back to Konva below the element threshold even if tileActive', () => {
        const d = resolveRenderStrategy(
            input({ renderer: 'tiled', tileActive: true, staticElementCount: 10, elementThreshold: 1000 }),
        );
        expect(d.useAccelerated).toBe(false);
        expect(d.useKonvaStatic).toBe(true);
    });

    it('ignores webglAvailable for the tiled strategy', () => {
        const d = resolveRenderStrategy(input({ renderer: 'tiled', webglAvailable: false }));
        expect(d.useAccelerated).toBe(true);
    });
});

describe('resolveRenderStrategy — threshold boundary & invariants', () => {
    it('treats count === threshold as meeting the threshold', () => {
        const d = resolveRenderStrategy(
            input({ renderer: 'webgl-hybrid', staticElementCount: 1000, elementThreshold: 1000 }),
        );
        expect(d.meetsThreshold).toBe(true);
        expect(d.useAccelerated).toBe(true);
    });

    it('useAccelerated and useKonvaStatic are always exact inverses', () => {
        const cases: Partial<RenderStrategyDecisionInput>[] = [
            { renderer: undefined },
            { renderer: 'konva' },
            { renderer: 'webgl-hybrid', webglAvailable: false },
            { renderer: 'webgl-hybrid', staticElementCount: 0 },
            { renderer: 'webgl-hybrid' },
            { renderer: 'tiled', tileActive: false },
            { renderer: 'tiled', staticElementCount: 0 },
            { renderer: 'tiled' },
        ];
        for (const c of cases) {
            const d = resolveRenderStrategy(input(c));
            expect(d.useKonvaStatic).toBe(!d.useAccelerated);
        }
    });

    it('exposes a sane default threshold constant', () => {
        expect(DEFAULT_RENDERER_ELEMENT_THRESHOLD).toBe(1000);
    });
});
