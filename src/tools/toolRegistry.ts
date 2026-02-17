/**
 * toolRegistry.ts
 * Central registry mapping ToolType → ToolHandler.
 *
 * Usage in FlowCanvas.tsx:
 *   const handler = getToolHandler(activeTool);
 *   handler?.onMouseDown(e, pos, toolCtx);
 *
 * Hand tool and select-mode element interactions are handled
 * directly by FlowCanvas (they involve Konva Stage drag and
 * selection transformer logic that doesn't fit the tool abstraction).
 */
import type { ToolType } from '@/types';
import type { ToolHandler } from './BaseTool';
import { selectTool } from './SelectTool';
import { eraserTool } from './EraserTool';
import { drawShapeTool } from './DrawShapeTool';
import { freeDrawTool } from './FreeDrawTool';
import { textTool } from './TextTool';
import { imageTool } from './ImageTool';
import { linearTool } from './LinearTool';

/**
 * Tool handler registry.
 * Maps ToolType → ToolHandler instance.
 *
 * Note: 'hand' tool is NOT registered here because panning
 * is handled by Konva's native Stage dragging mechanism.
 */
const toolHandlers: Partial<Record<ToolType, ToolHandler>> = {
    select: selectTool,
    rectangle: drawShapeTool,
    ellipse: drawShapeTool,
    diamond: drawShapeTool,
    line: linearTool,
    arrow: linearTool,
    freedraw: freeDrawTool,
    text: textTool,
    image: imageTool,
    eraser: eraserTool,
};

/**
 * Get the ToolHandler for a given ToolType.
 * Returns undefined for tools handled natively (hand).
 */
export function getToolHandler(tool: ToolType): ToolHandler | undefined {
    return toolHandlers[tool];
}

// Re-export types
export type { ToolHandler, ToolContext } from './BaseTool';
