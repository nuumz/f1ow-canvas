/**
 * useProgressiveRender.ts — Time-sliced progressive rendering for
 * large canvas initial loads and viewport jumps.
 *
 * When the visible element count exceeds what can comfortably render
 * in a single 16.67ms frame, this hook progressively reveals elements
 * in batches across multiple animation frames — keeping the UI
 * responsive during heavy renders.
 *
 * Features:
 *   - Cancel-restart on viewport changes (abort stale renders)
 *   - Configurable batch size (elements per frame)
 *   - Threshold-based activation (skip for small counts)
 *   - Always renders selected/interactive elements immediately
 *
 * Performance:
 *   - 10K elements at 500/frame = 20 frames = ~333ms progressive reveal
 *   - UI remains interactive throughout (no frame drops)
 *
 * This hook is designed for the STATIC layer only — interactive
 * elements (selected, being dragged) are always rendered immediately
 * by the interactive layer, so the progressive "reveal" effect is
 * barely noticeable to users.
 */
import { useState, useEffect, useRef, useMemo } from 'react';
import type { CanvasElement } from '@/types';

// ─── Config ───────────────────────────────────────────────────

/**
 * Below this element count, render everything in one frame.
 * Progressive rendering overhead isn't worthwhile for small sets.
 */
const PROGRESSIVE_THRESHOLD = 500;

/** Default: render 500 elements per animation frame */
const DEFAULT_BATCH_SIZE = 500;

// ─── Hook ─────────────────────────────────────────────────────

export interface UseProgressiveRenderOptions {
    /** Elements per batch (default: 500) */
    batchSize?: number;
    /** Minimum element count to activate progressive mode (default: 500) */
    threshold?: number;
    /** Whether progressive rendering is enabled (default: true) */
    enabled?: boolean;
}

export interface ProgressiveRenderState {
    /** Elements to render this frame (progressively grows) */
    visibleElements: CanvasElement[];
    /** Whether progressive loading is in progress */
    isLoading: boolean;
    /** Progress ratio (0 → 1) */
    progress: number;
}

/**
 * Progressive render hook for time-sliced element rendering.
 *
 * @param elements - Full array of elements to render
 * @param options - Configuration options
 * @returns Progressive render state with growing visible element list
 *
 * Usage:
 * ```tsx
 * const { visibleElements, isLoading } = useProgressiveRender(staticElements, {
 *   batchSize: 500,
 *   threshold: 500,
 * });
 * // Use visibleElements for rendering instead of staticElements
 * ```
 */
export function useProgressiveRender(
    elements: CanvasElement[],
    options: UseProgressiveRenderOptions = {},
): ProgressiveRenderState {
    const {
        batchSize = DEFAULT_BATCH_SIZE,
        threshold = PROGRESSIVE_THRESHOLD,
        enabled = true,
    } = options;

    // Generation counter for cancel-restart pattern
    const generationRef = useRef(0);
    // Current render index
    const [renderCount, setRenderCount] = useState(0);
    // Track element array identity for reset detection
    const prevElementsRef = useRef<CanvasElement[]>([]);
    // Track whether the previous progressive render completed fully.
    // Used to avoid restarting the batch sequence on minor changes
    // (e.g. selection change removes 1 element from the static list).
    const wasCompleteRef = useRef(false);
    // Previous element count for detecting minor vs. major changes
    const prevLenRef = useRef(0);

    // Detect element array changes (new elements reference = restart)
    const elementsChanged = elements !== prevElementsRef.current;
    if (elementsChanged) {
        prevElementsRef.current = elements;
    }

    // Determine if progressive mode should be active
    const shouldProgressiveRender = enabled && elements.length > threshold;

    useEffect(() => {
        if (!shouldProgressiveRender) {
            setRenderCount(elements.length);
            wasCompleteRef.current = true;
            prevLenRef.current = elements.length;
            return;
        }

        // ─── Minor change optimisation ────────────────────────
        // If the previous progressive render already completed and
        // the element count changed by less than one batch (e.g.
        // selection change, single element add/remove), skip the
        // progressive restart and immediately show all elements.
        // This prevents the visible "flash" where 999 elements
        // momentarily drop to 500 then fill back in.
        const prevLen = prevLenRef.current;
        if (wasCompleteRef.current && Math.abs(elements.length - prevLen) < batchSize) {
            setRenderCount(elements.length);
            prevLenRef.current = elements.length;
            // wasCompleteRef stays true
            return;
        }

        // ─── Major change: progressive restart ────────────────
        // New generation — invalidate any in-flight renders
        const generation = ++generationRef.current;
        wasCompleteRef.current = false;
        prevLenRef.current = elements.length;

        // Start from first batch
        setRenderCount(Math.min(batchSize, elements.length));

        // Schedule subsequent batches
        let currentCount = batchSize;

        function renderNextBatch() {
            // Abort if a newer generation has started
            if (generationRef.current !== generation) return;

            currentCount = Math.min(currentCount + batchSize, elements.length);
            setRenderCount(currentCount);

            if (currentCount < elements.length) {
                requestAnimationFrame(renderNextBatch);
            } else {
                wasCompleteRef.current = true;
            }
        }

        if (batchSize < elements.length) {
            requestAnimationFrame(renderNextBatch);
        } else {
            wasCompleteRef.current = true;
        }

        return () => {
            // Invalidate on cleanup (component unmount or deps change)
            generationRef.current++;
        };
    }, [elements, shouldProgressiveRender, batchSize]); // eslint-disable-line react-hooks/exhaustive-deps

    // Build the visible subset
    const visibleElements = useMemo(() => {
        if (!shouldProgressiveRender || renderCount >= elements.length) {
            return elements;
        }
        return elements.slice(0, renderCount);
    }, [elements, renderCount, shouldProgressiveRender]);

    const isLoading = shouldProgressiveRender && renderCount < elements.length;
    const progress = elements.length > 0
        ? Math.min(renderCount / elements.length, 1)
        : 1;

    return { visibleElements, isLoading, progress };
}

// ─── Utility: scheduleIdleWork ────────────────────────────────

/**
 * Schedule non-critical work during browser idle time.
 * Falls back to setTimeout(100ms) if requestIdleCallback is unavailable.
 *
 * Use cases:
 *   - Pre-compute spatial data
 *   - Prefetch image thumbnails
 *   - Update minimap
 *   - Rebuild spatial indices
 */
export function scheduleIdleWork(
    work: () => void,
    options?: { timeout?: number },
): void {
    const timeout = options?.timeout ?? 1000;
    if ('requestIdleCallback' in window) {
        (window as Window).requestIdleCallback(
            (deadline) => {
                if (deadline.timeRemaining() > 5) {
                    work();
                } else {
                    scheduleIdleWork(work, options);
                }
            },
            { timeout },
        );
    } else {
        setTimeout(work, 100);
    }
}

/**
 * Yield to browser main thread (let browser handle input events).
 * Used inside long-running loops to prevent frame drops.
 */
export function yieldToMain(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}
