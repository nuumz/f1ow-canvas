/**
 * TextHtmlOverlay.tsx
 *
 * HTML overlay for all text elements — renders markdown and handles editing.
 *
 * Mounted as a sibling to the Konva `<Stage>`, this overlay uses the same
 * CSS transform (translate + scale) as the Stage so that all child divs
 * can be positioned in world-space coordinates.
 *
 * Architecture:
 *   - Display mode: `innerHTML` shows rendered markdown (pointer-events: none)
 *   - Edit mode:    `contentEditable` with raw markdown (pointer-events: auto)
 *   - Konva `<Text>` nodes remain as invisible hit areas for click/drag/transform
 *
 * @see utils/markdown.ts — markdown renderer + CSS injection
 */
import React, { useRef, useEffect, useCallback, useMemo } from 'react';
import { useCanvasStore } from '@/store/useCanvasStore';
import { renderMarkdown, MD_CLASS, MD_STYLES } from '@/utils/markdown';
import { serializeEditableHtmlToMarkdown } from '@/utils/markdownEditing';
import { computeConnectorLabelPosition } from '@/utils/connection';
import {
    LABEL_PADDING_H,
    LABEL_PADDING_V,
    LABEL_CORNER,
    LABEL_LINE_HEIGHT,
    LABEL_MIN_WIDTH,
    measureLabelText,
} from '@/utils/labelMetrics';
import type {
    ViewportState,
    TextElement,
    CanvasElement,
    ArrowElement,
    LineElement,
} from '@/types';

// ── Constants ─────────────────────────────────────────────────
const SHAPE_TEXT_PADDING = 4;  // Must match TextShape's boundPos PADDING

// ── CSS injection ─────────────────────────────────────────────
let styleInjected = false;
function injectStyles() {
    if (styleInjected) return;
    const tag = document.createElement('style');
    tag.setAttribute('data-fc-md', '');
    tag.textContent = MD_STYLES;
    document.head.appendChild(tag);
    styleInjected = true;
}

// ── Props ─────────────────────────────────────────────────────
export interface TextHtmlOverlayProps {
    viewport: ViewportState;
    autoEditTextId: string | null;
    onEditStart: (id: string) => void;
    onEditEnd: (id: string, isEmpty: boolean) => void;
    onChange: (id: string, updates: Partial<TextElement>) => void;
}

// ── Main overlay container ────────────────────────────────────
export const TextHtmlOverlay: React.FC<TextHtmlOverlayProps> = React.memo(({
    viewport,
    autoEditTextId,
    onEditStart,
    onEditEnd,
    onChange,
}) => {
    // Inject markdown CSS once
    useEffect(injectStyles, []);

    const elements = useCanvasStore(s => s.elements);
    const textElements = useMemo(
        () => elements.filter((el): el is TextElement => el.type === 'text'),
        [elements],
    );

    return (
        <div
            style={{
                position: 'absolute',
                inset: 0,
                overflow: 'hidden',
                pointerEvents: 'none',
                zIndex: 1,  // above canvas, below toolbar/context-menu
            }}
        >
            {/* Inner container matches Konva Stage transform */}
            <div
                style={{
                    transformOrigin: '0 0',
                    transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
                    position: 'absolute',
                    left: 0,
                    top: 0,
                }}
            >
                {textElements.map(el => (
                    <TextOverlayItem
                        key={el.id}
                        element={el}
                        allElements={elements}
                        isEditing={autoEditTextId === el.id}
                        onEditStart={onEditStart}
                        onEditEnd={onEditEnd}
                        onChange={onChange}
                    />
                ))}
            </div>
        </div>
    );
});

TextHtmlOverlay.displayName = 'TextHtmlOverlay';

// ── Per-element overlay item ──────────────────────────────────
interface ItemProps {
    element: TextElement;
    allElements: CanvasElement[];
    isEditing: boolean;
    onEditStart: (id: string) => void;
    onEditEnd: (id: string, isEmpty: boolean) => void;
    onChange: (id: string, updates: Partial<TextElement>) => void;
}

