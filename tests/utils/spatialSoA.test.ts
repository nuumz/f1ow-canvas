/**
 * spatialSoA.test.ts — correctness of the Structure-of-Arrays spatial
 * index that backs the live viewport-culling path (`useSpatialIndex`).
 *
 * The SoA scan is asserted against an INDEPENDENT brute-force AABB-overlap
 * oracle over many randomized layouts, including lines/arrows whose points
 * do NOT start at the local origin (locks in the AABB seed fix), plus
 * per-instance isolation and incremental-update behaviour.
 */
import { describe, expect, it } from 'vitest';

import { SpatialSoA } from '@/utils/spatialSoA';
import { getVisibleBounds } from '@/utils/performance';
import type { CanvasElement, ViewportState } from '@/types';

// ─── Deterministic PRNG (mulberry32) so any failure is reproducible ──
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ─── Independent brute-force oracle ─────────────────────────────────
// Computes the true AABB with min/max SEEDED FROM THE FIRST POINT — this
// is the correct behaviour the SoA must match. (Seeding from 0 would force
// the box to always swallow the local origin.)
interface Box { minX: number; minY: number; maxX: number; maxY: number }

function refAABB(el: CanvasElement): Box {
    if (el.type === 'line' || el.type === 'arrow') {
        const pts = (el as { points: number[] }).points;
        if (pts.length < 2) return { minX: el.x, minY: el.y, maxX: el.x, maxY: el.y };
        let minX = pts[0], maxX = pts[0], minY = pts[1], maxY = pts[1];
        for (let i = 2; i < pts.length; i += 2) {
            const px = pts[i], py = pts[i + 1];
            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
        }
        return { minX: el.x + minX, minY: el.y + minY, maxX: el.x + maxX, maxY: el.y + maxY };
    }
    if (el.type === 'freedraw' && (el as { isComplete?: boolean }).isComplete === false) {
        const pts = (el as { points: number[] }).points;
        if (pts.length < 2) return { minX: el.x, minY: el.y, maxX: el.x + 1, maxY: el.y + 1 };
        let minX = pts[0], maxX = pts[0], minY = pts[1], maxY = pts[1];
        for (let i = 2; i < pts.length; i += 2) {
            const px = pts[i], py = pts[i + 1];
            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
        }
        return { minX, minY, maxX, maxY };
    }
    return { minX: el.x, minY: el.y, maxX: el.x + el.width, maxY: el.y + el.height };
}

