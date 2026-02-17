import React, { useCallback } from 'react';
import { Ellipse, Shape } from 'react-konva';
import type { EllipseElement } from '@/types';
import { getStrokeDash, snapToGrid } from '@/utils/geometry';
import { SELECTION_SHADOW } from '@/constants';
import { createRNG, drawRoughEllipseStrokes, getRoughPasses } from '@/utils/roughness';

interface Props {
    element: EllipseElement;
    isSelected: boolean;
    /** When true, individual drag is disabled — the parent KonvaGroup handles dragging */
    isGrouped?: boolean;
    onSelect: (id: string) => void;
    onChange: (id: string, updates: Partial<EllipseElement>) => void;
    onDragMove?: (id: string, updates: Partial<EllipseElement>) => void;
    onDoubleClick?: (id: string) => void;
    gridSnap?: number;
    onDragSnap?: (id: string, bounds: { x: number; y: number; width: number; height: number }) => { x: number; y: number } | null;
}

const EllipseShape: React.FC<Props> = ({ element, isSelected, isGrouped, onSelect, onChange, onDragMove, onDoubleClick, gridSnap, onDragSnap }) => {
    const { id, x, y, width, height, rotation, style, isLocked } = element;
    const isDraggable = !isLocked && !isGrouped;
    const roughness = style.roughness;

    // Shared handlers ──────────────────────────────────────────
    const handleClick = useCallback(() => onSelect(id), [onSelect, id]);
    const handleDblClick = useCallback(() => onDoubleClick?.(id), [onDoubleClick, id]);

    const handleDragMove = useCallback((e: any) => {
        let cx = e.target.x(), cy = e.target.y();
        if (gridSnap) {
            const sx = snapToGrid(cx - width / 2, gridSnap);
            const sy = snapToGrid(cy - height / 2, gridSnap);
            cx = sx + width / 2; cy = sy + height / 2;
            e.target.x(cx); e.target.y(cy);
        }
        if (!gridSnap && onDragSnap) {
            const snapped = onDragSnap(id, { x: cx - width / 2, y: cy - height / 2, width, height });
            if (snapped) { cx = snapped.x + width / 2; cy = snapped.y + height / 2; e.target.x(cx); e.target.y(cy); }
        }
        onDragMove?.(id, { x: cx - width / 2, y: cy - height / 2 });
    }, [id, gridSnap, width, height, onDragMove, onDragSnap]);

    const handleDragEnd = useCallback((e: any) => {
        let cx = e.target.x(), cy = e.target.y();
        if (gridSnap) {
            const sx = snapToGrid(cx - width / 2, gridSnap);
            const sy = snapToGrid(cy - height / 2, gridSnap);
            cx = sx + width / 2; cy = sy + height / 2;
        }
        onChange(id, { x: cx - width / 2, y: cy - height / 2 });
    }, [id, gridSnap, width, height, onChange]);

    const handleTransform = useCallback((e: any) => {
        const node = e.target;
        const sx = node.scaleX();
        const sy = node.scaleY();
        const rX = Math.max(5, (width * sx) / 2);
        const rY = Math.max(5, (height * sy) / 2);
        node.setAttrs({ scaleX: 1, scaleY: 1, radiusX: rX, radiusY: rY });
        const newW = rX * 2;
        const newH = rY * 2;
        onDragMove?.(id, { x: node.x() - rX, y: node.y() - rY, width: newW, height: newH });
    }, [id, width, height, onDragMove]);

    const handleTransformEnd = useCallback((e: any) => {
        const node = e.target;
        const rX = node.getAttr('radiusX') as number;
        const rY = node.getAttr('radiusY') as number;
        node.setAttrs({ scaleX: 1, scaleY: 1 });
        const newWidth = Math.max(5, rX * 2);
        const newHeight = Math.max(5, rY * 2);
        onChange(id, {
            x: node.x() - rX,
            y: node.y() - rY,
            width: newWidth,
            height: newHeight,
            rotation: node.rotation(),
        });
    }, [id, onChange]);

    // Selection shadow props
    const shadowColor = isSelected ? SELECTION_SHADOW.color : undefined;
    const shadowBlur = isSelected ? SELECTION_SHADOW.blur : 0;
    const shadowOpacity = isSelected ? SELECTION_SHADOW.opacity : 0;

    // ─── Rough mode ───────────────────────────────────────────
    if (roughness > 0) {
        const passes = getRoughPasses(roughness);
        const rx = width / 2;
        const ry = height / 2;

        return (
            <Shape
                id={id}
                x={x + rx}
                y={y + ry}
                rotation={rotation}
                transformsEnabled={rotation ? 'all' : 'position'}
                sceneFunc={(ctx, shape) => {
                    // 1. Fill with clean ellipse path
                    ctx.beginPath();
                    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
                    ctx.fillShape(shape);

                    // 2. Rough stroke (per-pass seeding for organic look)
                    for (let p = 0; p < passes; p++) {
                        const rng = createRNG(id + ':' + p);
                        ctx.beginPath();
                        drawRoughEllipseStrokes(ctx, 0, 0, rx, ry, roughness, rng, 1, style.strokeWidth);
                        ctx.strokeShape(shape);
                    }
                }}
                fill={style.fillColor}
                stroke={style.strokeColor}
                strokeWidth={style.strokeWidth}
                opacity={style.opacity}
                dash={getStrokeDash(style.strokeStyle, style.strokeWidth)}
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
        <Ellipse
            id={id}
            x={x + width / 2}
            y={y + height / 2}
            radiusX={width / 2}
            radiusY={height / 2}
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

export default React.memo(EllipseShape);
