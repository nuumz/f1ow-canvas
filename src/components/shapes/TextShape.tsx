/**
 * TextShape.tsx
 *
 * Editable text element following the Konva Editable Text pattern:
 *   https://konvajs.org/docs/sandbox/Editable_Text.html
 *
 * Key behaviors:
 * - Double-click → open DOM textarea overlay (viewport-aware positioning)
 * - Enter (without Shift) or click outside → save & close
 * - Escape → cancel edit (revert) & close
 * - Auto-delete when text is empty on blur
 * - Textarea matches canvas font size × zoom level
 * - Supports receiving `autoEdit` flag for immediate editing on creation
 * - Bound text (containerId != null) centers inside parent shape
 */
import React, { useRef, useEffect, useCallback, useMemo } from 'react';
import { Text } from 'react-konva';
import type Konva from 'konva';
import type { TextElement, CanvasElement, ArrowElement, LineElement } from '@/types';
import { computeCurveControlPoint, quadBezierAt, CURVE_RATIO } from '@/utils/curve';
import { snapToGrid } from '@/utils/geometry';

// ── Constants ─────────────────────────────────────────────────
const LINE_HEIGHT = 1.18;

interface Props {
    element: TextElement;
    isSelected: boolean;
    /** When true, individual drag is disabled — the parent KonvaGroup handles dragging */
    isGrouped?: boolean;
    onSelect: (id: string) => void;
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
    const isEditingRef = useRef(false);
    const autoEditDoneRef = useRef(false);

    // ── Resolve container position for bound text ─────────────
    const isBound = !!containerId;
    const isDraggable = !isBound && !isLocked && !isGrouped;
    const container = useMemo(() => {
        if (!containerId || !allElements) return null;
        return allElements.find(el => el.id === containerId) ?? null;
    }, [containerId, allElements]);

    // Bound text position: centered inside the container or at midpoint for linear
    const boundPos = useMemo(() => {
        if (!container) return { x, y };

        // ─── Arrow/Line container: position at midpoint ───────────
        if (container.type === 'arrow' || container.type === 'line') {
            const conn = container as ArrowElement | LineElement;
            const pts = conn.points;
            const startPt = { x: pts[0], y: pts[1] };
            const endPt = { x: pts[pts.length - 2], y: pts[pts.length - 1] };

            let midX: number, midY: number;
            if (conn.lineType === 'curved') {
                const cp = computeCurveControlPoint(startPt, endPt, (conn as ArrowElement).curvature ?? CURVE_RATIO);
                const mid = quadBezierAt(startPt, cp, endPt, 0.5);
                midX = conn.x + mid.x;
                midY = conn.y + mid.y;
            } else {
                midX = conn.x + (startPt.x + endPt.x) / 2;
                midY = conn.y + (startPt.y + endPt.y) / 2;
            }

            const textWidth = Math.max(80, width || 80);
            const textHeight = textRef.current?.height() ?? height;
            return {
                x: midX - textWidth / 2,
                y: midY - textHeight / 2,
                width: textWidth,
            };
        }

        // ─── Shape container: centered inside bounding box ────────
        const PADDING = 4;
        const cw = container.width - PADDING * 2;
        const textWidth = Math.max(20, cw);

        // Horizontal alignment
        const bx = container.x + PADDING;

        // For vertical, compute from actual text height
        const textActualHeight = textRef.current?.height() ?? height;
        let by: number;
        if (verticalAlign === 'top') {
            by = container.y + PADDING;
        } else if (verticalAlign === 'bottom') {
            by = container.y + container.height - textActualHeight - PADDING;
        } else {
            // middle
            by = container.y + (container.height - textActualHeight) / 2;
        }

        return { x: bx, y: by, width: textWidth };
    }, [container, x, y, height, verticalAlign]);

