/**
 * TextTool.ts
 * Text tool — creates a text element at the click position
 * and immediately opens the text editor.
 */
import type { ToolHandler, ToolContext } from './BaseTool';
import type Konva from 'konva';
import type { Point, CanvasElement } from '@/types';
import { generateId } from '@/utils/id';
import {
    createBoundTextElement,
    findTopmostTextContainerAtPoint,
    isPointInsideTextContainer,
    isTextContainerElement,
    type TextContainerElement,
} from '@/utils/textBinding';

export const textTool: ToolHandler = {
    name: 'text',

    onMouseDown(_e: Konva.KonvaEventObject<MouseEvent | TouchEvent>, pos: Point, ctx: ToolContext) {
        const sp = ctx.snapPos(pos);

        // Prefer a currently-selected shape when the click lands inside it.
        // This makes "select pink → switch to Text Tool → click overlap" bind
        // to pink, even when a different shape is on top visually.
        const selectedContainer = ctx.selectedIds
            .map((id) => ctx.elements.find((el) => el.id === id))
            .filter((el): el is TextContainerElement => !!el && isTextContainerElement(el))
            .find((el) => isPointInsideTextContainer(el, sp));

        ctx.clearSelection();

        const container = selectedContainer ?? findTopmostTextContainerAtPoint(ctx.elements, sp);
        if (container) {
            const existingTextBinding = container.boundElements?.find((be) => be.type === 'text');
            if (existingTextBinding) {
                ctx.setSelectedIds([existingTextBinding.id, container.id]);
                ctx.setActiveTool('select');
                ctx.setIsDrawing(false);
                ctx.setDrawStart(null);
                ctx.setAutoEditTextId(existingTextBinding.id);
                return;
            }

            const id = generateId();
            const el = createBoundTextElement(id, container, ctx.currentStyle);
            ctx.addElement(el);
            ctx.onElementCreate?.(el);
            ctx.updateElement(container.id, {
                boundElements: [...(container.boundElements ?? []), { id, type: 'text' }],
            });
            ctx.setSelectedIds([id, container.id]);
            ctx.setActiveTool('select');
            ctx.setIsDrawing(false);
            ctx.setDrawStart(null);
            ctx.setAutoEditTextId(id);
            return;
        }

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
            version: 0,
        };
        ctx.addElement(el);
        ctx.onElementCreate?.(el);
        ctx.setSelectedIds([id]);
        ctx.setActiveTool('select');
        ctx.setIsDrawing(false);
        ctx.setDrawStart(null);
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
