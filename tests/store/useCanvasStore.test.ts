import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_STYLE } from '@/constants';
import { useCanvasStore } from '@/store/useCanvasStore';
import type { CanvasElement } from '@/types';

function rectangle(id: string, x: number, y = 0, width = 10, height = 10): CanvasElement {
    return {
        id,
        type: 'rectangle',
        x,
        y,
        width,
        height,
        rotation: 0,
        style: { ...DEFAULT_STYLE },
        isLocked: false,
        isVisible: true,
        boundElements: null,
        version: 0,
        cornerRadius: 0,
    };
}

function text(id: string, containerId: string, x = 0, y = 0): CanvasElement {
    return {
        id,
        type: 'text',
        x,
        y,
        width: 20,
        height: 10,
        rotation: 0,
        style: { ...DEFAULT_STYLE },
        isLocked: false,
        isVisible: true,
        boundElements: null,
        version: 0,
        text: 'Label',
        containerId,
        textAlign: 'center',
        verticalAlign: 'middle',
    };
}

function lineWithNegativePoint(id: string): CanvasElement {
    return {
        id,
        type: 'line',
        x: 100,
        y: 100,
        width: 50,
        height: 20,
        rotation: 0,
        style: { ...DEFAULT_STYLE },
        isLocked: false,
        isVisible: true,
        boundElements: null,
        version: 0,
        points: [0, 0, -40, 10],
        lineType: 'sharp',
        startBinding: null,
        endBinding: null,
    };
}

function resetStore() {
    useCanvasStore.setState({
        elements: [],
        selectedIds: [],
        activeTool: 'select',
        currentStyle: { ...DEFAULT_STYLE },
        currentLineType: 'sharp',
        currentStartArrowhead: null,
        currentEndArrowhead: 'arrow',
        viewport: { x: 0, y: 0, scale: 1 },
        isDrawing: false,
        drawStart: null,
        history: [],
        historyIndex: -1,
        _historyBaseline: new Map(),
        _historyOrderBaseline: [],
        _historyPaused: false,
        showGrid: false,
    });
}

function setElements(elements: CanvasElement[]) {
    useCanvasStore.getState().setElements(elements);
}

function elementIds(): string[] {
    return useCanvasStore.getState().elements.map((el) => el.id);
}

describe('useCanvasStore history', () => {
    beforeEach(resetStore);

    it('records z-order changes so undo and redo restore layer order', () => {
        setElements([rectangle('a', 0), rectangle('b', 20), rectangle('c', 40)]);

        useCanvasStore.getState().sendToBack(['c']);
        expect(elementIds()).toEqual(['c', 'a', 'b']);

        useCanvasStore.getState().undo();
        expect(elementIds()).toEqual(['a', 'b', 'c']);

        useCanvasStore.getState().redo();
        expect(elementIds()).toEqual(['c', 'a', 'b']);
    });

    it('restores deleted elements at their original z-order position', () => {
        setElements([rectangle('a', 0), rectangle('b', 20), rectangle('c', 40)]);

        useCanvasStore.getState().deleteElements(['b']);
        expect(elementIds()).toEqual(['a', 'c']);

        useCanvasStore.getState().undo();
        expect(elementIds()).toEqual(['a', 'b', 'c']);

        useCanvasStore.getState().redo();
        expect(elementIds()).toEqual(['a', 'c']);
    });

    it('keeps selected ids that still exist after undo and redo', () => {
        setElements([rectangle('a', 0), rectangle('b', 20), rectangle('c', 40)]);
        useCanvasStore.getState().setSelectedIds(['c']);

        useCanvasStore.getState().sendToBack(['c']);
        expect(useCanvasStore.getState().selectedIds).toEqual(['c']);

        useCanvasStore.getState().undo();
        expect(useCanvasStore.getState().selectedIds).toEqual(['c']);

        useCanvasStore.getState().redo();
        expect(useCanvasStore.getState().selectedIds).toEqual(['c']);
    });
});

describe('useCanvasStore transform actions', () => {
    beforeEach(resetStore);

    it('aligns selected elements through the store action', () => {
        setElements([rectangle('a', 0, 0, 10, 10), rectangle('b', 30, 10, 20, 10)]);

        useCanvasStore.getState().alignElements(['a', 'b'], 'right');

        const [a, b] = useCanvasStore.getState().elements;
        expect(a.x).toBe(40);
        expect(b.x).toBe(30);
    });

    it('aligns linear elements using their actual point bounds', () => {
        setElements([lineWithNegativePoint('line'), rectangle('b', 200, 0, 10, 10)]);

        useCanvasStore.getState().alignElements(['line', 'b'], 'right');

        const [line] = useCanvasStore.getState().elements;
        expect(line.x).toBe(210);
    });

    it('syncs bound text after transforming its container', () => {
        const container = {
            ...rectangle('a', 0, 0, 10, 30),
            boundElements: [{ id: 'text-a', type: 'text' as const }],
        };
        setElements([container, text('text-a', 'a'), rectangle('b', 30, 0, 20, 10)]);

        useCanvasStore.getState().alignElements(['a', 'b'], 'right');

        const boundText = useCanvasStore.getState().elements.find((el) => el.id === 'text-a');
        expect(boundText?.x).toBe(44);
    });

    it('rotates selected elements and records the change in history', () => {
        setElements([rectangle('a', 0)]);

        useCanvasStore.getState().rotateElements(['a'], -90);
        expect(useCanvasStore.getState().elements[0].rotation).toBe(270);

        useCanvasStore.getState().undo();
        expect(useCanvasStore.getState().elements[0].rotation).toBe(0);
    });

    it('flips selected elements across the selection bounds', () => {
        setElements([rectangle('a', 0, 0, 10, 10), rectangle('b', 30, 0, 10, 10)]);

        useCanvasStore.getState().flipElements(['a', 'b'], 'horizontal');

        const [a, b] = useCanvasStore.getState().elements;
        expect(a.x).toBe(30);
        expect(b.x).toBe(0);
    });
});
