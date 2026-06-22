import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CanvasElement, ElementStyle, Point } from '@/types';
import { useCanvasStore } from '@/store/useCanvasStore';
import { drawShapeTool } from '@/tools/DrawShapeTool';
import { freeDrawTool } from '@/tools/FreeDrawTool';
import { linearTool } from '@/tools/LinearTool';

/**
 * Regression coverage for the "history paused forever" bug: drawing tools
 * pauseHistory() on mousedown and previously only resumed inside onMouseUp.
 * Switching tools mid-draw or releasing outside the Stage stranded the pause
 * and killed undo/redo for the whole session. deactivate() must always resume.
 */

const baseStyle: ElementStyle = {
    strokeColor: '#1e1e1e',
    fillColor: 'transparent',
    strokeWidth: 2,
    opacity: 1,
    strokeStyle: 'solid',
    roughness: 0,
    fontSize: 20,
    fontFamily: 'system-ui, sans-serif',
};

function createContext(elements: CanvasElement[], activeTool: string) {
    return {
        // Tools read transient state (pause/resume history, fresh elements,
        // line-type defaults) through ctx.store. These tests assert on the
        // singleton, so the mock context points at the singleton store.
        store: useCanvasStore,
        elements,
        selectedIds: [],
        activeTool,
        currentStyle: { ...baseStyle },
        isDrawing: false,
        drawStart: null,
        showGrid: false,
        addElement: vi.fn((el: CanvasElement) => { elements.push(el); }),
        updateElement: vi.fn(),
        deleteElements: vi.fn(),
        setSelectedIds: vi.fn(),
        clearSelection: vi.fn(),
        setActiveTool: vi.fn(),
        commitTool: vi.fn(),
        setIsDrawing: vi.fn(),
        setDrawStart: vi.fn(),
        pushHistory: vi.fn(),
        getPointerPos: vi.fn(),
        snapPos: vi.fn((point: Point) => point),
        currentElementIdRef: { current: null as string | null },
        shiftKeyRef: { current: false },
        startBindingRef: { current: null },
        setSnapTarget: vi.fn(),
        selectionBox: null,
        setSelectionBox: vi.fn(),
        setAutoEditTextId: vi.fn(),
        linearEdit: {
            isEditing: false,
            elementId: null,
            exitEditMode: vi.fn(),
            enterEditMode: vi.fn(),
        },
        onElementCreate: vi.fn(),
        onElementDelete: vi.fn(),
    };
}

afterEach(() => {
    // Never leave the shared singleton paused between tests.
    useCanvasStore.getState().resumeHistory();
});

describe('drawing-tool deactivate()', () => {
    it('drawShapeTool resumes paused history and clears gesture state', () => {
        const ctx = createContext([], 'rectangle');

        drawShapeTool.onMouseDown({} as any, { x: 10, y: 10 }, ctx as any);
        expect(useCanvasStore.getState()._historyPaused).toBe(true);
        expect(ctx.currentElementIdRef.current).not.toBeNull();

        drawShapeTool.deactivate!(ctx as any);

        expect(useCanvasStore.getState()._historyPaused).toBe(false);
        expect(ctx.currentElementIdRef.current).toBeNull();
        // deactivate must NOT drive the tool transition itself.
        expect(ctx.commitTool).not.toHaveBeenCalled();
        expect(ctx.setActiveTool).not.toHaveBeenCalled();
    });

    it('freeDrawTool resumes paused history on deactivate', () => {
        const ctx = createContext([], 'freedraw');

        freeDrawTool.onMouseDown({} as any, { x: 5, y: 5 }, ctx as any);
        expect(useCanvasStore.getState()._historyPaused).toBe(true);

        freeDrawTool.deactivate!(ctx as any);

        expect(useCanvasStore.getState()._historyPaused).toBe(false);
        expect(ctx.currentElementIdRef.current).toBeNull();
    });

    it('linearTool resumes paused history without switching tools', () => {
        const ctx = createContext([], 'line');

        linearTool.onMouseDown({} as any, { x: 0, y: 0 }, ctx as any);
        expect(useCanvasStore.getState()._historyPaused).toBe(true);

        linearTool.deactivate!(ctx as any);

        expect(useCanvasStore.getState()._historyPaused).toBe(false);
        expect(ctx.currentElementIdRef.current).toBeNull();
        expect(ctx.commitTool).not.toHaveBeenCalled();
    });

    it('drawShapeTool finalizes a real shape as one history entry', () => {
        const el = {
            id: 'shape-1', type: 'rectangle', x: 0, y: 0, width: 80, height: 40,
            rotation: 0, style: { ...baseStyle }, isLocked: false, isVisible: true,
            boundElements: null, version: 0,
        } as CanvasElement;
        const ctx = createContext([el], 'rectangle');
        ctx.currentElementIdRef.current = 'shape-1';
        useCanvasStore.getState().pauseHistory();

        drawShapeTool.deactivate!(ctx as any);

        expect(ctx.setSelectedIds).toHaveBeenCalledWith(['shape-1']);
        expect(ctx.pushHistory).toHaveBeenCalledTimes(1);
        expect(ctx.deleteElements).not.toHaveBeenCalled();
        expect(useCanvasStore.getState()._historyPaused).toBe(false);
    });

    it('drawShapeTool discards a degenerate (zero-size) shape', () => {
        const el = {
            id: 'shape-2', type: 'rectangle', x: 0, y: 0, width: 0, height: 0,
            rotation: 0, style: { ...baseStyle }, isLocked: false, isVisible: true,
            boundElements: null, version: 0,
        } as CanvasElement;
        const ctx = createContext([el], 'rectangle');
        ctx.currentElementIdRef.current = 'shape-2';
        useCanvasStore.getState().pauseHistory();

        drawShapeTool.deactivate!(ctx as any);

        expect(ctx.deleteElements).toHaveBeenCalledWith(['shape-2']);
        expect(ctx.pushHistory).not.toHaveBeenCalled();
        expect(useCanvasStore.getState()._historyPaused).toBe(false);
    });
});
