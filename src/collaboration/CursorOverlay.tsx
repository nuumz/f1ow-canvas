/**
 * collaboration/CursorOverlay.tsx — Remote user cursor rendering.
 *
 * Renders peer cursors and selection highlights on the Konva overlay layer.
 * Each cursor shows:
 *   - Arrow pointer in the user's color
 *   - User name label (background rect + text, correctly z-ordered)
 *   - Semi-transparent selection highlight around their selected elements
 *
 * Performance:
 *   - Viewport culling: skips cursors/selections outside visible area
 *   - All nodes: listening={false}, perfectDrawEnabled={false}
 *   - Selection highlights support element rotation
 *   - Name label width measured via canvas TextMetrics (not character count)
 */
import React, { useMemo, useRef } from 'react';
import { Group, Line, Rect, Text } from 'react-konva';
import type { AwarenessState } from './types';
import type { CanvasElement, ViewportState } from '@/types';

interface CursorOverlayProps {
    /** Remote peer awareness states */
    peers: AwarenessState[];
    /** Current viewport for coordinate transforms */
    viewport: ViewportState;
    /** Stage dimensions for viewport culling */
    stageWidth: number;
    stageHeight: number;
    /** All elements (for resolving selection highlights) */
    elements: CanvasElement[];
}

/** Cursor arrow path as flat [x,y] points, normalized to ~20px */
const CURSOR_POINTS = [0, 0, 0, 18, 4.5, 14.5, 9, 20, 12, 18, 7.5, 12.5, 14, 12.5, 0, 0];

/** Label font spec — shared between measurement and rendering */
const LABEL_FONT_SIZE = 12;
const LABEL_FONT_FAMILY = 'system-ui, -apple-system, sans-serif';
const LABEL_PADDING_X = 6;
const LABEL_PADDING_Y = 4;
const LABEL_OFFSET_X = 14;
const LABEL_OFFSET_Y = 18;

/**
 * Measure text width using an off-screen canvas (cached singleton).
 * Falls back to character-count heuristic if OffscreenCanvas is unavailable.
 */
const _measureCanvas: { ctx: CanvasRenderingContext2D | null; cache: Map<string, number> } = {
    ctx: null,
    cache: new Map(),
};

function measureTextWidth(text: string): number {
    const cached = _measureCanvas.cache.get(text);
    if (cached !== undefined) return cached;

    if (!_measureCanvas.ctx) {
        try {
            const canvas = document.createElement('canvas');
            _measureCanvas.ctx = canvas.getContext('2d');
        } catch {
            // Fallback if canvas unavailable
        }
    }

    let width: number;
    if (_measureCanvas.ctx) {
        _measureCanvas.ctx.font = `${LABEL_FONT_SIZE}px ${LABEL_FONT_FAMILY}`;
        width = _measureCanvas.ctx.measureText(text).width;
    } else {
        // Fallback heuristic
        width = text.length * 7;
    }

    // Limit cache size
    if (_measureCanvas.cache.size > 200) {
        _measureCanvas.cache.clear();
    }
    _measureCanvas.cache.set(text, width);
    return width;
}

/**
 * Check if a world-space point is within the visible viewport (with margin).
 */
function isInViewport(
    wx: number, wy: number,
    viewport: ViewportState,
    stageW: number, stageH: number,
    margin: number,
): boolean {
    // Convert world point to screen space
    const sx = (wx - viewport.x) * viewport.scale;
    const sy = (wy - viewport.y) * viewport.scale;
    return sx >= -margin && sx <= stageW + margin &&
           sy >= -margin && sy <= stageH + margin;
}

/**
 * Check if an element's bounding box overlaps the visible viewport.
 */
function isElementInViewport(
    el: CanvasElement,
    viewport: ViewportState,
    stageW: number, stageH: number,
    margin: number,
): boolean {
    // Use axis-aligned bounding box (conservative for rotated elements)
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;
    const halfDiag = Math.sqrt(el.width * el.width + el.height * el.height) / 2;
    return isInViewport(cx, cy, viewport, stageW, stageH, margin + halfDiag * viewport.scale);
}

const CursorOverlay: React.FC<CursorOverlayProps> = ({
    peers, viewport, stageWidth, stageHeight, elements,
}) => {
    // Build element lookup map
    const elementMap = useMemo(() => {
        const map = new Map<string, CanvasElement>();
        for (const el of elements) map.set(el.id, el);
        return map;
    }, [elements]);

    const invScale = 1 / viewport.scale;

    // Viewport culling margin (in screen pixels) — enough for cursor + label
    const CULL_MARGIN = 150;

    return (
        <>
            {peers.map((peer) => {
                if (!peer.cursor && peer.selectedIds.length === 0) return null;
                const { user } = peer;

                return (
                    <Group key={user.id}>
                        {/* Selection highlights (support rotation) */}
                        {peer.selectedIds.map((selId) => {
                            const el = elementMap.get(selId);
                            if (!el) return null;

                            // Viewport culling for selection highlights
                            if (!isElementInViewport(el, viewport, stageWidth, stageHeight, CULL_MARGIN)) {
                                return null;
                            }

                            const pad = 3 * invScale;
                            return (
                                <Rect
                                    key={selId}
                                    x={el.x + el.width / 2}
                                    y={el.y + el.height / 2}
                                    offsetX={el.width / 2 + pad}
                                    offsetY={el.height / 2 + pad}
                                    width={el.width + pad * 2}
                                    height={el.height + pad * 2}
                                    rotation={el.rotation ?? 0}
                                    stroke={user.color}
                                    strokeWidth={2 * invScale}
                                    dash={[6 * invScale, 4 * invScale]}
                                    cornerRadius={3 * invScale}
                                    listening={false}
                                    perfectDrawEnabled={false}
                                />
                            );
                        })}

                        {/* Cursor arrow + name label */}
                        {peer.cursor && isInViewport(
                            peer.cursor.x, peer.cursor.y,
                            viewport, stageWidth, stageHeight, CULL_MARGIN,
                        ) && (
                            <Group
                                x={peer.cursor.x}
                                y={peer.cursor.y}
                                scaleX={invScale}
                                scaleY={invScale}
                                listening={false}
                            >
                                {/* Cursor arrow */}
                                <Line
                                    points={CURSOR_POINTS}
                                    fill={user.color}
                                    stroke="#ffffff"
                                    strokeWidth={1}
                                    closed
                                    perfectDrawEnabled={false}
                                />
                                {/* Label background FIRST (Konva draws in children order) */}
                                <Rect
                                    x={LABEL_OFFSET_X}
                                    y={LABEL_OFFSET_Y}
                                    width={measureTextWidth(user.name) + LABEL_PADDING_X * 2}
                                    height={LABEL_FONT_SIZE + LABEL_PADDING_Y * 2}
                                    fill={user.color}
                                    cornerRadius={4}
                                    listening={false}
                                    perfectDrawEnabled={false}
                                />
                                {/* Name text ON TOP of background */}
                                <Text
                                    x={LABEL_OFFSET_X + LABEL_PADDING_X}
                                    y={LABEL_OFFSET_Y + LABEL_PADDING_Y}
                                    text={user.name}
                                    fontSize={LABEL_FONT_SIZE}
                                    fontFamily={LABEL_FONT_FAMILY}
                                    fill="#ffffff"
                                    listening={false}
                                    perfectDrawEnabled={false}
                                />
                            </Group>
                        )}
                    </Group>
                );
            })}
        </>
    );
};

export default React.memo(CursorOverlay);
