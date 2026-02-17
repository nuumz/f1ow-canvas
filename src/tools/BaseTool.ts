/**
 * BaseTool.ts
 * Defines the ToolHandler interface and ToolContext that all tools share.
 *
 * Each tool encapsulates
 * its own mouseDown/mouseMove/mouseUp logic, keeping FlowCanvas.tsx
 * focused on orchestration rather than tool-specific behavior.
 */
import type Konva from 'konva';
import type {
    CanvasElement,
    Point,
    ElementStyle,
    ToolType,
    Binding,
    SnapTarget,
} from '@/types';

/**
 * Shared context passed to every tool handler.
 * Contains store state, actions, utilities, and refs that tools need.
 */
export interface ToolContext {
    // ─── Current State ────────────────────────────────────────
    elements: CanvasElement[];
    selectedIds: string[];
    activeTool: ToolType;
    currentStyle: ElementStyle;
    isDrawing: boolean;
    drawStart: Point | null;
    showGrid: boolean;

    // ─── Store Actions ────────────────────────────────────────
    addElement: (el: CanvasElement) => void;
    updateElement: (id: string, updates: Partial<CanvasElement>) => void;
    deleteElements: (ids: string[]) => void;
    setSelectedIds: (ids: string[]) => void;
    clearSelection: () => void;
    setActiveTool: (tool: ToolType) => void;
    setIsDrawing: (b: boolean) => void;
    setDrawStart: (p: Point | null) => void;
    pushHistory: (mark?: string) => void;

    // ─── Utility Functions ────────────────────────────────────
    getPointerPos: () => Point | null;
    snapPos: (p: Point) => Point;

    // ─── Mutable Refs ─────────────────────────────────────────
    currentElementIdRef: React.MutableRefObject<string | null>;
    shiftKeyRef: React.MutableRefObject<boolean>;
    startBindingRef: React.MutableRefObject<Binding | null>;

    // ─── Snap / Selection State (setters from FlowCanvas) ─────
    setSnapTarget: (snap: SnapTarget | null) => void;
    selectionBox: { x: number; y: number; width: number; height: number } | null;
    setSelectionBox: (box: { x: number; y: number; width: number; height: number } | null) => void;
    setAutoEditTextId: (id: string | null) => void;

    // ─── Linear edit store ────────────────────────────────────
    linearEdit: {
        isEditing: boolean;
        elementId: string | null;
        exitEditMode: () => void;
        enterEditMode: (id: string) => void;
    };

    // ─── Callbacks ────────────────────────────────────────────
    onElementCreate?: (el: CanvasElement) => void;
    onElementDelete?: (ids: string[]) => void;
}

/**
 * Tool handler interface — each tool implements this to define
 * its mouse interaction behavior.
 */
export interface ToolHandler {
    /** Tool type this handler manages */
    readonly name: ToolType;

    /**
     * Handle mouse/touch down on the canvas.
     * @param e - Konva event
     * @param pos - World-space position of the pointer
     * @param ctx - Shared tool context
     */
    onMouseDown(e: Konva.KonvaEventObject<MouseEvent | TouchEvent>, pos: Point, ctx: ToolContext): void;

    /**
     * Handle mouse/touch move on the canvas.
     * @param e - Konva event
     * @param pos - World-space position of the pointer
     * @param ctx - Shared tool context
     */
    onMouseMove(e: Konva.KonvaEventObject<MouseEvent | TouchEvent>, pos: Point, ctx: ToolContext): void;

    /**
     * Handle mouse/touch up on the canvas.
     * @param ctx - Shared tool context
     */
    onMouseUp(ctx: ToolContext): void;

    /**
     * Optional: custom cursor for this tool.
     * Return undefined to use the default cursor logic.
     */
    getCursor?(): string | undefined;
}
