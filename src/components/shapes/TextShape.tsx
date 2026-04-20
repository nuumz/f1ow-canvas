/**
 * TextShape.tsx
 *
 * Transparent Konva hit area for standalone text and shape-bound text.
 * Visual rendering and editing are handled by TextHtmlOverlay.
 *
 * For connector labels (text bound to arrows/lines), see TextLabel.tsx.
 *
 * Responsibilities:
 * - Hit detection (click, double-click, drag, transform)
 * - Dimension sync (measureLabelText → store width/height)
 * - Bound text positioning (container inner rect)
 */
import React, { useRef, useEffect, useCallback, useMemo } from 'react';
import { Text } from 'react-konva';
import type Konva from 'konva';
import type { TextElement, CanvasElement } from '@/types';
import { snapToGrid } from '@/utils/geometry';
import { LABEL_LINE_HEIGHT } from '@/utils/labelMetrics';
import { markdownToPlainText } from '@/utils/markdown';

const LINE_HEIGHT = LABEL_LINE_HEIGHT;

interface Props {
    element: TextElement;
    isSelected: boolean;
    /** When true, individual drag is disabled — the parent KonvaGroup handles dragging */
    isGrouped?: boolean;
    onSelect: (id: string) => void;
    onDoubleClick?: (id: string) => void;
    onChange: (id: string, updates: Partial<TextElement>) => void;
    onDragMove?: (id: string, updates: Partial<TextElement>) => void;
    /** If true, auto-opens the textarea editor immediately after mount */
    autoEdit?: boolean;
    /** Called to notify parent that text editing started */
    onEditStart?: (id: string) => void;
    /** Called to notify parent that text editing ended */
    onEditEnd?: (id: string, isEmpty: boolean) => void;
    /** All elements (for resolving containerId position) */
    allElements?: CanvasElement[];
    /** Grid snap size (0 or undefined = no snap) */
    gridSnap?: number;
}

