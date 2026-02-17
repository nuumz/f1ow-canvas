/**
 * SelectTool.ts
 * Handles selection box drawing on empty canvas clicks.
 * Element-level selection/deselection is handled by FlowCanvas
 * via handleElementSelect — this tool only manages rubber-band selection.
 */
import type { ToolHandler, ToolContext } from './BaseTool';
import type Konva from 'konva';
import type { Point, ArrowElement, LineElement } from '@/types';
import { normalizeRect } from '@/utils/geometry';

export const selectTool: ToolHandler = {
    name: 'select',

    onMouseDown(e: Konva.KonvaEventObject<MouseEvent | TouchEvent>, pos: Point, ctx: ToolContext) {
        const clickedOnEmpty = e.target === e.target.getStage();
        if (clickedOnEmpty) {
            // Exit linear edit mode if active
            if (ctx.linearEdit.isEditing) {
                ctx.linearEdit.exitEditMode();
            }
            ctx.clearSelection();
            ctx.setIsDrawing(true);
            ctx.setDrawStart(pos);
            ctx.setSelectionBox({ x: pos.x, y: pos.y, width: 0, height: 0 });
        }
    },

    onMouseMove(_e: Konva.KonvaEventObject<MouseEvent | TouchEvent>, pos: Point, ctx: ToolContext) {
        if (!ctx.isDrawing || !ctx.drawStart) return;
        ctx.setSelectionBox(normalizeRect(ctx.drawStart, pos));
    },

    onMouseUp(ctx: ToolContext) {
        if (!ctx.isDrawing) return;

        const box = ctx.selectionBox;
        if (box && (box.width > 2 || box.height > 2)) {
            const selected = ctx.elements
                .filter((el) => {
                    let elX = el.x;
                    let elY = el.y;
                    let elW = el.width;
                    let elH = el.height;
                    // Arrow/Line: compute bounding box from points
                    if ((el.type === 'arrow' || el.type === 'line') && 'points' in el) {
                        const pts = (el as ArrowElement | LineElement).points;
                        const xs: number[] = [];
                        const ys: number[] = [];
                        for (let i = 0; i < pts.length; i += 2) {
                            xs.push(el.x + pts[i]);
                            ys.push(el.y + pts[i + 1]);
                        }
                        elX = Math.min(...xs);
                        elY = Math.min(...ys);
                        elW = Math.max(...xs) - elX;
                        elH = Math.max(...ys) - elY;
                    }
                    const elR = elX + elW;
                    const elB = elY + elH;
                    const boxR = box.x + box.width;
                    const boxB = box.y + box.height;
                    return elX < boxR && elR > box.x && elY < boxB && elB > box.y;
                })
                .map((el) => el.id);

            // Group-aware: expand selection to include all members of any group
            // that has at least one member inside the rubber-band box
            const selectedSet = new Set(selected);
            const groupIdsToInclude = new Set<string>();
            for (const id of selected) {
                const el = ctx.elements.find(e => e.id === id);
                if (el?.groupIds) {
                    for (const gid of el.groupIds) {
                        groupIdsToInclude.add(gid);
                    }
                }
            }
            if (groupIdsToInclude.size > 0) {
                for (const el of ctx.elements) {
                    if (!selectedSet.has(el.id) && el.groupIds) {
                        for (const gid of el.groupIds) {
                            if (groupIdsToInclude.has(gid)) {
                                selectedSet.add(el.id);
                                break;
                            }
                        }
                    }
                }
            }

            ctx.setSelectedIds([...selectedSet]);
        }
        ctx.setSelectionBox(null);
        ctx.setIsDrawing(false);
        ctx.setDrawStart(null);
    },
};
