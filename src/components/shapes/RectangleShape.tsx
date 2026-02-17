import React, { useCallback } from 'react';
import { Rect, Shape } from 'react-konva';
import type { RectangleElement } from '@/types';
import { getStrokeDash, snapToGrid } from '@/utils/geometry';
import { SELECTION_SHADOW } from '@/constants';
import { createRNG, drawRoughRectStrokes, getRoughPasses } from '@/utils/roughness';

interface Props {
    element: RectangleElement;
    isSelected: boolean;
    /** When true, individual drag is disabled — the parent KonvaGroup handles dragging */
    isGrouped?: boolean;
    onSelect: (id: string) => void;
    onChange: (id: string, updates: Partial<RectangleElement>) => void;
    onDragMove?: (id: string, updates: Partial<RectangleElement>) => void;
    onDoubleClick?: (id: string) => void;
    gridSnap?: number;
    onDragSnap?: (id: string, bounds: { x: number; y: number; width: number; height: number }) => { x: number; y: number } | null;
}

/**
 * Draw a rounded-rect path into the canvas context via arcTo.
 * Works in both native Canvas 2D and Konva's Context wrapper.
 */
function roundedRectPath(
    ctx: { beginPath(): void; moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void; closePath(): void },
    x: number, y: number, w: number, h: number, r: number,
): void {
    const cr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + cr, y);
    ctx.lineTo(x + w - cr, y);
    ctx.arcTo(x + w, y, x + w, y + cr, cr);
    ctx.lineTo(x + w, y + h - cr);
    ctx.arcTo(x + w, y + h, x + w - cr, y + h, cr);
    ctx.lineTo(x + cr, y + h);
    ctx.arcTo(x, y + h, x, y + h - cr, cr);
    ctx.lineTo(x, y + cr);
    ctx.arcTo(x, y, x + cr, y, cr);
    ctx.closePath();
}

const RectangleShape: React.FC<Props> = ({ element, isSelected, isGrouped, onSelect, onChange, onDragMove, onDoubleClick, gridSnap, onDragSnap }) => {
    const { id, x, y, width, height, rotation, cornerRadius, style, isLocked } = element;
    const isDraggable = !isLocked && !isGrouped;
    const roughness = style.roughness;

    // Shared event handlers ────────────────────────────────────
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
        const newW = Math.max(5, node.width() * sx);
        const newH = Math.max(5, node.height() * sy);
        node.setAttrs({ scaleX: 1, scaleY: 1, width: newW, height: newH });
        onDragMove?.(id, { x: node.x(), y: node.y(), width: newW, height: newH });
    }, [id, onDragMove]);

    const handleTransformEnd = useCallback((e: any) => {
        const node = e.target;
        const w = Math.max(5, node.width() * node.scaleX());
        const h = Math.max(5, node.height() * node.scaleY());
        node.setAttrs({ scaleX: 1, scaleY: 1, width: w, height: h });
        onChange(id, {
            x: node.x(),
            y: node.y(),
            width: w,
            height: h,
            rotation: node.rotation(),
        });
    }, [id, onChange]);

    // Selection shadow props
    const shadowColor = isSelected ? SELECTION_SHADOW.color : undefined;
    const shadowBlur = isSelected ? SELECTION_SHADOW.blur : 0;
    const shadowOpacity = isSelected ? SELECTION_SHADOW.opacity : 0;

    // ─── Rough mode: use <Shape> with hand-drawn strokes ──────
    if (roughness > 0) {
        const passes = getRoughPasses(roughness);
        const dash = getStrokeDash(style.strokeStyle, style.strokeWidth);

        return (
            <Shape
                id={id}
                x={x}
                y={y}
                width={width}
                height={height}
                rotation={rotation}
                transformsEnabled={rotation ? 'all' : 'position'}
                sceneFunc={(ctx, shape) => {
                    // 1. Fill — use rounded-rect path when cornerRadius > 0
                    if (cornerRadius > 0) {
                        roundedRectPath(ctx as any, 0, 0, width, height, cornerRadius);
                    } else {
                        ctx.beginPath();
                        ctx.rect(0, 0, width, height);
                    }
                    ctx.fillShape(shape);

                    // 2. Draw rough strokes (per-pass seeding for organic look)
                    for (let p = 0; p < passes; p++) {
                        const rng = createRNG(id + ':' + p);
                        ctx.beginPath();
                        drawRoughRectStrokes(ctx, 0, 0, width, height, roughness, rng, 1, style.strokeWidth);
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

    // ─── Clean mode (roughness === 0): standard Konva Rect ────
    return (
        <Rect
            id={id}
            x={x}
            y={y}
            width={width}
            height={height}
            rotation={rotation}
            transformsEnabled={rotation ? 'all' : 'position'}
            cornerRadius={cornerRadius}
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

export default React.memo(RectangleShape);
