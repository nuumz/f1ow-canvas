import React, { useCallback } from 'react';
import { Rect as KonvaRect } from 'react-konva';
import type { CanvasElement } from '../../types';
import RectangleShape from '../shapes/RectangleShape';
import EllipseShape from '../shapes/EllipseShape';
import DiamondShape from '../shapes/DiamondShape';
import LineShape from '../shapes/LineShape';
import ArrowShape from '../shapes/ArrowShape';
import FreeDrawShape from '../shapes/FreeDrawShape';
import TextShape from '../shapes/TextShape';
import ImageShape from '../shapes/ImageShape';

// ─── LOD (Level of Detail) thresholds ─────────────────────────
// Screen-space pixels (element's max dimension × viewport scale).
// Below SKIP: element is sub-pixel — don't render at all.
// Below SIMPLIFY: render a cheap colored rectangle placeholder.
const LOD_SKIP_THRESHOLD = 2;
const LOD_SIMPLIFY_THRESHOLD = 24;

interface Props {
    element: CanvasElement;
    isSelected: boolean;
    isEditing?: boolean;
    /** When true, individual drag is disabled — the parent KonvaGroup handles dragging */
    isGrouped?: boolean;
    onSelect: (id: string) => void;
    onChange: (id: string, updates: Partial<CanvasElement>) => void;
    onDragMove?: (id: string, updates: Partial<CanvasElement>) => void;
    onDoubleClick?: (id: string) => void;
    /** Text-specific: auto-open editor on mount */
    autoEditText?: boolean;
    /** Text-specific: editing started */
    onTextEditStart?: (id: string) => void;
    /** Text-specific: editing ended */
    onTextEditEnd?: (id: string, isEmpty: boolean) => void;
    /** All elements for resolving containerId position */
    allElements?: CanvasElement[];
    /** Grid snap size (0 or undefined = no snap) */
    gridSnap?: number;
    /** Alignment snap: returns snapped {x,y} given current bounds */
    onDragSnap?: (id: string, bounds: { x: number; y: number; width: number; height: number }) => { x: number; y: number } | null;
    /**
     * Current viewport scale (efficient/discretized zoom).
     * When provided, enables LOD optimisation for non-selected elements:
     *   - < LOD_SKIP_THRESHOLD screen px → skip rendering entirely
     *   - < LOD_SIMPLIFY_THRESHOLD screen px → render simplified rect
     */
    viewportScale?: number;
}

const CanvasElementRenderer: React.FC<Props> = ({
    element, isSelected, isEditing, isGrouped, onSelect, onChange, onDragMove, onDoubleClick,
    autoEditText, onTextEditStart, onTextEditEnd, allElements, gridSnap, onDragSnap,
    viewportScale,
}) => {
    // Stable callback for LOD placeholder click
    const handleLODClick = useCallback(() => onSelect(element.id), [onSelect, element.id]);

    if (!element.isVisible) return null;

    // ─── LOD: degrade non-selected elements that are tiny on screen ──
    if (viewportScale !== undefined && !isSelected && !isEditing) {
        const screenSize = Math.max(element.width, element.height) * viewportScale;

        // Sub-pixel — invisible, skip entirely
        if (screenSize < LOD_SKIP_THRESHOLD) return null;

        // Small — render a cheap coloured rectangle placeholder
        if (screenSize < LOD_SIMPLIFY_THRESHOLD) {
            return (
                <KonvaRect
                    x={element.x}
                    y={element.y}
                    width={element.width}
                    height={element.height}
                    fill={element.style?.fillColor || '#e0e0e0'}
                    stroke={element.style?.strokeColor || '#999'}
                    strokeWidth={1 / viewportScale}
                    opacity={element.style?.opacity ?? 1}
                    onClick={handleLODClick}
                    onTap={handleLODClick}
                    perfectDrawEnabled={false}
                    shadowForStrokeEnabled={false}
                    transformsEnabled="position"
                />
            );
        }
    }

    switch (element.type) {
        case 'rectangle':
            return <RectangleShape element={element} isSelected={isSelected} isGrouped={isGrouped} onSelect={onSelect} onChange={onChange} onDragMove={onDragMove} onDoubleClick={onDoubleClick} gridSnap={gridSnap} onDragSnap={onDragSnap} />;
        case 'ellipse':
            return <EllipseShape element={element} isSelected={isSelected} isGrouped={isGrouped} onSelect={onSelect} onChange={onChange} onDragMove={onDragMove} onDoubleClick={onDoubleClick} gridSnap={gridSnap} onDragSnap={onDragSnap} />;
        case 'diamond':
            return <DiamondShape element={element} isSelected={isSelected} isGrouped={isGrouped} onSelect={onSelect} onChange={onChange} onDragMove={onDragMove} onDoubleClick={onDoubleClick} gridSnap={gridSnap} onDragSnap={onDragSnap} />;
        case 'line':
            return <LineShape element={element} isSelected={isSelected} isEditing={isEditing} isGrouped={isGrouped} onSelect={onSelect} onChange={onChange} onDragMove={onDragMove} onDoubleClick={onDoubleClick} gridSnap={gridSnap} allElements={allElements} />;
        case 'arrow':
            return <ArrowShape element={element} isSelected={isSelected} isEditing={isEditing} isGrouped={isGrouped} onSelect={onSelect} onChange={onChange} onDragMove={onDragMove} onDoubleClick={onDoubleClick} gridSnap={gridSnap} allElements={allElements} />;
        case 'freedraw':
            return <FreeDrawShape element={element} isSelected={isSelected} isGrouped={isGrouped} onSelect={onSelect} onChange={onChange} onDragMove={onDragMove} onDoubleClick={onDoubleClick} gridSnap={gridSnap} onDragSnap={onDragSnap} />;
        case 'text':
            return (
                <TextShape
                    element={element}
                    isSelected={isSelected}
                    isGrouped={isGrouped}
                    onSelect={onSelect}
                    onChange={onChange}
                    onDragMove={onDragMove}
                    autoEdit={autoEditText}
                    onEditStart={onTextEditStart}
                    onEditEnd={onTextEditEnd}
                    allElements={allElements}
                    gridSnap={gridSnap}
                />
            );
        case 'image':
            return <ImageShape element={element} isSelected={isSelected} isGrouped={isGrouped} onSelect={onSelect} onChange={onChange} onDragMove={onDragMove} onDoubleClick={onDoubleClick} gridSnap={gridSnap} onDragSnap={onDragSnap} />;
        default:
            return null;
    }
};

// ─── Custom comparator for React.memo ────────────────────────
// Only re-render when the element's own data or selection state changes.
// Callbacks are stabilised via useCallback (deps:[readOnly]) in FlowCanvas
// so they are referentially stable across element-change renders.
// `allElements` is intentionally skipped: it changes on every element
// update and would break memoisation for ALL 1000+ components.
// Shapes that need allElements (arrow, line, text) still receive the
// latest value when their OWN element reference changes, which is the
// only time they need to re-render.
function arePropsEqual(prev: Props, next: Props): boolean {
    if (prev.element !== next.element) return false;
    if (prev.isSelected !== next.isSelected) return false;
    if (prev.isEditing !== next.isEditing) return false;
    if (prev.isGrouped !== next.isGrouped) return false;
    if (prev.autoEditText !== next.autoEditText) return false;
    if (prev.viewportScale !== next.viewportScale) return false;
    if (prev.gridSnap !== next.gridSnap) return false;
    return true;
}

export default React.memo(CanvasElementRenderer, arePropsEqual);
