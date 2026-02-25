import React, { useMemo } from 'react';
import { Shape } from 'react-konva';
import { GRID_SIZE } from '../../constants';

interface Props {
    width: number;
    height: number;
    viewport: { x: number; y: number; scale: number };
    gridColor?: string;
}

/**
 * High-performance grid layer using a single Konva <Shape> with sceneFunc.
 *
 * Instead of creating hundreds of individual <Line> React/Konva nodes
 * (each with its own hit canvas, event subscriptions, and React reconciliation cost),
 * we draw all grid lines in a single canvas draw call.
 *
 * Performance impact:
 * - Eliminates O(n) React elements for grid lines
 * - Single canvas path instead of per-line stroke calls
 * - No hit graph computation (listening=false + perfectDrawEnabled=false)
 */
const GridLayer: React.FC<Props> = ({ width, height, viewport, gridColor = '#e5e5e5' }) => {
    const { x: vx, y: vy, scale } = viewport;
    const gridSize = GRID_SIZE;

    // Memoize grid bounds to avoid recalculation in sceneFunc
    const bounds = useMemo(() => {
        const startX = Math.floor((-vx / scale - gridSize) / gridSize) * gridSize;
        const endX = Math.ceil((-vx / scale + width / scale + gridSize) / gridSize) * gridSize;
        const startY = Math.floor((-vy / scale - gridSize) / gridSize) * gridSize;
        const endY = Math.ceil((-vy / scale + height / scale + gridSize) / gridSize) * gridSize;
        return { startX, endX, startY, endY };
    }, [vx, vy, scale, width, height, gridSize]);

    return (
        <Shape
            sceneFunc={(ctx) => {
                const { startX, endX, startY, endY } = bounds;
                // Keep line width constant regardless of zoom scale
                const lineWidth = 1 / scale;
                const nativeCtx = ctx._context as CanvasRenderingContext2D;

                nativeCtx.beginPath();
                nativeCtx.strokeStyle = gridColor;
                nativeCtx.lineWidth = lineWidth;

                // Vertical lines
                for (let x = startX; x <= endX; x += gridSize) {
                    nativeCtx.moveTo(x, startY);
                    nativeCtx.lineTo(x, endY);
                }
                // Horizontal lines
                for (let y = startY; y <= endY; y += gridSize) {
                    nativeCtx.moveTo(startX, y);
                    nativeCtx.lineTo(endX, y);
                }

                nativeCtx.stroke();
            }}
            listening={false}
            perfectDrawEnabled={false}
        />
    );
};

export default React.memo(GridLayer);
