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
        };
        const el: CanvasElement = ctx.activeTool === 'rectangle'
            ? { ...baseShape, type: 'rectangle', cornerRadius: 0 }
            : baseShape as CanvasElement;
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
        if (ctx.currentElementIdRef.current) {
            ctx.setSelectedIds([ctx.currentElementIdRef.current]);
            ctx.pushHistory();
        }
        ctx.setIsDrawing(false);
        ctx.setDrawStart(null);
        ctx.currentElementIdRef.current = null;
        ctx.setActiveTool('select');
    },

    getCursor() {
        return 'crosshair';
    },
};
