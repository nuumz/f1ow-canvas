/**
 * useViewportCulling.ts
 * Hook to cull elements to only those visible in the viewport.
 * Enables smooth rendering of large flows (1000+ elements)
 * by skipping off-screen Konva node creation.
 */
import { useMemo } from 'react';
import type { CanvasElement, ViewportState } from '@/types';
import { cullToViewport, toSet } from '@/utils/performance';

/**
 * Returns only the elements that are visible in the current viewport
 * plus any selected elements (always visible for transformer).
 *
 * @param elements - all resolved elements
 * @param viewport - current pan/zoom state
 * @param stageWidth - Stage pixel width
 * @param stageHeight - Stage pixel height
 * @param selectedIds - currently selected element IDs
 * @param padding - extra world-space padding (default 200)
 */
export function useViewportCulling(
    elements: CanvasElement[],
    viewport: ViewportState,
    stageWidth: number,
    stageHeight: number,
    selectedIds: string[],
    padding?: number,
): CanvasElement[] {
    const selectedSet = useMemo(() => toSet(selectedIds), [selectedIds]);

    return useMemo(
        () => cullToViewport(elements, viewport, stageWidth, stageHeight, selectedSet, padding),
        [elements, viewport.x, viewport.y, viewport.scale, stageWidth, stageHeight, selectedSet, padding],
    );
}
