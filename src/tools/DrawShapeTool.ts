/**
 * DrawShapeTool.ts
 * Handles rectangle, ellipse, and diamond shape creation.
 * Supports shift-constrained symmetric drawing and grid snapping.
 */
import type { ToolHandler, ToolContext } from './BaseTool';
import type Konva from 'konva';
import type { Point, CanvasElement } from '@/types';
import { normalizeRect, normalizeSymmetricRect } from '@/utils/geometry';
import { generateId } from '@/utils/id';

export const drawShapeTool: ToolHandler = {
    name: 'rectangle', // also handles ellipse and diamond

    onMouseDown(_e: Konva.KonvaEventObject<MouseEvent | TouchEvent>, pos: Point, ctx: ToolContext) {
        ctx.setIsDrawing(true);
        const sp = ctx.snapPos(pos);
        ctx.setDrawStart(sp);
        ctx.clearSelection();

        const id = generateId();
        ctx.currentElementIdRef.current = id;
        const baseShape = {
            id,
            type: ctx.activeTool as 'rectangle' | 'ellipse' | 'diamond',
            x: sp.x,
            y: sp.y,
            width: 0,
            height: 0,
            rotation: 0,
            style: { ...ctx.currentStyle },
            isLocked: false,
            isVisible: true,
            boundElements: null,
            version: 0,
        };
        const el: CanvasElement = ctx.activeTool === 'rectangle'
            ? { ...baseShape, type: 'rectangle', cornerRadius: 0 }
            : baseShape as CanvasElement;
        // Pause before addElement so no intermediate snapshot is recorded.
        ctx.store.getState().pauseHistory();
        ctx.addElement(el);
        ctx.onElementCreate?.(el);
    },

    onMouseMove(_e: Konva.KonvaEventObject<MouseEvent | TouchEvent>, pos: Point, ctx: ToolContext) {
        if (!ctx.isDrawing || !ctx.drawStart || !ctx.currentElementIdRef.current) return;
        const endPos = ctx.snapPos(pos);
        const rect = ctx.shiftKeyRef.current
            ? normalizeSymmetricRect(ctx.drawStart, endPos)
            : normalizeRect(ctx.drawStart, endPos);
        ctx.updateElement(ctx.currentElementIdRef.current, rect);
    },

    onMouseUp(ctx: ToolContext) {
        // Resume before pushHistory so the entire draw is one atomic undo entry.
        ctx.store.getState().resumeHistory();
        if (ctx.currentElementIdRef.current) {
            ctx.setSelectedIds([ctx.currentElementIdRef.current]);
            ctx.pushHistory();
        }
        ctx.setIsDrawing(false);
        ctx.setDrawStart(null);
        ctx.currentElementIdRef.current = null;
        ctx.commitTool();
    },

    deactivate(ctx: ToolContext) {
        const id = ctx.currentElementIdRef.current;
        if (!id) return; // no in-flight draw
        // Always resume to balance the pauseHistory() from onMouseDown.
        ctx.store.getState().resumeHistory();
        const el = ctx.elements.find((e) => e.id === id);
        if (el && el.width > 1 && el.height > 1) {
            // A real shape was dragged out — finalize as one atomic undo entry.
            ctx.setSelectedIds([id]);
            ctx.pushHistory();
        } else {
            // Bare mousedown with no (or degenerate) drag — discard.
            ctx.deleteElements([id]);
        }
        ctx.currentElementIdRef.current = null;
        ctx.setIsDrawing(false);
        ctx.setDrawStart(null);
    },

    getCursor() {
        return 'crosshair';
    },
};
