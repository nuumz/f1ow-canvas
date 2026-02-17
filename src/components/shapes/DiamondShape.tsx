import React, { useCallback } from 'react';
import { Line, Shape } from 'react-konva';
import type { DiamondElement } from '@/types';
import { getDiamondPoints, getStrokeDash, snapToGrid } from '@/utils/geometry';
import { SELECTION_SHADOW } from '@/constants';
import { createRNG, drawRoughDiamondStrokes, getRoughPasses } from '@/utils/roughness';

interface Props {
    element: DiamondElement;
    isSelected: boolean;
    /** When true, individual drag is disabled — the parent KonvaGroup handles dragging */
    isGrouped?: boolean;
    onSelect: (id: string) => void;
    onChange: (id: string, updates: Partial<DiamondElement>) => void;
    onDragMove?: (id: string, updates: Partial<DiamondElement>) => void;
    onDoubleClick?: (id: string) => void;
    gridSnap?: number;
    onDragSnap?: (id: string, bounds: { x: number; y: number; width: number; height: number }) => { x: number; y: number } | null;
}

const DiamondShape: React.FC<Props> = ({ element, isSelected, isGrouped, onSelect, onChange, onDragMove, onDoubleClick, gridSnap, onDragSnap }) => {
    const { id, x, y, width, height, rotation, style, isLocked } = element;
    const isDraggable = !isLocked && !isGrouped;
    const roughness = style.roughness;

    // Shared handlers ──────────────────────────────────────────
    const handleClick = useCallback(() => onSelect(id), [onSelect, id]);
    const handleDblClick = useCallback(() => onDoubleClick?.(id), [onDoubleClick, id]);

    const handleDragMove = useCallback((e: any) => {
        let nx = e.target.x(), ny = e.target.y();
        if (gridSnap) { nx = snapToGrid(nx, gridSnap); ny = snapToGrid(ny, gridSnap); e.target.x(nx); e.target.y(ny); }
        if (!gridSnap && onDragSnap) {
            const snapped = onDragSnap(id, { x: nx, y: ny, width, height });
            if (snapped) { nx = snapped.x; ny = snapped.y; e.target.x(nx); e.target.y(ny); }
        }
        onDragMove?.(id, { x: nx, y: ny });
    }, [id, gridSnap, width, height, onDragMove, onDragSnap]);

    const handleDragEnd = useCallback((e: any) => {
        let nx = e.target.x(), ny = e.target.y();
        if (gridSnap) { nx = snapToGrid(nx, gridSnap); ny = snapToGrid(ny, gridSnap); }
        onChange(id, { x: nx, y: ny });
    }, [id, gridSnap, onChange]);

    const handleTransform = useCallback((e: any) => {
        const node = e.target;
        const sx = node.scaleX();
        const sy = node.scaleY();
        const newW = Math.max(5, width * sx);
        const newH = Math.max(5, height * sy);
        node.setAttrs({ scaleX: 1, scaleY: 1, points: getDiamondPoints(newW, newH) });
        onDragMove?.(id, { x: node.x(), y: node.y(), width: newW, height: newH });
    }, [id, width, height, onDragMove]);

    const handleTransformEnd = useCallback((e: any) => {
        const node = e.target;
        node.setAttrs({ scaleX: 1, scaleY: 1 });
        const pts = node.getAttr('points') as number[] | undefined;
        const newW = pts ? pts[2] : width;
        const newH = pts ? pts[5] : height;
        onChange(id, {
            x: node.x(),
            y: node.y(),
            width: Math.max(5, newW),
            height: Math.max(5, newH),
            rotation: node.rotation(),
        });
    }, [id, width, height, onChange]);

    // Selection shadow props
    const shadowColor = isSelected ? SELECTION_SHADOW.color : undefined;
    const shadowBlur = isSelected ? SELECTION_SHADOW.blur : 0;
    const shadowOpacity = isSelected ? SELECTION_SHADOW.opacity : 0;

    // ─── Rough mode ───────────────────────────────────────────
    if (roughness > 0) {
        const passes = getRoughPasses(roughness);
        const dash = getStrokeDash(style.strokeStyle, style.strokeWidth);

        return (
            <Shape
                id={id}
                x={x}
                y={y}
                rotation={rotation}
                transformsEnabled={rotation ? 'all' : 'position'}
                sceneFunc={(ctx, shape) => {
                    // 1. Fill with clean diamond path
                    const pts = getDiamondPoints(width, height);
                    ctx.beginPath();
                    ctx.moveTo(pts[0], pts[1]);
                    for (let i = 2; i < pts.length; i += 2) {
                        ctx.lineTo(pts[i], pts[i + 1]);
                    }
                    ctx.closePath();
                    ctx.fillShape(shape);

                    // 2. Rough strokes (per-pass seeding for organic look)
                    for (let p = 0; p < passes; p++) {
                        const rng = createRNG(id + ':' + p);
                        ctx.beginPath();
                        drawRoughDiamondStrokes(ctx, width, height, roughness, rng, 1, style.strokeWidth);
                        ctx.strokeShape(shape);
                    }
                }}
                fill={style.fillColor}
                stroke={style.strokeColor}
                strokeWidth={style.strokeWidth}
                opacity={style.opacity}
                dash={dash}
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
                onDragMove={handleDragMove}
                onDragEnd={handleDragEnd}
                onTransform={handleTransform}
                onTransformEnd={handleTransformEnd}
                perfectDrawEnabled={false}
                shadowForStrokeEnabled={false}
            />
        );
    }

    // ─── Clean mode ───────────────────────────────────────────
    return (
        <Line
            id={id}
            x={x}
            y={y}
            points={getDiamondPoints(width, height)}
            closed
            rotation={rotation}
            transformsEnabled={rotation ? 'all' : 'position'}
            fill={style.fillColor}
            stroke={style.strokeColor}
            strokeWidth={style.strokeWidth}
            opacity={style.opacity}
            dash={getStrokeDash(style.strokeStyle, style.strokeWidth)}
            draggable={isDraggable}
            onClick={handleClick}
            onTap={handleClick}
            onDblClick={handleDblClick}
            onDblTap={handleDblClick}
            shadowColor={shadowColor}
            shadowBlur={shadowBlur}
            shadowOpacity={shadowOpacity}
            onDragMove={handleDragMove}
            onDragEnd={handleDragEnd}
            onTransform={handleTransform}
            onTransformEnd={handleTransformEnd}
            perfectDrawEnabled={false}
            shadowForStrokeEnabled={false}
        />
    );
};

export default React.memo(DiamondShape);
