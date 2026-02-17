/**
 * EraserTool.ts
 * Eraser tool — click or drag to delete elements under the pointer.
 */
import type { ToolHandler, ToolContext } from './BaseTool';
import type Konva from 'konva';
import type { Point } from '@/types';

/** Shared eraser drag state across mouseDown/mouseMove/mouseUp */
let isErasing = false;

export const eraserTool: ToolHandler = {
    name: 'eraser',

    onMouseDown(e: Konva.KonvaEventObject<MouseEvent | TouchEvent>, _pos: Point, ctx: ToolContext) {
        isErasing = true;
        const clickedId = e.target.id();
        if (clickedId) {
            ctx.deleteElements([clickedId]);
            ctx.onElementDelete?.([clickedId]);
        }
    },

    onMouseMove(e: Konva.KonvaEventObject<MouseEvent | TouchEvent>, _pos: Point, ctx: ToolContext) {
        if (!isErasing) return;
        const target = e.target;
        const clickedId = target.id?.();
        if (clickedId && target !== target.getStage()) {
            ctx.deleteElements([clickedId]);
            ctx.onElementDelete?.([clickedId]);
        }
    },

    onMouseUp(_ctx: ToolContext) {
        isErasing = false;
    },

    getCursor() {
        return 'not-allowed';
    },
};
