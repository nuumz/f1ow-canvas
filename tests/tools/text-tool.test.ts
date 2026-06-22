import { describe, expect, it, vi } from 'vitest';

import type { CanvasElement, ElementStyle, Point } from '@/types';
import { textTool } from '@/tools/TextTool';

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

function makeShape(overrides: Partial<CanvasElement> = {}): CanvasElement {
    return {
        id: 'shape-1',
        type: 'rectangle',
        x: 100,
        y: 100,
        width: 200,
        height: 120,
        rotation: 0,
        style: { ...baseStyle },
        isLocked: false,
        isVisible: true,
        boundElements: null,
        version: 0,
        ...overrides,
    } as CanvasElement;
}

function createContext(elements: CanvasElement[]) {
    return {
        elements,
        selectedIds: [],
        activeTool: 'text',
        currentStyle: { ...baseStyle },
        isDrawing: false,
        drawStart: null,
        showGrid: false,
        addElement: vi.fn(),
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
        currentElementIdRef: { current: null },
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

describe('textTool', () => {
    it('creates bound text when clicking inside a shape', () => {
        const shape = makeShape();
        const ctx = createContext([shape]);

        textTool.onMouseDown({} as any, { x: 140, y: 140 }, ctx as any);

        expect(ctx.addElement).toHaveBeenCalledTimes(1);
        const createdText = ctx.addElement.mock.calls[0][0] as CanvasElement;
        expect(createdText.type).toBe('text');
        expect((createdText as any).containerId).toBe(shape.id);
        expect(ctx.updateElement).toHaveBeenCalledWith(shape.id, {
            boundElements: [{ id: createdText.id, type: 'text' }],
        });
        expect(ctx.setSelectedIds).toHaveBeenCalledWith([createdText.id, shape.id]);
        expect(ctx.setAutoEditTextId).toHaveBeenCalledWith(createdText.id);
    });

    it('focuses existing bound text instead of creating a standalone text element', () => {
        const shape = makeShape({
            boundElements: [{ id: 'text-1', type: 'text' }],
        });
        const ctx = createContext([shape]);

        textTool.onMouseDown({} as any, { x: 140, y: 140 }, ctx as any);

        expect(ctx.addElement).not.toHaveBeenCalled();
        expect(ctx.setSelectedIds).toHaveBeenCalledWith(['text-1', shape.id]);
        expect(ctx.setAutoEditTextId).toHaveBeenCalledWith('text-1');
    });

    it('creates standalone text when clicking empty canvas', () => {
        const ctx = createContext([]);

        textTool.onMouseDown({} as any, { x: 32, y: 48 }, ctx as any);

        expect(ctx.addElement).toHaveBeenCalledTimes(1);
        const createdText = ctx.addElement.mock.calls[0][0] as CanvasElement;
        expect((createdText as any).containerId).toBeNull();
        expect(ctx.updateElement).not.toHaveBeenCalled();
        expect(ctx.setSelectedIds).toHaveBeenCalledWith([createdText.id]);
    });
});