function rectOverlap(a: Box, b: Box): boolean {
    return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

function bruteForceRect(elements: CanvasElement[], r: Box): Set<string> {
    const out = new Set<string>();
    for (const el of elements) {
        if (rectOverlap(refAABB(el), r)) out.add(el.id);
    }
    return out;
}

// ─── Element fixtures ───────────────────────────────────────────────
// The SoA / AABB logic only reads id/type/x/y/width/height/points/isComplete,
// so fixtures supply just those (cast to satisfy the strict union type).
type Mk = (id: string, x: number, y: number, w: number, h: number) => CanvasElement;

const mkRect: Mk = (id, x, y, w, h) =>
    ({ id, type: 'rectangle', x, y, width: w, height: h }) as unknown as CanvasElement;

const mkEllipse: Mk = (id, x, y, w, h) =>
    ({ id, type: 'ellipse', x, y, width: w, height: h }) as unknown as CanvasElement;

function mkLine(id: string, x: number, y: number, points: number[]): CanvasElement {
    return { id, type: 'line', x, y, width: 0, height: 0, points } as unknown as CanvasElement;
}

function mkArrow(id: string, x: number, y: number, points: number[]): CanvasElement {
    return { id, type: 'arrow', x, y, width: 0, height: 0, points } as unknown as CanvasElement;
}

function randomLayout(rnd: () => number, n: number): CanvasElement[] {
    const els: CanvasElement[] = [];
    for (let i = 0; i < n; i++) {
        const kind = Math.floor(rnd() * 4);
        const x = (rnd() - 0.5) * 4000;
        const y = (rnd() - 0.5) * 4000;
        if (kind === 0) {
            els.push(mkRect(`e${i}`, x, y, 10 + rnd() * 200, 10 + rnd() * 200));
        } else if (kind === 1) {
            els.push(mkEllipse(`e${i}`, x, y, 10 + rnd() * 200, 10 + rnd() * 200));
        } else {
            // Lines/arrows with points that DO NOT start at origin — the case
            // the AABB seed fix exists for.
            const pts: number[] = [];
            const segCount = 2 + Math.floor(rnd() * 3);
            for (let s = 0; s < segCount; s++) {
                pts.push(20 + rnd() * 400, 20 + rnd() * 400);
            }
            els.push(kind === 2 ? mkLine(`e${i}`, x, y, pts) : mkArrow(`e${i}`, x, y, pts));
        }
    }
    return els;
}

// ─── queryRect parity ───────────────────────────────────────────────
describe('SpatialSoA.queryRect — matches brute-force AABB overlap', () => {
    it('agrees with the oracle over many random layouts and rects', () => {
        const rnd = mulberry32(0xC0FFEE);
        for (let trial = 0; trial < 80; trial++) {
            const elements = randomLayout(rnd, 250 + Math.floor(rnd() * 250));
            const soa = new SpatialSoA();
            soa.rebuild(elements);

            for (let q = 0; q < 6; q++) {
                const cx = (rnd() - 0.5) * 4000;
                const cy = (rnd() - 0.5) * 4000;
                const hw = 50 + rnd() * 1500;
                const hh = 50 + rnd() * 1500;
                const r: Box = { minX: cx - hw, minY: cy - hh, maxX: cx + hw, maxY: cy + hh };

                const got = new Set(soa.queryRect(r.minX, r.minY, r.maxX, r.maxY));
                const want = bruteForceRect(elements, r);
                expect(got).toEqual(want);
            }
        }
    });
});

// ─── cullViewport parity ────────────────────────────────────────────
describe('SpatialSoA.cullViewport — matches brute-force over the viewport box', () => {
    it('agrees with the oracle for random viewports/zoom (incl. padding)', () => {
        const rnd = mulberry32(0x5EED);
        for (let trial = 0; trial < 60; trial++) {
            const elements = randomLayout(rnd, 220 + Math.floor(rnd() * 300));
            const soa = new SpatialSoA();
            soa.rebuild(elements);

            const stageW = 800 + rnd() * 800;
            const stageH = 600 + rnd() * 600;
            const padding = Math.floor(rnd() * 300);

            for (let q = 0; q < 5; q++) {
                const viewport: ViewportState = {
                    x: (rnd() - 0.5) * 3000,
                    y: (rnd() - 0.5) * 3000,
                    scale: 0.25 + rnd() * 3,
                };
                const got = new Set(soa.cullViewport(viewport, stageW, stageH, padding));
                const want = bruteForceRect(elements, getVisibleBounds(viewport, stageW, stageH, padding));
                expect(got).toEqual(want);
            }
        }
    });
});

// ─── AABB seed-fix lock-in ──────────────────────────────────────────
describe('SpatialSoA — line/arrow AABB does NOT include the local origin', () => {
    it('excludes a far-offset line when querying near the element transform', () => {
        // Line whose points live at (100,100)..(200,150) relative to el.x/el.y.
        // True world AABB = [600,600]–[700,650]. The local origin (0,0) maps to
        // (500,500); a box there must NOT hit the line once the seed bug is fixed.
        const line = mkLine('L', 500, 500, [100, 100, 200, 150]);
        const arrow = mkArrow('A', 500, 500, [100, 100, 200, 150]);
        const soa = new SpatialSoA();
        soa.rebuild([line, arrow]);

        // Box around the element transform / origin region — should be empty.
        const nearOrigin = soa.queryRect(480, 480, 560, 560);
        expect(nearOrigin).toEqual([]);

        // Box over the true bounds — should contain both.
        const overBounds = new Set(soa.queryRect(590, 590, 710, 660));
        expect(overBounds).toEqual(new Set(['L', 'A']));
    });
});

// ─── Per-instance isolation ─────────────────────────────────────────
describe('SpatialSoA — instances are isolated', () => {
    it('two indexes do not share data', () => {
        const a = new SpatialSoA();
        const b = new SpatialSoA();
        a.rebuild([mkRect('a1', 0, 0, 50, 50)]);
        b.rebuild([mkRect('b1', 1000, 1000, 50, 50), mkRect('b2', 1100, 1100, 50, 50)]);

        expect(a.length).toBe(1);
        expect(b.length).toBe(2);
        expect(a.queryRect(-10, -10, 60, 60)).toEqual(['a1']);
        // b1/b2 live far away — index `a` must not know them.
        expect(a.queryRect(990, 990, 1160, 1160)).toEqual([]);
        expect(new Set(b.queryRect(990, 990, 1160, 1160))).toEqual(new Set(['b1', 'b2']));
    });
});

// ─── Incremental updateElement ──────────────────────────────────────
describe('SpatialSoA.updateElement — in-place AABB patch', () => {
    it('reflects a moved element without a full rebuild', () => {
        const r = mkRect('r', 0, 0, 100, 100);
        const soa = new SpatialSoA();
        soa.rebuild([r]);
        expect(soa.queryRect(0, 0, 50, 50)).toEqual(['r']);

        const moved = mkRect('r', 5000, 5000, 100, 100);
        expect(soa.updateElement(moved)).toBe(true);
        expect(soa.queryRect(0, 0, 50, 50)).toEqual([]);
        expect(soa.queryRect(4990, 4990, 5110, 5110)).toEqual(['r']);
    });

    it('returns false for an unknown id', () => {
        const soa = new SpatialSoA();
        soa.rebuild([mkRect('known', 0, 0, 10, 10)]);
        expect(soa.updateElement(mkRect('ghost', 0, 0, 10, 10))).toBe(false);
    });
});
