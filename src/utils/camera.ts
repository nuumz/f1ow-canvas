/**
 * camera.ts
 * Camera / viewport utilities: pointer-centric zoom, zoomToFit,
 * zoomToSelection, and smooth animated viewport transitions.
 *
 * Provides cursor-aware zooming, discrete zoom steps,
 * and animated transitions via requestAnimationFrame-based easing.
 */
import type { ViewportState, CanvasElement } from '@/types';
import { MIN_ZOOM, MAX_ZOOM } from '@/constants';
import { getElementAABB, type AABB } from './performance';

// ─── Zoom Constants ───────────────────────────────────────────

/** Predefined zoom steps for smooth discrete zooming */
export const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5] as const;

/** Default animation duration in ms */
export const DEFAULT_ANIMATION_DURATION = 280;

// ─── Pointer-centric Zoom ─────────────────────────────────────

export interface ZoomAtPointOptions {
    /** Current viewport state */
    viewport: ViewportState;
    /** Screen-space point to zoom toward (e.g. cursor position) */
    point: { x: number; y: number };
    /** Target zoom scale */
    targetScale: number;
}

/**
 * Compute new viewport state that zooms to `targetScale` while keeping
 * `point` (in screen coordinates) stationary — the standard
 * "zoom toward cursor" algorithm.
 */
export function zoomAtPoint({ viewport, point, targetScale }: ZoomAtPointOptions): ViewportState {
    const clampedScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, targetScale));
    // World-space coordinate under the pointer
    const wx = (point.x - viewport.x) / viewport.scale;
    const wy = (point.y - viewport.y) / viewport.scale;
    return {
        scale: clampedScale,
        x: point.x - wx * clampedScale,
        y: point.y - wy * clampedScale,
    };
}

/**
 * Get the next predefined zoom step above the current scale.
 * Falls back to MAX_ZOOM if already beyond the last step.
 */
export function getNextZoomStep(currentScale: number): number {
    for (const step of ZOOM_STEPS) {
        if (step > currentScale + 0.01) return step;
    }
    return MAX_ZOOM;
}

/**
 * Get the next predefined zoom step below the current scale.
 * Falls back to MIN_ZOOM if already below the first step.
 */
export function getPrevZoomStep(currentScale: number): number {
    for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
        if (ZOOM_STEPS[i] < currentScale - 0.01) return ZOOM_STEPS[i];
    }
    return MIN_ZOOM;
}

// ─── Bounding Box Helpers ─────────────────────────────────────

/**
 * Compute the combined bounding box for a set of elements.
 * Returns null if the array is empty.
 */
export function getElementsBounds(elements: CanvasElement[]): AABB | null {
    if (elements.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of elements) {
        const bb = getElementAABB(el);
        if (bb.minX < minX) minX = bb.minX;
        if (bb.minY < minY) minY = bb.minY;
        if (bb.maxX > maxX) maxX = bb.maxX;
        if (bb.maxY > maxY) maxY = bb.maxY;
    }
    return { minX, minY, maxX, maxY };
}

// ─── Zoom-to-Fit ──────────────────────────────────────────────

export interface ZoomToFitOptions {
    /** Pixel padding around the content */
    padding?: number;
    /** Maximum zoom level (avoid zooming too far in on tiny content) */
    maxZoom?: number;
}

/**
 * Compute viewport state that fits the given bounding box within
 * a stage of the given pixel dimensions.
 */
export function computeZoomToFit(
    bounds: AABB,
    stageWidth: number,
    stageHeight: number,
    options: ZoomToFitOptions = {},
): ViewportState {
    const padding = options.padding ?? 50;
    const maxZoom = options.maxZoom ?? 2;

    const bbW = bounds.maxX - bounds.minX;
    const bbH = bounds.maxY - bounds.minY;
    if (bbW === 0 && bbH === 0) {
        // Single point — just center it
        return {
            scale: 1,
            x: stageWidth / 2 - bounds.minX,
            y: stageHeight / 2 - bounds.minY,
        };
    }

    const scaleX = (stageWidth - padding * 2) / (bbW || 1);
    const scaleY = (stageHeight - padding * 2) / (bbH || 1);
    const scale = Math.min(Math.min(scaleX, scaleY), maxZoom);
    const clampedScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));

    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;

    return {
        scale: clampedScale,
        x: stageWidth / 2 - centerX * clampedScale,
        y: stageHeight / 2 - centerY * clampedScale,
    };
}

// ─── Smooth Animation ─────────────────────────────────────────

/** Easing function — ease-out cubic for natural deceleration */
function easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
}

/** Active animation handle for cancellation */
let activeAnimationId: number | null = null;

/**
 * Smoothly animate the viewport from its current state to a target state.
 *
 * @param from - Start viewport
 * @param to - Target viewport
 * @param setViewport - Store setter to apply intermediate states
 * @param duration - Animation duration in ms (default 280)
 * @returns A cancel function
 */
export function animateViewport(
    from: ViewportState,
    to: ViewportState,
    setViewport: (v: Partial<ViewportState>) => void,
    duration: number = DEFAULT_ANIMATION_DURATION,
): () => void {
    // Cancel any running animation
    if (activeAnimationId !== null) {
        cancelAnimationFrame(activeAnimationId);
        activeAnimationId = null;
    }

    const startTime = performance.now();

    const tick = (now: number) => {
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const eased = easeOutCubic(progress);

        const interpolated: ViewportState = {
            x: from.x + (to.x - from.x) * eased,
            y: from.y + (to.y - from.y) * eased,
            scale: from.scale + (to.scale - from.scale) * eased,
        };

        setViewport(interpolated);

        if (progress < 1) {
            activeAnimationId = requestAnimationFrame(tick);
        } else {
            activeAnimationId = null;
            // Ensure exact final state
            setViewport(to);
        }
    };

    activeAnimationId = requestAnimationFrame(tick);

    return () => {
        if (activeAnimationId !== null) {
            cancelAnimationFrame(activeAnimationId);
            activeAnimationId = null;
        }
    };
}

/**
 * Cancel any in-progress viewport animation.
 */
export function cancelViewportAnimation(): void {
    if (activeAnimationId !== null) {
        cancelAnimationFrame(activeAnimationId);
        activeAnimationId = null;
    }
}
