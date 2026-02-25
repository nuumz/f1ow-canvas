/**
 * FreeDrawTool.ts
 * Pencil / free-draw tool — records raw pointer positions as points.
 */
import type { ToolHandler, ToolContext } from './BaseTool';
import type Konva from 'konva';
import type { Point, CanvasElement, FreeDrawElement } from '@/types';
import { generateId } from '@/utils/id';
import { useCanvasStore } from '@/store/useCanvasStore';
import { computeFreedrawBBox } from '@/utils/freehand';

/** Minimum squared distance (canvas pixels) between recorded points.
 *  Filters out near-duplicate points caused by high-frequency mouse events,
 *  keeping the points array small and path computation fast.
 *  3px threshold = 9 squared — good balance between fidelity and perf. */
const MIN_DIST_SQ = 9;

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

            // ─── Point decimation: skip if too close to previous point ─
            // Reduces the points array size on long strokes, keeping path
            // computation and array spread costs proportional to stroke
            // distance rather than raw event frequency.
            const pts = el.points;
            if (pts.length >= 2) {
                const prevX = pts[pts.length - 2];
                const prevY = pts[pts.length - 1];
                const dx = pos.x - prevX;
                const dy = pos.y - prevY;
                if (dx * dx + dy * dy < MIN_DIST_SQ) return;
            }

            const newPoints = [...el.points, pos.x, pos.y];
            // Update bbox so the spatial index never culls this element while drawing.
            // Points are still in world coordinates (isComplete: false).
            const { minX, minY, width, height } = computeFreedrawBBox(newPoints);
            ctx.updateElement(el.id, {
                points: newPoints,
                pressures: el.pressures ? [...el.pressures, pressure] : [pressure],
                isComplete: false,
                x: minX,
                y: minY,
                width,
                height,
            });
        }
    },

    onMouseUp(ctx: ToolContext) {
        // Finalize FreeDraw bounding box
        if (ctx.currentElementIdRef.current) {
            const el = ctx.elements.find((e) => e.id === ctx.currentElementIdRef.current) as FreeDrawElement | undefined;
            if (el) {
                const { minX, minY, width, height } = computeFreedrawBBox(el.points);
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