const TextOverlayItem: React.FC<ItemProps> = React.memo(({
    element,
    allElements,
    isEditing,
    onEditStart,
    onEditEnd,
    onChange,
}) => {
    const divRef = useRef<HTMLDivElement>(null);
    const editingRef = useRef(false);

    const { id, text, style, x, y, width, height, containerId, textAlign, verticalAlign, rotation } = element;

    // ── Determine element type ────────────────────────────────
    const container = useMemo(
        () => containerId ? allElements.find(el => el.id === containerId) ?? null : null,
        [containerId, allElements],
    );
    const isConnectorLabel = !!(container && (container.type === 'arrow' || container.type === 'line'));
    const isBound = !!container && !isConnectorLabel;

    // ── Compute position (world coordinates) ──────────────────
    const posStyle = useMemo((): React.CSSProperties => {
        if (isConnectorLabel) {
            return connectorLabelStyle(element, container as ArrowElement | LineElement);
        }
        if (isBound && container) {
            return boundTextStyle(element, container);
        }
        return standaloneTextStyle(element);
    }, [element, container, isBound, isConnectorLabel]);

    // ── Display: set markdown HTML ────────────────────────────
    useEffect(() => {
        if (!divRef.current || editingRef.current) return;
        divRef.current.innerHTML = renderMarkdown(text || '');
    }, [text]);

    // ── Edit mode transition ──────────────────────────────────
    useEffect(() => {
        const div = divRef.current;
        if (!div) return;

        if (isEditing && !editingRef.current) {
            editingRef.current = true;
            onEditStart(id);
            enterEditMode(div, element, container, isBound, isConnectorLabel, onChange, onEditEnd, editingRef);
        }
    }, [isEditing, id, element, container, isBound, isConnectorLabel, onChange, onEditEnd, onEditStart]);

    // ── Visibility ────────────────────────────────────────────
    // Hide when text is empty and not auto-editing
    const isVisible = !!(text || isEditing);

    // Bound text (shape labels) is rendered inside the Konva layer so it
    // shares the container's z-index and is correctly occluded by shapes
    // stacked above the container. The HTML overlay still takes over
    // during edit mode to provide WYSIWYG markdown editing.
    if (isBound && !isEditing) {
        return null;
    }

    return (
        <div
            ref={divRef}
            className={MD_CLASS}
            style={{
                ...posStyle,
                ...(isVisible ? {} : { display: 'none' }),
                pointerEvents: 'none',
            }}
        />
    );
});

TextOverlayItem.displayName = 'TextOverlayItem';

// ══════════════════════════════════════════════════════════════
// Position style helpers (world coordinates — viewport transform
// is applied by the outer container)
// ══════════════════════════════════════════════════════════════

function standaloneTextStyle(el: TextElement): React.CSSProperties {
    return {
        position: 'absolute',
        left: el.x,
        top: el.y,
        fontSize: el.style.fontSize,
        fontFamily: el.style.fontFamily,
        color: el.style.strokeColor,
        lineHeight: `${LABEL_LINE_HEIGHT}`,
        whiteSpace: 'pre-wrap',
        opacity: el.style.opacity,
        transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
        transformOrigin: 'left top',
    };
}

function boundTextStyle(el: TextElement, container: CanvasElement): React.CSSProperties {
    const pad = SHAPE_TEXT_PADDING;
    const innerW = Math.max(20, container.width - pad * 2);
    const innerH = Math.max(20, container.height - pad * 2);
    const align = el.textAlign || 'center';
    const vAlign = el.verticalAlign || 'middle';

    return {
        position: 'absolute',
        left: container.x + pad,
        top: container.y + pad,
        width: innerW,
        height: innerH,
        fontSize: el.style.fontSize,
        fontFamily: el.style.fontFamily,
        color: el.style.strokeColor,
        lineHeight: `${LABEL_LINE_HEIGHT}`,
        textAlign: align as React.CSSProperties['textAlign'],
        display: 'flex',
        flexDirection: 'column',
        alignItems: align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center',
        justifyContent: vAlign === 'top' ? 'flex-start' : vAlign === 'bottom' ? 'flex-end' : 'center',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        overflow: 'hidden',
        opacity: el.style.opacity,
        transform: container.rotation ? `rotate(${container.rotation}deg)` : undefined,
        transformOrigin: `${-pad}px ${-pad}px`,
    };
}