    // ── Measure and sync size from Konva Text node ────────────
    const syncSize = useCallback(() => {
        const node = textRef.current;
        if (!node || isEditingRef.current) return;

        const measuredHeight = node.height();
        const updates: Partial<TextElement> = {};
        let needsUpdate = false;

        if (Math.abs(measuredHeight - height) > 1) {
            updates.height = measuredHeight;
            needsUpdate = true;
        }
        // For standalone text, sync width to actual rendered text width
        if (!isBound) {
            // Use getTextWidth() for exact text pixel width (not box constraint)
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

    // Sync size when text/style changes
    useEffect(() => {
        // Delay to let Konva recalculate after prop changes
        requestAnimationFrame(syncSize);
    }, [text, style.fontSize, style.fontFamily, syncSize]);

    // ── Open textarea editor ──────────────────────────────────
    const openEditor = useCallback(() => {
        const textNode = textRef.current;
        if (!textNode || isEditingRef.current) return;

        const stage = textNode.getStage();
        if (!stage) return;

        isEditingRef.current = true;
        onEditStart?.(id);

        const stageContainer = stage.container();

        // Get text node's absolute position on screen
        const absTransform = textNode.getAbsoluteTransform().copy();
        const absPos = absTransform.point({ x: 0, y: 0 });

        // Current viewport scale from stage
        const stageScaleX = stage.scaleX();

        // Effective font size on screen (canvas fontSize × zoom)
        const screenFontSize = style.fontSize * stageScaleX;

        // Konva uses textBaseline='top' (no leading above text).
        // CSS centers leading equally above/below → half-leading pushes text down.
        // Compensate by shifting textarea up by the half-leading amount.
        const halfLeading = screenFontSize * (LINE_HEIGHT - 1.07) / 2;

        // ── Compute screen-space container bounds for bound text ──
        // Use stage transform + container data directly (more robust than stage.findOne)
        let containerScreenLeft = 0;
        let containerScreenTop = 0;
        let containerScreenW = 0;
        let containerScreenH = 0;
        const PADDING = 4;
        const PADDING_SCREEN = PADDING * stageScaleX;
        if (isBound && container) {
            const stageTransform = stage.getAbsoluteTransform().copy();
            const containerScreenPos = stageTransform.point({ x: container.x, y: container.y });
            containerScreenLeft = containerScreenPos.x;
            containerScreenTop = containerScreenPos.y;
            containerScreenW = container.width * stageScaleX;
            containerScreenH = container.height * stageScaleX;
        }

        // Width: bound text matches container exactly; standalone text has a comfortable minimum
        const nodeWidth = textNode.width();
        const screenWidth = isBound
            ? (containerScreenW - PADDING_SCREEN * 2)
            : Math.max(nodeWidth, 100) * stageScaleX;

        // Left: bound text aligns to container left + padding
        const screenLeft = isBound
            ? (containerScreenLeft + PADDING_SCREEN)
            : absPos.x;

        // Cache original text for cancel on Escape
        const originalText = text;

        // ── Create textarea ───────────────────────────────────
        const textarea = document.createElement('textarea');
        stageContainer.appendChild(textarea);

        textarea.value = text;
        textarea.style.position = 'absolute';

        // Initial top/left:
        // For bound text, derive from container bounds (not from Konva text node
        // which may lag by 1 frame for newly created bound text).
        // For standalone text, use the Konva text node's absolute position.
        if (isBound && container) {
            const vAlign = verticalAlign || 'middle';
            const textNodeH = textNode.height() * stageScaleX;
            let initTop: number;
            if (vAlign === 'top') {
                initTop = containerScreenTop + PADDING_SCREEN - halfLeading;
            } else if (vAlign === 'bottom') {
                initTop = containerScreenTop + containerScreenH - textNodeH - PADDING_SCREEN - halfLeading;
            } else {
                initTop = containerScreenTop + (containerScreenH - textNodeH) / 2 - halfLeading;
            }
            textarea.style.top = `${initTop}px`;
        } else {
            textarea.style.top = `${absPos.y - halfLeading}px`;
        }
        textarea.style.left = `${screenLeft}px`;
        textarea.style.width = `${screenWidth}px`;
        textarea.style.fontSize = `${screenFontSize}px`;
        textarea.style.fontFamily = style.fontFamily;
        textarea.style.color = style.strokeColor;
        textarea.style.lineHeight = `${LINE_HEIGHT}`;
        textarea.style.border = 'none';
        textarea.style.borderRadius = '0';
        textarea.style.padding = '0';
        textarea.style.margin = '0';
        textarea.style.outline = 'none';
        textarea.style.resize = 'none';
        textarea.style.overflow = 'hidden';
        textarea.style.background = 'transparent';
        textarea.style.zIndex = '1000';
        textarea.rows = 1; // prevent default rows=2 causing 2-line height
        textarea.style.minHeight = `${Math.max(20, screenFontSize * LINE_HEIGHT)}px`;
        textarea.style.boxSizing = 'border-box';
        textarea.style.transformOrigin = 'left top';
        textarea.style.letterSpacing = 'normal';
        textarea.style.caretColor = style.strokeColor;

        // Match Konva Text alignment and wrapping behavior
        const resolvedAlign = isBound ? (textAlign || 'center') : 'left';
        textarea.style.textAlign = resolvedAlign;
        if (isBound) {
            // Bound text wraps words like Konva wrap='word'
            textarea.style.whiteSpace = 'pre-wrap';
            textarea.style.wordBreak = 'break-word';
        } else {
            textarea.style.whiteSpace = 'pre';
            textarea.style.wordBreak = 'normal';
        }

        // Apply rotation: bound text inherits container rotation
        const effectiveRotation = isBound ? (container?.rotation ?? rotation) : rotation;
        if (effectiveRotation) {
            textarea.style.transform = `rotateZ(${effectiveRotation}deg)`;
        }

        // Auto-grow height as user types.
        // For bound text with vertical alignment, re-position the textarea
        // to stay aligned within the container — including halfLeading compensation.
        const autoGrow = () => {
            textarea.style.height = 'auto';
            const newH = textarea.scrollHeight;
            textarea.style.height = `${newH}px`;

            if (isBound && container) {
                // Re-position textarea vertically within container on screen
                // Apply halfLeading offset so CSS text baseline matches Konva's textBaseline='top'
                const vAlign = verticalAlign || 'middle';
                let newTop: number;
                if (vAlign === 'top') {
                    newTop = containerScreenTop + PADDING_SCREEN - halfLeading;
                } else if (vAlign === 'bottom') {
                    newTop = containerScreenTop + containerScreenH - newH - PADDING_SCREEN - halfLeading;
                } else {
                    // middle
                    newTop = containerScreenTop + (containerScreenH - newH) / 2 - halfLeading;
                }
                textarea.style.top = `${newTop}px`;
            }

            // For standalone text, also grow width
            if (!isBound) {
                textarea.style.width = 'auto';
                textarea.style.width = `${Math.max(textarea.scrollWidth, 100 * stageScaleX)}px`;
            }
        };

        textarea.addEventListener('input', autoGrow);
        requestAnimationFrame(autoGrow);

        // Hide Konva text while editing
        textNode.hide();
        stage.batchDraw();

        textarea.focus();
        textarea.select();

        let cancelled = false;

        const finishEdit = () => {
            if (!isEditingRef.current) return;
            isEditingRef.current = false;

            const newText = cancelled ? originalText : textarea.value;
            const isEmpty = newText.trim() === '';

            // Clean up DOM
            textarea.removeEventListener('input', autoGrow);
            textarea.removeEventListener('blur', handleBlur);
            textarea.removeEventListener('keydown', handleKeyDown);
            if (textarea.parentNode) {
                textarea.parentNode.removeChild(textarea);
            }

            // Show Konva text
            textNode.show();
            stage.batchDraw();

            // Update element text (Konva will re-measure on next render)
            if (!cancelled) {
                onChange(id, { text: newText });
            }

            // Notify parent — decides whether to delete empty text
            onEditEnd?.(id, isEmpty);
        };

        const handleBlur = () => {
            finishEdit();
        };

        const handleKeyDown = (e: KeyboardEvent) => {
            // Prevent keyboard shortcuts from firing while typing
            e.stopPropagation();

            if (e.key === 'Escape') {
                cancelled = true;
                textarea.blur();
            }
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                textarea.blur();
            }
            if (e.key === 'Tab') {
                e.preventDefault();
                textarea.blur();
            }
        };

        textarea.addEventListener('blur', handleBlur);
        textarea.addEventListener('keydown', handleKeyDown);
    }, [id, text, rotation, style, isBound, container, textAlign, verticalAlign, onChange, onEditStart, onEditEnd]);

    // ── Auto-edit on creation or re-edit ─────────────────────
    // Reset the guard when autoEdit goes back to false so subsequent
    // double-clicks on the same shape can re-trigger the editor.
    useEffect(() => {
        if (!autoEdit) {
            autoEditDoneRef.current = false;
        }
    }, [autoEdit]);

    useEffect(() => {
        if (autoEdit && !autoEditDoneRef.current && textRef.current) {
            autoEditDoneRef.current = true;
            // Open editor synchronously — no rAF delay to avoid placeholder flash
            openEditor();
        }
    }, [autoEdit, openEditor]);

    // Effective position and width: bound text follows container
    const effectiveX = isBound ? boundPos.x : x;
    const effectiveY = isBound ? boundPos.y : y;
    // Standalone text: don't pass width → let Konva auto-measure from content.
    // Bound text: constrain to container width for word-wrap.
    const effectiveWidth = isBound && boundPos.width ? boundPos.width : undefined;
    const effectiveAlign = isBound ? (textAlign || 'center') : undefined;

    return (
        <Text
            ref={textRef}
            id={id}
            x={effectiveX}
            y={effectiveY}
            text={text || (isBound ? '' : 'Double-click to edit')}
            fontSize={style.fontSize}
            fontFamily={style.fontFamily}
            fill={style.strokeColor}
            lineHeight={LINE_HEIGHT}
            width={effectiveWidth}
            align={effectiveAlign}
            wrap={isBound ? 'word' : 'none'}
            rotation={isBound ? (container?.rotation ?? rotation) : rotation}
            transformsEnabled={(isBound ? (container?.rotation ?? rotation) : rotation) ? 'all' : 'position'}
            visible={!(autoEdit && !isEditingRef.current && !text)}
            opacity={text ? style.opacity : (isBound ? 0 : 0.4)}
            draggable={isDraggable}
            listening={!isBound}
            onClick={isBound ? undefined : () => onSelect(id)}
            onTap={isBound ? undefined : () => onSelect(id)}
            onDblClick={openEditor}
            onDblTap={openEditor}
            shadowColor={!isBound && isSelected ? '#4f8df7' : undefined}
            shadowBlur={!isBound && isSelected ? 6 : 0}
            shadowOpacity={!isBound && isSelected ? 0.5 : 0}
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
                // Use the larger scale factor to compute new font size
                const scale = Math.max(Math.abs(scaleX), Math.abs(scaleY));
                const newFontSize = Math.max(8, Math.round(style.fontSize * scale));
                // Reset scale back to 1 — font size carries the scaling now
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
