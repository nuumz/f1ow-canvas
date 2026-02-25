import React, { useCallback, useMemo } from 'react';
import { Line, Path, Shape } from 'react-konva';
import type { FreeDrawElement } from '@/types';
import { snapToGrid } from '@/utils/geometry';
import { SELECTION_SHADOW } from '@/constants';
import { getFreehandPath } from '@/utils/freehand';
import { createRNG, drawRoughPolyline, getRoughPasses } from '@/utils/roughness';

interface Props {
    element: FreeDrawElement;
    isSelected: boolean;
    /** When true, individual drag is disabled — the parent KonvaGroup handles dragging */
    isGrouped?: boolean;
    onSelect: (id: string) => void;
    onChange: (id: string, updates: Partial<FreeDrawElement>) => void;
    onDragMove?: (id: string, updates: Partial<FreeDrawElement>) => void;
    onDoubleClick?: (id: string) => void;
    gridSnap?: number;
    onDragSnap?: (id: string, bounds: { x: number; y: number; width: number; height: number }) => { x: number; y: number } | null;
}

const FreeDrawShape: React.FC<Props> = ({ element, isSelected, isGrouped, onSelect, onChange, onDragMove, onDoubleClick, gridSnap, onDragSnap }) => {
    const { id, x, y, points, rotation, style, isLocked } = element;
    const isDraggable = !isLocked && !isGrouped;

    const handleClick = useCallback(() => onSelect(id), [onSelect, id]);
    const handleDblClick = useCallback(() => onDoubleClick?.(id), [onDoubleClick, id]);

    const handleDragMove = useCallback((e: any) => {
        let nx = e.target.x(), ny = e.target.y();
        if (gridSnap) { nx = snapToGrid(nx, gridSnap); ny = snapToGrid(ny, gridSnap); e.target.x(nx); e.target.y(ny); }
        if (!gridSnap && onDragSnap) {
            // Compute rough bounding box for smart snap
            let minX = 0, minY = 0, maxX = 0, maxY = 0;
            for (let i = 0; i < points.length; i += 2) {
                minX = Math.min(minX, points[i]);
                maxX = Math.max(maxX, points[i]);
                minY = Math.min(minY, points[i + 1]);
                maxY = Math.max(maxY, points[i + 1]);
            }
            const snapped = onDragSnap(id, { x: nx + minX, y: ny + minY, width: maxX - minX, height: maxY - minY });
            if (snapped) { nx = snapped.x - minX; ny = snapped.y - minY; e.target.x(nx); e.target.y(ny); }
        }
        onDragMove?.(id, { x: nx, y: ny });
    }, [id, gridSnap, points, onDragMove, onDragSnap]);

    const handleDragEnd = useCallback((e: any) => {
        let nx = e.target.x(), ny = e.target.y();
        if (gridSnap) { nx = snapToGrid(nx, gridSnap); ny = snapToGrid(ny, gridSnap); }
        onChange(id, { x: nx, y: ny });
    }, [id, gridSnap, onChange]);

    const handleTransformEnd = useCallback((e: any) => {
        const node = e.target;
        const sx = node.scaleX();
        const sy = node.scaleY();
        node.setAttrs({ scaleX: 1, scaleY: 1 });
        const newPoints = points.map((v, i) => i % 2 === 0 ? v * sx : v * sy);
        onChange(id, {
            x: node.x(),
            y: node.y(),
            points: newPoints,
            rotation: node.rotation(),
        });
    }, [id, points, onChange]);

    // Selection shadow props
    const shadowColor = isSelected ? SELECTION_SHADOW.color : undefined;
    const shadowBlur = isSelected ? SELECTION_SHADOW.blur : 0;
    const shadowOpacity = isSelected ? SELECTION_SHADOW.opacity : 0;

    const freehandStyle = style.freehandStyle || 'standard';
    // isComplete === false → stroke is still being drawn; points are in world
    // coordinates, so render at (0, 0) and keep end cap open (last: false).
    const drawing = element.isComplete === false;
    const renderX = drawing ? 0 : x;
    const renderY = drawing ? 0 : y;
    const useVariablePath = freehandStyle === 'pen' || freehandStyle === 'brush' || freehandStyle === 'standard';
    const useRoughPath = freehandStyle === 'pencil';

    const svgPath = useMemo(() => {
        if (!useVariablePath) return '';
        // last: false during active drawing keeps the end cap open, which is
        // faster to compute and looks more natural in real-time.
        const isLast = !drawing;

        if (freehandStyle === 'brush') {
            const brushSize = style.strokeWidth * 4;
            return getFreehandPath(points, element.pressures, {
                size: brushSize,
                // 0.7 mirrors tldraw's DrawUtil default — gives strong calligraphic
                // variation: fast strokes go thin, slow/heavy strokes go full width.
                thinning: 0.7,
                smoothing: 0.5,
                streamline: 0.5,
                simulatePressure: true,
                // Linear easing (default) — no clamping.  The first point's
                // DEFAULT_FIRST_PRESSURE (0.25) already creates a natural thin
                // start without needing a taper zone.  The end cap rounds off
                // the stroke tip organically when the stroke is finalised.
                last: isLast,
                // NO fixed-pixel taper: caps + DEFAULT_FIRST_PRESSURE are enough.
                // Adding taper zones forces a radius fade over a fixed distance,
                // which looks artificial and makes long strokes permanently thin.
                start: { cap: true },
                end:   { cap: true },
            });
        }

        if (freehandStyle === 'pen') {
            return getFreehandPath(points, element.pressures, {
                size: style.strokeWidth * 1.8,
                thinning: 0.6,
                smoothing: 0.5,
                streamline: 0.5,
                simulatePressure: true,
                last: isLast,
                start: { cap: true, taper: 0 },
                end: { cap: true, taper: 0 },
            });
        }

        // standard: smooth constant-width stroke rendered as filled path
        return getFreehandPath(points, element.pressures, {
            size: style.strokeWidth,
            thinning: 0,       // constant width — no pressure effect
            smoothing: 0.5,
            streamline: 0.5,
            simulatePressure: false,
            last: isLast,
            start: { cap: true },
            end: { cap: true },
        });
    }, [points, element.pressures, useVariablePath, freehandStyle, style.strokeWidth, drawing]);

    if (useVariablePath && svgPath) {
        return (
            <Path
                id={id}
                x={renderX}
                y={renderY}
                data={svgPath}
                rotation={rotation}
                transformsEnabled={rotation ? 'all' : 'position'}
                fill={style.strokeColor}
                opacity={style.opacity}
                draggable={isDraggable}
                onClick={handleClick}
                onTap={handleClick}
                onDblClick={handleDblClick}
                onDblTap={handleDblClick}
                shadowColor={shadowColor}
                shadowBlur={shadowBlur}
                shadowOpacity={shadowOpacity}
                hitStrokeWidth={20}
                onDragMove={handleDragMove}
                onDragEnd={handleDragEnd}
                onTransformEnd={handleTransformEnd}
                perfectDrawEnabled={false}
                shadowForStrokeEnabled={false}
            />
        );
    }

    if (useRoughPath) {
        // Pencil style: use rough.js-like rendering for a sketchy, hand-drawn look
        const roughness = 1; // Artist level roughness
        const passes = getRoughPasses(roughness);
        
        return (
            <Shape
                id={id}
                x={renderX}
                y={renderY}
                rotation={rotation}
                transformsEnabled={rotation ? 'all' : 'position'}
                sceneFunc={(ctx, shape) => {
                    const rng = createRNG(id);
                    ctx.beginPath();
                    
                    // For pencil, we want a continuous line, not disconnected segments.
                    // drawRoughPolyline draws each segment as a separate bezier curve.
                    // We can use it directly, but we might want to simplify the points first
                    // if there are too many, to avoid excessive wobble.
                    // For now, let's just use drawRoughPolyline.
                    
                    // Simplify points to avoid too many segments and excessive wobble
                    const simplifiedPoints: number[] = [];
                    if (points.length > 0) {
                        simplifiedPoints.push(points[0], points[1]);
                        let lastX = points[0];
                        let lastY = points[1];
                        for (let i = 2; i < points.length; i += 2) {
                            const x = points[i];
                            const y = points[i + 1];
                            const dx = x - lastX;
                            const dy = y - lastY;
                            const dist = Math.sqrt(dx * dx + dy * dy);
                            // Only add point if it's far enough from the last one
                            // Use a smaller distance threshold for smoother curves
                            if (dist > 1.5 || i === points.length - 2) {
                                simplifiedPoints.push(x, y);
                                lastX = x;
                                lastY = y;
                            }
                        }
                    }
                    
                    drawRoughPolyline(ctx, simplifiedPoints, roughness, rng, passes, style.strokeWidth);
                    ctx.fillStrokeShape(shape);
                }}
                stroke={style.strokeColor}
                strokeWidth={style.strokeWidth}
                opacity={style.opacity}
                lineCap="round"
                lineJoin="round"
                draggable={isDraggable}
                onClick={handleClick}
                onTap={handleClick}
                onDblClick={handleDblClick}
                onDblTap={handleDblClick}
                shadowColor={shadowColor}
                shadowBlur={shadowBlur}
                shadowOpacity={shadowOpacity}
                hitStrokeWidth={Math.max(20, style.strokeWidth + 16)}
                onDragMove={handleDragMove}
                onDragEnd={handleDragEnd}
                onTransformEnd={handleTransformEnd}
                perfectDrawEnabled={false}
                shadowForStrokeEnabled={false}
            />
        );
    }

    return (
        <Line
            id={id}
            x={renderX}
            y={renderY}
            points={points}
            rotation={rotation}
            transformsEnabled={rotation ? 'all' : 'position'}
            stroke={style.strokeColor}
            strokeWidth={style.strokeWidth}
            opacity={style.opacity}
            lineCap="round"
            lineJoin="round"
            tension={0.5}
            globalCompositeOperation="source-over"
            draggable={isDraggable}
            onClick={handleClick}
            onTap={handleClick}
            onDblClick={handleDblClick}
            onDblTap={handleDblClick}
            shadowColor={shadowColor}
            shadowBlur={shadowBlur}
            shadowOpacity={shadowOpacity}
            hitStrokeWidth={20}
            onDragMove={handleDragMove}
            onDragEnd={handleDragEnd}
            onTransformEnd={handleTransformEnd}
            perfectDrawEnabled={false}
            shadowForStrokeEnabled={false}
        />
    );
};

export default React.memo(FreeDrawShape);
