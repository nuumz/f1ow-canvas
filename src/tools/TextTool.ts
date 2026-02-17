/**
 * TextTool.ts
 * Text tool — creates a text element at the click position
 * and immediately opens the text editor.
 */
import type { ToolHandler, ToolContext } from './BaseTool';
import type Konva from 'konva';
import type { Point, CanvasElement } from '@/types';
import { generateId } from '@/utils/id';

export const textTool: ToolHandler = {
    name: 'text',

    onMouseDown(_e: Konva.KonvaEventObject<MouseEvent | TouchEvent>, pos: Point, ctx: ToolContext) {
        ctx.setIsDrawing(true);
        const sp = ctx.snapPos(pos);
        ctx.setDrawStart(sp);
        ctx.clearSelection();

        const id = generateId();
        const el: CanvasElement = {
            id,
            type: 'text',
            x: sp.x,
            y: sp.y,
            width: 10,
            height: 30,
            rotation: 0,
            style: { ...ctx.currentStyle },
            isLocked: false,
            isVisible: true,
            boundElements: null,
            text: '',
            containerId: null,
            textAlign: 'left',
            verticalAlign: 'top',
        };
        ctx.addElement(el);
        ctx.onElementCreate?.(el);
        ctx.setSelectedIds([id]);
        ctx.setActiveTool('select');
        ctx.setIsDrawing(false);
        // Auto-open text editor immediately
        ctx.setAutoEditTextId(id);
    },

    onMouseMove() {
        // No move behavior for text tool
    },

    onMouseUp() {
        // No up behavior for text tool
    },

    getCursor() {
        return 'text';
    },
};
