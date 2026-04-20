/**
 * ConnectionPoints.tsx
 * Visual overlay showing connection drop-zone highlights on shapes
 * when the active tool is line/arrow. Uses area-based detection —
 * highlights the entire shape as a drop target + shows the edge-point.
 *
 * Shows:
 * 1. Shape-matched highlight border (dashed outline)
 * 2. 4 cardinal anchor dots (N/S/E/W) on hovered shape
 * 3. Custom port dots from `element.ports`
 * 4. Active snap-point indicator (filled dot at snapped position)
 */
import React from 'react';
import { Circle, Rect, Ellipse, Line } from 'react-konva';
import type { CanvasElement, SnapTarget, Port } from '@/types';
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

const ANCHOR_FP: Array<[number, number]> = [
    [0.5, 0],   // N
    [0.5, 1],   // S
    [1, 0.5],   // E
    [0, 0.5],   // W
];

/** Anchor dots on the 4 cardinal edges of the hovered shape */
const AnchorDots: React.FC<{ el: CanvasElement; color: string; viewportScale: number; snapTarget: SnapTarget | null }> = ({ el, color, viewportScale, snapTarget }) => {
    const rotation = el.rotation || 0;
    const origin = { x: el.x, y: el.y };
    return (
        <>
            {ANCHOR_FP.map((fp, i) => {
                const raw = { x: el.x + fp[0] * el.width, y: el.y + fp[1] * el.height };
                const pt = rotation !== 0 ? rotatePoint(raw, origin, (rotation * Math.PI) / 180) : raw;
                const isActive = snapTarget?.snapMode === 'anchor' &&
                    snapTarget.fixedPoint[0] === fp[0] && snapTarget.fixedPoint[1] === fp[1];
                return (
                    <Circle
                        key={i}
                        x={pt.x}
                        y={pt.y}
                        radius={(isActive ? 5 : 3.5) / viewportScale}
                        fill={isActive ? color : 'white'}
                        stroke={color}
                        strokeWidth={1.5 / viewportScale}
                        listening={false}
                        perfectDrawEnabled={false}
                    />
                );
            })}
        </>
    );
};

/** Custom port dots from element.ports */
const PortDots: React.FC<{ el: CanvasElement; ports: Port[]; color: string; viewportScale: number; snapTarget: SnapTarget | null }> = ({ el, ports, color, viewportScale, snapTarget }) => {
    const rotation = el.rotation || 0;
    const origin = { x: el.x, y: el.y };
    return (
        <>
            {ports.map((port) => {
                const raw = { x: el.x + port.ratio[0] * el.width, y: el.y + port.ratio[1] * el.height };
                const pt = rotation !== 0 ? rotatePoint(raw, origin, (rotation * Math.PI) / 180) : raw;
                const isActive = snapTarget?.snapMode === 'port' && snapTarget.portId === port.id;
                return (
                    <Circle
                        key={port.id}
                        x={pt.x}
                        y={pt.y}
                        radius={(isActive ? 6 : 4) / viewportScale}
                        fill={isActive ? '#ff6b35' : '#fff3e0'}
                        stroke={'#ff6b35'}
                        strokeWidth={1.5 / viewportScale}
                        listening={false}
                        perfectDrawEnabled={false}
                    />
                );
            })}
        </>
    );
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
            {/* Cardinal anchor dots (N/S/E/W) */}
            <AnchorDots el={targetEl} color={color} viewportScale={viewportScale} snapTarget={snapTarget} />
            {/* Custom port dots */}
            {targetEl.ports && targetEl.ports.length > 0 && (
                <PortDots el={targetEl} ports={targetEl.ports} color={color} viewportScale={viewportScale} snapTarget={snapTarget} />
            )}
            {/* Edge/port/anchor point indicator — shown when snap is precise */}
            {snapTarget.isPrecise && snapTarget.snapMode !== 'anchor' && snapTarget.snapMode !== 'port' && (
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
            )}
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
