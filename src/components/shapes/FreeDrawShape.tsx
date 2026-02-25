import React, { useCallback, useMemo } from 'react';
import { Line, Path, Shape } from 'react-konva';
import type Konva from 'konva';
import type { FreeDrawElement } from '@/types';
import { snapToGrid } from '@/utils/geometry';
import { SELECTION_SHADOW } from '@/constants';
import { getFreehandPath, computeFreedrawBBox } from '@/utils/freehand';
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

    const handleDragMove = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
        let nx = e.target.x(), ny = e.target.y();
        if (gridSnap) { nx = snapToGrid(nx, gridSnap); ny = snapToGrid(ny, gridSnap); e.target.x(nx); e.target.y(ny); }
        if (!gridSnap && onDragSnap) {
            const { minX, minY, width, height } = computeFreedrawBBox(points);
            const snapped = onDragSnap(id, { x: nx + minX, y: ny + minY, width, height });
            if (snapped) { nx = snapped.x - minX; ny = snapped.y - minY; e.target.x(nx); e.target.y(ny); }
        }
        onDragMove?.(id, { x: nx, y: ny });
    }, [id, gridSnap, points, onDragMove, onDragSnap]);

    const handleDragEnd = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
        let nx = e.target.x(), ny = e.target.y();
        if (gridSnap) { nx = snapToGrid(nx, gridSnap); ny = snapToGrid(ny, gridSnap); }
        onChange(id, { x: nx, y: ny });
    }, [id, gridSnap, onChange]);

    const handleTransformEnd = useCallback((e: Konva.KonvaEventObject<Event>) => {
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
    // standard style renders via Konva <Line> (uniform stroke width).
    // pen + brush use perfect-freehand for pressure-sensitive filled paths.
    const useVariablePath = freehandStyle === 'pen' || freehandStyle === 'brush';
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
                thinning: 0.7,
                smoothing: 0.5,
                streamline: 0.5,
                simulatePressure: true,
                last: isLast,
                start: { cap: true },
                end:   { cap: true },
            });
        }

        // pen: pressure-sensitive calligraphic stroke
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
    }, [points, element.pressures, useVariablePath, freehandStyle, style.strokeWidth, drawing]);

    // Memoised point decimation for pencil/rough mode.
    // Keeps only points separated by > 1.5 px to prevent excessive wobble on
    // dense strokes while preserving the overall shape of the path.
    const simplifiedPoints = useMemo<number[]>(() => {
        if (!useRoughPath || points.length === 0) return [];
        const result: number[] = [points[0], points[1]];
        let lastX = points[0];
        let lastY = points[1];
        for (let i = 2; i < points.length; i += 2) {
            const px = points[i];
            const py = points[i + 1];
            const dx = px - lastX;
            const dy = py - lastY;
            if (dx * dx + dy * dy > 2.25 || i === points.length - 2) {
                result.push(px, py);
                lastX = px;
                lastY = py;
            }
        }
        return result;
    }, [useRoughPath, points]);

    // Memoised sceneFunc for pencil style — avoids recreating the closure and
    // rerunning roughness computations on every render.
    const pencilSceneFunc = useCallback((ctx: Konva.Context, shape: Konva.Shape) => {
        const roughness = style.roughness;
        const rng = createRNG(id);
        ctx.beginPath();
        drawRoughPolyline(ctx, simplifiedPoints, roughness, rng, getRoughPasses(roughness), style.strokeWidth);
        ctx.fillStrokeShape(shape);
    }, [id, simplifiedPoints, style.roughness, style.strokeWidth]);

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
        return (
            <Shape
                id={id}
                x={renderX}
                y={renderY}
                // Explicit dimensions so Konva can compute getSelfRect() correctly.
                // Without them, a custom sceneFunc Shape returns {w:0, h:0} and is
                // excluded from the layer cache, causing strokes to disappear.
                width={drawing ? undefined : element.width}
                height={drawing ? undefined : element.height}
                rotation={rotation}
                transformsEnabled={rotation ? 'all' : 'position'}
                sceneFunc={pencilSceneFunc}
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