function connectorLabelStyle(el: TextElement, connector: ArrowElement | LineElement): React.CSSProperties {
    const labelFontSize = el.style.fontSize * 0.9;
    const textW = Math.max(LABEL_MIN_WIDTH, el.width || 60);
    const pos = computeConnectorLabelPosition(connector, textW, el.height);
    const pillW = textW + LABEL_PADDING_H * 2;
    const pillH = el.height + LABEL_PADDING_V * 2;

    return {
        position: 'absolute',
        left: pos.x - LABEL_PADDING_H,
        top: pos.y - LABEL_PADDING_V,
        width: pillW,
        minHeight: pillH,
        fontSize: labelFontSize,
        fontFamily: el.style.fontFamily,
        color: el.style.strokeColor,
        lineHeight: `${LABEL_LINE_HEIGHT}`,
        textAlign: 'center',
        whiteSpace: 'nowrap',
        background: '#f8f9fa',
        borderRadius: LABEL_CORNER,
        padding: `${LABEL_PADDING_V}px ${LABEL_PADDING_H}px`,
        boxSizing: 'border-box',
        opacity: el.style.opacity,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
    };
}

// ══════════════════════════════════════════════════════════════
// Editing logic — imperative DOM (React + contenteditable don't mix)
// ══════════════════════════════════════════════════════════════

function normalizeEditorText(text: string): string {
    return text.replace(/\r\n?/g, '\n');
}

function readEditorText(div: HTMLDivElement): string {
    return normalizeEditorText(div.innerText || '');
}

function execRichTextCommand(command: 'bold' | 'italic' | 'strikeThrough') {
    document.execCommand(command, false);
}

function createEditingMarkup(text: string): string {
    return renderMarkdown(text || '') || '<br>';
}

