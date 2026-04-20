/**
 * TextLabel.tsx
 *
 * Connector label dimension tracker — keeps stored width/height
 * in sync with the actual text content using Canvas 2D measurement.
 *
 * Visual rendering (pill background + markdown text) and editing are
 * handled by TextHtmlOverlay. This component only manages measurement.
 *
 * @see docs/CONNECTOR_LABEL_DESIGN.md
 */
import React, { useRef, useEffect } from 'react';
import type { TextElement, ArrowElement, LineElement } from '@/types';
import {
    LABEL_MIN_WIDTH,
    measureLabelText,
} from '@/utils/labelMetrics';
import { markdownToPlainText } from '@/utils/markdown';

// ── Props ─────────────────────────────────────────────────────
export interface TextLabelProps {
    element: TextElement;
    /** The parent connector element (arrow or line) */
    connector: ArrowElement | LineElement;
    onChange: (id: string, updates: Partial<TextElement>) => void;
    /** If true, auto-opens the editor immediately after mount */
    autoEdit?: boolean;
    /** Called to notify parent that text editing started */
    onEditStart?: (id: string) => void;
    /** Called to notify parent that text editing ended */
    onEditEnd?: (id: string, isEmpty: boolean) => void;
}

// ── Component ─────────────────────────────────────────────────
const TextLabel: React.FC<TextLabelProps> = ({
    element,
    onChange,
}) => {
    const { id, width, height, style, text } = element;
    const labelFontSize = style.fontSize * 0.9;
    const visibleText = markdownToPlainText(text || '') || ' ';

    // ── Sync dimensions using Canvas 2D measurement ───────────
    // Keeps stored width/height accurate so the overlay can position
    // the pill correctly via computeConnectorLabelPosition.
    const syncSizeInitRef = useRef(true);
    useEffect(() => {
        if (syncSizeInitRef.current) {
            syncSizeInitRef.current = false;
            if (visibleText.trim() && height > 0) return;
        }
        const measured = measureLabelText(visibleText, labelFontSize, style.fontFamily);
        const updates: Partial<TextElement> = {};
        let needsUpdate = false;
        if (Math.abs(measured.height - height) > 1) {
            updates.height = measured.height;
            needsUpdate = true;
        }
        const measuredWidth = Math.max(LABEL_MIN_WIDTH, measured.width);
        if (Math.abs(measuredWidth - width) > 1) {
            updates.width = measuredWidth;
            needsUpdate = true;
        }
        if (needsUpdate) onChange(id, updates);
    }, [id, visibleText, height, width, labelFontSize, style.fontFamily, onChange]);

    // No Konva nodes — rendering handled by TextHtmlOverlay
    return null;
};

export default React.memo(TextLabel);

