/**
 * diffElements — frame-to-frame change detection that drives tile
 * invalidation. Detects adds, removes, geometry/version bumps, and the
 * style/visibility/text edits that the store does NOT version-track.
 */
import { describe, it, expect } from 'vitest';
import { diffElements } from '@/rendering/useTileRenderer';
import type { RectangleElement, TextElement } from '@/types';

function rect(id: string, overrides: Partial<RectangleElement> = {}): RectangleElement {
    return {
        id,
        type: 'rectangle',
        x: 0,
        y: 0,
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

function text(id: string, value: string, overrides: Partial<TextElement> = {}): TextElement {
    return {
        ...rect(id),
        type: 'text',
        text: value,
        containerId: null,
        textAlign: 'left',
        verticalAlign: 'top',
        ...overrides,
    };
}

describe('diffElements', () => {
    it('marks every element changed on the first frame (prev is empty)', () => {
        const els = [rect('A'), rect('B')];
        const { changed, removed, next } = diffElements(new Map(), els);

        expect(changed.map((e) => e.id)).toEqual(['A', 'B']);
        expect(removed).toEqual([]);
        expect(next.size).toBe(2);
    });

    it('reports no changes when nothing was edited', () => {
        const els = [rect('A'), rect('B')];
        const first = diffElements(new Map(), els);
        const second = diffElements(first.next, els);

        expect(second.changed).toEqual([]);
        expect(second.removed).toEqual([]);
    });

    it('detects a geometry change via the version bump', () => {
        const first = diffElements(new Map(), [rect('A')]);
        const second = diffElements(first.next, [rect('A', { x: 999, version: 1 })]);

        expect(second.changed.map((e) => e.id)).toEqual(['A']);
    });

    it('detects a style change that does not bump version', () => {
        const first = diffElements(new Map(), [rect('A')]);
        const restyled = rect('A', { style: { ...rect('A').style, fillColor: '#f00' } });
        const second = diffElements(first.next, [restyled]);

        expect(second.changed.map((e) => e.id)).toEqual(['A']);
    });

    it('detects a visibility toggle', () => {
        const first = diffElements(new Map(), [rect('A')]);
        const second = diffElements(first.next, [rect('A', { isVisible: false })]);

        expect(second.changed.map((e) => e.id)).toEqual(['A']);
    });

    it('detects a text content change', () => {
        const first = diffElements(new Map(), [text('T', 'hello')]);
        const second = diffElements(first.next, [text('T', 'world')]);

        expect(second.changed.map((e) => e.id)).toEqual(['T']);
    });

    it('detects removed elements', () => {
        const first = diffElements(new Map(), [rect('A'), rect('B')]);
        const second = diffElements(first.next, [rect('A')]);

        expect(second.changed).toEqual([]);
        expect(second.removed).toEqual(['B']);
    });

    it('detects an addition without flagging existing elements', () => {
        const first = diffElements(new Map(), [rect('A')]);
        const second = diffElements(first.next, [rect('A'), rect('B')]);

        expect(second.changed.map((e) => e.id)).toEqual(['B']);
        expect(second.removed).toEqual([]);
    });
});
