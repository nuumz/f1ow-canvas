/**
 * curve.ts
 *
 * Quadratic Bézier curve utilities for curved line/arrow rendering.
 *
 * Design:
 *   A curved line stores ONLY start + end points in its `points[]` array.
 *   The visual curve is a quadratic Bézier whose control point is computed
 *   at render time as a perpendicular offset from the midpoint of the
 *   start→end segment.  The offset ratio is a fixed constant (CURVE_RATIO),
 *   so the curve automatically scales when endpoints move.
 */
import type { Point } from '@/types';

// ── Constants ─────────────────────────────────────────────────

/** Perpendicular offset as a fraction of the start→end distance */
export const CURVE_RATIO = 0.2;

// ── Helpers ───────────────────────────────────────────────────

/**
 * Compute the quadratic Bézier control point for a curved line
 * defined by start and end points.
 *
 * The control point sits at the midpoint of start→end, offset
 * perpendicularly by `ratio × distance(start, end)`.
 * Positive ratio = offset to the left (looking from start to end).
 */
export function computeCurveControlPoint(
    start: Point,
    end: Point,
    ratio: number = CURVE_RATIO,
): Point {
    const mx = (start.x + end.x) / 2;
    const my = (start.y + end.y) / 2;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return { x: mx, y: my };
    // Perpendicular unit vector (rotated 90° CCW)
    const nx = -dy / len;
    const ny = dx / len;
    const offset = len * ratio;
    return { x: mx + nx * offset, y: my + ny * offset };
}

/**
 * Evaluate a quadratic Bézier at parameter t ∈ [0, 1].
 *   B(t) = (1-t)² P₀ + 2(1-t)t P₁ + t² P₂
 */
export function quadBezierAt(p0: Point, cp: Point, p2: Point, t: number): Point {
    const mt = 1 - t;
    return {
        x: mt * mt * p0.x + 2 * mt * t * cp.x + t * t * p2.x,
        y: mt * mt * p0.y + 2 * mt * t * cp.y + t * t * p2.y,
    };
}

/**
 * Compute the tangent (derivative) of a quadratic Bézier at parameter t.
 *   B'(t) = 2(1-t)(P₁ - P₀) + 2t(P₂ - P₁)
 * Returns a non-normalized direction vector.
 */
export function quadBezierTangent(p0: Point, cp: Point, p2: Point, t: number): Point {
    const mt = 1 - t;
    return {
        x: 2 * mt * (cp.x - p0.x) + 2 * t * (p2.x - cp.x),
        y: 2 * mt * (cp.y - p0.y) + 2 * t * (p2.y - cp.y),
    };
}

/**
 * Draw a quadratic Bézier curve path on a canvas 2D context.
 * Does NOT call stroke() — caller decides stroke/fill.
 */
export function drawQuadBezierPath(
    ctx: CanvasRenderingContext2D | { beginPath: () => void; moveTo: (x: number, y: number) => void; quadraticCurveTo: (cpx: number, cpy: number, x: number, y: number) => void },
    start: Point,
    cp: Point,
    end: Point,
): void {
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.quadraticCurveTo(cp.x, cp.y, end.x, end.y);
}

/**
 * Compute the "arriving direction" point for an arrowhead.
 * For start arrowhead: direction is tangent at t=0 pointing inward (from curve toward start).
 * For end arrowhead: direction is tangent at t=1 pointing inward (from curve toward end).
 *
 * Returns the "previous" point that drawArrowhead expects — i.e.
 * a point offset along the tangent away from the tip.
 */
export function curveArrowPrev(
    start: Point,
    cp: Point,
    end: Point,
    atEnd: boolean,
): Point {
    if (atEnd) {
        // Tangent at t=1 points from cp→end; "prev" is a step back along it
        const tan = quadBezierTangent(start, cp, end, 1);
        const len = Math.sqrt(tan.x * tan.x + tan.y * tan.y) || 1;
        return { x: end.x - tan.x / len * 20, y: end.y - tan.y / len * 20 };
    } else {
        // Tangent at t=0 points from start→cp; "prev" is a step back
        const tan = quadBezierTangent(start, cp, end, 0);
        const len = Math.sqrt(tan.x * tan.x + tan.y * tan.y) || 1;
        return { x: start.x + tan.x / len * 20, y: start.y + tan.y / len * 20 };
    }
}

/**
 * Compute the curvature ratio from a dragged control point position.
 *
 * Given the start/end endpoints of the line and the world position where
 * the user has dragged the curve handle, computes the signed perpendicular
 * offset ratio (curvature) that reproduces that position.
 *
 * Positive = left side (looking from start → end), negative = right side.
 */
export function curvatureFromDragPoint(
    start: Point,
    end: Point,
    dragWorld: Point,
): number {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return CURVE_RATIO;
    // Perpendicular unit vector (same as in computeCurveControlPoint: 90° CCW)
    const nx = -dy / len;
    const ny = dx / len;
    // Midpoint of start→end
    const mx = (start.x + end.x) / 2;
    const my = (start.y + end.y) / 2;
    // Vector from midpoint to drag point
    const vx = dragWorld.x - mx;
    const vy = dragWorld.y - my;
    // Project onto perpendicular axis → signed offset distance
    const projDist = vx * nx + vy * ny;
    // The drag handle sits at B(0.5) = M + 0.5 * ratio * len * n̂
    // So: projDist = 0.5 * ratio * len  →  ratio = 2 * projDist / len
    return (2 * projDist) / len;
}
