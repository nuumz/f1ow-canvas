import { describe, it, expect } from 'vitest';
import { computeMultiSelectAlignSnap } from '@/utils/alignment';
import type { RectangleElement } from '@/types';
import { DEFAULT_STYLE } from '@/constants';

function makeRect(
    id: string,
    x: number,
    y: number,
    width = 40,
    height = 40,
): RectangleElement {
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
        style: { ...DEFAULT_STYLE },
        isLocked: false,
        isVisible: true,
        boundElements: null,
    };
}

describe('computeMultiSelectAlignSnap', () => {
    it('returns a shared delta that snaps the selection AABB to a neighbor', () => {
        // Selected pair at x=0; anchor at x=100. Drag so union left is near 100.
        const elements = [
            makeRect('a', 0, 0),
            makeRect('b', 0, 50),
            makeRect('anchor', 100, 0),
        ];
        const selectedIds = ['a', 'b'];
        // Moving 'a' live to x=98 (within snap threshold of 100)
        const snap = computeMultiSelectAlignSnap(
            'a',
            { x: 98, y: 0, width: 40, height: 40 },
            elements,
            selectedIds,
        );

        expect(snap.dx).toBe(2); // 100 - 98
        expect(snap.dy).toBe(0);
        expect(snap.guides.length).toBeGreaterThan(0);
    });

    it('returns zero delta when nothing is near a snap edge', () => {
        const elements = [
            makeRect('a', 0, 0),
            makeRect('b', 0, 50),
            makeRect('anchor', 400, 0),
        ];
        const snap = computeMultiSelectAlignSnap(
            'a',
            { x: 10, y: 0, width: 40, height: 40 },
            elements,
            ['a', 'b'],
        );
        expect(snap.dx).toBe(0);
        expect(snap.dy).toBe(0);
    });
});
