/**
 * tests/collaboration/codec.test.ts
 *
 * Unit tests for the shared codec's granular CRDT primitives:
 *   - Y.Array / Y.Text round-trip through elementToYMap / yMapToElement
 *   - reconcileYArray / reconcileYText produce minimal, mergeable deltas
 *   - tombstone-aware reads
 *   - legacy JSON-blob deserialization (schema back-compat)
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { DEFAULT_STYLE } from '@/constants';
import type { CanvasElement } from '@/types';
import {
    elementToYMap,
    yMapToElement,
    reconcileYArray,
    reconcileYText,
    readLiveElement,
    collectLiveElements,
} from '@/collaboration/syncBridgeCodec';

function line(id: string, points: number[]): CanvasElement {
    return {
        id,
        type: 'line',
        x: 0,
        y: 0,
        width: 100,
        height: 0,
        rotation: 0,
        style: { ...DEFAULT_STYLE },
        isLocked: false,
        isVisible: true,
        boundElements: null,
        version: 0,
        points,
        lineType: 'sharp',
        startBinding: null,
        endBinding: null,
    };
}

function textEl(id: string, text: string): CanvasElement {
    return {
        id,
        type: 'text',
        x: 0,
        y: 0,
        width: 50,
        height: 20,
        rotation: 0,
        style: { ...DEFAULT_STYLE },
        isLocked: false,
        isVisible: true,
        boundElements: null,
        version: 0,
        text,
        containerId: null,
        textAlign: 'center',
        verticalAlign: 'middle',
    };
}

describe('codec — granular Yjs types', () => {
    it('stores line points as a Y.Array and round-trips', () => {
        const doc = new Y.Doc();
        const yMap = new Y.Map<unknown>();
        elementToYMap(line('l1', [0, 0, 10, 20]), yMap);
        doc.getMap('elements').set('l1', yMap);

        expect(yMap.get('points')).toBeInstanceOf(Y.Array);
        const el = yMapToElement(yMap) as Extract<CanvasElement, { points: number[] }>;
        expect(el.points).toEqual([0, 0, 10, 20]);
    });

    it('stores text as a Y.Text and round-trips', () => {
        const doc = new Y.Doc();
        const yMap = new Y.Map<unknown>();
        elementToYMap(textEl('t1', 'hello'), yMap);
        doc.getMap('elements').set('t1', yMap);

        expect(yMap.get('text')).toBeInstanceOf(Y.Text);
        const el = yMapToElement(yMap) as Extract<CanvasElement, { text: string }>;
        expect(el.text).toBe('hello');
    });

    it('deserializes legacy JSON-string points (schema back-compat)', () => {
        const doc = new Y.Doc();
        const yMap = new Y.Map<unknown>();
        doc.getMap('elements').set('l1', yMap);
        yMap.set('id', 'l1');
        yMap.set('type', 'line');
        yMap.set('points', JSON.stringify([1, 2, 3, 4])); // old blob format
        const el = yMapToElement(yMap) as Extract<CanvasElement, { points: number[] }>;
        expect(el.points).toEqual([1, 2, 3, 4]);
    });
});

describe('codec — reconcileYArray', () => {
    function run(initial: number[], next: number[]): number[] {
        const doc = new Y.Doc();
        const arr = doc.getArray<number>('a');
        arr.insert(0, initial);
        reconcileYArray(arr, next);
        return arr.toArray();
    }

    it('no-op when equal', () => {
        expect(run([1, 2, 3], [1, 2, 3])).toEqual([1, 2, 3]);
    });

    it('edits only the divergent middle (prefix/suffix preserved)', () => {
        expect(run([0, 0, 100, 0], [10, 5, 100, 0])).toEqual([10, 5, 100, 0]);
        expect(run([0, 0, 100, 0], [0, 0, 90, 5])).toEqual([0, 0, 90, 5]);
    });

    it('handles growth and shrink', () => {
        expect(run([1, 2], [1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
        expect(run([1, 2, 3, 4], [1, 4])).toEqual([1, 4]);
    });

    it('concurrent non-overlapping splices converge', () => {
        const docA = new Y.Doc();
        const docB = new Y.Doc();
        docA.getArray<number>('a').insert(0, [0, 0, 100, 0]);
        Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

        reconcileYArray(docA.getArray<number>('a'), [10, 5, 100, 0]); // A: start point
        reconcileYArray(docB.getArray<number>('a'), [0, 0, 90, 5]); // B: end point

        Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
        Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));

        expect(docA.getArray<number>('a').toArray()).toEqual([10, 5, 90, 5]);
        expect(docB.getArray<number>('a').toArray()).toEqual([10, 5, 90, 5]);
    });
});

describe('codec — reconcileYText', () => {
    it('concurrent inserts at different offsets merge', () => {
        const docA = new Y.Doc();
        const docB = new Y.Doc();
        docA.getText('t').insert(0, 'hello world');
        Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

        reconcileYText(docA.getText('t'), 'hello brave world'); // A inserts "brave "
        reconcileYText(docB.getText('t'), 'hello world!'); // B appends "!"

        Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
        Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));

        expect(docA.getText('t').toString()).toBe(docB.getText('t').toString());
        expect(docA.getText('t').toString()).toBe('hello brave world!');
    });
});

describe('codec — tombstone-aware reads', () => {
    it('readLiveElement returns null for tombstoned ids', () => {
        const doc = new Y.Doc();
        const yElements = doc.getMap('elements') as Y.Map<Y.Map<unknown>>;
        const tombstones = doc.getMap('tombstones') as Y.Map<number>;

        const yMap = new Y.Map<unknown>();
        elementToYMap(line('l1', [0, 0, 1, 1]), yMap);
        yElements.set('l1', yMap);

        expect(readLiveElement(yElements, tombstones, 'l1')).not.toBeNull();
        tombstones.set('l1', Date.now());
        expect(readLiveElement(yElements, tombstones, 'l1')).toBeNull();
        expect(collectLiveElements(yElements, tombstones)).toHaveLength(0);
    });
});