function enterEditMode(
    div: HTMLDivElement,
    element: TextElement,
    container: CanvasElement | null,
    isBound: boolean,
    isConnectorLabel: boolean,
    onChange: (id: string, updates: Partial<TextElement>) => void,
    onEditEnd: (id: string, isEmpty: boolean) => void,
    editingRef: React.MutableRefObject<boolean>,
) {
    const originalText = element.text;

    // Switch to WYSIWYG editing and serialize back to markdown on save.
    div.contentEditable = 'true';
    div.style.pointerEvents = 'auto';
    div.style.cursor = 'text';
    div.style.caretColor = element.style.strokeColor;
    div.style.outline = 'none';
    div.style.minHeight = `${Math.ceil(element.style.fontSize * LABEL_LINE_HEIGHT)}px`;

    if (!isBound) {
        div.style.minWidth = '1ch';
    }

    // If bound or connector, show subtle editing indicator
    if (isBound) {
        div.style.background = 'rgba(79, 141, 247, 0.04)';
        div.style.borderRadius = '2px';
    }
    if (isConnectorLabel) {
        div.style.boxShadow = '0 0 0 2px rgba(79, 141, 247, 0.3)';
    }

    // Start from rendered markdown so inline styles remain visible while editing.
    div.innerHTML = createEditingMarkup(element.text || '');

    // Focus & select all — defer to next frame so the browser's mousedown
    // event (from the Stage click that created this element) finishes first.
    // Without this, the Stage canvas steals focus immediately after we focus
    // the contentEditable, triggering blur → finishEdit → delete empty text.
    requestAnimationFrame(() => {
        if (!editingRef.current) return;  // cancelled before focus
        div.focus();
        const sel = window.getSelection();
        if (sel) {
            const range = document.createRange();
            range.selectNodeContents(div);
            sel.removeAllRanges();
            sel.addRange(range);
        }
    });

    // ── Auto-grow for connector labels (re-center over midpoint) ──
    let autoGrow: (() => void) | null = null;
    if (isConnectorLabel && container) {
        const connector = container as ArrowElement | LineElement;
        const labelFontSize = element.style.fontSize * 0.9;

        autoGrow = () => {
            const currentText = readEditorText(div).replace(/\n$/, '') || ' ';
            const measured = measureLabelText(currentText, labelFontSize, element.style.fontFamily);
            const newTextW = Math.max(LABEL_MIN_WIDTH, measured.width);
            const pos = computeConnectorLabelPosition(connector, newTextW, measured.height);
            const pillW = newTextW + LABEL_PADDING_H * 2;
            const pillH = measured.height + LABEL_PADDING_V * 2;
            div.style.left = `${pos.x - LABEL_PADDING_H}px`;
            div.style.top = `${pos.y - LABEL_PADDING_V}px`;
            div.style.width = `${pillW}px`;
            div.style.minHeight = `${pillH}px`;
        };
        div.addEventListener('input', autoGrow);
        requestAnimationFrame(autoGrow);
    }

    // ── Cleanup function ──
    let cancelled = false;

    const finishEdit = () => {
        if (!editingRef.current) return;
        editingRef.current = false;

        const nextText = cancelled ? originalText : serializeEditableHtmlToMarkdown(div.innerHTML);
        const visibleText = cancelled ? originalText : readEditorText(div).replace(/\n$/, '');
        const isEmpty = visibleText.trim() === '';

        // Restore display state
        div.contentEditable = 'false';
        div.style.pointerEvents = 'none';
        div.style.cursor = '';
        div.style.caretColor = '';
        div.style.outline = '';
        div.style.boxShadow = '';
        div.style.minHeight = '';
        div.style.minWidth = '';

        if (isBound) {
            div.style.background = '';
            div.style.borderRadius = '';
        }

        // Render markdown
        div.innerHTML = renderMarkdown(nextText || '');

        // Remove listeners
        if (autoGrow) div.removeEventListener('input', autoGrow);
        div.removeEventListener('beforeinput', handleBeforeInput);
        div.removeEventListener('blur', handleBlur);
        div.removeEventListener('keydown', handleKeyDown);

        if (!cancelled) {
            if (isConnectorLabel) {
                const labelFontSize = element.style.fontSize * 0.9;
                const measured = measureLabelText(visibleText || ' ', labelFontSize, element.style.fontFamily);
                onChange(element.id, { text: nextText, width: measured.width, height: measured.height });
            } else {
                onChange(element.id, { text: nextText });
            }
        }

        onEditEnd(element.id, isEmpty);
    };

    const handleBlur = () => finishEdit();

    const handleBeforeInput = (e: InputEvent) => {
        if (e.inputType === 'formatBold') {
            e.preventDefault();
            execRichTextCommand('bold');
            return;
        }
        if (e.inputType === 'formatItalic') {
            e.preventDefault();
            execRichTextCommand('italic');
            return;
        }
        if (e.inputType === 'formatStrikeThrough') {
            e.preventDefault();
            execRichTextCommand('strikeThrough');
        }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
        e.stopPropagation();
        if ((e.metaKey || e.ctrlKey) && !e.altKey) {
            const key = e.key.toLowerCase();
            if (key === 'b') {
                e.preventDefault();
                execRichTextCommand('bold');
                return;
            }
            if (key === 'i') {
                e.preventDefault();
                execRichTextCommand('italic');
                return;
            }
        }
        if (e.key === 'Escape') { cancelled = true; div.blur(); }
        // Enter without Shift → confirm (Shift+Enter → newline)
        if (e.key === 'Enter' && !e.shiftKey) {
            // For connector labels: always confirm on Enter (single-line)
            // For bound/standalone: allow multi-line with Shift+Enter
            if (isConnectorLabel || !e.shiftKey) {
                e.preventDefault();
                div.blur();
            }
        }
        if (e.key === 'Tab') { e.preventDefault(); div.blur(); }
    };

    div.addEventListener('beforeinput', handleBeforeInput);
    div.addEventListener('blur', handleBlur);
    div.addEventListener('keydown', handleKeyDown);
}
