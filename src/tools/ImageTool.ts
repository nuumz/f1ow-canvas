/**
 * ImageTool.ts
 * Image tool — opens file picker at click position to insert images.
 */
import type { ToolHandler, ToolContext } from './BaseTool';
import type Konva from 'konva';
import type { Point } from '@/types';
import {
    fileToDataURL,
    loadImage,
    createImageElement,
    openImageFilePicker,
} from '@/utils/image';

export const imageTool: ToolHandler = {
    name: 'image',

    onMouseDown(_e: Konva.KonvaEventObject<MouseEvent | TouchEvent>, pos: Point, ctx: ToolContext) {
        ctx.setIsDrawing(false);
        const sp = ctx.snapPos(pos);
        ctx.clearSelection();

        // Open file picker; insert image at click position
        openImageFilePicker().then(async (files) => {
            for (const file of files) {
                try {
                    const dataURL = await fileToDataURL(file);
                    const img = await loadImage(dataURL);
                    const el = createImageElement(
                        dataURL,
                        img.naturalWidth,
                        img.naturalHeight,
                        sp.x,
                        sp.y,
                        { ...ctx.currentStyle },
                    );
                    ctx.addElement(el);
                    ctx.onElementCreate?.(el);
                    ctx.setSelectedIds([el.id]);
                    ctx.pushHistory();
                } catch { /* skip failed images */ }
            }
            ctx.setActiveTool('select');
        });
    },

    onMouseMove() {
        // No move behavior for image tool
    },

    onMouseUp() {
        // No up behavior for image tool
    },

    getCursor() {
        return 'copy';
    },
};
