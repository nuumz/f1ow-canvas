import React, { useCallback } from 'react';
import { Line } from 'react-konva';
import type { FreeDrawElement } from '@/types';
import { snapToGrid } from '@/utils/geometry';
import { SELECTION_SHADOW } from '@/constants';

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

    return (
        <Line
            id={id}
            x={x}
            y={y}
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
