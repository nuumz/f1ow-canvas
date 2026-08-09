/**
 * EraserTool.ts
 * Eraser tool — click or drag to delete elements under the pointer.
 *
 * A single drag gesture is one undo step: history is paused for the
 * duration of the erase stroke and pushed once on mouse-up.
 */
import type { ToolHandler, ToolContext } from './BaseTool';
import type Konva from 'konva';
import type { Point } from '@/types';

/** Shared eraser drag state across mouseDown/mouseMove/mouseUp */
let isErasing = false;
/** Ids deleted during the current stroke (skip re-delete) */
let deletedIds: Set<string> | null = null;

function eraseHit(ctx: ToolContext, clickedId: string): void {
    if (!clickedId || !deletedIds || deletedIds.has(clickedId)) return;
    deletedIds.add(clickedId);
    ctx.deleteElements([clickedId]);
    ctx.onElementDelete?.([clickedId]);
}

function finalizeErase(ctx: ToolContext): void {
    if (!isErasing) return;
    isErasing = false;
    ctx.store.getState().resumeHistory();
    if (deletedIds && deletedIds.size > 0) {
        ctx.pushHistory();
    }
    deletedIds = null;
}

export const eraserTool: ToolHandler = {
    name: 'eraser',

    onMouseDown(e: Konva.KonvaEventObject<MouseEvent | TouchEvent>, _pos: Point, ctx: ToolContext) {
        isErasing = true;
        deletedIds = new Set();
        /*
         * Pause before the first delete so each hit during the drag does not
         * create its own history entry. One atomic push happens in finalize.
         */
        ctx.store.getState().pauseHistory();
        const clickedId = e.target.id();
        if (clickedId) {
            eraseHit(ctx, clickedId);
        }
    },

    onMouseMove(e: Konva.KonvaEventObject<MouseEvent | TouchEvent>, _pos: Point, ctx: ToolContext) {
        if (!isErasing) return;
        const target = e.target;
        const clickedId = target.id?.();
        if (clickedId && target !== target.getStage()) {
            eraseHit(ctx, clickedId);
        }
    },

    onMouseUp(ctx: ToolContext) {
        finalizeErase(ctx);
    },

    deactivate(ctx: ToolContext) {
        /*
         * Finalize so a release outside the Stage (or a tool switch mid-erase)
         * still resumes history and records one undo entry when anything was deleted.
         */
        finalizeErase(ctx);
    },

    getCursor() {
        return 'not-allowed';
    },
};
