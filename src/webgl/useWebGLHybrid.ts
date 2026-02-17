/**
 * webgl/useWebGLHybrid.ts — React hook for WebGL hybrid rendering.
 *
 * Manages the lifecycle of a WebGLHybridRenderer:
 *   - Creates <canvas> element and overlays it behind the Konva Stage
 *   - Initialises WebGL2 context
 *   - Renders static elements on every viewport change
 *   - Invalidates elements on changes
 *   - Cleans up on unmount
 *
 * Usage:
 * ```tsx
 * const { webglCanvasRef, isActive } = useWebGLHybrid(
 *   elements, selectedIds, viewport, dimensions, { enabled: true }
 * );
 * ```
 */
import { useRef, useEffect, useCallback, useMemo } from 'react';
import type { CanvasElement, ViewportState } from '@/types';
import { WebGLHybridRenderer, type WebGLHybridRendererOptions } from './WebGLHybridRenderer';

export interface UseWebGLHybridOptions extends WebGLHybridRendererOptions {
    /** Enable/disable WebGL hybrid rendering. Default false. */
    enabled?: boolean;
}

export interface UseWebGLHybridReturn {
    /**
     * Ref callback for the WebGL canvas element.
     * Attach this to a <canvas> that is positioned behind the Konva Stage.
     */
    webglCanvasRef: (canvas: HTMLCanvasElement | null) => void;
    /** Whether WebGL is currently active and rendering */
    isActive: boolean;
    /** Invalidate specific element textures (call on element change) */
    invalidateElements: (ids: string[]) => void;
    /** Force full re-rasterisation (call on undo/import) */
    invalidateAll: () => void;
    /** Number of instances rendered last frame */
    instanceCount: number;
}

export function useWebGLHybrid(
    elements: CanvasElement[],
    selectedIds: ReadonlySet<string>,
    viewport: ViewportState,
    dimensions: { width: number; height: number },
    options: UseWebGLHybridOptions = {},
): UseWebGLHybridReturn {
    const { enabled = false, rasterFn, elementThreshold } = options;

    const rendererRef = useRef<WebGLHybridRenderer | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const isActiveRef = useRef(false);

    // Create renderer once
    useEffect(() => {
        if (!enabled) {
            rendererRef.current?.dispose();
            rendererRef.current = null;
            isActiveRef.current = false;
            return;
        }
        rendererRef.current = new WebGLHybridRenderer({ rasterFn, elementThreshold });
        return () => {
            rendererRef.current?.dispose();
            rendererRef.current = null;
            isActiveRef.current = false;
        };
    }, [enabled, rasterFn, elementThreshold]);

    // Canvas ref callback
    const webglCanvasRef = useCallback((canvas: HTMLCanvasElement | null) => {
        canvasRef.current = canvas;
        if (canvas && rendererRef.current) {
            isActiveRef.current = rendererRef.current.init(canvas);
        }
    }, []);

    // Update dimensions
    useEffect(() => {
        rendererRef.current?.setSize(dimensions.width, dimensions.height);
    }, [dimensions.width, dimensions.height]);

    // Render on every viewport/element change
    useEffect(() => {
        if (!rendererRef.current || !isActiveRef.current) return;
        rendererRef.current.render(elements, selectedIds, viewport);
    });

    const invalidateElements = useCallback((ids: string[]) => {
        rendererRef.current?.invalidateElements(ids);
    }, []);

    const invalidateAll = useCallback(() => {
        rendererRef.current?.invalidateAll();
    }, []);

    return useMemo(() => ({
        webglCanvasRef,
        isActive: isActiveRef.current,
        invalidateElements,
        invalidateAll,
        instanceCount: rendererRef.current?.instanceCount ?? 0,
    }), [webglCanvasRef, invalidateElements, invalidateAll]);
}
