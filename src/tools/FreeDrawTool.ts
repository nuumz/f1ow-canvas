/**
 * FreeDrawTool.ts
 * Pencil / free-draw tool — records raw pointer positions as points.
 */
import type { ToolHandler, ToolContext } from './BaseTool';
import type Konva from 'konva';
import type { Point, CanvasElement, FreeDrawElement } from '@/types';
import { generateId } from '@/utils/id';

export const freeDrawTool: ToolHandler = {
    name: 'freedraw',

    onMouseDown(_e: Konva.KonvaEventObject<MouseEvent | TouchEvent>, pos: Point, ctx: ToolContext) {
        ctx.setIsDrawing(true);
        ctx.setDrawStart(pos);
        ctx.clearSelection();

        const id = generateId();
        ctx.currentElementIdRef.current = id;
        const el: CanvasElement = {
            id,
            type: 'freedraw',
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            rotation: 0,
            style: { ...ctx.currentStyle },
            isLocked: false,
            isVisible: true,
            boundElements: null,
            points: [pos.x, pos.y],
        };
        ctx.addElement(el);
        ctx.onElementCreate?.(el);
    },

    onMouseMove(_e: Konva.KonvaEventObject<MouseEvent | TouchEvent>, pos: Point, ctx: ToolContext) {
        if (!ctx.isDrawing || !ctx.currentElementIdRef.current) return;
        const el = ctx.elements.find((e) => e.id === ctx.currentElementIdRef.current) as FreeDrawElement | undefined;
        if (el) {
            ctx.updateElement(el.id, { points: [...el.points, pos.x, pos.y] });
        }
    },

    onMouseUp(ctx: ToolContext) {
        // Finalize FreeDraw bounding box
        if (ctx.currentElementIdRef.current) {
            const el = ctx.elements.find((e) => e.id === ctx.currentElementIdRef.current) as FreeDrawElement | undefined;
            if (el && el.points.length >= 4) {
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (let i = 0; i < el.points.length; i += 2) {
                    minX = Math.min(minX, el.points[i]);
                    minY = Math.min(minY, el.points[i + 1]);
                    maxX = Math.max(maxX, el.points[i]);
                    maxY = Math.max(maxY, el.points[i + 1]);
                }
                ctx.updateElement(el.id, {
                    x: minX,
                    y: minY,
                    width: maxX - minX,
                    height: maxY - minY,
                    points: el.points.map((v, i) => i % 2 === 0 ? v - minX : v - minY),
                });
            }
            ctx.setSelectedIds([ctx.currentElementIdRef.current]);
            ctx.pushHistory();
        }
        ctx.setIsDrawing(false);
        ctx.setDrawStart(null);
        ctx.currentElementIdRef.current = null;
    },

    getCursor() {
        return 'crosshair';
    },
};
