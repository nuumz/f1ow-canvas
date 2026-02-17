import React, { useEffect, useRef, useMemo } from 'react';
import { Transformer } from 'react-konva';
import type Konva from 'konva';
import { useCanvasStore } from '@/store/useCanvasStore';
import type { CanvasElement } from '@/types';

interface Props {
    selectedIds: string[];
    selectionColor?: string;
}

/**
 * Derive a stable fingerprint from selection-relevant props (lock, type)
 * so the transformer only re-renders when these traits change — not on
 * every position update during drag.
 *
 * Performance: uses a Set for O(1) lookup of selected IDs, iterates
 * elements once and exits early once all selected are found.  The Zustand
 * selector runs on EVERY store update — early exit keeps the common case
 * (1-10 selected, 1000+ total) fast: typically exits after scanning
 * only a fraction of the elements array.
 */
function selectionFingerprint(selectedIds: string[], elements: CanvasElement[]): string {
    if (selectedIds.length === 0) return '';

    // Build lookup + ordered collector
    const needed = new Set(selectedIds);
    const found = new Map<string, CanvasElement>();
    for (const el of elements) {
        if (needed.has(el.id)) {
            found.set(el.id, el);
            if (found.size === needed.size) break; // early exit!
        }
    }

    // Reconstruct in selectedIds order for stable fingerprint
    const parts: string[] = [];
    for (const sid of selectedIds) {
        const el = found.get(sid);
        if (el) parts.push(`${sid}:${el.isLocked ? 1 : 0}:${el.type}`);
    }
    return parts.join(',');
}

const SelectionTransformer: React.FC<Props> = ({ selectedIds, selectionColor = '#4f8df7' }) => {
    const trRef = useRef<Konva.Transformer>(null);

    // Stable selector: derive a fingerprint from lock/type state only.
    // This prevents re-renders during drag (position changes don't
    // affect the fingerprint).
    const fp = useCanvasStore((s) => selectionFingerprint(selectedIds, s.elements));

    // Decode from fingerprint — cheaper than subscribing to full elements
    const { hasLocked, allLocked, allText } = useMemo(() => {
        if (!fp || selectedIds.length === 0) {
            return { hasLocked: false, allLocked: false, allText: false };
        }
        const entries = fp.split(',');
        let locked = 0;
        let text = 0;
        for (const e of entries) {
            const parts = e.split(':');
            if (parts[1] === '1') locked++;
            if (parts[2] === 'text') text++;
        }
        return {
            hasLocked: locked > 0,
            allLocked: locked === entries.length,
            allText: text === entries.length,
        };
    }, [fp, selectedIds.length]);

    const anchors = allText
        ? ['top-left', 'top-right', 'bottom-left', 'bottom-right']
        : ['top-left', 'top-right', 'bottom-left', 'bottom-right',
            'middle-left', 'middle-right', 'top-center', 'bottom-center'];

    useEffect(() => {
        const tr = trRef.current;
        if (!tr) return;
        const stage = tr.getStage();
        if (!stage) return;

        const nodes = selectedIds
            .map((id) => stage.findOne(`#${id}`))
            .filter(Boolean) as Konva.Node[];
        tr.nodes(nodes);
        tr.getLayer()?.batchDraw();
    }, [selectedIds]);

    if (selectedIds.length === 0) return null;

    // Show a non-interactive border for locked elements (visual feedback only)
    const lockedBorderColor = hasLocked ? '#ff9500' : selectionColor;

    return (
        <Transformer
            ref={trRef}
            flipEnabled={false}
            keepRatio={allText}
            resizeEnabled={!allLocked}
            rotateEnabled={!allLocked}
            boundBoxFunc={(oldBox, newBox) => {
                if (allLocked) return oldBox;
                if (Math.abs(newBox.width) < 5 || Math.abs(newBox.height) < 5) return oldBox;
                return newBox;
            }}
            anchorFill={allLocked ? '#ff9500' : '#ffffff'}
            anchorStroke={lockedBorderColor}
            anchorSize={allLocked ? 0 : 8}
            anchorCornerRadius={2}
            borderStroke={lockedBorderColor}
            borderStrokeWidth={1}
            borderDash={allLocked ? [6, 3] : [4, 4]}
            rotateAnchorOffset={25}
            enabledAnchors={allLocked ? [] : anchors}
        />
    );
};

export default React.memo(SelectionTransformer);
