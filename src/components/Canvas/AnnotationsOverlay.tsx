/**
 * AnnotationsOverlay.tsx
 *
 * A DOM overlay that renders custom badges / annotations on top of
 * canvas elements.  The entire layer is `pointerEvents: 'none'`
 * so mouse/touch events pass through to the underlying Konva Stage.
 * Individual annotation nodes can opt-in to interactivity by setting
 * `pointerEvents: 'auto'` on themselves.
 *
 * Performance considerations:
 * - Bound text elements (internal — `containerId != null`) are skipped.
 * - Off-screen elements are culled before calling `renderAnnotation`.
 * - Each annotation item is wrapped in a memoised component.
 * - The overlay itself is `React.memo`'d.
 */
import React, { useMemo } from 'react';
import type { CanvasElement, TextElement, ViewportState } from '@/types';

// ─── Public types ─────────────────────────────────────────────

/** Screen-space bounding box passed to the annotation renderer */
export interface AnnotationScreenBounds {
    /** Left edge in pixels (relative to canvas container) */
    x: number;
    /** Top edge in pixels (relative to canvas container) */
    y: number;
    /** Width in screen pixels */
    width: number;
    /** Height in screen pixels */
    height: number;
}

/** Context provided to the `renderAnnotation` callback */
export interface AnnotationContext {
    /** The canvas element being annotated */
    element: CanvasElement;
    /** Screen-space bounding box of the element (after zoom/pan) */
    screenBounds: AnnotationScreenBounds;
    /** Current viewport zoom level */
    scale: number;
}

/** Signature for the `renderAnnotation` prop */
export type RenderAnnotationFn = (ctx: AnnotationContext) => React.ReactNode;

// ─── Props ────────────────────────────────────────────────────

interface AnnotationsOverlayProps {
    elements: CanvasElement[];
    viewport: ViewportState;
    /** Container dimensions for viewport-culling */
    containerWidth: number;
    containerHeight: number;
    renderAnnotation: RenderAnnotationFn;
}

// ─── Per-element wrapper (memoised to avoid re-rendering unchanged items) ──

interface AnnotationItemProps {
    element: CanvasElement;
    viewport: ViewportState;
    renderAnnotation: RenderAnnotationFn;
}

const AnnotationItem: React.FC<AnnotationItemProps> = React.memo(({
    element: el,
    viewport,
    renderAnnotation,
}) => {
    const screenX = el.x * viewport.scale + viewport.x;
    const screenY = el.y * viewport.scale + viewport.y;
    const screenW = el.width * viewport.scale;
    const screenH = el.height * viewport.scale;

    const ctx: AnnotationContext = {
        element: el,
        screenBounds: { x: screenX, y: screenY, width: screenW, height: screenH },
        scale: viewport.scale,
    };

    const annotation = renderAnnotation(ctx);
    if (!annotation) return null;

    // Build CSS transform: always include scale(viewport.scale) so that
    // content inside the wrapper lives in world-space and scales naturally
    // with zoom.  Append rotation when present.
    const transforms: string[] = [`scale(${viewport.scale})`];
    if (el.rotation) transforms.push(`rotate(${el.rotation}deg)`);

    return (
        <div
            style={{
                position: 'absolute',
                left: screenX,
                top: screenY,
                width: el.width,    // world-space; CSS scale handles screen sizing
                height: el.height,  // world-space
                pointerEvents: 'none',
                transform: transforms.join(' '),
                transformOrigin: 'top left',
            }}
        >
            {annotation}
        </div>
    );
});

AnnotationItem.displayName = 'AnnotationItem';

// ─── Overlay container ────────────────────────────────────────

const CONTAINER_STYLE: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
    overflow: 'hidden',
    zIndex: 10,
};

export const AnnotationsOverlay: React.FC<AnnotationsOverlayProps> = React.memo(({
    elements,
    viewport,
    containerWidth,
    containerHeight,
    renderAnnotation,
}) => {
    // Filter: skip bound text (internal), hidden, and off-screen elements
    const visibleElements = useMemo(() => {
        const margin = 100; // px margin so annotations near edges aren't clipped prematurely
        return elements.filter(el => {
            // Skip bound text labels — they are internal, not user-facing shapes
            if (el.type === 'text' && (el as TextElement).containerId) return false;
            // Skip hidden
            if (!el.isVisible) return false;
            // Viewport-cull: skip elements entirely outside the container
            const sx = el.x * viewport.scale + viewport.x;
            const sy = el.y * viewport.scale + viewport.y;
            const sw = el.width * viewport.scale;
            const sh = el.height * viewport.scale;
            if (sx + sw < -margin || sy + sh < -margin) return false;
            if (sx > containerWidth + margin || sy > containerHeight + margin) return false;
            return true;
        });
    }, [elements, viewport.scale, viewport.x, viewport.y, containerWidth, containerHeight]);

    if (visibleElements.length === 0) return null;

    return (
        <div style={CONTAINER_STYLE}>
            {visibleElements.map(el => (
                <AnnotationItem
                    key={el.id}
                    element={el}
                    viewport={viewport}
                    renderAnnotation={renderAnnotation}
                />
            ))}
        </div>
    );
});
