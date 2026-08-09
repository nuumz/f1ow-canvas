import { describe, it, expect } from 'vitest';
import { computeNextSelection, resolveClickTargetIds } from '@/utils/selection';
import type { CanvasElement, RectangleElement } from '@/types';
import { DEFAULT_STYLE } from '@/constants';

function makeRect(id: string, groupIds?: string[]): RectangleElement {
    return {
        id,
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 40,
        height: 40,
        rotation: 0,
        cornerRadius: 0,
        version: 0,
        style: { ...DEFAULT_STYLE },
        isLocked: false,
        isVisible: true,
        boundElements: null,
        groupIds,
    };
}

describe('resolveClickTargetIds', () => {
    it('returns the single id for ungrouped elements', () => {
        const elements = [makeRect('a'), makeRect('b')];
        expect(resolveClickTargetIds(elements, 'a')).toEqual(['a']);
    });

    it('expands to outermost group members', () => {
        const elements = [
            makeRect('a', ['g1']),
            makeRect('b', ['g1']),
            makeRect('c'),
        ];
        expect(resolveClickTargetIds(elements, 'a').sort()).toEqual(['a', 'b']);
    });
});

describe('computeNextSelection', () => {
    const elements: CanvasElement[] = [
        makeRect('a'),
        makeRect('b'),
        makeRect('c', ['g1']),
        makeRect('d', ['g1']),
    ];

    it('replaces selection when not additive', () => {
        expect(computeNextSelection(elements, ['a'], 'b', false)).toEqual(['b']);
    });

    it('adds to selection when additive and not already selected', () => {
        expect(computeNextSelection(elements, ['a'], 'b', true).sort()).toEqual(['a', 'b']);
    });

    it('removes from selection when additive and already selected', () => {
        expect(computeNextSelection(elements, ['a', 'b'], 'b', true)).toEqual(['a']);
    });

    it('toggles a whole group under additive select', () => {
        expect(computeNextSelection(elements, ['a'], 'c', true).sort()).toEqual(['a', 'c', 'd']);
        expect(computeNextSelection(elements, ['a', 'c', 'd'], 'c', true)).toEqual(['a']);
    });
});
