/**
 * TextLabel.tsx
 *
 * Connector label — a text element bound to an arrow/line via `containerId`.
 * Renders as a white "pill" (Rect + Text inside a Group) floating at the
 * connector's midpoint.
 *
 * Separated from TextShape because:
 *   - Rendering: Group(Rect + Text) vs plain Text node
 *   - Sizing:    Canvas-measured single-line (wrap=none) vs container-constrained word-wrap
 *   - Editing:   Canvas-measured textarea vs CSS-measured textarea
 *   - Position:  Midpoint of connector path vs shape bounding box
 *
 * @see docs/CONNECTOR_LABEL_DESIGN.md
 */
import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { Text, Rect, Group } from 'react-konva';
import type Konva from 'konva';
import type { TextElement, CanvasElement, ArrowElement, LineElement } from '@/types';
import { computeConnectorLabelPosition } from '@/utils/connection';
import {
    LABEL_PADDING_H,
    LABEL_PADDING_V,
    LABEL_CORNER,
    LABEL_LINE_HEIGHT,
    LABEL_MIN_WIDTH,
    measureLabelText,
} from '@/utils/labelMetrics';

// ── Props ─────────────────────────────────────────────────────
export interface TextLabelProps {
    element: TextElement;
    /** The parent connector element (arrow or line) */
    connector: ArrowElement | LineElement;
    onChange: (id: string, updates: Partial<TextElement>) => void;
    /** If true, auto-opens the textarea editor immediately after mount */
    autoEdit?: boolean;
    /** Called to notify parent that text editing started */
    onEditStart?: (id: string) => void;
    /** Called to notify parent that text editing ended */
    onEditEnd?: (id: string, isEmpty: boolean) => void;
}

