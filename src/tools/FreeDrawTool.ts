/**
 * FreeDrawTool.ts
 * Pencil / free-draw tool — records raw pointer positions as points.
 */
import type { ToolHandler, ToolContext } from './BaseTool';
import type Konva from 'konva';
import type { Point, CanvasElement, FreeDrawElement } from '@/types';
import { generateId } from '@/utils/id';
import { useCanvasStore } from '@/store/useCanvasStore';

export const freeDrawTool: ToolHandler = {
    name: 'freedraw',

    onMouseDown(e: Konva.KonvaEventObject<MouseEvent | TouchEvent>, pos: Point, ctx: ToolContext) {
        ctx.setIsDrawing(true);
        ctx.setDrawStart(pos);
        ctx.clearSelection();

        // Extract pressure if available (PointerEvent)
        let pressure = 0.5;
        if (e.evt instanceof PointerEvent && e.evt.pressure !== undefined) {
            pressure = e.evt.pressure === 0 ? 0.5 : e.evt.pressure;
        }

        const id = generateId();
        ctx.currentElementIdRef.current = id;
        const el: CanvasElement = {
            id,
            type: 'freedraw',
            x: pos.x,
            y: pos.y,
            width: 1,
            height: 1,
            rotation: 0,
            style: { ...ctx.currentStyle },
            isLocked: false,
            isVisible: true,
            boundElements: null,
            points: [pos.x, pos.y],
            pressures: [pressure],
            isComplete: false,
        };
        // Pause before addElement so no intermediate snapshot is recorded.
        useCanvasStore.getState().pauseHistory();
        ctx.addElement(el);
        ctx.onElementCreate?.(el);
    },

    onMouseMove(e: Konva.KonvaEventObject<MouseEvent | TouchEvent>, pos: Point, ctx: ToolContext) {
        if (!ctx.isDrawing || !ctx.currentElementIdRef.current) return;
        const el = ctx.elements.find((e) => e.id === ctx.currentElementIdRef.current) as FreeDrawElement | undefined;
        if (el) {
            let pressure = 0.5;
            if (e.evt instanceof PointerEvent && e.evt.pressure !== undefined) {
                pressure = e.evt.pressure === 0 ? 0.5 : e.evt.pressure;
            }
            
            const newPoints = [...el.points, pos.x, pos.y];
            // Compute bbox over all world-coordinate points so the spatial
            // index always finds this element in the viewport during drawing.
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (let i = 0; i < newPoints.length; i += 2) {
                if (newPoints[i] < minX) minX = newPoints[i];
                if (newPoints[i] > maxX) maxX = newPoints[i];
                if (newPoints[i + 1] < minY) minY = newPoints[i + 1];
                if (newPoints[i + 1] > maxY) maxY = newPoints[i + 1];
            }
            ctx.updateElement(el.id, { 
                points: newPoints,
                pressures: el.pressures ? [...el.pressures, pressure] : [pressure],
                // Keep isComplete: false — FreeDrawShape reads this to know that
                // points are still in world coordinates (not relative to x,y)
                isComplete: false,
                // Update bbox for spatial index so the element is never culled
                x: minX,
                y: minY,
                width: Math.max(1, maxX - minX),
                height: Math.max(1, maxY - minY),
            });
        }
    },

    onMouseUp(ctx: ToolContext) {
        // Finalize FreeDraw bounding box
        if (ctx.currentElementIdRef.current) {
            const el = ctx.elements.find((e) => e.id === ctx.currentElementIdRef.current) as FreeDrawElement | undefined;
            if (el) {
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (let i = 0; i < el.points.length; i += 2) {
                    minX = Math.min(minX, el.points[i]);
                    minY = Math.min(minY, el.points[i + 1]);
                    maxX = Math.max(maxX, el.points[i]);
                    maxY = Math.max(maxY, el.points[i + 1]);
                }
                
                // Ensure minimum width/height so it's selectable and visible
                const width = Math.max(1, maxX - minX);
                const height = Math.max(1, maxY - minY);
                
                ctx.updateElement(el.id, {
                    x: minX,
                    y: minY,
                    width,
                    height,
                    // Normalise points to be relative to (minX, minY) now that drawing is done
                    points: el.points.map((v, i) => i % 2 === 0 ? v - minX : v - minY),
                    isComplete: true,
                });
            }
            // Resume then push one atomic entry for the entire stroke.
            useCanvasStore.getState().resumeHistory();
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
