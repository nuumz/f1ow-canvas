/**
 * Baseline tests for connection binding math.
 * These capture known behavior to detect regressions during the v2 refactor.
 */
import { describe, it, expect } from 'vitest';
import {
    computeFixedPoint,
    getEdgePointFromFixedPoint,
    getEdgePoint,
    computeBindingGap,
    findNearestSnapTarget,
    recomputeBoundPoints,
    clearBindingsForDeletedElements,
    addBoundElement,
    removeBoundElement,
    isConnectable,
    anchorToFixedPoint,
    fixedPointToAnchor,
    resolveBindingPoint,
    createBindingFromSnap,
    isBindingStale,
    resolvePort,
} from '@/utils/connection';
import type { CanvasElement, RectangleElement, EllipseElement, DiamondElement, ArrowElement, Point, Binding, SnapTarget } from '@/types';

// ─── Test Factories ───────────────────────────────────────────

function makeRect(overrides: Partial<RectangleElement> = {}): RectangleElement {
    return {
        id: 'rect-1',
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 100,
        height: 60,
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

function makeEllipse(overrides: Partial<EllipseElement> = {}): EllipseElement {
    return {
        ...makeRect(),
        id: 'ellipse-1',
        type: 'ellipse',
        ...overrides,
    } as EllipseElement;
}

function makeDiamond(overrides: Partial<DiamondElement> = {}): DiamondElement {
    return {
        ...makeRect(),
        id: 'diamond-1',
        type: 'diamond',
        ...overrides,
    } as DiamondElement;
}

function makeArrow(overrides: Partial<ArrowElement> = {}): ArrowElement {
    return {
        id: 'arrow-1',
        type: 'arrow',
        x: 0,
        y: 0,
        width: 100,
        height: 0,
        rotation: 0,
        version: 0,
        points: [0, 0, 100, 0],
        startArrowhead: null,
        endArrowhead: 'arrow',
        lineType: 'sharp',
        startBinding: null,
        endBinding: null,
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

// ─── Tests ────────────────────────────────────────────────────

describe('isConnectable', () => {
    it('returns true for rectangle, ellipse, diamond, text, image', () => {
        expect(isConnectable(makeRect())).toBe(true);
        expect(isConnectable(makeEllipse())).toBe(true);
        expect(isConnectable(makeDiamond())).toBe(true);
    });

    it('returns false for arrow, line, freedraw', () => {
        expect(isConnectable(makeArrow())).toBe(false);
    });
});

describe('computeFixedPoint', () => {
    it('returns [0.5, 0.5] for shape center', () => {
        const rect = makeRect({ x: 0, y: 0, width: 100, height: 60 });
        const fp = computeFixedPoint(rect, { x: 50, y: 30 });
        expect(fp[0]).toBeCloseTo(0.5, 2);
        expect(fp[1]).toBeCloseTo(0.5, 2);
    });

    it('returns [0.5, 0] for top center', () => {
        const rect = makeRect({ x: 0, y: 0, width: 100, height: 60 });
        const fp = computeFixedPoint(rect, { x: 50, y: 0 });
        expect(fp[0]).toBeCloseTo(0.5, 2);
        expect(fp[1]).toBeCloseTo(0, 2);
    });

    it('returns [1, 0.5] for right center', () => {
        const rect = makeRect({ x: 0, y: 0, width: 100, height: 60 });
        const fp = computeFixedPoint(rect, { x: 100, y: 30 });
        expect(fp[0]).toBeCloseTo(1, 2);
        expect(fp[1]).toBeCloseTo(0.5, 2);
    });

    it('handles rotated shape (90deg)', () => {
        const rect = makeRect({ x: 0, y: 0, width: 100, height: 60, rotation: 90 });
        // After 90° rotation, what was the right edge (1, 0.5) in local
        // is now in a different world position.
        // Center is (50, 30), top-center in world after rotation should map to ~[0.5, 0]
        const fp = computeFixedPoint(rect, { x: 50, y: 30 }); // center
        expect(fp[0]).toBeCloseTo(0.5, 2);
        expect(fp[1]).toBeCloseTo(0.5, 2);
    });

    it('clamps values to [0, 1]', () => {
        const rect = makeRect({ x: 0, y: 0, width: 100, height: 60 });
        const fp = computeFixedPoint(rect, { x: -50, y: -50 });
        expect(fp[0]).toBeGreaterThanOrEqual(0);
        expect(fp[1]).toBeGreaterThanOrEqual(0);
        expect(fp[0]).toBeLessThanOrEqual(1);
        expect(fp[1]).toBeLessThanOrEqual(1);
    });
});

describe('getEdgePointFromFixedPoint', () => {
    it('top center [0.5, 0] → shape top edge', () => {
        const rect = makeRect({ x: 0, y: 0, width: 100, height: 60 });
        const pt = getEdgePointFromFixedPoint(rect, [0.5, 0]);
        expect(pt.x).toBeCloseTo(50, 0);
        expect(pt.y).toBeCloseTo(0, 0);
    });

    it('right center [1, 0.5] → shape right edge', () => {
        const rect = makeRect({ x: 0, y: 0, width: 100, height: 60 });
        const pt = getEdgePointFromFixedPoint(rect, [1, 0.5]);
        expect(pt.x).toBeCloseTo(100, 0);
        expect(pt.y).toBeCloseTo(30, 0);
    });

    it('center [0.5, 0.5] → returns shape center (degenerate)', () => {
        const rect = makeRect({ x: 0, y: 0, width: 100, height: 60 });
        const pt = getEdgePointFromFixedPoint(rect, [0.5, 0.5]);
        expect(pt.x).toBeCloseTo(50, 0);
        expect(pt.y).toBeCloseTo(30, 0);
    });

    it('applies gap offset', () => {
        const rect = makeRect({ x: 0, y: 0, width: 100, height: 60 });
        const pt = getEdgePointFromFixedPoint(rect, [0.5, 0], 5);
        expect(pt.y).toBeCloseTo(-5, 0); // 5px above top edge
    });

    describe('ellipse shape', () => {
        it('right center [1, 0.5] → ellipse right edge', () => {
            const el = makeEllipse({ x: 0, y: 0, width: 100, height: 60 });
            const pt = getEdgePointFromFixedPoint(el, [1, 0.5]);
            expect(pt.x).toBeCloseTo(100, 0); // right edge at rx
            expect(pt.y).toBeCloseTo(30, 0); // center y
        });
    });

    describe('diamond shape', () => {
        it('top center [0.5, 0] → diamond top vertex', () => {
            const el = makeDiamond({ x: 0, y: 0, width: 100, height: 60 });
            const pt = getEdgePointFromFixedPoint(el, [0.5, 0]);
            expect(pt.x).toBeCloseTo(50, 0);
            expect(pt.y).toBeCloseTo(0, 0);
        });
    });
});

describe('getEdgePoint', () => {
    it('rect: toward above → hits top edge', () => {
        const rect = makeRect({ x: 0, y: 0, width: 100, height: 60 });
        const pt = getEdgePoint(rect, { x: 50, y: -100 });
        expect(pt.x).toBeCloseTo(50, 0);
        expect(pt.y).toBeCloseTo(0, 0);
    });

    it('rect: toward right → hits right edge', () => {
        const rect = makeRect({ x: 0, y: 0, width: 100, height: 60 });
        const pt = getEdgePoint(rect, { x: 200, y: 30 });
        expect(pt.x).toBeCloseTo(100, 0);
        expect(pt.y).toBeCloseTo(30, 0);
    });

    it('center toward falls back to widest dimension edge', () => {
        const rect = makeRect({ x: 0, y: 0, width: 100, height: 60 });
        const pt = getEdgePoint(rect, { x: 50, y: 30 }); // center → toward=center
        // Landscape rect → falls back to right edge (widest dimension)
        expect(pt.x).toBeCloseTo(100, 0);
        expect(pt.y).toBeCloseTo(30, 0);
    });
});

describe('computeBindingGap', () => {
    it('returns base offset + half stroke width', () => {
        expect(computeBindingGap(2)).toBe(5); // 4 + 1
        expect(computeBindingGap(4)).toBe(6); // 4 + 2
    });
});

describe('clearBindingsForDeletedElements', () => {
    it('nullifies bindings referencing deleted elements', () => {
        const rect = makeRect({ id: 'r1', boundElements: [{ id: 'a1', type: 'arrow' }] });
        const arrow = makeArrow({
            id: 'a1',
            startBinding: { elementId: 'r1', fixedPoint: [0.5, 0], gap: 5, snapMode: 'edge' as const, elementVersion: 0 },
            endBinding: { elementId: 'r2', fixedPoint: [0.5, 1], gap: 5, snapMode: 'edge' as const, elementVersion: 0 },
        });
        const deletedIds = new Set(['r2']);
        const result = clearBindingsForDeletedElements(deletedIds, [rect, arrow]);
        const updatedArrow = result.find((e: CanvasElement) => e.id === 'a1') as ArrowElement;
        expect(updatedArrow.startBinding).not.toBeNull(); // r1 not deleted
        expect(updatedArrow.endBinding).toBeNull(); // r2 deleted → cleared
    });

    it('removes boundElement refs to deleted elements', () => {
        const rect = makeRect({
            id: 'r1',
            boundElements: [
                { id: 'a1', type: 'arrow' },
                { id: 'a2', type: 'arrow' },
            ],
        });
        const deletedIds = new Set(['a1']);
        const result = clearBindingsForDeletedElements(deletedIds, [rect]);
        const updated = result[0] as RectangleElement;
        expect(updated.boundElements).toHaveLength(1);
        expect(updated.boundElements![0].id).toBe('a2');
    });
});

describe('addBoundElement / removeBoundElement', () => {
    it('adds a new bound element ref', () => {
        const rect = makeRect({ boundElements: null });
        const updated = addBoundElement(rect, { id: 'a1', type: 'arrow' });
        expect(updated.boundElements).toHaveLength(1);
        expect(updated.boundElements![0].id).toBe('a1');
    });

    it('prevents duplicate bound element refs', () => {
        const rect = makeRect({ boundElements: [{ id: 'a1', type: 'arrow' }] });
        const updated = addBoundElement(rect, { id: 'a1', type: 'arrow' });
        expect(updated.boundElements).toHaveLength(1); // no duplicate
    });

    it('removes a bound element ref', () => {
        const rect = makeRect({
            boundElements: [
                { id: 'a1', type: 'arrow' },
                { id: 'a2', type: 'arrow' },
            ],
        });
        const updated = removeBoundElement(rect, 'a1');
        expect(updated.boundElements).toHaveLength(1);
        expect(updated.boundElements![0].id).toBe('a2');
    });

    it('sets boundElements to null when last ref removed', () => {
        const rect = makeRect({ boundElements: [{ id: 'a1', type: 'arrow' }] });
        const updated = removeBoundElement(rect, 'a1');
        expect(updated.boundElements).toBeNull();
    });
});

describe('recomputeBoundPoints', () => {
    it('returns null for unbound connectors', () => {
        const arrow = makeArrow({ startBinding: null, endBinding: null });
        expect(recomputeBoundPoints(arrow, [])).toBeNull();
    });

    it('recomputes start point when start-bound', () => {
        const rect = makeRect({ id: 'r1', x: 200, y: 200, width: 100, height: 60 });
        const arrow = makeArrow({
            x: 0,
            y: 0,
            points: [0, 0, 250, 230],
            startBinding: {
                elementId: 'r1',
                fixedPoint: [0.5, 0.5],
                gap: 5,
                snapMode: 'center' as const,
                elementVersion: 0,
            },
            endBinding: null,
        });
        const result = recomputeBoundPoints(arrow, [rect, arrow]);
        expect(result).not.toBeNull();
        expect(result!.x).toBeDefined();
        expect(result!.y).toBeDefined();
    });

    it('double-bound: start and end points converge', () => {
        const r1 = makeRect({ id: 'r1', x: 0, y: 0, width: 100, height: 60 });
        const r2 = makeRect({ id: 'r2', x: 300, y: 0, width: 100, height: 60 });
        const arrow = makeArrow({
            id: 'a1',
            x: 100,
            y: 30,
            points: [0, 0, 200, 0],
            startBinding: {
                elementId: 'r1',
                fixedPoint: [0.5, 0.5],
                gap: 5,
                snapMode: 'center' as const,
                elementVersion: 0,
            },
            endBinding: {
                elementId: 'r2',
                fixedPoint: [0.5, 0.5],
                gap: 5,
                snapMode: 'center' as const,
                elementVersion: 0,
            },
        });
        const result = recomputeBoundPoints(arrow, [r1, r2, arrow]);
        expect(result).not.toBeNull();
        // Start should be near right edge of r1 (100, 30)
        expect(result!.x).toBeGreaterThan(90);
        expect(result!.x).toBeLessThan(115);
    });
});

describe('findNearestSnapTarget', () => {
    it('returns null when no connectable shapes nearby', () => {
        const arrow = makeArrow();
        const result = findNearestSnapTarget({ x: 500, y: 500 }, [arrow]);
        expect(result).toBeNull();
    });

    it('snaps to shape edge when cursor is within threshold', () => {
        const rect = makeRect({ x: 0, y: 0, width: 100, height: 60 });
        // Cursor just outside right edge
        const result = findNearestSnapTarget({ x: 110, y: 30 }, [rect]);
        expect(result).not.toBeNull();
        expect(result!.elementId).toBe('rect-1');
        expect(result!.isPrecise).toBe(true);
    });

    it('excludes specified IDs', () => {
        const rect = makeRect({ x: 0, y: 0, width: 100, height: 60 });
        const result = findNearestSnapTarget(
            { x: 50, y: 30 },
            [rect],
            24,
            new Set(['rect-1']),
        );
        expect(result).toBeNull();
    });

    it('prefers center binding when cursor deep inside shape', () => {
        const rect = makeRect({ x: 0, y: 0, width: 200, height: 200 });
        const result = findNearestSnapTarget({ x: 100, y: 100 }, [rect]);
        expect(result).not.toBeNull();
        expect(result!.isPrecise).toBe(false);
        expect(result!.fixedPoint[0]).toBeCloseTo(0.5, 1);
        expect(result!.fixedPoint[1]).toBeCloseTo(0.5, 1);
    });

    it('returns snapMode on result', () => {
        const rect = makeRect({ x: 0, y: 0, width: 100, height: 60 });
        // Cursor near east anchor → anchor snap
        const anchor = findNearestSnapTarget({ x: 110, y: 30 }, [rect]);
        expect(anchor!.snapMode).toBe('anchor');
        expect(anchor!.anchor).toBe('e');
        // Cursor deep inside a large shape → center snap
        const center = findNearestSnapTarget({ x: 50, y: 30 }, [makeRect({ width: 200, height: 200 })]);
        expect(center!.snapMode).toBe('center');
    });
});

// ─── Phase 2: Anchor / Port helpers ──────────────────────────

describe('anchorToFixedPoint', () => {
    it('maps cardinal anchors correctly', () => {
        expect(anchorToFixedPoint('n')).toEqual([0.5, 0]);
        expect(anchorToFixedPoint('s')).toEqual([0.5, 1]);
        expect(anchorToFixedPoint('e')).toEqual([1, 0.5]);
        expect(anchorToFixedPoint('w')).toEqual([0, 0.5]);
    });

    it('maps corner anchors', () => {
        expect(anchorToFixedPoint('ne')).toEqual([1, 0]);
        expect(anchorToFixedPoint('sw')).toEqual([0, 1]);
    });

    it('center and auto return [0.5, 0.5]', () => {
        expect(anchorToFixedPoint('center')).toEqual([0.5, 0.5]);
        expect(anchorToFixedPoint('auto')).toEqual([0.5, 0.5]);
    });
});

describe('fixedPointToAnchor', () => {
    it('maps cardinal fixedPoints to anchors', () => {
        expect(fixedPointToAnchor([0.5, 0])).toBe('n');
        expect(fixedPointToAnchor([0.5, 1])).toBe('s');
        expect(fixedPointToAnchor([1, 0.5])).toBe('e');
        expect(fixedPointToAnchor([0, 0.5])).toBe('w');
    });

    it('finds nearest anchor for arbitrary point', () => {
        expect(fixedPointToAnchor([0.48, 0.02])).toBe('n'); // close to north
        expect(fixedPointToAnchor([0.95, 0.55])).toBe('e'); // close to east
    });
});

describe('resolvePort', () => {
    it('returns port ratio when found', () => {
        const el = makeRect({
            ports: [
                { id: 'db-in', ratio: [0.2, 0.5] },
                { id: 'db-out', ratio: [0.8, 0.5] },
            ],
        });
        expect(resolvePort(el, 'db-in')).toEqual([0.2, 0.5]);
        expect(resolvePort(el, 'db-out')).toEqual([0.8, 0.5]);
    });

    it('returns null for missing port', () => {
        const el = makeRect({ ports: [{ id: 'p1', ratio: [0, 0] }] });
        expect(resolvePort(el, 'nonexistent')).toBeNull();
    });

    it('returns null when element has no ports', () => {
        const el = makeRect();
        expect(resolvePort(el, 'any')).toBeNull();
    });
});

describe('resolveBindingPoint', () => {
    it('port takes highest priority', () => {
        const el = makeRect({
            ports: [{ id: 'p1', ratio: [0.3, 0.7] }],
        });
        const binding: Binding = {
            elementId: el.id,
            fixedPoint: [0.5, 0],
            gap: 5,
            snapMode: 'edge',
            elementVersion: 0,
            anchor: 'n',
            portId: 'p1',
        };
        const result = resolveBindingPoint(binding, el);
        expect(result.fixedPoint).toEqual([0.3, 0.7]);
        expect(result.snapMode).toBe('port');
    });

    it('anchor takes priority over fixedPoint', () => {
        const el = makeRect();
        const binding: Binding = {
            elementId: el.id,
            fixedPoint: [0.2, 0.3],
            gap: 5,
            snapMode: 'edge',
            elementVersion: 0,
            anchor: 's',
        };
        const result = resolveBindingPoint(binding, el);
        expect(result.fixedPoint).toEqual([0.5, 1]);
        expect(result.snapMode).toBe('anchor');
    });

    it('falls back to fixedPoint when no anchor/port', () => {
        const el = makeRect();
        const binding: Binding = {
            elementId: el.id,
            fixedPoint: [0.7, 0.2],
            gap: 5,
            snapMode: 'edge',
            elementVersion: 0,
        };
        const result = resolveBindingPoint(binding, el);
        expect(result.fixedPoint).toEqual([0.7, 0.2]);
        expect(result.snapMode).toBe('edge');
    });

    it('returns center mode for center fixedPoint', () => {
        const el = makeRect();
        const binding: Binding = {
            elementId: el.id,
            fixedPoint: [0.5, 0.5],
            gap: 5,
            snapMode: 'center',
            elementVersion: 0,
        };
        const result = resolveBindingPoint(binding, el);
        expect(result.snapMode).toBe('center');
    });
});

describe('createBindingFromSnap', () => {
    it('creates a Binding from SnapTarget', () => {
        const snap: SnapTarget = {
            elementId: 'r1',
            fixedPoint: [0.5, 0],
            position: { x: 50, y: 0 },
            isPrecise: true,
            snapMode: 'edge',
            anchor: 'n',
        };
        const binding = createBindingFromSnap(snap, 5, 3);
        expect(binding.elementId).toBe('r1');
        expect(binding.fixedPoint).toEqual([0.5, 0]);
        expect(binding.gap).toBe(5);
        expect(binding.snapMode).toBe('edge');
        expect(binding.elementVersion).toBe(3);
        expect(binding.isPrecise).toBe(true);
        expect(binding.anchor).toBe('n');
    });
});

describe('isBindingStale', () => {
    it('detects stale binding when version mismatch', () => {
        const binding: Binding = {
            elementId: 'r1',
            fixedPoint: [0.5, 0],
            gap: 5,
            snapMode: 'edge',
            elementVersion: 0,
        };
        const el = makeRect({ id: 'r1', version: 2 });
        expect(isBindingStale(binding, el)).toBe(true);
    });

    it('returns false when versions match', () => {
        const binding: Binding = {
            elementId: 'r1',
            fixedPoint: [0.5, 0],
            gap: 5,
            snapMode: 'edge',
            elementVersion: 2,
        };
        const el = makeRect({ id: 'r1', version: 2 });
        expect(isBindingStale(binding, el)).toBe(false);
    });
});

// ─── Phase 3: Deterministic center fixedPoint ─────────────────

describe('getEdgePointFromFixedPoint with toward param', () => {
    it('center [0.5, 0.5] uses toward for direction', () => {
        const rect = makeRect({ x: 0, y: 0, width: 100, height: 60 });
        // toward is to the right → should exit right edge
        const pt = getEdgePointFromFixedPoint(rect, [0.5, 0.5], 0, { x: 200, y: 30 });
        expect(pt.x).toBeCloseTo(100, 0);
        expect(pt.y).toBeCloseTo(30, 0);
    });

    it('center [0.5, 0.5] without toward returns center', () => {
        const rect = makeRect({ x: 0, y: 0, width: 100, height: 60 });
        const pt = getEdgePointFromFixedPoint(rect, [0.5, 0.5], 0);
        expect(pt.x).toBeCloseTo(50, 0); // center
        expect(pt.y).toBeCloseTo(30, 0);
    });

    it('non-center fixedPoint ignores toward', () => {
        const rect = makeRect({ x: 0, y: 0, width: 100, height: 60 });
        const ptWith = getEdgePointFromFixedPoint(rect, [0.5, 0], 0, { x: 200, y: 30 });
        const ptWithout = getEdgePointFromFixedPoint(rect, [0.5, 0], 0);
        expect(ptWith.x).toBeCloseTo(ptWithout.x, 0);
        expect(ptWith.y).toBeCloseTo(ptWithout.y, 0);
    });
});
