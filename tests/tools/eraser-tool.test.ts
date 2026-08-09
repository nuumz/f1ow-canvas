import { describe, it, expect } from 'vitest';
import { createCanvasStore } from '@/store/useCanvasStore';
import { eraserTool } from '@/tools/EraserTool';
import type { ToolContext } from '@/tools/BaseTool';
import type { CanvasElement, Point, RectangleElement, ToolType } from '@/types';
import { DEFAULT_STYLE } from '@/constants';

function makeRect(id: string): RectangleElement {
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
    };
}

function makeCtx(store: ReturnType<typeof createCanvasStore>): ToolContext {
    const s = () => store.getState();
    return {
        store,
        get elements() { return s().elements; },
        selectedIds: [],
        activeTool: 'eraser',
        currentStyle: { ...DEFAULT_STYLE },
        isDrawing: false,
        drawStart: null,
        showGrid: false,
        addElement: (el: CanvasElement) => s().addElement(el),
        updateElement: (id: string, u: Partial<CanvasElement>) => s().updateElement(id, u),
        deleteElements: (ids: string[]) => s().deleteElements(ids),
        setSelectedIds: (ids: string[]) => s().setSelectedIds(ids),
        clearSelection: () => s().clearSelection(),
        setActiveTool: (t: ToolType) => s().setActiveTool(t),
        commitTool: () => s().commitTool(),
        setIsDrawing: () => {},
        setDrawStart: () => {},
        pushHistory: (m?: string) => s().pushHistory(m),
        getPointerPos: () => null,
        snapPos: (p: Point) => p,
        currentElementIdRef: { current: null },
        shiftKeyRef: { current: false },
        startBindingRef: { current: null },
        snapThreshold: 24,
        hysteresisMargin: 6,
        setSnapTarget: () => {},
        selectionBox: null,
        setSelectionBox: () => {},
        setAutoEditTextId: () => {},
        linearEdit: {
            isEditing: false,
            elementId: null,
            exitEditMode() {},
            enterEditMode() {},
        },
    };
}

function fakeTarget(id: string) {
    return {
        target: {
            id: () => id,
            getStage: () => ({}),
        },
    } as never;
}

describe('eraserTool history batching', () => {
    it('records one history entry for a multi-delete drag', () => {
        const store = createCanvasStore();
        store.getState().setElements([makeRect('a'), makeRect('b'), makeRect('c')]);
        // Seed a clean baseline so the erase stroke is the next undoable op.
        store.getState().pushHistory();
        const historyBefore = store.getState().history.length;

        const ctx = makeCtx(store);
        eraserTool.onMouseDown(fakeTarget('a'), { x: 0, y: 0 }, ctx);
        eraserTool.onMouseMove(fakeTarget('b'), { x: 1, y: 0 }, ctx);
        eraserTool.onMouseMove(fakeTarget('c'), { x: 2, y: 0 }, ctx);
        eraserTool.onMouseUp(ctx);

        expect(store.getState().elements.map((e) => e.id)).toEqual([]);
        expect(store.getState().history.length).toBe(historyBefore + 1);

        store.getState().undo();
        expect(store.getState().elements.map((e) => e.id).sort()).toEqual(['a', 'b', 'c']);
    });

    it('resumes history on deactivate without pushing when nothing was deleted', () => {
        const store = createCanvasStore();
        store.getState().setElements([makeRect('a')]);
        store.getState().pushHistory();
        const historyBefore = store.getState().history.length;

        const ctx = makeCtx(store);
        eraserTool.onMouseDown(
            { target: { id: () => '', getStage: () => ({}) } } as never,
            { x: 0, y: 0 },
            ctx,
        );
        eraserTool.deactivate?.(ctx);

        expect(store.getState()._historyPaused).toBe(false);
        expect(store.getState().history.length).toBe(historyBefore);
        expect(store.getState().elements).toHaveLength(1);
    });
});
