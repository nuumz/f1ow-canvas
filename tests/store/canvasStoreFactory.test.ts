/**
 * Verifies that `createCanvasStore()` produces independent stores so apps
 * can render multiple `<FlowCanvas>` instances side-by-side without React
 * subscribers cross-talking.
 */
import { describe, it, expect } from 'vitest';

import { DEFAULT_STYLE } from '@/constants';
import { createCanvasStore } from '@/store/useCanvasStore';
import type { CanvasElement } from '@/types';

function rectangle(id: string, x = 0): CanvasElement {
    return {
        id,
        type: 'rectangle',
        x,
        y: 0,
        width: 10,
        height: 10,
        rotation: 0,
        style: { ...DEFAULT_STYLE },
        isLocked: false,
        isVisible: true,
        boundElements: null,
        version: 0,
        cornerRadius: 0,
    };
}

describe('createCanvasStore', () => {
    it('returns independent stores with separate elements/selection/viewport', () => {
        const a = createCanvasStore();
        const b = createCanvasStore();

        a.getState().setElements([rectangle('a1'), rectangle('a2', 20)]);
        a.getState().setSelectedIds(['a1']);
        a.getState().setViewport({ x: 100, y: 0, scale: 2 });

        b.getState().setElements([rectangle('b1', 5)]);
        b.getState().setSelectedIds(['b1']);

        expect(a.getState().elements.map((e) => e.id)).toEqual(['a1', 'a2']);
        expect(b.getState().elements.map((e) => e.id)).toEqual(['b1']);
        expect(a.getState().selectedIds).toEqual(['a1']);
        expect(b.getState().selectedIds).toEqual(['b1']);
        expect(a.getState().viewport.scale).toBe(2);
        expect(b.getState().viewport.scale).toBe(1);
    });

    it('keeps history isolated between instances', () => {
        const a = createCanvasStore();
        const b = createCanvasStore();

        a.getState().setElements([rectangle('a1'), rectangle('a2', 20)]);
        a.getState().sendToBack(['a2']);
        expect(a.getState().elements.map((e) => e.id)).toEqual(['a2', 'a1']);

        // History action on `a` must not affect `b`
        a.getState().undo();
        expect(a.getState().elements.map((e) => e.id)).toEqual(['a1', 'a2']);
        expect(b.getState().history.length).toBe(0);
    });
});
