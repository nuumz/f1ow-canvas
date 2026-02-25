/**
 * ConnectionPoints.tsx
 * Visual overlay showing connection drop-zone highlights on shapes
 * when the active tool is line/arrow. Uses area-based detection —
 * highlights the entire shape as a drop target + shows the edge-point.
 *
 * Renders shape-matched highlights: rectangle for rect/text/image,
 * ellipse for ellipse, diamond polygon for diamond.
 */
import React from 'react';
import { Circle, Rect, Ellipse, Line } from 'react-konva';
import type { CanvasElement, SnapTarget } from '@/types';
import { isConnectable } from '@/utils/connection';
import { rotatePoint } from '@/utils/geometry';

interface Props {
    elements: CanvasElement[];
    /** Currently hovered snap target */
    snapTarget: SnapTarget | null;
    /** Whether to render at all (only during line/arrow tool) */
    visible: boolean;
    /** Accent color */
    color?: string;
    /** Current viewport scale for LOD */
    viewportScale?: number;
}

const HIGHLIGHT_PADDING = 6;

/** Render the shape-matched highlight border around the drop-target */
const ShapeHighlight: React.FC<{ el: CanvasElement; color: string; viewportScale: number }> = ({ el, color, viewportScale }) => {
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;
    const rotation = el.rotation || 0;

    switch (el.type) {
        case 'ellipse': {
            // Ellipse highlight — concentric ellipse with padding
            return (
                <Ellipse
                    x={cx}
                    y={cy}
                    radiusX={el.width / 2 + HIGHLIGHT_PADDING}
                    radiusY={el.height / 2 + HIGHLIGHT_PADDING}
                    rotation={rotation}
                    stroke={color}
                    strokeWidth={2 / viewportScale}
                    dash={[8 / viewportScale, 4 / viewportScale]}
                    fill={color}
                    opacity={0.1}
                    listening={false}
                    perfectDrawEnabled={false}
                />
            );
        }

        case 'diamond': {
            // Diamond highlight — expanded rhombus polygon
            const pw = el.width + HIGHLIGHT_PADDING * 2;
            const ph = el.height + HIGHLIGHT_PADDING * 2;
            const points = [
                pw / 2, 0,        // top
                pw, ph / 2,       // right
                pw / 2, ph,       // bottom
                0, ph / 2,        // left
            ];
            return (
                <Line
                    x={cx - pw / 2}
                    y={cy - ph / 2}
                    points={points}
                    closed
                    rotation={rotation}
                    offsetX={0}
                    offsetY={0}
                    stroke={color}
                    strokeWidth={2 / viewportScale}
                    dash={[8 / viewportScale, 4 / viewportScale]}
                    fill={color}
                    opacity={0.1}
                    listening={false}
                    perfectDrawEnabled={false}
                />
            );
        }

        default: {
            // Rectangle (also text, image) — padded rounded rect
            return (
                <Rect
                    x={cx}
                    y={cy}
                    offsetX={el.width / 2 + HIGHLIGHT_PADDING}
                    offsetY={el.height / 2 + HIGHLIGHT_PADDING}
                    width={el.width + HIGHLIGHT_PADDING * 2}
                    height={el.height + HIGHLIGHT_PADDING * 2}
                    rotation={rotation}
                    stroke={color}
                    strokeWidth={2 / viewportScale}
                    dash={[8 / viewportScale, 4 / viewportScale]}
                    cornerRadius={6}
                    fill={color}
                    opacity={0.1}
                    listening={false}
                    perfectDrawEnabled={false}
                />
            );
        }
    }
};

const ConnectionPointsOverlay: React.FC<Props> = ({
    elements,
    snapTarget,
    visible,
    color = '#4f8df7',
    viewportScale = 1,
}) => {
    if (!visible || !snapTarget) return null;

    const targetEl = elements.find(
        (el) => el.id === snapTarget.elementId && isConnectable(el),
    );
    if (!targetEl) return null;

    return (
        <>
            {/* Shape-matched highlight border around drop-target */}
            <ShapeHighlight el={targetEl} color={color} viewportScale={viewportScale} />
            {/* Edge-point indicator on perimeter */}
            <Circle
                x={snapTarget.position.x}
                y={snapTarget.position.y}
                radius={6 / viewportScale}
                fill={color}
                stroke="white"
                strokeWidth={2 / viewportScale}
                listening={false}
                perfectDrawEnabled={false}
            />
            {/* Center indicator — shown when snap will use center binding */}
            {!snapTarget.isPrecise && (() => {
                // For rotated shapes, the visual center is rotated around the
                // shape origin (x, y). Compute proper world-space center.
                const rot = targetEl.rotation || 0;
                const rawCenter = { x: targetEl.x + targetEl.width / 2, y: targetEl.y + targetEl.height / 2 };
                const center = rot !== 0
                    ? rotatePoint(rawCenter, { x: targetEl.x, y: targetEl.y }, (rot * Math.PI) / 180)
                    : rawCenter;
                return (
                    <Circle
                        x={center.x}
                        y={center.y}
                        radius={4 / viewportScale}
                        fill="white"
                        stroke={color}
                        strokeWidth={2 / viewportScale}
                        listening={false}
                        perfectDrawEnabled={false}
                    />
                );
            })()}
        </>
    );
};

export default React.memo(ConnectionPointsOverlay);