const TextShape: React.FC<Props> = ({
    element,
    isSelected,
    isGrouped,
    onSelect,
    onDoubleClick,
    onChange,
    onDragMove,
    autoEdit,
    onEditStart,
    onEditEnd,
    allElements,
    gridSnap,
}) => {
    const { id, x, y, width, height, rotation, style, text, containerId, textAlign, verticalAlign, isLocked } = element;
    const textRef = useRef<Konva.Text>(null);
    const visibleText = useMemo(() => markdownToPlainText(text || '') || ' ', [text]);

    // ── Resolve container position for bound text ─────────────
    const isBound = !!containerId;
    const isDraggable = !isBound && !isLocked && !isGrouped;
    const container = useMemo(() => {
        if (!containerId || !allElements) return null;
        return allElements.find(el => el.id === containerId) ?? null;
    }, [containerId, allElements]);

    // Bound text position & size: spans the container's inner rect.
    // Konva's <Text verticalAlign=...> handles pixel-perfect centering
    // using real font ascent/descent when BOTH width and height are set.
    const boundPos = useMemo(() => {
        if (!container) return { x, y };

        const PADDING = 4;
        return {
            x: container.x + PADDING,
            y: container.y + PADDING,
            width: Math.max(20, container.width - PADDING * 2),
            height: Math.max(20, container.height - PADDING * 2),
        };
    }, [container, x, y]);

    // ── Measure and sync size from Konva Text node ────────────
    const syncSize = useCallback(() => {
        const node = textRef.current;
        if (!node) return;

        const updates: Partial<TextElement> = {};
        let needsUpdate = false;

        // For bound text, height is driven by the container (via boundPos)
        // and Konva's verticalAlign handles centering internally. The stored
        // height is no longer used for positioning, so skip syncing it to
        // avoid writing container-derived values back to the text element.
        if (!isBound) {
            const measuredHeight = node.height();
            if (Math.abs(measuredHeight - height) > 1) {
                updates.height = measuredHeight;
                needsUpdate = true;
            }
            // Standalone text: sync width to actual rendered text width
            const measuredWidth = Math.ceil(node.getTextWidth());
            if (Math.abs(measuredWidth - width) > 1) {
                updates.width = measuredWidth;
                needsUpdate = true;
            }
        }

        if (needsUpdate) {
            onChange(id, updates);
        }
    }, [id, height, width, isBound, onChange]);

    // Sync size when text/style changes.
    // Also re-sync when autoEdit turns off (finish editing) so transformer
    // bounds always match the newly-committed text.
    useEffect(() => {
        if (isBound || autoEdit) return;
        const id = requestAnimationFrame(syncSize);
        return () => cancelAnimationFrame(id);
    }, [visibleText, style.fontSize, style.fontFamily, isBound, autoEdit, syncSize]);

    // Effective position and size: bound text follows container.
    // Standalone text: don't pass width/height → Konva auto-measures.
    // Bound text: pass BOTH width and height so Konva's verticalAlign
    // can center using real font ascent/descent metrics.
    const effectiveX = isBound ? boundPos.x : x;
    const effectiveY = isBound ? boundPos.y : y;
    const effectiveWidth = isBound && boundPos.width ? boundPos.width : undefined;
    const effectiveHeight = isBound && boundPos.height ? boundPos.height : undefined;
    const effectiveAlign = isBound ? (textAlign || 'center') : undefined;
    const effectiveVerticalAlign = isBound ? (verticalAlign || 'middle') : undefined;

    // Bound text: paint visibly here so it sits at the container's z-index
    // inside the Konva layer (HTML overlay no longer renders bound text
    // except during edit). Standalone text stays transparent — the HTML
    // overlay still owns visual rendering for markdown.
    const fillColor = isBound ? (style.strokeColor || '#1a1a1a') : 'transparent';
    const textOpacity = isBound ? (style.opacity ?? 1) : 1;

    return (
        <Text
            ref={textRef}
            id={id}
            x={effectiveX}
            y={effectiveY}
            text={visibleText}
            fontSize={style.fontSize}
            fontFamily={style.fontFamily}
            fill={fillColor}
            opacity={textOpacity}
            lineHeight={LINE_HEIGHT}
            width={effectiveWidth}
            height={effectiveHeight}
            align={effectiveAlign}
            verticalAlign={effectiveVerticalAlign}
            wrap={isBound ? 'word' : 'none'}
            rotation={isBound ? (container?.rotation ?? rotation) : rotation}
            // Text resize relies on Transformer scale; keep full transforms enabled.
            transformsEnabled="all"
            visible={!autoEdit}
            draggable={isDraggable && !autoEdit}
            listening={!isBound}
            onClick={isBound ? undefined : () => onSelect(id)}
            onTap={isBound ? undefined : () => onSelect(id)}
            onDblClick={isBound ? undefined : () => onDoubleClick?.(id)}
            onDblTap={isBound ? undefined : () => onDoubleClick?.(id)}
            hitStrokeWidth={isBound ? 0 : 10}
            perfectDrawEnabled={false}
            onDragMove={isBound ? undefined : (e) => {
                let nx = e.target.x(), ny = e.target.y();
                if (gridSnap) { nx = snapToGrid(nx, gridSnap); ny = snapToGrid(ny, gridSnap); e.target.x(nx); e.target.y(ny); }
                onDragMove?.(id, { x: nx, y: ny });
            }}
            onDragEnd={isBound ? undefined : (e) => {
                let nx = e.target.x(), ny = e.target.y();
                if (gridSnap) { nx = snapToGrid(nx, gridSnap); ny = snapToGrid(ny, gridSnap); }
                onChange(id, { x: nx, y: ny });
            }}
            onTransformEnd={isBound ? undefined : (e) => {
                const node = e.target as Konva.Text;
                const scaleX = node.scaleX();
                const scaleY = node.scaleY();
                const scale = Math.max(Math.abs(scaleX), Math.abs(scaleY));
                const newFontSize = Math.max(8, Math.round(style.fontSize * scale));
                node.scaleX(1);
                node.scaleY(1);
                onChange(id, {
                    x: node.x(),
                    y: node.y(),
                    rotation: node.rotation(),
                    style: { ...style, fontSize: newFontSize },
                });
            }}
        />
    );
};

export default React.memo(TextShape);