// ── Component ─────────────────────────────────────────────────
const TextLabel: React.FC<TextLabelProps> = ({
    element,
    connector,
    onChange,
    autoEdit,
    onEditStart,
    onEditEnd,
}) => {
    const { id, x, y, width, height, style, text } = element;
    const labelFontSize = style.fontSize * 0.9;
    const textRef = useRef<Konva.Text>(null);
    const bgRectRef = useRef<Konva.Rect>(null);
    const isEditingRef = useRef(false);
    const [isEditingState, setIsEditingState] = useState(false);
    const autoEditDoneRef = useRef(false);

    // ── Position at connector midpoint ────────────────────────
    const boundPos = useMemo(() => {
        const textWidth = Math.max(LABEL_MIN_WIDTH, width || 60);
        // Use stored height only — textRef.current is null on remount
        // (layer transition) which would cause a position jump.
        const pos = computeConnectorLabelPosition(connector, textWidth, height);
        return { x: pos.x, y: pos.y, width: textWidth };
    }, [connector, width, height]);

    const effectiveX = boundPos.x;
    const effectiveY = boundPos.y;

    // ── Measure and sync size ─────────────────────────────────
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

        // Use measureLabelText (Canvas 2D) — same engine as Konva and textarea editor
        const measuredWidth = measureLabelText(text || ' ', labelFontSize, style.fontFamily).width;
        if (Math.abs(measuredWidth - width) > 1) {
            updates.width = measuredWidth;
            needsUpdate = true;
        }

        if (needsUpdate) {
            onChange(id, updates);
        }
    }, [id, text, height, width, labelFontSize, style.fontFamily, onChange]);

    // Skip the very first mount when the text element already has
    // accurate dimensions (layer-transition remount). This prevents a
    // spurious store update → re-render → flicker.
    const syncSizeInitRef = useRef(true);
    useEffect(() => {
        if (syncSizeInitRef.current) {
            syncSizeInitRef.current = false;
            if (text && height > 0) return;
        }
        const rafId = requestAnimationFrame(syncSize);
        return () => cancelAnimationFrame(rafId);
    }, [text, labelFontSize, style.fontFamily, syncSize]);

    // ── Open textarea editor ──────────────────────────────────
    const openEditor = useCallback(() => {
        const textNode = textRef.current;
        if (!textNode || isEditingRef.current) return;

        const stage = textNode.getStage();
        if (!stage) return;

        isEditingRef.current = true;
        setIsEditingState(true);
        onEditStart?.(id);

        const stageContainer = stage.container();

        // Absolute position of the text node on screen
        const absTransform = textNode.getAbsoluteTransform().copy();
        const absPos = absTransform.point({ x: 0, y: 0 });

        const stageScaleX = stage.scaleX();
        const screenFontSize = labelFontSize * stageScaleX;
        const nodeWidth = textNode.width();

        // Scaled padding
        const scaledPadH = LABEL_PADDING_H * stageScaleX;
        const scaledPadV = LABEL_PADDING_V * stageScaleX;

        // Canvas-measured initial pill dimensions
        const initMeasured = measureLabelText(text || ' ', labelFontSize, style.fontFamily);
        const initPillW = Math.max(LABEL_MIN_WIDTH, initMeasured.width) * stageScaleX + scaledPadH * 2;
        const initPillH = initMeasured.height * stageScaleX + scaledPadV * 2;

        // Connector midpoint on screen
        const connMidScreenX = absPos.x + (nodeWidth * stageScaleX) / 2;
        const connMidScreenY = absPos.y + (textNode.height() * stageScaleX) / 2;

        const originalText = text;

        // ── Create textarea ──
        const textarea = document.createElement('textarea');
        stageContainer.appendChild(textarea);

        textarea.value = text;
        textarea.style.position = 'absolute';
        textarea.style.top = `${connMidScreenY - initPillH / 2}px`;
        textarea.style.left = `${connMidScreenX - initPillW / 2}px`;
        textarea.style.width = `${initPillW}px`;
        textarea.style.height = `${initPillH}px`;
        textarea.style.fontSize = `${screenFontSize}px`;
        textarea.style.fontFamily = style.fontFamily;
        textarea.style.color = style.strokeColor;
        textarea.style.lineHeight = `${LABEL_LINE_HEIGHT}`;
        textarea.style.border = 'none';
        textarea.style.margin = '0';
        textarea.style.outline = 'none';
        textarea.style.resize = 'none';
        textarea.style.overflow = 'hidden';
        textarea.style.zIndex = '1000';
        textarea.rows = 1;
        textarea.style.minHeight = `${Math.max(20, screenFontSize * LABEL_LINE_HEIGHT)}px`;
        textarea.style.boxSizing = 'border-box';
        textarea.style.transformOrigin = 'left top';
        textarea.style.letterSpacing = 'normal';
        textarea.style.caretColor = style.strokeColor;

        // Pill appearance
        textarea.style.background = '#f8f9fa'; // Match canvas background
        textarea.style.borderRadius = `${LABEL_CORNER * stageScaleX}px`;
        textarea.style.padding = `${scaledPadV}px ${scaledPadH}px`;
        textarea.style.textAlign = 'center';
        textarea.style.whiteSpace = 'nowrap';
        textarea.style.wordBreak = 'normal';

        // ── Auto-grow using canvas measurement ──
        const autoGrow = () => {
            const currentText = textarea.value || ' ';
            const measured = measureLabelText(currentText, labelFontSize, style.fontFamily);
            const newTextW = Math.max(LABEL_MIN_WIDTH, measured.width) * stageScaleX;
            const pillW = newTextW + scaledPadH * 2;
            const pillH = measured.height * stageScaleX + scaledPadV * 2;
            textarea.style.width = `${pillW}px`;
            textarea.style.height = `${pillH}px`;
            // Re-center over connector midpoint
            textarea.style.left = `${connMidScreenX - pillW / 2}px`;
            textarea.style.top = `${connMidScreenY - pillH / 2}px`;
        };

        textarea.addEventListener('input', autoGrow);
        requestAnimationFrame(autoGrow);

        // Hide Konva nodes while editing
        textNode.hide();
        bgRectRef.current?.hide();
        stage.batchDraw();

        textarea.focus();
        textarea.select();

        let cancelled = false;

        const finishEdit = () => {
            if (!isEditingRef.current) return;
            isEditingRef.current = false;
            setIsEditingState(false);

            const newText = cancelled ? originalText : textarea.value;
            const isEmpty = newText.trim() === '';

            textarea.removeEventListener('input', autoGrow);
            textarea.removeEventListener('blur', handleBlur);
            textarea.removeEventListener('keydown', handleKeyDown);
            if (textarea.parentNode) {
                textarea.parentNode.removeChild(textarea);
            }

            textNode.show();
            bgRectRef.current?.show();
            stage.batchDraw();

            if (!cancelled) {
                const measured = measureLabelText(newText || ' ', labelFontSize, style.fontFamily);
                onChange(id, { 
                    text: newText,
                    width: measured.width,
                    height: measured.height
                });
            }

            onEditEnd?.(id, isEmpty);
        };

        const handleBlur = () => finishEdit();

        const handleKeyDown = (e: KeyboardEvent) => {
            e.stopPropagation();
            if (e.key === 'Escape') { cancelled = true; textarea.blur(); }
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); textarea.blur(); }
            if (e.key === 'Tab') { e.preventDefault(); textarea.blur(); }
        };

        textarea.addEventListener('blur', handleBlur);
        textarea.addEventListener('keydown', handleKeyDown);
    }, [id, text, style, onChange, onEditStart, onEditEnd]);

    // ── Auto-edit on creation ─────────────────────────────────
    useEffect(() => {
        if (!autoEdit) { autoEditDoneRef.current = false; }
    }, [autoEdit]);

    useEffect(() => {
        if (autoEdit && !autoEditDoneRef.current && textRef.current) {
            autoEditDoneRef.current = true;
            openEditor();
        }
    }, [autoEdit, openEditor]);

    // ── Render: Group(Rect + Text) ────────────────────────────
    const pillTextW = Math.max(LABEL_MIN_WIDTH, width || 60);
    const labelW = pillTextW + LABEL_PADDING_H * 2;
    const labelH = height + LABEL_PADDING_V * 2;
    const isVisible = !isEditingState && !(autoEdit && !text);
    const labelOpacity = text ? style.opacity : 0;

    return (
        <Group
            x={(effectiveX ?? 0) - LABEL_PADDING_H}
            y={(effectiveY ?? 0) - LABEL_PADDING_V}
            visible={isVisible}
            opacity={labelOpacity}
            listening={false}
            perfectDrawEnabled={false}
        >
            {/* Pill background matching canvas */}
            <Rect
                ref={bgRectRef}
                width={labelW}
                height={labelH}
                fill="#f8f9fa"
                cornerRadius={LABEL_CORNER}
                listening={false}
                perfectDrawEnabled={false}
            />
            {/* Text — single-line, no width constraint */}
            <Text
                ref={textRef}
                id={id}
                x={LABEL_PADDING_H}
                y={LABEL_PADDING_V}
                text={text || ''}
                fontSize={labelFontSize}
                fontFamily={style.fontFamily}
                fill={style.strokeColor}
                lineHeight={LABEL_LINE_HEIGHT}
                wrap="none"
                listening={false}
                perfectDrawEnabled={false}
                onDblClick={openEditor}
                onDblTap={openEditor}
            />
        </Group>
    );
};

export default React.memo(TextLabel);
