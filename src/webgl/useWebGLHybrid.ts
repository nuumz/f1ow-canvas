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
import { useRef, useEffect, useCallback, useState } from 'react';
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
    const rafRef = useRef<number | null>(null);
    // `isActive` is state (not a ref) so consumers re-render when WebGL comes
    // online — a ref read inside a memo would stay false forever.
    const [isActive, setIsActive] = useState(false);

    // Create / destroy the renderer in an effect (never during render).
    // Idempotent: `init()` guards double-init so React 19 StrictMode's
    // mount→unmount→mount double-invoke is safe.
    useEffect(() => {
        if (!enabled) return;
        const renderer = new WebGLHybridRenderer({ rasterFn, elementThreshold });
        rendererRef.current = renderer;
        renderer.setSize(dimensions.width, dimensions.height);
        // The canvas ref may already be attached (ref callbacks run before
        // effects), so initialise immediately if so.
        if (canvasRef.current) {
            setIsActive(renderer.init(canvasRef.current));
        }
        return () => {
            renderer.dispose();
            if (rendererRef.current === renderer) rendererRef.current = null;
            setIsActive(false);
        };
        // dimensions intentionally excluded — handled by the resize effect.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, rasterFn, elementThreshold]);

    // Canvas ref callback — initialise once both canvas and renderer exist.
    const webglCanvasRef = useCallback((canvas: HTMLCanvasElement | null) => {
        canvasRef.current = canvas;
        if (canvas && rendererRef.current) {
            setIsActive(rendererRef.current.init(canvas));
        }
    }, []);

    // Keep canvas size in sync.
    useEffect(() => {
        rendererRef.current?.setSize(dimensions.width, dimensions.height);
    }, [dimensions.width, dimensions.height]);

    // Render on relevant changes only, coalesced into a single rAF tick so
    // bursts of React commits don't trigger redundant GPU work.
    useEffect(() => {
        if (!isActive) return;
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => {
            rafRef.current = null;
            rendererRef.current?.render(elements, selectedIds, viewport);
        });
        return () => {
            if (rafRef.current !== null) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = null;
            }
        };
    }, [elements, selectedIds, viewport, dimensions, isActive]);

    const invalidateElements = useCallback((ids: string[]) => {
        rendererRef.current?.invalidateElements(ids);
    }, []);

    const invalidateAll = useCallback(() => {
        rendererRef.current?.invalidateAll();
    }, []);

    return {
        webglCanvasRef,
        isActive,
        invalidateElements,
        invalidateAll,
        instanceCount: rendererRef.current?.instanceCount ?? 0,
    };
}
