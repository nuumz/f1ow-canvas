import { describe, expect, it } from 'vitest';
import { computeBindingGap, recomputeBoundPoints } from '@/utils/connection';
import { computeElbowPoints, getElbowPreferredDirection } from '@/utils/elbow';
import type { ArrowElement, Binding, RectangleElement } from '@/types';

function makeRect(id: string, x: number, y: number, width = 100, height = 60): RectangleElement {
    return {
        id,
        type: 'rectangle',
        x,
        y,
        width,
        height,
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
    };
}

function makeCenterBinding(elementId: string, gap: number): Binding {
    return {
        elementId,
        fixedPoint: [0.5, 0.5],
        gap,
        snapMode: 'center',
        elementVersion: 0,
        isPrecise: false,
    };
}

function makeElbowArrow(startBinding: Binding, endBinding: Binding): ArrowElement {
    return {
        id: 'arrow-1',
        type: 'arrow',
        x: 0,
        y: 0,
        width: 240,
        height: 200,
        rotation: 0,
        version: 0,
        points: [0, 0, 240, -200],
        startArrowhead: null,
        endArrowhead: 'arrow',
        lineType: 'elbow',
        startBinding,
        endBinding,
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
    };
}

describe('getElbowPreferredDirection', () => {
    it('prefers the smaller horizontal gap for diagonal shapes', () => {
        const start = makeRect('start', 0, 0);
        const end = makeRect('end', 140, -200);
        const targetCenter = { x: end.x + end.width / 2, y: end.y + end.height / 2 };

        expect(getElbowPreferredDirection(start, targetCenter, end)).toBe('right');
    });

    it('prefers the smaller vertical gap for diagonal shapes', () => {
        const start = makeRect('start', 0, 100);
        const end = makeRect('end', 220, 0);
        const targetCenter = { x: end.x + end.width / 2, y: end.y + end.height / 2 };

        expect(getElbowPreferredDirection(start, targetCenter, end)).toBe('up');
    });
});

describe('center-bound elbow routing', () => {
    it('prefers a horizontal source exit when the target is diagonally down-right but anchored on its left face', () => {
        const source = makeRect('F0O07LEkT6YR', 441, 336, 138, 122);
        const target = makeRect('OXiWlKH4BPBJ', 704, 505, 121, 97);
        const gap = computeBindingGap(2);
        const startBinding = makeCenterBinding(source.id, gap);
        const endBinding: Binding = {
            elementId: target.id,
            fixedPoint: [0, 0.5],
            gap,
            isPrecise: true,
            snapMode: 'anchor',
            elementVersion: 688,
        };
        const arrow = makeElbowArrow(startBinding, endBinding);

        const recomputed = recomputeBoundPoints(arrow, [source, target, arrow]);
        expect(recomputed).not.toBeNull();

        expect(recomputed!.x).toBeCloseTo(source.x + source.width + gap, 0);
        expect(recomputed!.y).toBeCloseTo(source.y + source.height / 2, 0);

        const routed = computeElbowPoints(
            { x: recomputed!.x as number, y: recomputed!.y as number },
            {
                x: (recomputed!.x as number) + (recomputed!.points as number[])[(recomputed!.points as number[]).length - 2],
                y: (recomputed!.y as number) + (recomputed!.points as number[])[(recomputed!.points as number[]).length - 1],
            },
            startBinding,
            endBinding,
            [source, target, arrow],
        );

        expect(routed[2]).toBeGreaterThan(routed[0]);
        expect(routed[3]).toBeCloseTo(routed[1], 3);
    });

    it('uses side-face exits when the horizontal corridor is tighter than the vertical one', () => {
        const start = makeRect('start', 0, 0);
        const end = makeRect('end', 140, -200);
        const gap = computeBindingGap(2);
        const startBinding = makeCenterBinding(start.id, gap);
        const endBinding = makeCenterBinding(end.id, gap);
        const arrow = makeElbowArrow(startBinding, endBinding);

        const recomputed = recomputeBoundPoints(arrow, [start, end, arrow]);
        expect(recomputed).not.toBeNull();

        const startWorld = {
            x: recomputed!.x as number,
            y: recomputed!.y as number,
        };
        expect(startWorld.x).toBeCloseTo(start.x + start.width + gap, 0);
        expect(startWorld.y).toBeCloseTo(start.y + start.height / 2, 0);

        const recomputedPoints = recomputed!.points as number[];
        const endWorld = {
            x: startWorld.x + recomputedPoints[recomputedPoints.length - 2],
            y: startWorld.y + recomputedPoints[recomputedPoints.length - 1],
        };
        const routed = computeElbowPoints(
            startWorld,
            endWorld,
            startBinding,
            endBinding,
            [start, end, arrow],
        );

        expect(routed[2]).toBeGreaterThan(routed[0]);
        expect(routed[3]).toBeCloseTo(routed[1], 3);
    });

    it('uses top/bottom exits when the vertical corridor is tighter than the horizontal one', () => {
        const start = makeRect('start', 0, 100);
        const end = makeRect('end', 220, 0);
        const gap = computeBindingGap(2);
        const startBinding = makeCenterBinding(start.id, gap);
        const endBinding = makeCenterBinding(end.id, gap);
        const arrow = makeElbowArrow(startBinding, endBinding);

        const recomputed = recomputeBoundPoints(arrow, [start, end, arrow]);
        expect(recomputed).not.toBeNull();

        const startWorld = {
            x: recomputed!.x as number,
            y: recomputed!.y as number,
        };
        expect(startWorld.x).toBeCloseTo(start.x + start.width / 2, 0);
        expect(startWorld.y).toBeCloseTo(start.y - gap, 0);

        const recomputedPoints = recomputed!.points as number[];
        const endWorld = {
            x: startWorld.x + recomputedPoints[recomputedPoints.length - 2],
            y: startWorld.y + recomputedPoints[recomputedPoints.length - 1],
        };
        const routed = computeElbowPoints(
            startWorld,
            endWorld,
            startBinding,
            endBinding,
            [start, end, arrow],
        );

        expect(routed[2]).toBeCloseTo(routed[0], 3);
        expect(routed[3]).toBeLessThan(routed[1]);
    });
});