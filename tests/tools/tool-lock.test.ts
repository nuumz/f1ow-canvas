import { describe, it, expect } from 'vitest';
import { createCanvasStore } from '@/store/useCanvasStore';
import { drawShapeTool } from '@/tools/DrawShapeTool';
import type { ToolContext } from '@/tools/BaseTool';
import type { Point, CanvasElement, ToolType } from '@/types';
import { DEFAULT_STYLE } from '@/constants';

/**
 * Wire a ToolContext to a REAL store so we exercise the actual
 * store.commitTool() + tool onMouseUp integration (not mocks).
 */
function makeCtx(store: ReturnType<typeof createCanvasStore>): ToolContext {
    const s = () => store.getState();
    return {
        store,
        elements: [],
        selectedIds: [],
        activeTool: 'rectangle',
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
        setIsDrawing: (b: boolean) => s().setIsDrawing(b),
        setDrawStart: (p: Point | null) => s().setDrawStart(p),
        pushHistory: (m?: string) => s().pushHistory(m),
        getPointerPos: () => null,
        snapPos: (p: Point) => p,
        currentElementIdRef: { current: null },
        shiftKeyRef: { current: false },
        startBindingRef: { current: null },
        setSnapTarget: () => {},
        selectionBox: null,
        setSelectionBox: () => {},
        setAutoEditTextId: () => {},
        linearEdit: { isEditing: false, elementId: null, exitEditMode() {}, enterEditMode() {} },
    } as unknown as ToolContext;
}

function drawOnce(store: ReturnType<typeof createCanvasStore>) {
    const ctx = makeCtx(store);
    drawShapeTool.onMouseDown({} as never, { x: 0, y: 0 }, ctx);
    drawShapeTool.onMouseUp(ctx);
}

describe('tool-lock', () => {
    it('toggleToolLock flips the flag', () => {
        const store = createCanvasStore();
        expect(store.getState().toolLocked).toBe(false);
        store.getState().toggleToolLock();
        expect(store.getState().toolLocked).toBe(true);
    });

    it('reverts to select after drawing when UNLOCKED', () => {
        const store = createCanvasStore();
        store.getState().setActiveTool('rectangle');
        drawOnce(store);
        expect(store.getState().activeTool).toBe('select');
    });

    it('keeps the tool active after drawing when LOCKED', () => {
        const store = createCanvasStore();
        store.getState().setActiveTool('rectangle');
        store.getState().toggleToolLock();
        drawOnce(store);
        expect(store.getState().activeTool).toBe('rectangle');
    });
});
